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
import { ApiClient } from '../ApiClient';
import type {
  TaskRequest,
  TaskResult,
} from '../../types/api';
import type { StopCondition, BathRepairConfig, FleetPreset } from '../../types/model';
import { Logger } from '../../utils/Logger';
import { RepairManager } from './RepairManager';
import { StopConditionChecker } from './StopConditionChecker';
import { ExpeditionTimer } from './ExpeditionTimer';
import { TaskQueue, generateTaskId, parseUiCount } from './TaskQueue';
import { TaskPriority, type SchedulerTaskType, type SchedulerTask, type SchedulerStatus, type SchedulerCallbacks } from '../../types/scheduler';

// ════════════════════════════════════════
// Scheduler 实现
// ════════════════════════════════════════

const DEFAULT_EXPEDITION_INTERVAL_MS = 15 * 60 * 1000; // 15 分钟

export class Scheduler {
  private api: ApiClient;
  private callbacks: SchedulerCallbacks = {};

  // ── 队列 ──
  private _taskQueue: TaskQueue;
  private currentTask: SchedulerTask | null = null;

  // ── 状态 ──
  private _status: SchedulerStatus = 'not_connected';
  private connected = false;
  /** 用户主动停止标志，阻止 handleTaskFinished 创建后续任务 */
  private _stopped = false;

  // ── 远征定时器 & 停止条件 ──
  private expeditionTimer: ExpeditionTimer;
  private stopChecker: StopConditionChecker;

  // ── 泡澡修理 ──
  private repairManager: RepairManager;

  constructor(api: ApiClient) {
    this.api = api;
    this._taskQueue = new TaskQueue();
    this.repairManager = new RepairManager(api);
    this.stopChecker = new StopConditionChecker(api, (level, message) => this.emitLog(level, message));
    this.expeditionTimer = new ExpeditionTimer(DEFAULT_EXPEDITION_INTERVAL_MS, {
      onTick: (sec) => this.callbacks.onExpeditionTimerTick?.(sec),
      onTrigger: () => this.handleExpeditionTrigger(),
    });
    this.setupApiCallbacks();
  }

  // ── 公开 API ──

  setCallbacks(cb: SchedulerCallbacks): void {
    this.callbacks = cb;
  }

  /** 更新远征检查间隔（分钟），立即重启定时器 */
  setExpeditionInterval(minutes: number): void {
    const clamped = Math.max(1, Math.min(120, minutes));
    this.expeditionTimer.setInterval(clamped * 60 * 1000);
  }

  get status(): SchedulerStatus {
    return this._status;
  }

  get currentRunningTask(): SchedulerTask | null {
    return this.currentTask;
  }

  get taskQueue(): ReadonlyArray<SchedulerTask> {
    return this._taskQueue.items;
  }

  /** 启动系统 (连接模拟器 + 启动游戏) */
  async start(configPath?: string): Promise<boolean> {
    const resp = await this.api.systemStart(configPath, 300_000);
    if (!resp.success) return false;

    this.api.connectWebSockets();
    this.setStatus('idle');

    // 系统启动后立即检查远征，确保远征页面不会阻碍后续任务
    this.emitLog('info', '正在检查远征...');
    try {
      await this.api.expeditionCheck();
      this.emitLog('info', '远征检查完成');
    } catch {
      this.emitLog('debug', '远征检查跳过');
    }
    this.expeditionTimer.start();
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
    this.expeditionTimer.start();
  }

  /** 停止系统 */
  async stop(): Promise<void> {
    this.expeditionTimer.stop();
    if (this.currentTask) {
      await this.api.taskStop();
    }
    this._taskQueue.clearQueue();
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
    bathRepairConfig?: BathRepairConfig,
    fleetId?: number,
    fleetPresets?: FleetPreset[],
    currentPresetIndex?: number,
  ): string {
    const id = this._taskQueue.addTask(name, type, request, priority, times, stopCondition, bathRepairConfig, fleetId, fleetPresets, currentPresetIndex);
    this.notifyQueueChange();
    return id;
  }

  /** 手动开始消费队列 */
  startConsuming(): void {
    this._stopped = false;
    if (this._status === 'idle' && !this.currentTask && this._taskQueue.length > 0) {
      this.consumeNext();
    }
  }

  /** 移除排队中的任务 (不能移除正在运行的) */
  removeTask(taskId: string): boolean {
    const removed = this._taskQueue.removeTask(taskId);
    if (removed) this.notifyQueueChange();
    return removed;
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
    Logger.debug(`stopRunning: currentTask=${this.currentTask?.name ?? 'null'} queueLen=${this._taskQueue.length}`, 'scheduler');
    this._stopped = true;
    if (this.currentTask) {
      try { await this.api.taskStop(); } catch { /* ignore */ }
      this.currentTask = null;
    }
    this._taskQueue.clearDeferredTimer();
    this.setStatus('idle');
    this.notifyQueueChange();
  }

