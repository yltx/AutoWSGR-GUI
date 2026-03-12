/**
 * Scheduler —— 前端任务调度器 (Model 层)。
 *
 * 设计思路 (来自架构讨论):
 *   - 带优先级的生产者-消费者模型
 *   - 三类生产者: 定时器 / 手动触发 / 后触发(任务完成后自动追加)
 *   - 优先级: expedition > user_task > daily(战役/演习)
 *   - 同一时间只有一个任务在后端执行
 *   - 调度器属于 Model 层，通过回调通知 Controller
 *
 * 调度器不直接操作 UI，也不直接构建 ViewObject。
 * Controller 监听调度器事件来更新 View。
 */
import {
  ApiClient,
  type TaskRequest,
  type TaskStatus,
  type WsLogMessage,
  type WsTaskUpdate,
  type WsTaskCompleted,
  type TaskResult,
} from './ApiClient';
import type { StopCondition } from './types';
import { Logger } from '../utils/Logger';

// ════════════════════════════════════════
// 任务队列项
// ════════════════════════════════════════

/** 任务优先级: 数值越小优先级越高 */
export enum TaskPriority {
  EXPEDITION = 0,   // 远征检查 (最高)
  USER_TASK = 10,   // 用户手动发起的任务
  DAILY = 20,       // 日常自动任务 (战役/演习)
}

export type SchedulerTaskType =
  | 'normal_fight'
  | 'event_fight'
  | 'campaign'
  | 'exercise'
  | 'decisive'
  | 'expedition';

export interface SchedulerTask {
  id: string;
  name: string;
  type: SchedulerTaskType;
  priority: TaskPriority;
  request: TaskRequest;
  /** 重复剩余次数 (用于任务分拆: 打500次 → 每次打1次然后后触发剩余) */
  remainingTimes: number;
  /** 总次数（用于显示进度） */
  totalTimes: number;
  /** 后端返回的 task_id (仅当前正在运行的任务有值) */
  backendTaskId?: string;
  /** 可选的停止条件: 每轮完成后检查，满足则不再后触发 */
  stopCondition?: StopCondition;
  /** 失败后最大重试次数 (默认 2) */
  maxRetries: number;
  /** 当前已重试次数 */
  retryCount: number;
}

// ════════════════════════════════════════
// 调度器状态
// ════════════════════════════════════════

export type SchedulerStatus = 'idle' | 'running' | 'stopping' | 'not_connected';

// ════════════════════════════════════════
// 事件回调
// ════════════════════════════════════════

export interface SchedulerCallbacks {
  /** 调度器状态改变 (idle/running/stopping) */
  onStatusChange?: (status: SchedulerStatus) => void;
  /** 当前任务进度更新 */
  onProgressUpdate?: (taskId: string, progress: { current: number; total: number; node: string | null }) => void;
  /** 任务完成 (单轮) */
  onTaskCompleted?: (taskId: string, success: boolean, result?: TaskResult | null, error?: string | null) => void;
  /** 新日志消息 */
  onLog?: (msg: WsLogMessage) => void;
  /** 队列变化 */
  onQueueChange?: (queue: ReadonlyArray<SchedulerTask>) => void;
  /** WebSocket 连接状态 */
  onConnectionChange?: (connected: boolean) => void;
  /** 远征倒计时更新 (秒) */
  onExpeditionTimerTick?: (remainingSeconds: number) => void;
}

// ════════════════════════════════════════
// Scheduler 实现
// ════════════════════════════════════════

const DEFAULT_EXPEDITION_INTERVAL_MS = 15 * 60 * 1000; // 15 分钟
const EXPEDITION_TIMER_TICK_MS = 1000;          // 每秒更新倒计时

/** 从 "[UI] 战利品数量: 50/50" 格式中提取当前值 */
function parseUiCount(msg: string, label: string): number | null {
  const re = new RegExp(`\\[UI\\] ${label}[:：]\\s*(\\d+)`);
  const m = msg.match(re);
  return m ? parseInt(m[1], 10) : null;
}

let nextTaskId = 1;
function generateTaskId(): string {
  return `sched_${nextTaskId++}`;
}

