/**
 * SchedulerBinder —— 调度器回调绑定子控制器。
 * 封装 Scheduler / CronScheduler 的回调绑定逻辑 + 关联的可变状态。
 */
import { TaskPriority, type Scheduler, type SchedulerStatus, type CronScheduler } from '../../model/scheduler';
import type { ApiClient } from '../../model/ApiClient';
import type { TemplateModel } from '../../model/TemplateModel';
import { PlanModel } from '../../model/PlanModel';
import type { NormalFightReq } from '../../types/api';
import { Logger } from '../../utils/Logger';

export interface SchedulerBinderHost {
  readonly scheduler: Scheduler;
  readonly cronScheduler: CronScheduler;
  readonly api: ApiClient;
  readonly templateModel: TemplateModel;
  renderMain(): void;
  updateOpsAvailability(connected: boolean): void;
}

export class SchedulerBinder {
  private static readonly DEFAULT_EXERCISE_TOTAL = 6;
  private static readonly LOG_DEDUP_WINDOW_MS = 1200;

  // ── 状态（从 AppController 迁移而来） ──
  private pendingExerciseTaskId: string | null = null;
  private pendingBattleTaskId: string | null = null;
  private pendingLootTaskId: string | null = null;
  private exerciseTotal = SchedulerBinder.DEFAULT_EXERCISE_TOTAL;
  private exerciseCurrent = 0;
  private exerciseRoundInProgress = false;
  private lastParsedLogMessage = '';
  private lastParsedLogTaskId = '';
  private lastParsedLogAt = 0;
  currentProgress = '';
  trackedLoot = '';
  trackedShip = '';
  wsConnected = false;
  expeditionTimerText = '--:--';

  constructor(private readonly host: SchedulerBinderHost) {}

  /** 绑定 Scheduler 回调 */
  bindSchedulerCallbacks(): void {
    this.host.scheduler.setCallbacks({
      onStatusChange: (_status: SchedulerStatus) => {
        this.host.renderMain();
      },

      onProgressUpdate: (_taskId, progress) => {
        if (this.host.scheduler.currentRunningTask?.type === 'exercise') {
          // 演习优先使用日志解析进度；若尚未解析到日志，先展示 0/默认总场次。
          if (!this.currentProgress) {
            this.currentProgress = `0/${this.exerciseTotal}`;
            this.host.renderMain();
          }
          return;
        }
        this.currentProgress = `${progress.current}/${progress.total}`;
        this.host.renderMain();
      },

      onTaskCompleted: (taskId, success, _result, _error) => {
        this.currentProgress = '';
        this.resetExerciseProgress();
        this.lastParsedLogMessage = '';
        this.lastParsedLogTaskId = '';
        this.lastParsedLogAt = 0;
        this.trackedLoot = '';
        this.trackedShip = '';
        if (taskId === this.pendingExerciseTaskId) {
          if (success) {
            this.host.cronScheduler.markExerciseCompleted();
          } else {
            this.host.cronScheduler.clearExercisePending();
          }
          this.pendingExerciseTaskId = null;
        }
        if (taskId === this.pendingBattleTaskId) {
          this.host.cronScheduler.markBattleHandled();
          this.pendingBattleTaskId = null;
        }
        if (taskId === this.pendingLootTaskId) {
          this.host.cronScheduler.markLootHandled();
          this.pendingLootTaskId = null;
        }
        this.host.renderMain();
      },

      onLog: (msg) => {
        const changed = this.consumeRuntimeLogMessage(msg.message);
        if (changed) this.host.renderMain();
        Logger.logLevel(msg.level.toLowerCase(), msg.message, msg.channel);
      },

      onQueueChange: () => {
        this.host.renderMain();
      },

      onConnectionChange: (connected) => {
        this.wsConnected = connected;
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
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        this.expeditionTimerText = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const el = document.getElementById('expedition-timer');
        if (el) el.textContent = this.expeditionTimerText;
      },
    });
  }