  /** 处理后端进程 stdout 日志行（用于解析 OCR 数据和触发停止条件） */
  processBackendLog(message: string): void {
    const loot = parseUiCount(message, '战利品数量');
    const ship = parseUiCount(message, '舰船数量');
    if (loot != null) Logger.debug(`[StopCond] stdout 解析到战利品数量: ${loot}`, 'scheduler');
    if (ship != null) Logger.debug(`[StopCond] stdout 解析到舰船数量: ${ship}`, 'scheduler');
    this.stopChecker.updateTracked(loot, ship);

    if ((loot != null || ship != null) && this.currentTask?.stopCondition) {
      Logger.debug(`[StopCond] 当前任务有停止条件，检查是否满足`, 'scheduler');
      this.checkAndStopRunningTask(this.currentTask.stopCondition);
    }
  }

  /** 清空队列 (不影响当前正在运行的) */
  clearQueue(): void {
    this._taskQueue.clear();
    this.repairManager.clearAll();
    this.notifyQueueChange();
  }

  /** 移动队列中的任务顺序 */
  moveTask(fromIndex: number, toIndex: number): void {
    this._taskQueue.moveTask(fromIndex, toIndex);
    this.notifyQueueChange();
  }

  /** 获取延迟任务列表（只读） */
  get deferredTaskList(): ReadonlyArray<SchedulerTask> {
    return this._taskQueue.deferredItems;
  }

  // ── 内部: 消费循环 ──

  private async consumeNext(): Promise<void> {
    if (this.currentTask) return; // 还有任务在跑
    if (this._taskQueue.length === 0) {
      if (this._taskQueue.hasDeferredTasks) {
        this._taskQueue.scheduleDeferredRetry(
          () => this.consumeNext(),
          (level, msg) => this.emitLog(level, msg),
        );
        this.setStatus('idle');
      } else {
        this.setStatus('idle');
      }
      return;
    }

    const task = this._taskQueue.shift()!;
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

    // 发起前预检停止条件
    if (task.stopCondition) {
      const preflightMet = await this.stopChecker.preflightCheck(task.stopCondition, task.name);
      if (preflightMet) {
        this.emitLog('info', `任务「${task.name}」启动前已满足停止条件，跳过`);
        this.callbacks.onTaskCompleted?.(task.id, true, null, null);
        this.currentTask = null;
        this.consumeNext();
        return;
      }
    }

    // 泡澡修理编排: 检查 → 送泡澡 → 轮换预设 → 是否 defer
    if (task.bathRepairConfig?.enabled && task.fleetId) {
      const repairResult = await this.prepareRepair(task);
      if (repairResult === 'deferred') return;
    }

    await this.executeTaskStart(task);
  }

  // ── 内部: 泡澡修理编排 ──

  /**
   * 任务执行前的泡澡修理检查与编排。
   * @returns 'proceed' 表示可以继续执行任务, 'deferred' 表示任务已被延迟。
   */
  private async prepareRepair(task: SchedulerTask): Promise<'proceed' | 'deferred'> {
    const checkResult = await this.repairManager.checkFleetHealth(task.fleetId!, task.bathRepairConfig!);
    if (checkResult.ready) return 'proceed';

    // 有舰船需要修理 → 送入泡澡
    if (checkResult.shipsNeedRepair.length > 0) {
      this.emitLog('info', `任务「${task.name}」: ${checkResult.shipsNeedRepair.join('、')} 需要修理，送入泡澡`);
      await this.repairManager.sendToBath(checkResult.shipsNeedRepair);
    }

    // 尝试编队预设轮换
    const presets = task.fleetPresets;
    if (presets && presets.length > 1) {
      const healthyIdx = this.repairManager.findHealthyPreset(presets, task.currentPresetIndex ?? -1);
      if (healthyIdx >= 0) {
        this.emitLog('info', `任务「${task.name}」: 轮换至编队预设「${presets[healthyIdx].name}」`);
        this._taskQueue.switchTaskPreset(task, healthyIdx);
        return 'proceed';
      }
      this.emitLog('info', `任务「${task.name}」: 所有编队预设的舰船都在修理中，任务延迟`);
    } else if (checkResult.shipsInBath.length > 0) {
      this.emitLog('info', `任务「${task.name}」: ${checkResult.shipsInBath.join('、')} 正在泡澡中，任务延迟`);
    } else {
      this.emitLog('info', `任务「${task.name}」: 舰船正在修理，任务延迟`);
    }

    this.deferCurrentTask(task);
    return 'deferred';
  }

