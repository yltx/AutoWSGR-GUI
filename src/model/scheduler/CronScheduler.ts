/** 维护定时任务触发器、最后执行时间和 pending 状态。 */
import { browserStorageStore, type StorageStore } from '../../adapter/index.js';
import type { LootPlanSource } from '../../shared/lootPlans.js';
import type {
  DecisiveAutomationSource,
} from '../../shared/decisiveAutomation.js';

/**
 * CronScheduler —— 基于系统时钟的定时任务调度器。
 *
 * 职责:
 *   - 每分钟检查一次系统时间
 *   - 在演习刷新时间 (0:00 / 12:00 / 18:00) 后自动生成演习任务
 *   - 每日 0 点后自动生成战役任务
 *   - 支持 YAML 中 scheduled_time 定时触发
 *
 * 核心机制:
 *   通过注入的持久化存储记录演习/战役任务的【实际完成】时间戳，
 *   而非记录"是否已触发"。这样即使 App 因 ADB 断开等原因重启，
 *   只要任务未真正完成、时间戳就不更新，下次启动后仍会补发任务。
 */

// ════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════

export interface CronConfig {
  /** 启用自动演习 */
  autoExercise: boolean;
  /** 演习使用的舰队 ID (1-4) */
  exerciseFleetId: number;
  /** 启用自动战役 */
  autoBattle: boolean;
  /** 战役类型名称 */
  battleType: string;
  /** 战役次数 */
  battleTimes: number;
  /** 启用自动常规出击（每日执行任务列表） */
  autoNormalFight: boolean;
  /** 启用每日自动决战 */
  autoDecisive: boolean;
  /** 自动决战使用计划页方案或系统预设 */
  decisiveTemplateId: DecisiveAutomationSource;
  /** 启用每日自动刷战利品 */
  autoLoot: boolean;
  /** 战利品受管计划来源。 */
  lootPlanSource: LootPlanSource;
  /** 战利品受管计划文件名，不依赖列表顺序。 */
  lootPlanId: string;
  /** 战利品停止数量 */
  lootStopCount: number;
}

/** 定时任务触发时的回调 */
export interface CronCallbacks {
  /** 请求添加演习任务 */
  onExerciseDue?: (fleetId: number) => void;
  /** 请求添加战役任务 */
  onCampaignDue?: (campaignName: string, times: number) => void;
  /** 请求执行任务列表中所有任务 */
  onNormalFightDue?: () => void;
  /** 请求按指定来源添加一轮决战任务 */
  onDecisiveDue?: (source: DecisiveAutomationSource) => void;
  /** 请求添加战利品任务 */
  onLootDue?: (
    source: LootPlanSource,
    planId: string,
    stopCount: number,
  ) => void;
  /** 请求添加定时方案任务 */
  onScheduledTaskDue?: (taskKey: string) => void;
  /** 日志 */
  onLog?: (level: string, message: string) => void;
}

/** 定时方案:  YAML 中用 scheduled_time 指定触发时间  */
export interface ScheduledTask {
  /** 唯一标识 (文件名或自定义 key) */
  key: string;
  /** 触发时间 "HH:MM" 格式 */
  time: string;
  /** 今日是否已触发 */
  firedToday: boolean;
}

// 演习刷新时间点 (小时)
const EXERCISE_REFRESH_HOURS = [0, 12, 18];

/** 持久化 key — 记录任务实际完成时间 */
const LS_KEY_LAST_EXERCISE_RUN = 'cron_lastExerciseRun';   // ISO 时间戳
const LS_KEY_LAST_BATTLE_RUN   = 'cron_lastBattleRun';     // YYYY-MM-DD
const LS_KEY_LAST_NORMAL_FIGHT_RUN = 'cron_lastNormalFightRun'; // YYYY-MM-DD
const LS_KEY_LAST_DECISIVE_RUN = 'cron_lastDecisiveRun';   // YYYY-MM-DD
const LS_KEY_LAST_LOOT_RUN = 'cron_lastLootRun';           // YYYY-MM-DD

// ════════════════════════════════════════
// CronScheduler 实现
// ════════════════════════════════════════

export class CronScheduler {
  private config: CronConfig;
  private callbacks: CronCallbacks = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private storage: StorageStore;

