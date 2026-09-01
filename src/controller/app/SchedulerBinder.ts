/** 绑定 Scheduler 与 CronScheduler 回调并协调任务生命周期。 */
import {
  CAMPAIGN_OUT_OF_TIMES_RESULT,
  TaskPriority,
  type CampaignDailyQuota,
  type CronScheduler,
  type LogicalTaskCancelReason,
  type NormalFightDailyQuota,
  type Scheduler,
  type SchedulerStatus,
} from '../../model/scheduler';
import type { ApiClient } from '../../model/ApiClient';
import type { ConfigModel } from '../../model/ConfigModel';
import type { TemplateModel } from '../../model/TemplateModel';
import type { NormalFightTaskConfig } from '../../types/model.js';
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
  readonly campaignDailyQuota: CampaignDailyQuota;
  readonly normalFightDailyQuota: NormalFightDailyQuota;
  renderMain(): void;
  refreshNormalFightRemaining(): void;
  updateOpsAvailability(connected: boolean): void;
  updateExpeditionTimer(text: string): void;
}

export class SchedulerBinder {
  private pendingExerciseTaskId: string | null = null;
  private pendingBattleTaskId: string | null = null;
  private pendingBattleConfig: {
    campaignName: string;
    target: number;
    remainingAtStart: number;
  } | null = null;
  private pendingBattleResult: string | null = null;
  private pendingDecisiveTaskId: string | null = null;
  private pendingDecisiveResult: string | null = null;
  private pendingLootTaskId: string | null = null;
  private pendingNormalFightTaskIds = new Set<string>();
  private pendingNormalFightConfigs =
    new Map<string, NormalFightTaskConfig>();

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

  /** 在 Renderer 卸载时释放运行状态监听。 */
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

      onTaskCompleted: (taskId, success, result, _error) => {
        const runningTask = this.host.scheduler.currentRunningTask;
        if (
          runningTask?.id === taskId
          && runningTask.logicalId === this.pendingBattleTaskId
          && runningTask.type === 'campaign'
        ) {
          const details = result?.details ?? [];
          this.pendingBattleResult = details.some(
            detail => detail.result === CAMPAIGN_OUT_OF_TIMES_RESULT,
          )
            ? CAMPAIGN_OUT_OF_TIMES_RESULT
            : (details[details.length - 1]?.result ?? null);
          if (
            success
            && (result?.success_runs ?? 0) > 0
            && this.pendingBattleConfig
          ) {
            const remaining = this.host.campaignDailyQuota.markCompleted(
              this.pendingBattleConfig.campaignName,
              this.pendingBattleConfig.target,
            );
            Logger.info(
              `自动战役今日正常结算 1 次，剩余 ${remaining} 次`,
            );
          }
        }
        if (
          runningTask?.id === taskId
          && runningTask.logicalId === this.pendingDecisiveTaskId
          && runningTask.type === 'decisive'
        ) {
          const details = result?.details ?? [];
          const decisiveResult = details[details.length - 1]?.result;
          this.pendingDecisiveResult =
            typeof decisiveResult === 'string'
              ? decisiveResult
              : (success ? null : 'error');
        }
        this.runtime.reset();
        this.host.renderMain();
      },