export class Scheduler {
  private api: ApiClient;
  private callbacks: SchedulerCallbacks = {};

  // ── 队列 ──
  private queue: SchedulerTask[] = [];
  private currentTask: SchedulerTask | null = null;

  // ── 状态 ──
  private _status: SchedulerStatus = 'not_connected';
  private connected = false;
  /** 用户主动停止标志，阻止 handleTaskFinished 创建后续任务 */
  private _stopped = false;

  // ── 远征定时器 ──
  private expeditionTimer: ReturnType<typeof setInterval> | null = null;
  private expeditionTickTimer: ReturnType<typeof setInterval> | null = null;
  /** 从后端 [UI] 日志 OCR 中解析的战利品/舰船当前值 */
  private trackedLootCount: number | null = null;
  private trackedShipCount: number | null = null;
  private lastExpeditionCheck = 0; // timestamp ms
  private expeditionIntervalMs = DEFAULT_EXPEDITION_INTERVAL_MS;

  constructor(api: ApiClient) {
    this.api = api;
    this.setupApiCallbacks();
  }

  // ── 公开 API ──

  setCallbacks(cb: SchedulerCallbacks): void {
    this.callbacks = cb;
  }

  /** 更新远征检查间隔（分钟），立即重启定时器 */
  setExpeditionInterval(minutes: number): void {
    const clamped = Math.max(1, Math.min(120, minutes));
    this.expeditionIntervalMs = clamped * 60 * 1000;
    // 如果定时器已在运行，重启以应用新间隔
    if (this.expeditionTimer) {
      this.startExpeditionTimer();
    }
  }

  get status(): SchedulerStatus {
    return this._status;
  }

  get currentRunningTask(): SchedulerTask | null {
    return this.currentTask;
  }

  get taskQueue(): ReadonlyArray<SchedulerTask> {
    return this.queue;
  }

  /** 启动系统 (连接模拟器 + 启动游戏) */
  async start(configPath?: string): Promise<boolean> {
    const resp = await this.api.systemStart(configPath, 300_000);
    if (!resp.success) return false;

    this.api.connectWebSockets();

    // 模拟器就绪，立即更新为空闲状态
    this.setStatus('idle');

    // 系统启动后立即检查远征，确保远征页面不会阻碍后续任务
    this.emitLog('info', '正在检查远征...');
    try {
      await this.api.expeditionCheck();
      this.emitLog('info', '远征检查完成');
    } catch {
      this.emitLog('debug', '远征检查跳过');
    }
    this.startExpeditionTimer();
    return true;
  }

  /** 仅检查后端是否可达 (不触发 system start) */
  async ping(): Promise<boolean> {
    try {
      const resp = await this.api.systemStatus();
      return resp.success;
    } catch {
      return false;
    }
  }

  /**
   * HTTP 超时但后端实际已就绪时的恢复:
   * 建立 WebSocket、设置状态、启动远征检查。
   */
  recoverAfterTimeout(): void {
    this.api.connectWebSockets();
    this.setStatus('idle');
    this.startExpeditionTimer();
  }

  /** 停止系统 */
  async stop(): Promise<void> {
    this.stopExpeditionTimer();
    if (this.currentTask) {
      await this.api.taskStop();
    }
    this.queue = [];
    this.currentTask = null;
    await this.api.systemStop();
    this.api.disconnectWebSockets();
    this.setStatus('not_connected');
    this.notifyQueueChange();
  }

  /** 添加任务到队列 */
  addTask(
    name: string,
    type: SchedulerTaskType,
    request: TaskRequest,
    priority: TaskPriority = TaskPriority.USER_TASK,
    times: number = 1,
    stopCondition?: StopCondition,
  ): string {
    const id = generateTaskId();
    const task: SchedulerTask = {
      id,
      name,
      type,
      priority,
      request,
      remainingTimes: times,
      totalTimes: times,
      stopCondition,
      maxRetries: 2,
      retryCount: 0,
    };

    // 按优先级插入队列
    this.insertByPriority(task);
    this.notifyQueueChange();

    return id;
  }

