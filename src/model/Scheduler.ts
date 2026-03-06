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
  /** 后端返回的 task_id (仅当前正在运行的任务有值) */
  backendTaskId?: string;
  /** 可选的停止条件: 每轮完成后检查，满足则不再后触发 */
  stopCondition?: StopCondition;
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

const EXPEDITION_INTERVAL_MS = 15 * 60 * 1000; // 15 分钟
const EXPEDITION_TIMER_TICK_MS = 1000;          // 每秒更新倒计时

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

  // ── 远征定时器 ──
  private expeditionTimer: ReturnType<typeof setInterval> | null = null;
  private expeditionTickTimer: ReturnType<typeof setInterval> | null = null;
  private lastExpeditionCheck = 0; // timestamp ms

  constructor(api: ApiClient) {
    this.api = api;
    this.setupApiCallbacks();
  }

  // ── 公开 API ──

  setCallbacks(cb: SchedulerCallbacks): void {
    this.callbacks = cb;
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
    const resp = await this.api.systemStart(configPath, 120_000);
    if (!resp.success) return false;

    this.api.connectWebSockets();

    // 系统启动后立即检查远征，确保远征页面不会阻碍后续任务
    this.emitLog('info', '正在检查远征...');
    try {
      await this.api.expeditionCheck();
      this.emitLog('info', '远征检查完成');
    } catch {
      this.emitLog('debug', '远征检查跳过');
    }

    this.setStatus('idle');
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
      stopCondition,
    };

    // 按优先级插入队列
    this.insertByPriority(task);
    this.notifyQueueChange();

    return id;
  }

  /** 手动开始消费队列 */
  startConsuming(): void {
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

  /** 清空队列 (不影响当前正在运行的) */
  clearQueue(): void {
    this.queue = [];
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

    try {
      const resp = await this.api.taskStart(task.request);
      if (resp.success && resp.data) {
        task.backendTaskId = resp.data.task_id;
      } else {
        // 启动失败，跳过
        this.currentTask = null;
        this.callbacks.onTaskCompleted?.(task.id, false, null, resp.error ?? '任务启动失败');
        this.consumeNext();
      }
    } catch (e) {
      this.currentTask = null;
      this.callbacks.onTaskCompleted?.(task.id, false, null, String(e));
      this.consumeNext();
    }
  }

  /** 任务完成后的后触发处理 */
  private async handleTaskFinished(success: boolean, result?: TaskResult | null, error?: string | null): Promise<void> {
    const finished = this.currentTask;
    if (!finished) return;

    this.callbacks.onTaskCompleted?.(finished.id, success, result, error);

    // 后触发: 如果还有剩余次数，追加一个新任务回队列
    if (success && finished.remainingTimes > 1) {
      // 检查停止条件
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
        stopCondition: finished.stopCondition,
      };
      this.insertByPriority(followUp);
    }

    this.currentTask = null;
    // 继续消费下一个任务
    this.consumeNext();
  }

  /** 检查停止条件是否满足 */
  private async checkStopCondition(cond: StopCondition, taskName: string): Promise<boolean> {
    try {
      const resp = await this.api.gameAcquisition();
      if (!resp.success || !resp.data) return false;
      const data = resp.data;

      if (cond.loot_count_ge != null && data.loot_count != null && data.loot_count >= cond.loot_count_ge) {
        this.emitLog('info', `战利品已达 ${data.loot_count}/${data.loot_max ?? '?'}，满足停止条件 (≥${cond.loot_count_ge})`);
        return true;
      }
      if (cond.ship_count_ge != null && data.ship_count != null && data.ship_count >= cond.ship_count_ge) {
        this.emitLog('info', `舰船获取已达 ${data.ship_count}/${data.ship_max ?? '?'}，满足停止条件 (≥${cond.ship_count_ge})`);
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

    // 主定时器: 每 15 分钟触发远征检查
    this.expeditionTimer = setInterval(() => {
      this.triggerExpeditionCheck();
    }, EXPEDITION_INTERVAL_MS);

    // 倒计时 tick: 每秒通知 Controller 剩余时间
    this.expeditionTickTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastExpeditionCheck;
      const remaining = Math.max(0, EXPEDITION_INTERVAL_MS - elapsed);
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

  /** 触发一次远征检查 — 调用后端 API 收取已完成的远征。 */
  private triggerExpeditionCheck(): void {
    this.lastExpeditionCheck = Date.now();
    this.api.expeditionCheck().catch(() => {
      // 定时远征检查失败不影响调度器运行
    });
  }

  // ── 内部: WebSocket 回调绑定 ──

  private setupApiCallbacks(): void {
    this.api.setCallbacks({
      onLog: (msg) => {
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