      onLogicalTaskCompleted: (
        logicalId,
        success,
        _error,
        countedRound,
        completionReason,
      ) => {
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
          const config = this.pendingBattleConfig;
          const remaining = config
            ? this.host.campaignDailyQuota.remaining(
                config.campaignName,
                config.target,
              )
            : 0;
          if (remaining === 0) {
            this.host.cronScheduler.markBattleHandled();
          } else if (
            this.pendingBattleResult === CAMPAIGN_OUT_OF_TIMES_RESULT
          ) {
            const completed = config
              ? Math.max(0, config.target - remaining)
              : 0;
            Logger.warn(
              `自动战役次数已用完，今日正常结算 ${completed}/${config?.target ?? 0} 次，剩余游戏次数 0`,
            );
            this.host.cronScheduler.markBattleHandled();
          } else if (
            config
            && remaining < config.remainingAtStart
          ) {
            Logger.warn(
              `自动战役本批已有正常结算记录，今日仍缺少 ${remaining} 次，将在下次检查时补跑`,
            );
            this.host.cronScheduler.clearBattlePending();
          } else {
            Logger.warn(
              '自动战役本批未正常结算，单轮重试已耗尽，今日停止补跑',
            );
            this.host.cronScheduler.markBattleHandled();
          }
          this.pendingBattleTaskId = null;
          this.pendingBattleConfig = null;
          this.pendingBattleResult = null;
        }
        if (logicalId === this.pendingDecisiveTaskId) {
          if (
            this.pendingDecisiveResult === 'chapter_clear'
            || this.pendingDecisiveResult === 'leave'
          ) {
            this.host.cronScheduler.markDecisiveHandled();
          } else {
            Logger.warn('自动决战未正常结束，单轮重试已耗尽，今日停止补跑');
            this.host.cronScheduler.markDecisiveHandled();
          }
          this.pendingDecisiveTaskId = null;
          this.pendingDecisiveResult = null;
        }
        if (logicalId === this.pendingLootTaskId) {
          if (completionReason === 'stop_condition') {
            this.host.cronScheduler.markLootHandled();
          } else {
            Logger.warn(
              '自动战利品本批未达到停止数量，已到达批次或重试上限，今日停止补跑',
            );
            this.host.cronScheduler.markLootHandled();
          }
          this.pendingLootTaskId = null;
        }
        const normalFightConfig =
          this.pendingNormalFightConfigs.get(logicalId);
        this.pendingNormalFightConfigs.delete(logicalId);
        if (this.pendingNormalFightTaskIds.delete(logicalId)) {
          if (success && countedRound === true && normalFightConfig) {
            const remaining = this.host.normalFightDailyQuota
              .markCompleted(normalFightConfig);
            Logger.info(
              `自动出征今日有效完成 1 次，当前计划剩余 ${remaining} 次`,
            );
            this.host.refreshNormalFightRemaining();
          }
          if (this.pendingNormalFightTaskIds.size === 0) {
            this.host.cronScheduler.markNormalFightHandled();
          }
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
      this.pendingBattleConfig = null;
      this.pendingBattleResult = null;
    }
    if (logicalId === this.pendingDecisiveTaskId) {
      if (allowRetry) {
        this.host.cronScheduler.clearDecisivePending();
      } else {
        this.host.cronScheduler.markDecisiveHandled();
      }
      this.pendingDecisiveTaskId = null;
      this.pendingDecisiveResult = null;
    }
    if (logicalId === this.pendingLootTaskId) {
      if (allowRetry) {
        this.host.cronScheduler.clearLootPending();
      } else {
        this.host.cronScheduler.markLootHandled();
      }
      this.pendingLootTaskId = null;
    }
    this.pendingNormalFightConfigs.delete(logicalId);
    if (this.pendingNormalFightTaskIds.delete(logicalId)) {
      if (this.pendingNormalFightTaskIds.size !== 0) return;
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
        const remaining = this.host.campaignDailyQuota.remaining(
          campaignName,
          times,
        );
        if (remaining === 0) {
          this.host.cronScheduler.markBattleHandled();
          return;
        }
        const id = this.host.scheduler.addTask(
          `自动战役·${campaignName}`,
          'campaign',
          { type: 'campaign', campaign_name: campaignName, times: 1 },
          TaskPriority.DAILY,
          remaining,
        );
        this.pendingBattleTaskId = id;
        this.pendingBattleConfig = {
          campaignName,
          target: times,
          remainingAtStart: remaining,
        };
        this.pendingBattleResult = null;
        Logger.info(
          `自动战役已加入队列 (${campaignName}，剩余结算 ${remaining} 次)`,
        );
        this.host.scheduler.startConsuming();
      },

      onScheduledTaskDue: (taskKey) => {
        Logger.info(`定时任务「${taskKey}」已触发`);
      },

      onLootDue: (source, planId, stopCount) => {
        void this.enqueueLootTask(source, planId, stopCount);
      },

      canStartNormalFight: () => {
        const tasks = this.host.configModel.current
          .daily_automation
          .normal_fight_tasks;
        const hasRemaining = this.host.normalFightDailyQuota.hasRemaining(
          tasks,
        );
        const completelyIdle = this.host.scheduler.isCompletelyIdle;
        this.host.refreshNormalFightRemaining();
        return completelyIdle && hasRemaining;
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
    try {
      const result = await this.taskLoader.loadNormalFightTasks();
      if (result.status === 'handled') {
        this.host.cronScheduler.markNormalFightHandled();
        return;
      }
      if (result.status === 'retry') {
        this.host.cronScheduler.clearNormalFightPending();
        return;
      }
      for (const task of result.tasks) {
        this.pendingNormalFightTaskIds.add(task.taskId);
        this.pendingNormalFightConfigs.set(
          task.taskId,
          structuredClone(task.config),
        );
      }
      this.host.scheduler.startConsuming();
    } catch (error) {
      Logger.error(
        `自动出征加载失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.host.cronScheduler.clearNormalFightPending();
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