  /** 手动开始消费队列 */
  startConsuming(): void {
    this._stopped = false;
    if (this._status === 'idle' && !this.currentTask && this.queue.length > 0) {
      this.consumeNext();
    }
  }

  /** 移除排队中的任务 (不能移除正在运行的) */
  removeTask(taskId: string): boolean {
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    this.notifyQueueChange();
    return true;
  }

  /** 请求停止当前正在运行的任务 */
  async stopCurrentTask(): Promise<boolean> {
    if (!this.currentTask) return false;
    this.setStatus('stopping');
    const resp = await this.api.taskStop();
    return resp.success;
  }

  /** 立即停止当前任务并清除运行状态（不删除队列，不自动消费下一个） */
  async stopRunning(): Promise<void> {
    Logger.debug(`stopRunning: currentTask=${this.currentTask?.name ?? 'null'} queueLen=${this.queue.length}`, 'scheduler');
    this._stopped = true;
    if (this.currentTask) {
      try { await this.api.taskStop(); } catch { /* ignore */ }
      this.currentTask = null;
    }
    this.setStatus('idle');
    this.notifyQueueChange();
  }

  /** 处理后端进程 stdout 日志行（用于解析 OCR 数据和触发停止条件） */
  processBackendLog(message: string): void {
    const loot = parseUiCount(message, '战利品数量');
    const ship = parseUiCount(message, '舰船数量');
    if (loot != null) {
      this.trackedLootCount = loot;
      Logger.debug(`[StopCond] stdout 解析到战利品数量: ${loot}`, 'scheduler');
    }
    if (ship != null) {
      this.trackedShipCount = ship;
      Logger.debug(`[StopCond] stdout 解析到舰船数量: ${ship}`, 'scheduler');
    }

    if ((loot != null || ship != null) && this.currentTask?.stopCondition) {
      Logger.debug(`[StopCond] 当前任务有停止条件，检查是否满足`, 'scheduler');
      this.checkAndStopRunningTask(this.currentTask.stopCondition);
    }
  }

  /** 清空队列 (不影响当前正在运行的) */
  clearQueue(): void {
    this.queue = [];
    this.notifyQueueChange();
  }

