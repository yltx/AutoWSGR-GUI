/** 唯一持有就绪与延迟队列，并实现优先级和轮询排序。 */
/**
 * TaskQueue —— 优先级任务队列 + 延迟任务管理。
 * 从 Scheduler.ts 拆出，封装队列数据结构及相关操作。
 */
import type { TaskRequest } from '../../types/api.js';
import type {
  StopCondition,
  BathRepairConfig,
  FleetPreset,
  BattleResultGrade,
} from '../../types/model.js';
import type { BathingShip } from './RepairManager';
import { TaskPriority, type SchedulerTaskType, type SchedulerTask } from '../../types/scheduler';
import { toBackendName } from '../../shared/shipNameNormalizer.js';
import {
  resolveFleetPreset,
  resolveFleetPresetRules,
} from '../fleet/index.js';
import { calculateRepairWaitMs } from './SchedulerRepairPolicy.js';
import { createSchedulerTask, findPriorityInsertionIndex } from './SchedulerTaskPolicy.js';

// ════════════════════════════════════════
// ID 生成 & 辅助函数
// ════════════════════════════════════════

let nextTaskId = 1;

export function generateTaskId(): string {
  return `sched_${nextTaskId++}`;
}

/** 从 "[UI] 战利品数量: 50/50" 格式中提取当前值 */
export function parseUiCount(msg: string, label: string): number | null {
  const re = new RegExp(`\\[UI\\] ${label}[:：]\\s*(\\d+)`);
  const m = msg.match(re);
  return m ? parseInt(m[1], 10) : null;
}

// ════════════════════════════════════════
// TaskQueue 实现
// ════════════════════════════════════════

