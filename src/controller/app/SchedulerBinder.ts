/** 绑定 Scheduler 与 CronScheduler 回调并协调任务生命周期。 */
import {
  TaskPriority,
  type CronScheduler,
  type LogicalTaskCancelReason,
  type Scheduler,
  type SchedulerStatus,
} from '../../model/scheduler';
import type { ApiClient } from '../../model/ApiClient';
import type { ConfigModel } from '../../model/ConfigModel';
import type { TemplateModel } from '../../model/TemplateModel';
import {
  type LootPlanSource,
} from '../../shared/lootPlans.js';
import {
  type DecisiveAutomationSource,
} from '../../shared/decisiveAutomation.js';
import { Logger } from '../../utils/Logger';
import {
  ScheduledTaskLoader,
} from './ScheduledTaskLoader';
import {
  SchedulerRuntimeTracker,
  type SchedulerRuntimeSnapshot,
} from './SchedulerRuntimeTracker';

export interface SchedulerBinderHost {
  readonly scheduler: Scheduler;
  readonly cronScheduler: CronScheduler;
  readonly api: ApiClient;
  readonly templateModel: TemplateModel;
  readonly configModel: ConfigModel;
  renderMain(): void;
  updateOpsAvailability(connected: boolean): void;
  updateExpeditionTimer(text: string): void;
}

export class SchedulerBinder {
  private pendingExerciseTaskId: string | null = null;
  private pendingBattleTaskId: string | null = null;
  private pendingDecisiveTaskId: string | null = null;
  private pendingLootTaskId: string | null = null;
  private pendingNormalFightTaskIds = new Set<string>();

  constructor(
    private readonly host: SchedulerBinderHost,
    private readonly runtime = new SchedulerRuntimeTracker(
      host.scheduler,
      host.renderMain,
    ),
    private readonly taskLoader = new ScheduledTaskLoader(host),
  ) {}

  get runtimeState(): SchedulerRuntimeSnapshot {
    return this.runtime.snapshot;
  }

  resetRuntimeState(): void {
    this.runtime.reset();
  }

  /**
   * 解绑运行状态监听。
   * 当前没有生产调用方，保留为正式生命周期清理接口。
   */
  dispose(): void {
    this.runtime.dispose();
  }

  /** 绑定 Scheduler 回调 */
  bindSchedulerCallbacks(): void {
    this.host.scheduler.setCallbacks({
      onStatusChange: (_status: SchedulerStatus) => {
        this.host.renderMain();
      },

      onProgressUpdate: (_taskId, progress) => {
        this.runtime.updateProgress(
          progress.current,
          progress.total,
        );
        this.host.renderMain();
      },

      onTaskCompleted: (_taskId, _success, _result, _error) => {
        this.runtime.reset();
        this.host.renderMain();
      },

      onLogicalTaskCompleted: (logicalId, success) => {
        this.runtime.reset();
        if (logicalId === this.pendingExerciseTaskId) {
          if (success) {
            this.host.cronScheduler.markExerciseCompleted();
          } else {
            this.host.cronScheduler.clearExercisePending();
          }
          this.pendingExerciseTaskId = null;
        }
        if (logicalId === this.pendingBattleTaskId) {
          this.host.cronScheduler.markBattleHandled();
          this.pendingBattleTaskId = null;
        }
        if (logicalId === this.pendingDecisiveTaskId) {
          this.host.cronScheduler.markDecisiveHandled();
          this.pendingDecisiveTaskId = null;
        }
        if (logicalId === this.pendingLootTaskId) {
          this.host.cronScheduler.markLootHandled();
          this.pendingLootTaskId = null;
        }
        if (this.pendingNormalFightTaskIds.delete(logicalId)
          && this.pendingNormalFightTaskIds.size === 0) {
          this.host.cronScheduler.markNormalFightHandled();
        }
        this.host.renderMain();
      },

      onLogicalTaskCanceled: (logicalId, reason) => {
        if (!this.host.scheduler.currentRunningTask) {
          this.runtime.reset();
        }
        this.handleLogicalTaskCanceled(logicalId, reason);
        this.host.renderMain();
      },

      onLog: (msg) => {
        const changed = this.runtime.consume(msg.message);
        if (changed) this.host.renderMain();
        Logger.logLevel(msg.level.toLowerCase(), msg.message, msg.channel);
      },

      onQueueChange: () => {
        this.host.renderMain();
      },

      onConnectionChange: (connected) => {
        this.runtime.setConnection(connected);
        this.host.updateOpsAvailability(connected);
        if (connected) {
          this.host.api.health().then(res => {
            if (res.success && res.data) {
              const uptime = Math.floor(res.data.uptime_seconds);
              Logger.debug(`后端健康检查: 运行 ${uptime}s, 模拟器${res.data.emulator_connected ? '已连接' : '未连接'}`);
            }
          }).catch(() => {});
        }
        this.host.renderMain();
      },

      onExpeditionTimerTick: (seconds) => {
        this.host.updateExpeditionTimer(
          this.runtime.updateExpeditionTimer(seconds),
        );
      },
    });
  }