  /** 上一次演习任务实际完成的时间 */
  private lastExerciseRun: Date | null = null;
  /** 上一次战役任务实际完成的日期 (YYYY-MM-DD) */
  private lastBattleRun = '';
  /** 是否有演习/战役/常规出击任务正在排队或执行中 (避免同一会话重复入队) */
  private exercisePending = false;
  /** 当前 pending 的演习任务所属的刷新时段 (小时), 用于跨时段时允许重新触发 */
  private exercisePendingSlot = -1;
  private battlePending = false;
  /** 当前 pending 的战役任务所属的日期, 用于跨日时允许重新触发 */
  private battlePendingDate = '';
  /** 上一次常规出击实际完成的日期 (YYYY-MM-DD) */
  private lastNormalFightRun = '';
  private normalFightPending = false;
  private normalFightPendingDate = '';
  /** 上一次自动决战实际处理的日期 (YYYY-MM-DD) */
  private lastDecisiveRun = '';
  private decisivePending = false;
  private decisivePendingDate = '';
  /** 上一次战利品任务实际完成的日期 (YYYY-MM-DD) */
  private lastLootRun = '';
  private lootPending = false;
  private lootPendingDate = '';
  /** 注册的定时方案任务 */
  private scheduledTasks: ScheduledTask[] = [];
  /** 上次检查定时方案标记时的日期 */
  private scheduledTaskDate = '';

  constructor(config: CronConfig, storage: StorageStore = browserStorageStore) {
    this.config = { ...config };
    this.storage = storage;
  }

  setCallbacks(cb: CronCallbacks): void {
    this.callbacks = cb;
  }

  /** 更新配置 (配置页保存时调用) */
  updateConfig(config: Partial<CronConfig>): void {
    Object.assign(this.config, config);
  }

