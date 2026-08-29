/** 持有当前任务和运行状态，驱动任务消费、重试与后续任务。 */
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
  RoundResult,
  WsTaskCompleted,
} from '../../types/api.js';
import type {
  StopCondition,
  BathRepairConfig,
  FleetPreset,
  BattleResultGrade,
} from '../../types/model.js';
import { Logger } from '../../utils/Logger';
import { jsonCodec } from '../../adapter/index.js';
import { RepairManager } from './RepairManager';
import { StopConditionChecker } from './StopConditionChecker';
import { ExpeditionTimer } from './ExpeditionTimer';
import { TaskQueue, generateTaskId, parseUiCount } from './TaskQueue';
import {
  TaskPriority,
  type LogicalTaskCancelReason,
  type SchedulerTaskType,
  type SchedulerTask,
  type SchedulerStatus,
  type SchedulerCallbacks,
  type SchedulerWaitingTask,
} from '../../types/scheduler';
import { toBackendName } from '../../shared/shipNameNormalizer.js';
import {
  buildFollowUpTask as createFollowUpTask,
  getNonRetryableTaskResult,
} from './SchedulerTaskPolicy.js';

const RESULT_GRADE_ORDER: BattleResultGrade[] = ['D', 'C', 'B', 'A', 'S', 'SS'];

// ════════════════════════════════════════
// Scheduler 实现
// ════════════════════════════════════════

const DEFAULT_EXPEDITION_INTERVAL_MS = 15 * 60 * 1000; // 15 分钟
const STOP_CONFIRM_POLL_INTERVAL_MS = 250;
const STOP_CONFIRM_TIMEOUT_MS = 30_000;

type StopRequestReason = 'manual' | 'condition';

interface WaitingTaskEntry extends SchedulerWaitingTask {
  timer: ReturnType<typeof setTimeout>;
}

export class Scheduler {
  private api: ApiClient;
  private callbacks: SchedulerCallbacks = {};

  // ── 队列 ──
  private _taskQueue: TaskQueue;
  private currentTask: SchedulerTask | null = null;
  private startingTaskId: string | null = null;
  private pendingTaskCompletions = new Map<string, WsTaskCompleted>();

  // ── 状态 ──
  private _status: SchedulerStatus = 'not_connected';
  private systemActive = false;
  private autoExpedition = true;
  /** 当前停止请求的来源，避免把停止条件误当作用户暂停。 */
  private stopRequest: {
    taskId: string;
    reason: StopRequestReason;
  } | null = null;
  /** 失败重试和轮次间隔中的任务，保留任务身份并允许取消。 */
  private waitingTasks = new Map<string, WaitingTaskEntry>();

  // ── 远征定时器 & 停止条件 ──
  private expeditionTimer: ExpeditionTimer;
  private stopChecker: StopConditionChecker;

  // ── 泡澡修理 ──
  private repairManager: RepairManager;