  /**
   * 同步被取消的父任务。
   * 用户删除或清空表示本时段主动放弃；系统停止则只释放 pending，
   * 允许下次启动后重新触发。
   */
  private handleLogicalTaskCanceled(
    logicalId: string,
    reason: LogicalTaskCancelReason,
  ): void {
    const allowRetry = reason === 'system_stopped';

    if (logicalId === this.pendingExerciseTaskId) {
      if (allowRetry) {
        this.host.cronScheduler.clearExercisePending();
      } else {
        this.host.cronScheduler.markExerciseHandled();
      }
      this.pendingExerciseTaskId = null;
    }
    if (logicalId === this.pendingBattleTaskId) {
      if (allowRetry) {
        this.host.cronScheduler.clearBattlePending();
      } else {
        this.host.cronScheduler.markBattleHandled();
      }
      this.pendingBattleTaskId = null;
    }
    if (logicalId === this.pendingDecisiveTaskId) {
      if (allowRetry) {
        this.host.cronScheduler.clearDecisivePending();
      } else {
        this.host.cronScheduler.markDecisiveHandled();
      }
      this.pendingDecisiveTaskId = null;
    }
    if (logicalId === this.pendingLootTaskId) {
      if (allowRetry) {
        this.host.cronScheduler.clearLootPending();
      } else {
        this.host.cronScheduler.markLootHandled();
      }
      this.pendingLootTaskId = null;
    }
    if (
      this.pendingNormalFightTaskIds.delete(logicalId)
      && this.pendingNormalFightTaskIds.size === 0
    ) {
      if (allowRetry) {
        this.host.cronScheduler.clearNormalFightPending();
      } else {
        this.host.cronScheduler.markNormalFightHandled();
      }
    }
  }

  /** 处理后端 stdout 日志，作为 WebSocket 日志的进度兜底。 */
  handleBackendRuntimeLog(message: string): void {
    if (this.runtime.consume(message)) {
      this.host.renderMain();
    }
  }

  /** 绑定定时调度器回调 */
  bindCronCallbacks(): void {
    this.host.cronScheduler.setCallbacks({
      onExerciseDue: (fleetId) => {
        const id = this.host.scheduler.addTask(
          '自动演习',
          'exercise',
          { type: 'exercise', fleet_id: fleetId },
          TaskPriority.DAILY,
          1,
        );
        this.pendingExerciseTaskId = id;
        Logger.info(`自动演习已加入队列 (舰队 ${fleetId})`);
        this.host.scheduler.startConsuming();
      },

      onCampaignDue: (campaignName, times) => {
        const id = this.host.scheduler.addTask(
          `自动战役·${campaignName}`,
          'campaign',
          { type: 'campaign', campaign_name: campaignName, times: 1 },
          TaskPriority.DAILY,
          times,
        );
        this.pendingBattleTaskId = id;
        Logger.info(`自动战役已加入队列 (${campaignName} ×${times})`);
        this.host.scheduler.startConsuming();
      },

      onScheduledTaskDue: (taskKey) => {
        Logger.info(`定时任务「${taskKey}」已触发`);
      },

      onLootDue: (source, planId, stopCount) => {
        void this.enqueueLootTask(source, planId, stopCount);
      },

      onNormalFightDue: () => {
        void this.enqueueNormalFightTasks();
      },

      onDecisiveDue: (source) => {
        void this.enqueueDecisiveTask(source);
      },

      onLog: (level, message) => {
        Logger.logLevel(level, message);
      },
    });
  }

  private async enqueueDecisiveTask(
    source: DecisiveAutomationSource,
  ): Promise<void> {
    try {
      this.pendingDecisiveTaskId = await this.taskLoader
        .loadDecisiveTask(source);
    } catch (error) {
      Logger.error(
        `自动决战加载失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.host.cronScheduler.clearDecisivePending();
    }
  }

  private async enqueueNormalFightTasks(): Promise<void> {
    const result = await this.taskLoader.loadNormalFightTasks();
    if (result.status === 'handled') {
      this.host.cronScheduler.markNormalFightHandled();
      return;
    }
    if (result.status === 'retry') {
      this.host.cronScheduler.clearNormalFightPending();
      return;
    }
    for (const taskId of result.taskIds) {
      this.pendingNormalFightTaskIds.add(taskId);
    }
  }

  private async enqueueLootTask(
    source: LootPlanSource,
    planId: string,
    stopCount: number,
  ): Promise<void> {
    try {
      const taskId = await this.taskLoader.loadLootTask(
        source,
        planId,
        stopCount,
      );
      if (taskId) {
        this.pendingLootTaskId = taskId;
        return;
      }
      this.host.cronScheduler.clearLootPending();
    } catch (error) {
      Logger.error(
        `自动战利品加载失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.host.cronScheduler.clearLootPending();
    }
  }
}