  /** 启动定时检查 (每分钟) */
  start(): void {
    this.stop();
    this.loadTimestamps();
    this.log(
      'info',
      `定时调度配置: 演习=${this.config.autoExercise}, 战役=${this.config.autoBattle}, `
        + `常规出击=${this.config.autoNormalFight}, 决战=${this.config.autoDecisive}`,
    );
    if (this.lastExerciseRun) {
      this.log('info', `上次演习完成: ${this.lastExerciseRun.toLocaleString()}`);
    }
    if (this.lastBattleRun) {
      this.log('info', `上次战役完成: ${this.lastBattleRun}`);
    }
    // 立即检查一次（处理 App 关闭期间错过的窗口）
    this.tick();
    // 每 60 秒检查
    this.timer = setInterval(() => this.tick(), 60_000);
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── 时间戳记录 ──

  /** Controller 在演习任务成功完成后调用 */
  markExerciseCompleted(): void {
    this.lastExerciseRun = new Date();
    this.exercisePending = false;
    try {
      this.storage.set(LS_KEY_LAST_EXERCISE_RUN, this.lastExerciseRun.toISOString());
    } catch { /* ignore */ }
    this.log('info', '演习任务完成，已记录运行时间');
  }

  /** 演习任务被用户取消，本刷新时段不再重复触发。 */
  markExerciseHandled(): void {
    this.lastExerciseRun = new Date();
    this.exercisePending = false;
    try {
      this.storage.set(
        LS_KEY_LAST_EXERCISE_RUN,
        this.lastExerciseRun.toISOString(),
      );
    } catch { /* ignore */ }
    this.log('info', '演习任务已取消，本刷新时段不再重复触发');
  }

  /**
   * Controller 在战役任务结束（成功或失败）后调用。
   *
   * 战役次数每日 0 点刷新，同一天内不应像演习一样反复重触发。
   * 因此无论执行成功与否，都将当天记为已处理。
   */
  markBattleHandled(): void {
    this.lastBattleRun = this.dateKey(new Date());
    this.battlePending = false;
    try {
      this.storage.set(LS_KEY_LAST_BATTLE_RUN, this.lastBattleRun);
    } catch { /* ignore */ }
    this.log('info', '战役任务已处理，今日不再重复触发');
  }

  /** 演习任务失败 — 清除 pending 标记，下次 tick 将重新触发 */
  clearExercisePending(): void {
    this.exercisePending = false;
  }

  /** 战役任务失败 — 清除 pending 标记，下次 tick 将重新触发 */
  clearBattlePending(): void {
    this.battlePending = false;
  }

  /** 常规出击任务已处理（成功或失败），今日不再重复 */
  markNormalFightHandled(): void {
    this.lastNormalFightRun = this.dateKey(new Date());
    this.normalFightPending = false;
    try {
      this.storage.set(LS_KEY_LAST_NORMAL_FIGHT_RUN, this.lastNormalFightRun);
    } catch { /* ignore */ }
  }

  /** 常规出击失败 — 清除 pending，下次 tick 重试 */
  clearNormalFightPending(): void {
    this.normalFightPending = false;
  }

  /**
   * 自动决战已结束，无论成功与否今日均不重复。
   * 决战可能在失败前消耗票数，禁止同日盲目重试。
   */
  markDecisiveHandled(): void {
    this.lastDecisiveRun = this.dateKey(new Date());
    this.decisivePending = false;
    try {
      this.storage.set(LS_KEY_LAST_DECISIVE_RUN, this.lastDecisiveRun);
    } catch { /* ignore */ }
    this.log('info', '自动决战已处理，今日不再重复触发');
  }

  /** 决战任务尚未入队时清除 pending，允许下次 tick 重试。 */
  clearDecisivePending(): void {
    this.decisivePending = false;
  }

  /** 战利品任务已处理（成功或失败），今日不再重复 */
  markLootHandled(): void {
    this.lastLootRun = this.dateKey(new Date());
    this.lootPending = false;
    try {
      this.storage.set(LS_KEY_LAST_LOOT_RUN, this.lastLootRun);
    } catch { /* ignore */ }
  }

  /** 战利品任务失败 — 清除 pending，下次 tick 重试 */
  clearLootPending(): void {
    this.lootPending = false;
  }

  // ── 持久化 ──

  /** 从持久化存储加载上次运行时间戳 */
  private loadTimestamps(): void {
    try {
      const exRaw = this.storage.get(LS_KEY_LAST_EXERCISE_RUN);
      if (exRaw) {
        const d = new Date(exRaw);
        if (!isNaN(d.getTime())) this.lastExerciseRun = d;
      }
      this.lastBattleRun = this.storage.get(LS_KEY_LAST_BATTLE_RUN) || '';
      this.lastNormalFightRun = this.storage.get(LS_KEY_LAST_NORMAL_FIGHT_RUN) || '';
      this.lastDecisiveRun = this.storage.get(LS_KEY_LAST_DECISIVE_RUN) || '';
      this.lastLootRun = this.storage.get(LS_KEY_LAST_LOOT_RUN) || '';
    } catch { /* ignore */ }
  }

  /** 当前没有生产调用方引用，保留给 scheduled_time 后续接入。 */
  registerScheduledTask(key: string, time: string): void {
    // 去重
    if (this.scheduledTasks.some(t => t.key === key)) return;
    this.scheduledTasks.push({ key, time, firedToday: false });
  }

  /** 当前没有生产调用方引用，保留给 scheduled_time 后续接入。 */
  unregisterScheduledTask(key: string): void {
    this.scheduledTasks = this.scheduledTasks.filter(t => t.key !== key);
  }

  // ── 核心 tick ──

  private tick(): void {
    const now = new Date();
    this.resetDailyFlags(now);
    this.checkExercise(now);
    this.checkCampaign(now);
    this.checkNormalFight(now);
    this.checkDecisive(now);
    this.checkLoot(now);
    this.checkScheduledTasks(now);
  }

  /**
   * 检查演习:
   * 找到当前所属刷新时段的起始时间，若 lastExerciseRun 早于该时间则触发。
   * 当刷新时段切换时（如 12:00 → 18:00），即使上一时段的演习仍在排队也会重新触发，
   * 确保持续挂机期间不会错过新的刷新窗口。
   */
  private checkExercise(now: Date): void {
    if (!this.config.autoExercise) return;

    const hour = now.getHours();
    // 找到当前所属的刷新时段 (最近一个 ≤ hour 的刷新小时)
    let slotHour = -1;
    for (let i = EXERCISE_REFRESH_HOURS.length - 1; i >= 0; i--) {
      if (hour >= EXERCISE_REFRESH_HOURS[i]) {
        slotHour = EXERCISE_REFRESH_HOURS[i];
        break;
      }
    }
    if (slotHour < 0) return;

    // 若已有演习任务在排队且属于同一时段，跳过
    if (this.exercisePending && this.exercisePendingSlot === slotHour) return;

    // 当前时段的起始时间
    const slotStart = new Date(now);
    slotStart.setHours(slotHour, 0, 0, 0);

    // 上次运行在本时段之前 → 需要触发
    if (!this.lastExerciseRun || this.lastExerciseRun < slotStart) {
      this.exercisePending = true;
      this.exercisePendingSlot = slotHour;
      this.log('info', `自动演习触发 (${slotHour}:00 时段, 舰队 ${this.config.exerciseFleetId})`);
      this.callbacks.onExerciseDue?.(this.config.exerciseFleetId);
    }
  }

  /**
   * 检查战役:
   * 战役每日 0 点刷新。若 lastBattleRun 的日期不是今天则触发。
   * 跨日时即使上一天的战役仍在排队也会重新触发。
   */
  private checkCampaign(now: Date): void {
    if (!this.config.autoBattle) return;

    const todayStr = this.dateKey(now);

    // 若已有战役任务在排队且属于同一天，跳过
    if (this.battlePending && this.battlePendingDate === todayStr) return;

    if (this.lastBattleRun >= todayStr) return; // 今天已运行过

    this.battlePending = true;
    this.battlePendingDate = todayStr;
    this.log('info', `自动战役触发 (${this.config.battleType} ×${this.config.battleTimes})`);
    this.callbacks.onCampaignDue?.(this.config.battleType, this.config.battleTimes);
  }

  /**
   * 检查常规出击:
   * 每日 0 点刷新。若 lastNormalFightRun 不是今天则触发，将任务列表全部加入队列。
   * 跨日时即使上一天的常规出击仍在排队也会重新触发。
   */
  private checkNormalFight(now: Date): void {
    if (!this.config.autoNormalFight) return;

    const todayStr = this.dateKey(now);

    // 若已有任务在排队且属于同一天，跳过
    if (this.normalFightPending && this.normalFightPendingDate === todayStr) return;

    if (this.lastNormalFightRun >= todayStr) return;

    this.normalFightPending = true;
    this.normalFightPendingDate = todayStr;
    this.log('info', '自动常规出击触发 (执行任务列表中所有任务)');
    this.callbacks.onNormalFightDue?.();
  }

  /**
   * 检查决战:
   * 每日最多加入一轮。无法查询剩余票数，因此不推导票数保留或执行轮数。
   */
  private checkDecisive(now: Date): void {
    if (!this.config.autoDecisive) return;

    const todayStr = this.dateKey(now);
    if (
      this.decisivePending
      && this.decisivePendingDate === todayStr
    ) {
      return;
    }
    if (this.lastDecisiveRun >= todayStr) return;

    this.decisivePending = true;
    this.decisivePendingDate = todayStr;
    this.log(
      'info',
      `自动决战触发 (方案=${this.config.decisiveTemplateId}, 轮数=1)`,
    );
    this.callbacks.onDecisiveDue?.(this.config.decisiveTemplateId);
  }

  /**
   * 检查战利品:
   * 每日 0 点刷新。若 lastLootRun 不是今天则触发。
   * 跨日时即使上一天的战利品任务仍在排队也会重新触发。
   */
  private checkLoot(now: Date): void {
    if (!this.config.autoLoot) return;

    const todayStr = this.dateKey(now);

    // 若已有任务在排队且属于同一天，跳过
    if (this.lootPending && this.lootPendingDate === todayStr) return;

    if (this.lastLootRun >= todayStr) return;

    this.lootPending = true;
    this.lootPendingDate = todayStr;
    this.log(
      'info',
      `自动战利品触发 (来源=${this.config.lootPlanSource}, 方案=${this.config.lootPlanId}, 停止数量=${this.config.lootStopCount})`,
    );
    this.callbacks.onLootDue?.(
      this.config.lootPlanSource,
      this.config.lootPlanId,
      this.config.lootStopCount,
    );
  }

  /** 检查定时方案任务 */
  private checkScheduledTasks(now: Date): void {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const task of this.scheduledTasks) {
      if (task.firedToday) continue;
      if (hhmm >= task.time) {
        task.firedToday = true;
        this.log('info', `定时任务「${task.key}」触发 (预定 ${task.time})`);
        this.callbacks.onScheduledTaskDue?.(task.key);
      }
    }
  }

  /** 跨日重置: 日期变化时清除 firedToday 标记 */
  private resetDailyFlags(now: Date): void {
    const today = this.dateKey(now);
    if (!this.scheduledTaskDate) {
      this.scheduledTaskDate = today;
      return;
    }
    if (this.scheduledTaskDate === today) return;

    this.scheduledTaskDate = today;
    for (const task of this.scheduledTasks) {
      task.firedToday = false;
    }
  }

  private dateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private log(level: string, message: string): void {
    this.callbacks.onLog?.(level, message);
  }
}
