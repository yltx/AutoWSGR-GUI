/** 把调度器和游戏状态转换为主页面 ViewObject。 */
import type {
  CurrentFleetShipVO,
  MainViewObject,
  TaskQueueItemVO,
} from '../../types/view.js';
import type { Scheduler } from '../../model/scheduler';
import type { DailySortieStatsSnapshot } from '../../types/statistics.js';
import { PRIORITY_LABELS, STATUS_TEXT } from './constants';

export interface RenderingState {
  readonly scheduler: Scheduler;
  currentFleet: CurrentFleetShipVO[];
  currentProgress: string;
  trackedLoot: string;
  trackedShip: string;
  dailySortieStats: DailySortieStatsSnapshot;
  wsConnected: boolean;
  expeditionTimerText: string;
}

/** 根据日志中解析到的后端 OCR 数据构建资源文本 */
export function buildAcquisitionText(trackedLoot: string, trackedShip: string): string | undefined {
  const parts: string[] = [];
  if (trackedLoot) parts.push(`装备 ${trackedLoot}`);
  if (trackedShip) parts.push(`舰船 ${trackedShip}`);
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/** 从调度器状态 + 追踪数据拼装 MainViewObject */
export function buildMainViewObject(state: RenderingState): MainViewObject {
  const {
    scheduler,
    currentFleet,
    currentProgress,
    trackedLoot,
    trackedShip,
    dailySortieStats,
    wsConnected,
    expeditionTimerText,
  } = state;
  const running = scheduler.currentRunningTask;
  const queue = scheduler.taskQueue;
  const statusText = scheduler.status === 'idle' && queue.length > 0
    ? '队列已暂停'
    : (STATUS_TEXT[scheduler.status] ?? '未知');

  const taskQueueVo: TaskQueueItemVO[] = [];

  if (running) {
    let progressPercent = 0;
    if (currentProgress) {
      const parts = currentProgress.split('/');
      if (parts.length === 2) {
        const cur = parseInt(parts[0], 10);
        const total = parseInt(parts[1], 10);
        if (total > 0) progressPercent = cur / total;
      }
    }
    taskQueueVo.push({
      id: running.id,
      name: running.name,
      priorityLabel: PRIORITY_LABELS[running.priority] ?? '用户',
      remaining: running.remainingTimes,
      totalTimes: running.totalTimes,
      unlimited: running.unlimited,
      progress: currentProgress || undefined,
      progressPercent,
      acquisitionText: buildAcquisitionText(trackedLoot, trackedShip),
    });
  }

  for (const t of queue) {
    taskQueueVo.push({
      id: t.id,
      name: t.name,
      priorityLabel: PRIORITY_LABELS[t.priority] ?? '用户',
      remaining: t.remainingTimes,
      totalTimes: t.totalTimes,
      unlimited: t.unlimited,
    });
  }

  for (const waiting of scheduler.waitingTaskList) {
    const t = waiting.task;
    taskQueueVo.push({
      id: t.id,
      name: t.name,
      priorityLabel: PRIORITY_LABELS[t.priority] ?? '用户',
      remaining: t.remainingTimes,
      totalTimes: t.totalTimes,
      unlimited: t.unlimited,
      waiting: true,
      waitingText: waiting.reason === 'gap'
        ? '等待下一轮'
        : '等待重试',
    });
  }

  return {
    status: scheduler.status === 'not_connected' ? 'not_connected' : scheduler.status,
    statusText,
    currentTask: running
      ? {
          name: running.name,
          type: running.type as MainViewObject['currentTask'] extends null ? never : NonNullable<MainViewObject['currentTask']>['type'],
          progress: currentProgress || '0/0',
          startedAt: '',
        }
      : null,
    currentFleet,
    dailySortieStats,
    expeditionTimer: expeditionTimerText,
    taskQueue: taskQueueVo,
    wsConnected,
    runningTaskId: running?.id ?? null,
  };
}
