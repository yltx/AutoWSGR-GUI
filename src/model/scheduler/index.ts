/** 导出调度器、任务队列、定时器和修理管理器公共接口。 */
/**
 * scheduler/ 模块入口 —— barrel re-export。
 * 外部统一从 '../model/scheduler' 导入，不需要关心内部拆分细节。
 */
export { Scheduler } from './Scheduler';
export * from './SchedulerTaskPolicy';
export * from './SchedulerRepairPolicy';
export { CronScheduler } from './CronScheduler';
export type { CronConfig, CronCallbacks, ScheduledTask } from './CronScheduler';
export { CampaignDailyQuota } from './CampaignDailyQuota';
export {
  DEFAULT_NORMAL_FIGHT_DAILY_EXECUTIONS,
  MAX_NORMAL_FIGHT_DAILY_EXECUTIONS,
  NormalFightDailyQuota,
  normalFightDailyLimit,
  normalFightTaskKey,
  uniqueNormalFightTasks,
} from './NormalFightDailyQuota';

// 类型 re-export（来自 types/scheduler.ts）
export {
  TaskPriority,
  type SchedulerTaskType,
  type SchedulerTask,
  type SchedulerStatus,
  type SchedulerCallbacks,
  type LogicalTaskCancelReason,
  type LogicalTaskCompletionReason,
  type SchedulerWaitingTask,
} from '../../types/scheduler';