  private resetExerciseProgress(): void {
    this.exerciseCurrent = 0;
    this.exerciseTotal = SchedulerBinder.DEFAULT_EXERCISE_TOTAL;
    this.exerciseRoundInProgress = false;
  }

  /**
   * 从后端运行日志更新界面追踪状态（演习进度 + 战利品/舰船计数）。
   * 返回 true 表示有可视状态变化，需要触发 renderMain。
   */
  private consumeRuntimeLogMessage(message: string): boolean {
    let changed = false;

    const lootMatch = message.match(/\[UI\] 战利品数量: (\d+\/\d+)/);
    if (lootMatch && lootMatch[1] !== this.trackedLoot) {
      this.trackedLoot = lootMatch[1];
      changed = true;
    }

    const shipMatch = message.match(/\[UI\] 舰船数量: (\d+\/\d+)/);
    if (shipMatch && shipMatch[1] !== this.trackedShip) {
      this.trackedShip = shipMatch[1];
      changed = true;
    }

    const running = this.host.scheduler.currentRunningTask;
    if (running?.type !== 'exercise') return changed;

    const normalized = message.trim();
    const now = Date.now();
    const duplicate =
      this.lastParsedLogTaskId === running.id
      && this.lastParsedLogMessage === normalized
      && (now - this.lastParsedLogAt) < SchedulerBinder.LOG_DEDUP_WINDOW_MS;

    if (duplicate) return changed;

    const progressChanged = this.updateExerciseProgressFromLog(normalized);
    this.lastParsedLogTaskId = running.id;
    this.lastParsedLogMessage = normalized;
    this.lastParsedLogAt = now;
    return changed || progressChanged;
  }

  /**
   * 处理后端 stdout 日志（用于 WS 日志延迟/缺失时的进度兜底）。
   */
  handleBackendRuntimeLog(message: string): void {
    if (this.consumeRuntimeLogMessage(message)) {
      this.host.renderMain();
    }
  }

  private updateExerciseProgressFromLog(message: string): boolean {
    let changed = false;
    const normalized = message.trim();

    if (/(?:\[[^\]]+\]\s*)?开始演习流程/.test(normalized)) {
      this.exerciseCurrent = 0;
      this.exerciseRoundInProgress = false;
      this.currentProgress = `0/${this.exerciseTotal}`;
      return true;
    }

