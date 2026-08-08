/** 维护任务优先级和状态文案等界面常量。 */
import { TaskPriority } from '../../model/scheduler';

/** 优先级 → 中文标签 */
export const PRIORITY_LABELS: Record<number, string> = {
  [TaskPriority.EXPEDITION]: '远征',
  [TaskPriority.USER_TASK]: '用户',
  [TaskPriority.DAILY]: '日常',
};

/** 调度器状态 → 中文文案 */
export const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  stopping: '正在停止…',
  not_connected: '未连接',
};