export class TaskQueue {
  private queue: SchedulerTask[] = [];
  /** 因舰船修理被延迟的任务列表 */
  private deferredTasks: SchedulerTask[] = [];
  /** 延迟任务重试定时器 */
  private deferredRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getShipNameAliases:
      () => Readonly<Record<string, string>> = () => ({}),
  ) {}

  // ── 队列读取 ──

  get items(): ReadonlyArray<SchedulerTask> {
    return this.queue;
  }

  get length(): number {
    return this.queue.length;
  }

  get deferredItems(): ReadonlyArray<SchedulerTask> {
    return this.deferredTasks;
  }

  get hasDeferredTasks(): boolean {
    return this.deferredTasks.length > 0;
  }

  /** 从队首取出一个任务 */
  shift(): SchedulerTask | undefined {
    return this.queue.shift();
  }

  /** 检查队列中是否存在指定类型的任务 */
  hasType(type: SchedulerTaskType): boolean {
    return this.queue.some(t => t.type === type);
  }

  // ── 队列写入 ──

  /**
   * 按优先级插入队列。
   * 同优先级内按 sortKey 升序排列（sortKey 越小越靠前）。
   * beforeSamePriority=true 时，会插入到同优先级任务之前（用于重试/跟随）。
   */
  insertByPriority(task: SchedulerTask, beforeSamePriority = false): void {
    const idx = findPriorityInsertionIndex(this.queue, task, beforeSamePriority);
    if (idx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(idx, 0, task);
    }
  }

  /** 创建任务并按优先级入队，返回任务 ID */
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
    const id = generateTaskId();
    const task = createSchedulerTask({
      id,
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
    });
    this.insertByPriority(task);
    return id;
  }

  /** 查找就绪或修理延迟中的任务。 */
  findTask(taskId: string): SchedulerTask | null {
    return this.queue.find(task => task.id === taskId)
      ?? this.deferredTasks.find(task => task.id === taskId)
      ?? null;
  }

  /** 移除就绪或修理延迟中的任务，并返回被移除的任务。 */
  removeTask(taskId: string): SchedulerTask | null {
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      return this.queue.splice(idx, 1)[0];
    }

    const deferredIdx = this.deferredTasks.findIndex(
      task => task.id === taskId,
    );
    if (deferredIdx === -1) return null;
    return this.deferredTasks.splice(deferredIdx, 1)[0];
  }

  /** 移动队列中的任务顺序 */
  moveTask(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.queue.length) return;
    if (toIndex < 0 || toIndex >= this.queue.length) return;
    if (fromIndex === toIndex) return;
    const [task] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, task);
  }

  /** 清空队列和延迟任务 */
  clear(): void {
    this.queue = [];
    this.deferredTasks = [];
    if (this.deferredRetryTimer) {
      clearTimeout(this.deferredRetryTimer);
      this.deferredRetryTimer = null;
    }
  }

  // ── 延迟任务管理 ──

  /** 将任务放入延迟列表，不消耗 remainingTimes */
  deferTask(task: SchedulerTask): void {
    this.deferredTasks.push(task);
  }

  /**
   * 动态延迟后重新尝试延迟任务。
   * @param onRetry 延迟到期后的回调，调用方负责将延迟任务重新入队并消费。
   * @param emitLog 日志回调
   * @param bathingShips 泡澡中舰船列表（用于计算动态等待时间）
   */
  scheduleDeferredRetry(
    onRetry: () => void,
    emitLog: (level: string, msg: string) => void,
    bathingShips?: ReadonlyMap<string, BathingShip>,
  ): void {
    if (this.deferredRetryTimer) return;

    const waitMs = calculateRepairWaitMs(bathingShips);

    if (waitMs <= 0) {
      emitLog('info', '维修时间未知，30 秒后重试...');
      this.deferredRetryTimer = setTimeout(() => {
        this.deferredRetryTimer = null;
        this.retryDeferredTasks(emitLog);
        onRetry();
      }, 30_000);
    } else {
      const waitSeconds = Math.ceil(waitMs / 1000);
      emitLog('info', `预计 ${waitSeconds} 秒后维修完成，等待中...`);
      this.deferredRetryTimer = setTimeout(() => {
        this.deferredRetryTimer = null;
        this.retryDeferredTasks(emitLog);
        onRetry();
      }, waitMs);
    }
  }

  /** 重新尝试延迟的任务：将全部延迟项按优先级插回主队列 */
  private retryDeferredTasks(emitLog: (level: string, msg: string) => void): void {
    if (this.deferredTasks.length === 0) return;
    for (const task of this.deferredTasks) {
      this.insertByPriority(task);
    }
    this.deferredTasks = [];
    emitLog('info', '延迟任务已重新加入队列，尝试执行');
  }

  /** 清理延迟任务定时器 */
  clearDeferredTimer(): void {
    if (this.deferredRetryTimer) {
      clearTimeout(this.deferredRetryTimer);
      this.deferredRetryTimer = null;
    }
  }

  // ── 编队预设切换 ──

  /** 切换任务使用的编队预设（修改 request 中的 fleet 舰船列表） */
  switchTaskPreset(task: SchedulerTask, presetIndex: number): void {
    const preset = task.fleetPresets?.[presetIndex];
    if (!preset) return;
    task.currentPresetIndex = presetIndex;

    const req = task.request;
    if (req.type === 'normal_fight' || req.type === 'event_fight') {
      const resolved = resolveFleetPreset(preset.ships);
      const fleet = resolved.map(toBackendName);
      const fleetRules = resolveFleetPresetRules(
        preset.ships,
        this.getShipNameAliases(),
      );
      if (req.plan) {
        if (fleet.length > 0) req.plan.fleet = fleet;
        if (fleetRules.length > 0) req.plan.fleet_rules = fleetRules;
        req.plan.fleet_id = task.fleetId;
      } else {
        req.plan = {
          ...(fleet.length > 0 ? { fleet } : {}),
          ...(fleetRules.length > 0 ? { fleet_rules: fleetRules } : {}),
          fleet_id: task.fleetId,
        };
      }
      if (req.type === 'event_fight') req.fleet_id = task.fleetId;
    }
  }
}