    const rivalMatch = normalized.match(/(?:\[[^\]]+\]\s*)?(?:当前可挑战对手|演习对手状态):\s*ExerciseRivalStatus\(\[([^\]]*)\]\)/);
    if (rivalMatch) {
      const flags = rivalMatch[1]
        .split(',')
        .map(s => s.trim().toUpperCase())
        .filter(Boolean);
      if (flags.length > 0) {
        const available = flags.filter(f => f === 'Y').length;
        const nextTotal = available > 0 ? available : flags.length;
        if (nextTotal > 0 && nextTotal !== this.exerciseTotal) {
          this.exerciseTotal = nextTotal;
          changed = true;
        }
        if (!this.currentProgress) {
          this.currentProgress = `0/${this.exerciseTotal}`;
          changed = true;
        }
      }
    }

    // 每轮演习可能出现多条相关日志（正在挑战/选择对手/开始战斗）。
    // 这里使用“单轮状态位”避免重复计数。
    const hasRoundStartSignal =
      /(?:\[[^\]]+\]\s*)?正在挑战对手\s*\d+/.test(normalized)
      || /(?:\[[^\]]+\]\s*)?选择对手\s*\d+/.test(normalized)
      || /(?:\[[^\]]+\]\s*)?演习\s*[->→]\s*开始战斗/.test(normalized);

    if (hasRoundStartSignal && !this.exerciseRoundInProgress) {
      this.exerciseRoundInProgress = true;
      this.exerciseCurrent += 1;
      if (this.exerciseCurrent > this.exerciseTotal) {
        this.exerciseTotal = this.exerciseCurrent;
      }
      const next = `${this.exerciseCurrent}/${this.exerciseTotal}`;
      if (next !== this.currentProgress) {
        this.currentProgress = next;
        changed = true;
      }
    }

    if (/(?:\[[^\]]+\]\s*)?战斗结束:\s*/.test(normalized)) {
      // 兜底：若某些后端版本缺失“挑战/选择/开始战斗”日志，则在战斗结束时补计一轮。
      if (!this.exerciseRoundInProgress) {
        this.exerciseCurrent += 1;
        if (this.exerciseCurrent > this.exerciseTotal) {
          this.exerciseTotal = this.exerciseCurrent;
        }
        const next = `${this.exerciseCurrent}/${this.exerciseTotal}`;
        if (next !== this.currentProgress) {
          this.currentProgress = next;
          changed = true;
        }
      }
      this.exerciseRoundInProgress = false;
    }

    const finishedMatch = normalized.match(/(?:\[[^\]]+\]\s*)?演习流程结束,\s*共完成\s*(\d+)\s*场/);
    if (finishedMatch) {
      const done = parseInt(finishedMatch[1], 10);
      if (Number.isFinite(done) && done >= 0) {
        this.exerciseCurrent = done;
        this.exerciseRoundInProgress = false;
        if (done > this.exerciseTotal) this.exerciseTotal = done;
        const next = `${this.exerciseCurrent}/${this.exerciseTotal}`;
        if (next !== this.currentProgress) {
          this.currentProgress = next;
          changed = true;
        }
      }
    }

    return changed;
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

      onLootDue: (planIndex, stopCount) => {
        this.autoLoadLootTask(planIndex, stopCount);
      },

      onLog: (level, message) => {
        Logger.logLevel(level, message);
      },
    });
  }

  /** 自动战利品：加载内置捞胖次方案并加入队列 */
  private async autoLoadLootTask(planIndex: number, stopCount: number): Promise<void> {
    const tpl = this.host.templateModel.get('builtin_farm_loot');
    if (!tpl) {
      Logger.error('自动战利品：未找到内置 builtin_farm_loot 模板');
      this.host.cronScheduler.clearLootPending();
      return;
    }
    const paths = tpl.planPaths ?? [];
    const planPath = paths[planIndex] ?? paths[0];
    if (!planPath) {
      Logger.error('自动战利品：模板缺少方案文件');
      this.host.cronScheduler.clearLootPending();
      return;
    }
    const bridge = window.electronBridge;
    if (!bridge) {
      this.host.cronScheduler.clearLootPending();
      return;
    }
    try {
      const content = await bridge.readFile(planPath);
      const plan = PlanModel.fromYaml(content, planPath);
      const req: NormalFightReq = {
        type: 'normal_fight',
        plan_id: plan.fileName,
        times: 1,
        gap: plan.data.gap ?? 0,
      };
      if (plan.data.selected_nodes.length > 0) {
        req.plan = req.plan ?? {};
        req.plan.selected_nodes = [...plan.data.selected_nodes];
        // 与普通出击一致：避免后端把 plan.fleet_id 默认成 1 覆盖 YAML 内舰队。
        if (plan.data.fleet_id != null) {
          req.plan.fleet_id = plan.data.fleet_id;
        }
      }
      const stopCondition = { loot_count_ge: stopCount };
      const id = this.host.scheduler.addTask(
        `自动刷胖次·${plan.mapName}`,
        'normal_fight',
        req,
        TaskPriority.DAILY,
        99,
        stopCondition,
      );
      this.pendingLootTaskId = id;
      Logger.info(`自动战利品已加入队列 (${plan.mapName}, 战利品≥${stopCount}时停止)`);
      this.host.scheduler.startConsuming();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error(`自动战利品加载失败: ${msg}`);
      this.host.cronScheduler.clearLootPending();
    }
  }
}
