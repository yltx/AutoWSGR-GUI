/** 提供任务完成、重试、轮询和后续任务构造的纯规则。 */
/** Pure scheduler task construction and queue ordering policies. */
import type { TaskRequest, TaskResult } from '../../types/api.js';
import type {
  StopCondition,
  BathRepairConfig,
  FleetPreset,
  BattleResultGrade,
} from '../../types/model.js';
import { TaskPriority, type SchedulerTaskType, type SchedulerTask } from '../../types/scheduler';

export const CAMPAIGN_OUT_OF_TIMES_RESULT = 'out of times';

export function getNonRetryableTaskResult(
  task: Pick<SchedulerTask, 'type'>,
  result?: TaskResult | null,
): string | null {
  if (task.type !== 'campaign') return null;
  return result?.details.some(
    detail => detail.result === CAMPAIGN_OUT_OF_TIMES_RESULT,
  )
    ? CAMPAIGN_OUT_OF_TIMES_RESULT
    : null;
}

export function findPriorityInsertionIndex(
  queue: ReadonlyArray<SchedulerTask>,
  task: SchedulerTask,
  beforeSamePriority = false,
): number {
  return queue.findIndex((current) => {
    if (current.priority < task.priority) return false;
    if (current.priority > task.priority) return true;
    const currentKey = current.sortKey ?? Infinity;
    const taskKey = task.sortKey ?? Infinity;
    return beforeSamePriority ? currentKey >= taskKey : currentKey > taskKey;
  });
}

export interface SchedulerTaskOptions {
  name: string;
  type: SchedulerTaskType;
  request: TaskRequest;
  priority?: TaskPriority;
  times?: number;
  stopCondition?: StopCondition;
  bathRepairConfig?: BathRepairConfig;
  fleetId?: number;
  fleetPresets?: FleetPreset[];
  currentPresetIndex?: number;
  forceRetry?: boolean;
  allowPolling?: boolean;
  endpointNodes?: string[];
  endpointResult?: BattleResultGrade;
  sortKey?: number;
  id: string;
}

export function createSchedulerTask(options: SchedulerTaskOptions): SchedulerTask {
  const times = options.times ?? 1;
  const unlimited = !Number.isFinite(times);
  const normalizedTimes = unlimited ? 1 : Math.max(1, Math.trunc(times));
  return {
    id: options.id,
    logicalId: options.id,
    name: options.name,
    type: options.type,
    priority: options.priority ?? TaskPriority.USER_TASK,
    request: options.request,
    remainingTimes: normalizedTimes,
    totalTimes: normalizedTimes,
    unlimited,
    stopCondition: options.stopCondition,
    maxRetries: 2,
    retryCount: 0,
    forceRetry: options.forceRetry,
    allowPolling: !!options.allowPolling,
    bathRepairConfig: options.bathRepairConfig,
    fleetId: options.fleetId,
    fleetPresets: options.fleetPresets,
    currentPresetIndex: options.currentPresetIndex ?? -1,
    endpointNodes: options.endpointNodes,
    endpointResult: options.endpointResult,
    sortKey: options.sortKey,
  };
}

export function buildFollowUpTask(task: SchedulerTask, remainingTimes: number, id: string): SchedulerTask {
  return {
    id,
    logicalId: task.logicalId,
    name: task.name,
    type: task.type,
    priority: task.priority,
    request: task.request,
    remainingTimes,
    totalTimes: task.totalTimes,
    unlimited: task.unlimited,
    stopCondition: task.stopCondition,
    maxRetries: task.maxRetries,
    retryCount: 0,
    forceRetry: task.forceRetry,
    allowPolling: task.allowPolling,
    bathRepairConfig: task.bathRepairConfig,
    fleetId: task.fleetId,
    fleetPresets: task.fleetPresets,
    currentPresetIndex: task.currentPresetIndex,
    endpointNodes: task.endpointNodes,
    endpointResult: task.endpointResult,
    sortKey: task.sortKey,
  };
}