  constructor(
    api: ApiClient,
    getShipNameAliases:
      () => Readonly<Record<string, string>> = () => ({}),
  ) {
    this.api = api;
    this._taskQueue = new TaskQueue(getShipNameAliases);
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

  /** 开关自动远征检查；运行中修改时立即启停定时器 */
  setAutoExpedition(enabled: boolean): void {
    this.autoExpedition = enabled;
    if (!enabled) {
      this.expeditionTimer.stop();
    } else if (this.systemActive && !this.expeditionTimer.isRunning) {
      this.expeditionTimer.start();
    }
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

  /** 当前无运行、排队、重试或修理延迟任务，可接收空闲自动任务。 */
  get isCompletelyIdle(): boolean {
    return this.systemActive
      && this._status === 'idle'
      && this.currentTask === null
      && this._taskQueue.length === 0
      && !this._taskQueue.hasDeferredTasks
      && this.waitingTasks.size === 0;
  }

  /** 获取轮次间隔或失败重试中的任务。 */
  get waitingTaskList(): ReadonlyArray<SchedulerWaitingTask> {
    return [...this.waitingTasks.values()]
      .sort((left, right) => left.readyAt - right.readyAt)
      .map(({ task, reason, readyAt }) => ({
        task,
        reason,
        readyAt,
      }));
  }

  /** 按物理任务 ID 查找运行中、排队中或等待中的任务。 */
  findTask(taskId: string): SchedulerTask | null {
    if (this.currentTask?.id === taskId) return this.currentTask;
    return this._taskQueue.findTask(taskId)
      ?? this.waitingTasks.get(taskId)?.task
      ?? null;
  }

  /** 执行一次远征检查（系统启动时与远征任务消费时共用） */
  private async checkExpedition(): Promise<void> {
    this.emitLog('info', '正在检查远征...');
    try {
      await this.api.expeditionCheck();
      this.emitLog('info', '远征检查完成');
    } catch {
      this.emitLog('debug', '远征检查跳过');
    }
  }

  /** 启动系统 (连接模拟器 + 启动游戏) */
  async start(configPath?: string): Promise<boolean> {
    const resp = await this.api.systemStart(configPath, 300_000);
    if (!resp.success) return false;

    this.systemActive = true;
    this.stopRequest = null;
    this.api.connectWebSockets();
    this.setStatus('idle');

    if (this.autoExpedition) {
      // 系统启动后立即检查远征，确保远征页面不会阻碍后续任务
      await this.checkExpedition();
      this.expeditionTimer.start();
    }
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

  /** 检查后端系统是否已经完成模拟器连接。 */
  async isSystemReady(): Promise<boolean> {
    try {
      const resp = await this.api.systemStatus();
      return resp.success && resp.data?.emulator_connected === true;
    } catch {
      return false;
    }
  }

  /**
   * HTTP 超时但后端实际已就绪时的恢复:
   * 建立 WebSocket、设置状态、启动远征检查。
   */
  recoverAfterTimeout(): void {
    this.systemActive = true;
    this.stopRequest = null;
    this.api.connectWebSockets();
    this.setStatus('idle');
    if (this.autoExpedition) this.expeditionTimer.start();
  }

  /**
   * 停止系统并释放调度资源。
   * 当前没有生产调用方，保留为正式生命周期清理接口。
   */
  async stop(): Promise<void> {
    const hadRunningTask = this.currentTask !== null;
    const canceledLogicalIds = this.collectLogicalIds([
      ...(this.currentTask ? [this.currentTask] : []),
      ...this._taskQueue.items,
      ...this._taskQueue.deferredItems,
      ...this.waitingTaskList.map(item => item.task),
    ]);
    this.systemActive = false;
    this.stopRequest = null;
    this.expeditionTimer.stop();
    this.clearWaitingTasks();
    this._taskQueue.clear();
    this.currentTask = null;
    this.emitLogicalCancellations(
      canceledLogicalIds,
      'system_stopped',
    );

    try {
      if (hadRunningTask) {
        try {
          await this.api.taskStop();
        } catch (e) {
          this.emitLog('warn', `停止当前任务失败: ${String(e)}`);
        }
      }
      try {
        await this.api.systemStop();
      } catch (e) {
        this.emitLog('warn', `停止后端系统失败: ${String(e)}`);
      }
    } finally {
      this.api.disconnectWebSockets();
      this.stopRequest = null;
      this.setStatus('not_connected');
      this.notifyQueueChange();
    }
  }

  /**
   * 添加任务到队列。
   * 当前没有生产调用方传入 bathRepairConfig，保留给泡澡维修后续接入。
   */
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
    forceRetry?: boolean,
    allowPolling?: boolean,
    endpointNodes?: string[],
    endpointResult?: BattleResultGrade,
    sortKey?: number,
  ): string {
    const id = this._taskQueue.addTask(
      name,
      type,
      request,
      priority,
      times,
      stopCondition,
      bathRepairConfig,
      fleetId,
      fleetPresets,
      currentPresetIndex,
      forceRetry,
      allowPolling,
      endpointNodes,
      endpointResult,
      sortKey,
    );
    this.notifyQueueChange();
    return id;
  }

  /** 手动开始消费队列 */
  startConsuming(): void {
    if (!this.currentTask) this.stopRequest = null;
    if (this._status === 'idle' && !this.currentTask && this._taskQueue.length > 0) {
      this.consumeNext();
    }
  }

  /** 移除排队或等待中的任务（不能移除正在运行的任务）。 */
  removeTask(taskId: string): boolean {
    const removed = this._taskQueue.removeTask(taskId)
      ?? this.removeWaitingTask(taskId);
    if (!removed) return false;

    if (!this.hasLogicalTask(removed.logicalId)) {
      this.callbacks.onLogicalTaskCanceled?.(
        removed.logicalId,
        'removed',
      );
    }
    this.notifyQueueChange();
    return true;
  }

  /**
   * 请求停止当前任务，等待后端 worker 退出后再放回队列。
   * WebSocket 完成事件和状态轮询任一确认停止即可结束等待。
   */
  async stopRunning(): Promise<void> {
    Logger.debug(`stopRunning: currentTask=${this.currentTask?.name ?? 'null'} queueLen=${this._taskQueue.length}`, 'scheduler');

    const runningTask = this.currentTask;
    if (!runningTask) {
      this._taskQueue.clearDeferredTimer();
      this.setStatus('idle');
      this.notifyQueueChange();
      return;
    }

    this.stopRequest = {
      taskId: runningTask.id,
      reason: 'manual',
    };
    this.setStatus('stopping');
    try {
      const response = await this.api.taskStop();
      if (this.currentTask?.id !== runningTask.id) return;
      if (!response.success) {
        this.stopRequest = null;
        this.setStatus('running');
        throw new Error(response.error || '后端拒绝停止任务');
      }
    } catch (error) {
      if (this.currentTask?.id === runningTask.id) {
        this.stopRequest = null;
        this.setStatus('running');
      }
      throw error;
    }

    const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
    while (this.currentTask?.id === runningTask.id) {
      try {
        const response = await this.api.taskStatus();
        if (
          response.success
          && response.data
          && response.data.status !== 'running'
        ) {
          this.finishManualStop(runningTask);
          return;
        }
      } catch {
        // WebSocket 仍可能确认结束；轮询错误在超时前继续重试。
      }

      if (Date.now() >= deadline) {
        this.stopRequest = null;
        this.setStatus('running');
        throw new Error('停止请求已发送，但后端在 30 秒内未确认任务结束');
      }
      await new Promise(resolve => {
        setTimeout(resolve, STOP_CONFIRM_POLL_INTERVAL_MS);
      });
    }
  }

  /** 后端确认退出后，将手动停止的任务恢复为未开始状态。 */
  private finishManualStop(runningTask: SchedulerTask): void {
    if (this.currentTask?.id !== runningTask.id) return;

    runningTask.retryCount = 0;
    runningTask.backendTaskId = undefined;
    this.currentTask = null;
    this._taskQueue.insertByPriority(runningTask, !runningTask.allowPolling);
    this.stopRequest = null;

    this._taskQueue.clearDeferredTimer();
    this.setStatus('idle');
    this.notifyQueueChange();
  }

  /** 停止条件命中后结束父任务，不把当前轮重新放回队列。 */
  private finishStopCondition(runningTask: SchedulerTask): void {
    if (this.currentTask?.id !== runningTask.id) return;

    runningTask.backendTaskId = undefined;
    this.currentTask = null;
    this.stopRequest = null;
    this.emitLog(
      'info',
      `任务「${runningTask.name}」满足停止条件，逻辑任务已结束`,
    );
    this.callbacks.onLogicalTaskCompleted?.(
      runningTask.logicalId,
      true,
      null,
      false,
      'stop_condition',
    );
    this.setStatus('idle');
    this.notifyQueueChange();
    this.consumeNext();
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
    const canceledLogicalIds = this.collectLogicalIds([
      ...this._taskQueue.items,
      ...this._taskQueue.deferredItems,
      ...this.waitingTaskList.map(item => item.task),
    ]);
    this.clearWaitingTasks();
    this._taskQueue.clear();
    this.repairManager.clearAll();
    this.emitLogicalCancellations(
      canceledLogicalIds,
      'queue_cleared',
    );
    this.notifyQueueChange();
  }

  /** 移动队列中的任务顺序 */
  moveTask(fromIndex: number, toIndex: number): void {
    this._taskQueue.moveTask(fromIndex, toIndex);
    this.notifyQueueChange();
  }

  // ── 内部: 消费循环 ──

  private async consumeNext(): Promise<void> {
    if (!this.systemActive) return;
    if (this.currentTask) return; // 还有任务在跑
    if (this._taskQueue.length === 0) {
      if (this._taskQueue.hasDeferredTasks) {
        this._taskQueue.scheduleDeferredRetry(
          () => this.consumeNext(),
          (level, msg) => this.emitLog(level, msg),
          this.repairManager.getBathingShips(),
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

    Logger.debug(`consumeNext: 「${task.name}」 type=${task.type} remaining=${task.remainingTimes}/${task.totalTimes} req=${jsonCodec.stringify(task.request)}`, 'scheduler');

    // 远征任务: 直接调用远征 API，不走 taskStart 流程
    if (task.type === 'expedition') {
      await this.checkExpedition();

      if (!this.systemActive || this.currentTask?.id !== task.id) return;
      await this.handlePostExpedition();

      if (!this.systemActive || this.currentTask?.id !== task.id) return;
      this.currentTask = null;
      this.consumeNext();
      return;
    }

    // 发起前预检停止条件
    if (task.stopCondition) {
      const preflightMet = await this.stopChecker.preflightCheck(task.stopCondition, task.name);
      if (!this.systemActive || this.currentTask?.id !== task.id) return;
      if (preflightMet) {
        this.emitLog('info', `任务「${task.name}」启动前已满足停止条件，跳过`);
        this.callbacks.onTaskCompleted?.(task.id, true, null, null);
        this.callbacks.onLogicalTaskCompleted?.(
          task.logicalId,
          true,
          null,
          false,
          'stop_condition',
        );
        this.currentTask = null;
        this.consumeNext();
        return;
      }
    }

    // 泡澡修理编排: 检查 → 送泡澡 → 轮换预设 → 是否 defer
    if (task.bathRepairConfig?.enabled && task.fleetId) {
      const repairResult = await this.prepareRepair(task);
      if (!this.systemActive || this.currentTask?.id !== task.id) return;
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
        this.notifyQueueChange();
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
    this.startingTaskId = task.id;
    this.pendingTaskCompletions.clear();
    try {
      if (task.request.type === 'expedition') {
        throw new Error('远征检查不能通过 taskStart 执行');
      }
      const resp = await this.api.taskStart(task.request);
      if (!this.systemActive || this.currentTask?.id !== task.id) return;
      if (resp.success && resp.data) {
        task.backendTaskId = resp.data.task_id;
        const pendingCompletion = this.pendingTaskCompletions.get(task.backendTaskId);
        this.pendingTaskCompletions.clear();
        if (pendingCompletion) this.handleTaskCompletedMessage(pendingCompletion);
      } else {
        const reason = resp.error ?? '任务启动失败';
        this.currentTask = null;
        if (this.scheduleRetry(task, reason)) return;
        this.emitLog(
          'error',
          `任务「${task.name}」启动失败，重试已耗尽：${reason}`,
        );
        this.callbacks.onTaskCompleted?.(task.id, false, null, reason);
        this.callbacks.onLogicalTaskCompleted?.(
          task.logicalId,
          false,
          reason,
          false,
          'failed',
        );
        this.consumeNext();
      }
    } catch (e) {
      if (!this.systemActive || this.currentTask?.id !== task.id) return;
      const reason = String(e);
      this.currentTask = null;
      if (this.scheduleRetry(task, reason)) return;
      this.emitLog(
        'error',
        `任务「${task.name}」启动异常，重试已耗尽：${reason}`,
      );
      this.callbacks.onTaskCompleted?.(task.id, false, null, reason);
      this.callbacks.onLogicalTaskCompleted?.(
        task.logicalId,
        false,
        reason,
        false,
        'failed',
      );
      this.consumeNext();
    } finally {
      if (this.startingTaskId === task.id) {
        this.startingTaskId = null;
        this.pendingTaskCompletions.clear();
      }
    }
  }

  /**
   * 通用重试: 若未超过上限，5s 后重新入队并消费。
   * @returns true 表示已安排重试，调用方应 return；false 表示重试耗尽。
   */
  private scheduleRetry(task: SchedulerTask, reason: string): boolean {
    if (!this.systemActive) return false;
    if (task.retryCount >= task.maxRetries) return false;
    task.retryCount++;
    const retryHint = task.forceRetry ? '，强制重试' : '';
    this.emitLog('warn', `任务「${task.name}」${reason}，${task.retryCount}/${task.maxRetries} 次重试${retryHint} (5s 后)`);
    this.scheduleWaitingTask(
      task,
      5000,
      'retry',
      !!task.forceRetry || !task.allowPolling,
    );
    return true;
  }

  // ── 内部: 任务完成 & 后触发 ──

  private handleTaskCompletedMessage(msg: WsTaskCompleted): void {
    const current = this.currentTask;
    if (current?.backendTaskId === msg.task_id) {
      void this.handleTaskFinished(msg.task_id, msg.success, msg.result, msg.error);
      return;
    }
    if (current && this.startingTaskId === current.id) {
      this.pendingTaskCompletions.set(msg.task_id, msg);
    }
  }

  /** 任务完成后的后触发处理 */
  private async handleTaskFinished(
    taskId: string,
    success: boolean,
    result?: TaskResult | null,
    error?: string | null,
  ): Promise<void> {
    if (!this.systemActive) return;
    const finished = this.currentTask;
    if (!finished || finished.backendTaskId !== taskId) return;

    const stopReason = this.stopRequest?.taskId === finished.id
      ? this.stopRequest.reason
      : null;

    // 用户主动停止后保留原任务；停止条件命中则结束整个逻辑任务。
    if (stopReason === 'manual') {
      Logger.debug(`handleTaskFinished: confirmed manual stop for 「${finished.name}」`, 'scheduler');
      this.finishManualStop(finished);
      return;
    }
    if (stopReason === 'condition') {
      this.finishStopCondition(finished);
      return;
    }

    // 执行失败 → 尝试重试
    if (!success) {
      this.callbacks.onTaskCompleted?.(finished.id, false, result, error);
      this.currentTask = null;
      const terminalResult = getNonRetryableTaskResult(finished, result);
      if (terminalResult) {
        this.emitLog(
          'warn',
          `任务「${finished.name}」返回不可重试结果：${terminalResult}，逻辑任务已结束`,
        );
        this.callbacks.onLogicalTaskCompleted?.(
          finished.logicalId,
          false,
          error,
          false,
          'terminal',
        );
        this.consumeNext();
        return;
      }
      const reason = error ? `执行失败：${error}` : '执行失败';
      if (this.scheduleRetry(finished, reason)) return;
      this.emitLog(
        'error',
        `任务「${finished.name}」执行失败，重试已耗尽${error ? `：${error}` : ''}`,
      );
      // 重试耗尽时，将失败轮计入次数并继续剩余轮次
      const nextRemaining = finished.unlimited
        ? 1
        : finished.remainingTimes - 1;
      if (nextRemaining > 0) {
        const followUp = this.buildFollowUpTask(finished, nextRemaining);
        this._taskQueue.insertByPriority(followUp, !finished.allowPolling);
      } else {
        this.callbacks.onLogicalTaskCompleted?.(
          finished.logicalId,
          false,
          error,
          false,
          'failed',
        );
      }
      this.consumeNext();
      return;
    }

    const shouldCountRound = this.shouldCountAsCompletedRound(finished, result);
    if (!shouldCountRound) {
      const endpoints = this.getEndpointNodes(finished);
      if (endpoints.length > 0) {
        const resultHint = finished.endpointResult
          ? `或终点战果未达到 ${finished.endpointResult}`
          : '';
        this.emitLog(
          'info',
          `任务「${finished.name}」未到达终点节点 ${endpoints.join('/')}${resultHint}，本轮不计入次数`,
        );
      }
    }

    this.callbacks.onTaskCompleted?.(finished.id, true, result, error);

    const nextRemainingTimes = finished.unlimited
      ? 1
      : shouldCountRound
        ? finished.remainingTimes - 1
        : finished.remainingTimes;

    // 后触发: 若还有剩余次数，追加一个新任务回队列。
    // 注意: 未达到终点节点时，本轮不计数，remainingTimes 不减少。
    if (nextRemainingTimes > 0) {
      if (finished.stopCondition) {
        const shouldStop = await this.stopChecker.checkCondition(finished.stopCondition, finished.name);
        if (!this.systemActive || this.currentTask?.id !== finished.id) return;
        if (shouldStop) {
          this.emitLog('info', `任务「${finished.name}」满足停止条件，不再继续`);
          this.currentTask = null;
          this.callbacks.onLogicalTaskCompleted?.(
            finished.logicalId,
            true,
            null,
            false,
            'stop_condition',
          );
          this.consumeNext();
          return;
        }
      }

      const followUp: SchedulerTask = this.buildFollowUpTask(finished, nextRemainingTimes);
      Logger.debug(`followUp: 「${finished.name}」 remaining=${followUp.remainingTimes}/${followUp.totalTimes}`, 'scheduler');
      const gapSeconds = 'gap' in finished.request
        ? Math.max(0, Number(finished.request.gap) || 0)
        : 0;
      if (shouldCountRound && gapSeconds > 0) {
        this.scheduleFollowUpAfterGap(followUp, gapSeconds);
      } else {
        this._taskQueue.insertByPriority(followUp, !finished.allowPolling);
      }
    } else {
      this.callbacks.onLogicalTaskCompleted?.(
        finished.logicalId,
        true,
        null,
        shouldCountRound,
        'completed',
      );
    }

    this.currentTask = null;
    this.consumeNext();
  }

  private buildFollowUpTask(finished: SchedulerTask, remainingTimes: number): SchedulerTask {
    return createFollowUpTask(
      finished,
      remainingTimes,
      generateTaskId(),
    );
  }

  /** 按方案 gap 等待后再把下一轮放回队列。 */
  private scheduleFollowUpAfterGap(
    task: SchedulerTask,
    gapSeconds: number,
  ): void {
    this.emitLog(
      'info',
      `任务「${task.name}」将在 ${gapSeconds} 秒后开始下一轮`,
    );
    this.scheduleWaitingTask(
      task,
      gapSeconds * 1000,
      'gap',
      !task.allowPolling,
    );
  }

  /** 将任务保存为可见、可取消的等待项，时间到后再回到就绪队列。 */
  private scheduleWaitingTask(
    task: SchedulerTask,
    delayMs: number,
    reason: SchedulerWaitingTask['reason'],
    beforeSamePriority: boolean,
  ): void {
    this.removeWaitingTask(task.id);
    const readyAt = Date.now() + delayMs;
    const timer = setTimeout(() => {
      const entry = this.waitingTasks.get(task.id);
      if (!entry || entry.timer !== timer) return;
      this.waitingTasks.delete(task.id);
      if (!this.systemActive) return;
      this._taskQueue.insertByPriority(task, beforeSamePriority);
      this.notifyQueueChange();
      this.consumeNext();
    }, delayMs);
    this.waitingTasks.set(task.id, {
      task,
      reason,
      readyAt,
      timer,
    });
    if (!this.currentTask) this.setStatus('idle');
    this.notifyQueueChange();
  }

  /** 移除一个等待项并取消其定时器。 */
  private removeWaitingTask(taskId: string): SchedulerTask | null {
    const entry = this.waitingTasks.get(taskId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.waitingTasks.delete(taskId);
    return entry.task;
  }

  /** 取消全部轮次间隔和失败重试定时器。 */
  private clearWaitingTasks(): void {
    for (const entry of this.waitingTasks.values()) {
      clearTimeout(entry.timer);
    }
    this.waitingTasks.clear();
  }

  /**
   * 获取本轮认定完成的终点节点列表。
   * 优先使用 task.endpointNodes（用户在 plan 中显式配置），
   * 回退到 selected_nodes 的最后一个节点。
   */
  private getEndpointNodes(task: SchedulerTask): string[] {
    if (task.endpointNodes && task.endpointNodes.length > 0) {
      return task.endpointNodes.map(n => n.trim().toUpperCase());
    }
    // 回退：取 selected_nodes 最后一个
    if (task.type !== 'normal_fight' && task.type !== 'event_fight') return [];
    if (task.request.type !== 'normal_fight' && task.request.type !== 'event_fight') return [];
    const selectedNodes = task.request.plan?.selected_nodes;
    if (!selectedNodes || selectedNodes.length === 0) return [];
    const last = selectedNodes[selectedNodes.length - 1];
    if (typeof last !== 'string' || !last.trim()) return [];
    return [last.trim().toUpperCase()];
  }

  private shouldCountAsCompletedRound(task: SchedulerTask, result?: TaskResult | null): boolean {
    const endpoints = this.getEndpointNodes(task);
    if (endpoints.length === 0) return true;

    const details = result?.details;
    if (!details || details.length === 0) return !task.endpointResult;

    if (task.endpointResult) {
      return details.some((round) => this.roundMeetsEndpointResult(
        round,
        endpoints,
        task.endpointResult!,
      ));
    }

    // 失败轮次保持原有行为（计入次数），避免在异常场景下无限重跑。
    if (details.some((round) => !round.success)) return true;

    return details.some((round) => {
      if (!Array.isArray(round.nodes)) return false;
      return round.nodes.some((node) => {
        const normalized = String(node).trim().toUpperCase();
        return endpoints.includes(normalized);
      });
    });
  }

  /** 检查指定终点的战果是否达到用户要求。 */
  private roundMeetsEndpointResult(
    round: RoundResult,
    endpoints: string[],
    requiredResult: BattleResultGrade,
  ): boolean {
    const endpointFightEvents = (round.events ?? []).filter((event) => {
      const node = String(event.node ?? '').trim().toUpperCase();
      return (
        (event.type === 'RESULT' || event.type === 'FIGHT_RESULT')
        && endpoints.includes(node)
      );
    });

    if (endpointFightEvents.length > 0) {
      return endpointFightEvents.some((event) => this.resultMeetsRequirement(
        event.result,
        requiredResult,
      ));
    }

    // 兼容不返回 events 的旧后端：仅当最后经过的节点是终点时使用 round.grade。
    const lastNode = round.nodes?.[round.nodes.length - 1];
    if (!lastNode || !endpoints.includes(String(lastNode).trim().toUpperCase())) {
      return false;
    }
    return this.resultMeetsRequirement(round.grade, requiredResult);
  }

  private resultMeetsRequirement(
    actual: unknown,
    required: BattleResultGrade,
  ): boolean {
    if (typeof actual !== 'string') return false;
    const actualIndex = RESULT_GRADE_ORDER.indexOf(
      actual.trim().toUpperCase() as BattleResultGrade,
    );
    const requiredIndex = RESULT_GRADE_ORDER.indexOf(required);
    return actualIndex >= requiredIndex;
  }

  /** 任务执行中实时检查停止条件，满足则立即发送 taskStop */
  private checkAndStopRunningTask(cond: StopCondition): void {
    const runningTask = this.currentTask;
    if (!runningTask || this.stopRequest) return;
    if (!this.stopChecker.checkRunning(cond)) return;

    this.stopRequest = {
      taskId: runningTask.id,
      reason: 'condition',
    };
    this.setStatus('stopping');
    void this.stopForCondition(runningTask);
  }

  /** 请求停止满足条件的当前轮，并等待后端确认退出。 */
  private async stopForCondition(runningTask: SchedulerTask): Promise<void> {
    try {
      const response = await this.api.taskStop();
      if (
        this.currentTask?.id !== runningTask.id
        || this.stopRequest?.reason !== 'condition'
      ) {
        return;
      }
      if (!response.success) {
        throw new Error(response.error || '后端拒绝停止任务');
      }
    } catch (error) {
      if (this.currentTask?.id === runningTask.id) {
        this.stopRequest = null;
        this.setStatus('running');
        this.emitLog(
          'warn',
          `任务「${runningTask.name}」停止条件已满足，但停止失败: ${String(error)}`,
        );
      }
      return;
    }

    const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
    while (
      this.currentTask?.id === runningTask.id
      && this.stopRequest?.reason === 'condition'
    ) {
      try {
        const response = await this.api.taskStatus();
        if (
          response.success
          && response.data
          && response.data.status !== 'running'
        ) {
          this.finishStopCondition(runningTask);
          return;
        }
      } catch {
        // WebSocket 仍可能确认结束；轮询错误在超时前继续重试。
      }

      if (Date.now() >= deadline) {
        this.stopRequest = null;
        this.setStatus('running');
        this.emitLog(
          'warn',
          `任务「${runningTask.name}」停止条件已满足，但后端未确认停止`,
        );
        return;
      }
      await new Promise(resolve => {
        setTimeout(resolve, STOP_CONFIRM_POLL_INTERVAL_MS);
      });
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
        this.repairManager.getBathingShips(),
      );
      this.setStatus('idle');
    }
  }

  // ── 内部: 远征后处理 ──

  /**
   * 远征检查完成后的附加操作:
   * 1. 自动领取任务奖励
   * 2. 智能浴室维修（仅在无战斗任务时执行）
   */
  private async handlePostExpedition(): Promise<void> {
    try {
      const rewardResp = await this.api.rewardCollect();
      if (rewardResp.success) {
        this.emitLog('info', '任务奖励已自动领取');
      }
    } catch {
      this.emitLog('debug', '任务奖励领取跳过');
    }

    const hasCombatTask = this._taskQueue.items.some(t =>
      t.type === 'normal_fight' || t.type === 'event_fight'
        || t.type === 'campaign' || t.type === 'exercise' || t.type === 'decisive',
    );
    const currentIsCombat = this.currentTask
      && (this.currentTask.type === 'normal_fight' || this.currentTask.type === 'event_fight'
        || this.currentTask.type === 'campaign' || this.currentTask.type === 'exercise'
        || this.currentTask.type === 'decisive');
    if (hasCombatTask || currentIsCombat) return;

    try {
      const resp = await this.api.gameContext();
      if (!resp.success || !resp.data?.fleets) return;

      const shipsNeedRepair: string[] = [];
      for (const fleet of resp.data.fleets) {
        for (const ship of fleet.ships) {
          if (!ship || !ship.name) continue;
          if (ship.health < ship.max_health && ship.max_health > 0) {
            const key = toBackendName(ship.name);
            if (!this.repairManager.getBathingShips().has(key)) {
              shipsNeedRepair.push(ship.name);
            }
          }
        }
      }

      if (shipsNeedRepair.length > 0) {
        this.emitLog('info', `远征后自动送修: ${shipsNeedRepair.join('、')}`);
        await this.repairManager.sendToBath(shipsNeedRepair);
      }
    } catch {
      this.emitLog('debug', '远征后自动维修检查跳过');
    }
  }

  // ── 内部: 远征触发 ──

  /** 远征定时器回调 — 排到队首，等待当前单轮完整结束后执行。 */
  private handleExpeditionTrigger(): void {
    if (!this.systemActive || !this.autoExpedition) return;
    if (this.currentTask?.type === 'expedition') return;
    if (this._taskQueue.hasType('expedition')) return;

    const id = generateTaskId();
    const task: SchedulerTask = {
      id,
      logicalId: id,
      name: '远征检查',
      type: 'expedition',
      priority: TaskPriority.EXPEDITION,
      request: { type: 'expedition' },
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
        // Stop-condition counters are owned by processBackendLog (stdout).
        // The WebSocket carries the same backend lines and must not count them again.
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
        this.handleTaskCompletedMessage(msg);
      },

      onWsStatusChange: (connected) => {
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

  /** 判断同一父任务是否仍有运行、排队、延迟或等待中的物理任务。 */
  private hasLogicalTask(logicalId: string): boolean {
    if (this.currentTask?.logicalId === logicalId) return true;
    if (this._taskQueue.items.some(task => task.logicalId === logicalId)) {
      return true;
    }
    if (
      this._taskQueue.deferredItems.some(
        task => task.logicalId === logicalId,
      )
    ) {
      return true;
    }
    return [...this.waitingTasks.values()].some(
      entry => entry.task.logicalId === logicalId,
    );
  }

  private collectLogicalIds(
    tasks: ReadonlyArray<SchedulerTask>,
  ): Set<string> {
    return new Set(tasks.map(task => task.logicalId));
  }

  private emitLogicalCancellations(
    logicalIds: ReadonlySet<string>,
    reason: LogicalTaskCancelReason,
  ): void {
    for (const logicalId of logicalIds) {
      this.callbacks.onLogicalTaskCanceled?.(logicalId, reason);
    }
  }

  notifyQueueChange(): void {
    this.callbacks.onQueueChange?.(this._taskQueue.items);
  }
}