  /** 移动队列中的任务顺序 */
  moveTask(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.queue.length) return;
    if (toIndex < 0 || toIndex >= this.queue.length) return;
    if (fromIndex === toIndex) return;
    const [task] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, task);
    this.notifyQueueChange();
  }

  // ── 内部: 消费循环 ──

  private async consumeNext(): Promise<void> {
    if (this.currentTask) return; // 还有任务在跑
    if (this.queue.length === 0) {
      this.setStatus('idle');
      return;
    }

    const task = this.queue.shift()!;
    this.currentTask = task;
    this.setStatus('running');
    this.notifyQueueChange();

    Logger.debug(`consumeNext: 「${task.name}」 type=${task.type} remaining=${task.remainingTimes}/${task.totalTimes} req=${JSON.stringify(task.request)}`, 'scheduler');

    // 远征任务: 直接调用远征 API，不走 taskStart 流程
    if (task.type === 'expedition') {
      try {
        this.emitLog('info', '正在检查远征...');
        await this.api.expeditionCheck();
        this.emitLog('info', '远征检查完成');
      } catch {
        this.emitLog('debug', '远征检查跳过');
      }
      this.currentTask = null;
      this.consumeNext();
      return;
    }

    // 发起前预检停止条件：仅依赖 OCR 识别结果
    // 调用 /api/game/acquisition 读取当前战利品/舰船数量
    if (task.stopCondition) {
      const preflightMet = await this.preflightStopCheck(task.stopCondition, task.name);
      if (preflightMet) {
        this.emitLog('info', `任务「${task.name}」启动前已满足停止条件，跳过`);
        this.callbacks.onTaskCompleted?.(task.id, true, null, null);
        this.currentTask = null;
        this.consumeNext();
        return;
      }
    }

    try {
      const resp = await this.api.taskStart(task.request);
      if (resp.success && resp.data) {
        task.backendTaskId = resp.data.task_id;
      } else {
        // 启动失败，尝试重试
        this.currentTask = null;
        if (task.retryCount < task.maxRetries) {
          task.retryCount++;
          this.emitLog('warn', `任务「${task.name}」启动失败，${task.retryCount}/${task.maxRetries} 次重试 (5s 后)`);
          setTimeout(() => {
            this.insertByPriority(task);
            this.notifyQueueChange();
            this.consumeNext();
          }, 5000);
        } else {
          this.callbacks.onTaskCompleted?.(task.id, false, null, resp.error ?? '任务启动失败');
          this.consumeNext();
        }
      }
    } catch (e) {
      this.currentTask = null;
      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        this.emitLog('warn', `任务「${task.name}」异常，${task.retryCount}/${task.maxRetries} 次重试 (5s 后)`);
        setTimeout(() => {
          this.insertByPriority(task);
          this.notifyQueueChange();
          this.consumeNext();
        }, 5000);
      } else {
        this.callbacks.onTaskCompleted?.(task.id, false, null, String(e));
        this.consumeNext();
      }
    }
  }

  /** 任务完成后的后触发处理 */
  private async handleTaskFinished(success: boolean, result?: TaskResult | null, error?: string | null): Promise<void> {
    const finished = this.currentTask;
    if (!finished) return;

    // 用户主动停止后，不再创建后续任务
    if (this._stopped) {
      Logger.debug(`handleTaskFinished: _stopped flag set, skipping follow-up for 「${finished.name}」`, 'scheduler');
      this._stopped = false;
      this.currentTask = null;
      this.setStatus('idle');
      this.notifyQueueChange();
      return;
    }

    // 执行失败 → 尝试重试
    if (!success) {
      if (finished.retryCount < finished.maxRetries) {
        finished.retryCount++;
        this.emitLog('warn', `任务「${finished.name}」执行失败，${finished.retryCount}/${finished.maxRetries} 次重试 (5s 后)`);
        this.callbacks.onTaskCompleted?.(finished.id, false, result, error);
        this.currentTask = null;
        setTimeout(() => {
          this.insertByPriority(finished);
          this.notifyQueueChange();
          this.consumeNext();
        }, 5000);
        return;
      }
      // 重试耗尽
      this.callbacks.onTaskCompleted?.(finished.id, false, result, error);
      this.currentTask = null;
      this.consumeNext();
      return;
    }

    this.callbacks.onTaskCompleted?.(finished.id, true, result, error);

    // 后触发: 如果还有剩余次数，追加一个新任务回队列
    if (finished.remainingTimes > 1) {
      // 停止条件检查：通过 gameContext 读取计数器
      if (finished.stopCondition) {
        const shouldStop = await this.checkStopCondition(finished.stopCondition, finished.name);
        if (shouldStop) {
          this.emitLog('info', `任务「${finished.name}」满足停止条件，不再继续`);
          this.currentTask = null;
          this.consumeNext();
          return;
        }
      }

      const followUp: SchedulerTask = {
        id: generateTaskId(),
        name: finished.name,
        type: finished.type,
        priority: finished.priority,
        request: finished.request,
        remainingTimes: finished.remainingTimes - 1,
        totalTimes: finished.totalTimes,
        stopCondition: finished.stopCondition,
        maxRetries: finished.maxRetries,
        retryCount: 0,
      };
      Logger.debug(`followUp: 「${finished.name}」 remaining=${followUp.remainingTimes}/${followUp.totalTimes}`, 'scheduler');
      this.insertByPriority(followUp);
    }

    this.currentTask = null;
    // 继续消费下一个任务
    this.consumeNext();
  }

  /** 任务执行中实时检查停止条件，满足则立即发送 taskStop */
  private checkAndStopRunningTask(cond: StopCondition): void {
    let met = false;
    if (cond.loot_count_ge != null && this.trackedLootCount != null && this.trackedLootCount >= cond.loot_count_ge) {
      this.emitLog('info', `战利品已达 ${this.trackedLootCount}/${cond.loot_count_ge}，实时触发停止`);
      met = true;
    }
    if (cond.ship_count_ge != null && this.trackedShipCount != null && this.trackedShipCount >= cond.ship_count_ge) {
      this.emitLog('info', `舰船已达 ${this.trackedShipCount}/${cond.ship_count_ge}，实时触发停止`);
      met = true;
    }
    if (met) {
      this._stopped = true;
      this.api.taskStop().catch(() => {});
    }
  }

  /**
   * 预飞检查：在发起 taskStart 之前确认停止条件是否已满足。
   *
   * 仅依赖 OCR：调用 /api/game/acquisition 读取出征面板数量。
   * 不使用本地跟踪值，也不使用 gameContext 计数器。
   */
  private async preflightStopCheck(cond: StopCondition, taskName: string): Promise<boolean> {
    Logger.debug(`[StopCond] 预飞OCR检查: 「${taskName}」 条件=${JSON.stringify(cond)}`, 'scheduler');

    try {
      const resp = await this.api.gameAcquisition();
      if (resp.success && resp.data) {
        const { loot_count, ship_count } = resp.data;
        Logger.debug(`[StopCond] acquisition OCR: loot=${loot_count} ship=${ship_count}`, 'scheduler');

        if (loot_count != null) this.trackedLootCount = loot_count;
        if (ship_count != null) this.trackedShipCount = ship_count;

        if (cond.loot_count_ge != null && loot_count != null && loot_count >= cond.loot_count_ge) {
          this.emitLog('info', `[预飞] OCR: 战利品 ${loot_count} ≥ ${cond.loot_count_ge}，满足停止条件`);
          return true;
        }
        if (cond.ship_count_ge != null && ship_count != null && ship_count >= cond.ship_count_ge) {
          this.emitLog('info', `[预飞] OCR: 舰船 ${ship_count} ≥ ${cond.ship_count_ge}，满足停止条件`);
          return true;
        }

        this.emitLog('info', `[预飞] OCR: 战利品=${loot_count ?? '-'} 舰船=${ship_count ?? '-'}，未达停止条件`);
      } else {
        this.emitLog('warn', `[预飞] OCR 检查失败: ${resp.error ?? 'unknown error'}`);
      }
    } catch (e) {
      this.emitLog('warn', `[预飞] OCR 检查异常: ${String(e)}`);
    }

    Logger.debug(`[StopCond] 预飞OCR检查: 未满足停止条件，任务将启动`, 'scheduler');
    return false;
  }

  /** 检查停止条件是否满足（优先使用 OCR 日志中跟踪的计数，回退到 gameContext API） */
  private async checkStopCondition(cond: StopCondition, _taskName: string): Promise<boolean> {
    // 优先使用从后端 [UI] 日志 OCR 到的实时数据
    if (cond.loot_count_ge != null && this.trackedLootCount != null && this.trackedLootCount >= cond.loot_count_ge) {
      this.emitLog('info', `战利品已达 ${this.trackedLootCount}，满足停止条件 (≥${cond.loot_count_ge})`);
      return true;
    }
    if (cond.ship_count_ge != null && this.trackedShipCount != null && this.trackedShipCount >= cond.ship_count_ge) {
      this.emitLog('info', `舰船获取已达 ${this.trackedShipCount}，满足停止条件 (≥${cond.ship_count_ge})`);
      return true;
    }

    // 回退：从 gameContext API 读取（后端计数器暂未递增，留作将来兼容）
    try {
      const resp = await this.api.gameContext();
      if (!resp.success || !resp.data) return false;
      const data = resp.data;

      if (cond.loot_count_ge != null && data.dropped_loot_count != null && data.dropped_loot_count >= cond.loot_count_ge) {
        this.emitLog('info', `战利品已达 ${data.dropped_loot_count}，满足停止条件 (≥${cond.loot_count_ge})`);
        return true;
      }
      if (cond.ship_count_ge != null && data.dropped_ship_count != null && data.dropped_ship_count >= cond.ship_count_ge) {
        this.emitLog('info', `舰船获取已达 ${data.dropped_ship_count}，满足停止条件 (≥${cond.ship_count_ge})`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── 内部: 优先级插入 ──

  private insertByPriority(task: SchedulerTask): void {
    // 找到第一个优先级低于 task 的位置
    const idx = this.queue.findIndex((t) => t.priority > task.priority);
    if (idx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(idx, 0, task);
    }
  }

  // ── 内部: 远征定时器 ──

  private startExpeditionTimer(): void {
    this.lastExpeditionCheck = Date.now();
    this.stopExpeditionTimer();

    // 主定时器: 按配置间隔触发远征检查
    this.expeditionTimer = setInterval(() => {
      this.triggerExpeditionCheck();
    }, this.expeditionIntervalMs);

    // 倒计时 tick: 每秒通知 Controller 剩余时间
    this.expeditionTickTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastExpeditionCheck;
      const remaining = Math.max(0, this.expeditionIntervalMs - elapsed);
      this.callbacks.onExpeditionTimerTick?.(Math.ceil(remaining / 1000));
    }, EXPEDITION_TIMER_TICK_MS);
  }

  private stopExpeditionTimer(): void {
    if (this.expeditionTimer) {
      clearInterval(this.expeditionTimer);
      this.expeditionTimer = null;
    }
    if (this.expeditionTickTimer) {
      clearInterval(this.expeditionTickTimer);
      this.expeditionTickTimer = null;
    }
  }

  /** 触发一次远征检查 — 向队列插入远征任务，由调度器按优先级消费。 */
  private triggerExpeditionCheck(): void {
    this.lastExpeditionCheck = Date.now();

    // 防止重复：已有远征任务排队或正在执行时跳过
    if (this.currentTask?.type === 'expedition') return;
    if (this.queue.some(t => t.type === 'expedition')) return;

    const id = generateTaskId();
    const task: SchedulerTask = {
      id,
      name: '远征检查',
      type: 'expedition',
      priority: TaskPriority.EXPEDITION,
      request: { type: 'expedition' } as unknown as TaskRequest,
      remainingTimes: 1,
      totalTimes: 1,
      maxRetries: 1,
      retryCount: 0,
    };
    this.insertByPriority(task);
    this.notifyQueueChange();
    Logger.debug('远征定时器触发，已插入远征任务到队列', 'scheduler');

    // 如果当前空闲，立即消费
    if (!this.currentTask && this._status === 'idle') {
      this.consumeNext();
    }
  }

  // ── 内部: WebSocket 回调绑定 ──

  private setupApiCallbacks(): void {
    this.api.setCallbacks({
      onLog: (msg) => {
        // 解析后端出征面板 OCR 日志，跟踪战利品/舰船数量用于停止条件
        const loot = parseUiCount(msg.message, '战利品数量');
        const ship = parseUiCount(msg.message, '舰船数量');
        if (loot != null) this.trackedLootCount = loot;
        if (ship != null) this.trackedShipCount = ship;

        // 实时停止：任务执行中收到 OCR 数据后，立即检查是否满足停止条件
        if ((loot != null || ship != null) && this.currentTask?.stopCondition) {
          this.checkAndStopRunningTask(this.currentTask.stopCondition);
        }

        this.callbacks.onLog?.(msg);
      },

      onTaskUpdate: (msg) => {
        if (!this.currentTask) return;
        this.callbacks.onProgressUpdate?.(
          this.currentTask.id,
          msg.progress ?? { current: 0, total: 0, node: null },
        );
      },

      onTaskCompleted: (msg) => {
        this.handleTaskFinished(msg.success, msg.result, msg.error);
      },

      onWsStatusChange: (connected) => {
        this.connected = connected;
        this.callbacks.onConnectionChange?.(connected);
        if (!connected && this._status !== 'not_connected') {
          // WebSocket 断开但系统可能还在运行，不改状态
        }
      },
    });
  }

  // ── 内部: 状态管理 ──

  private setStatus(s: SchedulerStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.callbacks.onStatusChange?.(s);
  }

  /** 通过回调发送前端侧日志 */
  private emitLog(level: string, message: string): void {
    this.callbacks.onLog?.({
      type: 'log',
      timestamp: new Date().toISOString(),
      level,
      channel: 'scheduler',
      message,
    });
  }

  private notifyQueueChange(): void {
    this.callbacks.onQueueChange?.(this.queue);
  }
}