  // ── 内部: 任务启动 + 重试 ──

  /** 向后端发起 taskStart，失败时按重试策略处理 */
  private async executeTaskStart(task: SchedulerTask): Promise<void> {
    try {
      const resp = await this.api.taskStart(task.request);
      if (resp.success && resp.data) {
        task.backendTaskId = resp.data.task_id;
      } else {
        this.currentTask = null;
        if (this.scheduleRetry(task, resp.error ?? '任务启动失败')) return;
        this.callbacks.onTaskCompleted?.(task.id, false, null, resp.error ?? '任务启动失败');
        this.consumeNext();
      }
    } catch (e) {
      this.currentTask = null;
      if (this.scheduleRetry(task, String(e))) return;
      this.callbacks.onTaskCompleted?.(task.id, false, null, String(e));
      this.consumeNext();
    }
  }

  /**
   * 通用重试: 若未超过上限，5s 后重新入队并消费。
   * @returns true 表示已安排重试，调用方应 return；false 表示重试耗尽。
   */
  private scheduleRetry(task: SchedulerTask, reason: string): boolean {
    if (task.retryCount >= task.maxRetries) return false;
    task.retryCount++;
    this.emitLog('warn', `任务「${task.name}」${reason}，${task.retryCount}/${task.maxRetries} 次重试 (5s 后)`);
    setTimeout(() => {
      this._taskQueue.insertByPriority(task);
      this.notifyQueueChange();
      this.consumeNext();
    }, 5000);
    return true;
  }

  // ── 内部: 任务完成 & 后触发 ──

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
      this.callbacks.onTaskCompleted?.(finished.id, false, result, error);
      this.currentTask = null;
      if (this.scheduleRetry(finished, '执行失败')) return;
      this.consumeNext();
      return;
    }

    this.callbacks.onTaskCompleted?.(finished.id, true, result, error);

    // 后触发: 如果还有剩余次数，追加一个新任务回队列
    if (finished.remainingTimes > 1) {
      if (finished.stopCondition) {
        const shouldStop = await this.stopChecker.checkCondition(finished.stopCondition, finished.name);
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
        bathRepairConfig: finished.bathRepairConfig,
        fleetId: finished.fleetId,
        fleetPresets: finished.fleetPresets,
        currentPresetIndex: finished.currentPresetIndex,
      };
      Logger.debug(`followUp: 「${finished.name}」 remaining=${followUp.remainingTimes}/${followUp.totalTimes}`, 'scheduler');
      this._taskQueue.insertByPriority(followUp);
    }

    this.currentTask = null;
    this.consumeNext();
  }

  /** 任务执行中实时检查停止条件，满足则立即发送 taskStop */
  private checkAndStopRunningTask(cond: StopCondition): void {
    if (this.stopChecker.checkRunning(cond)) {
      this._stopped = true;
      this.api.taskStop().catch(() => {});
    }
  }

  // ── 泡澡延迟 ──

  /** 延迟当前任务（因修理阻塞） */
  private deferCurrentTask(task: SchedulerTask): void {
    this.currentTask = null;
    this._taskQueue.deferTask(task);
    this.notifyQueueChange();
    if (this._taskQueue.length > 0) {
      this.consumeNext();
    } else {
      this._taskQueue.scheduleDeferredRetry(
        () => this.consumeNext(),
        (level, msg) => this.emitLog(level, msg),
      );
      this.setStatus('idle');
    }
  }

  // ── 内部: 远征触发 ──

  /** 远征定时器回调 — 向队列插入远征任务，由调度器按优先级消费。 */
  private handleExpeditionTrigger(): void {
    if (this.currentTask?.type === 'expedition') return;
    if (this._taskQueue.hasType('expedition')) return;

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
    this._taskQueue.insertByPriority(task);
    this.notifyQueueChange();
    Logger.debug('远征定时器触发，已插入远征任务到队列', 'scheduler');

    if (!this.currentTask && this._status === 'idle') {
      this.consumeNext();
    }
  }

  // ── 内部: WebSocket 回调绑定 ──

  private setupApiCallbacks(): void {
    this.api.setCallbacks({
      onLog: (msg) => {
        const loot = parseUiCount(msg.message, '战利品数量');
        const ship = parseUiCount(msg.message, '舰船数量');
        this.stopChecker.updateTracked(loot, ship);

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
    this.callbacks.onQueueChange?.(this._taskQueue.items);
  }
}
