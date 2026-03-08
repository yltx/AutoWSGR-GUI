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
 *   通过 localStorage 记录演习/战役任务的【实际完成】时间戳，
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
}

/** 定时任务触发时的回调 */
export interface CronCallbacks {
  /** 请求添加演习任务 */
  onExerciseDue?: (fleetId: number) => void;
  /** 请求添加战役任务 */
  onCampaignDue?: (campaignName: string, times: number) => void;
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

/** localStorage key — 记录任务实际完成时间 */
const LS_KEY_LAST_EXERCISE_RUN = 'cron_lastExerciseRun';   // ISO 时间戳
const LS_KEY_LAST_BATTLE_RUN   = 'cron_lastBattleRun';     // YYYY-MM-DD

// ════════════════════════════════════════
// CronScheduler 实现
// ════════════════════════════════════════

export class CronScheduler {
  private config: CronConfig;
  private callbacks: CronCallbacks = {};
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 上一次演习任务实际完成的时间 */
  private lastExerciseRun: Date | null = null;
  /** 上一次战役任务实际完成的日期 (YYYY-MM-DD) */
  private lastBattleRun = '';
  /** 是否有演习/战役任务正在排队或执行中 (避免同一会话重复入队) */
  private exercisePending = false;
  private battlePending = false;
  /** 注册的定时方案任务 */
  private scheduledTasks: ScheduledTask[] = [];

  constructor(config: CronConfig) {
    this.config = { ...config };
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
    this.log('info', `定时调度配置: 演习=${this.config.autoExercise}, 战役=${this.config.autoBattle}`);
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
      localStorage.setItem(LS_KEY_LAST_EXERCISE_RUN, this.lastExerciseRun.toISOString());
    } catch { /* ignore */ }
    this.log('info', '演习任务完成，已记录运行时间');
  }

  /** Controller 在战役任务成功完成后调用 */
  markBattleCompleted(): void {
    this.lastBattleRun = this.dateKey(new Date());
    this.battlePending = false;
    try {
      localStorage.setItem(LS_KEY_LAST_BATTLE_RUN, this.lastBattleRun);
    } catch { /* ignore */ }
    this.log('info', '战役任务完成，已记录运行时间');
  }

  /** 演习任务失败 — 清除 pending 标记，下次 tick 将重新触发 */
  clearExercisePending(): void {
    this.exercisePending = false;
  }

  /** 战役任务失败 — 清除 pending 标记，下次 tick 将重新触发 */
  clearBattlePending(): void {
    this.battlePending = false;
  }

  // ── 持久化 ──

  /** 从 localStorage 加载上次运行时间戳 */
  private loadTimestamps(): void {
    try {
      const exRaw = localStorage.getItem(LS_KEY_LAST_EXERCISE_RUN);
      if (exRaw) {
        const d = new Date(exRaw);
        if (!isNaN(d.getTime())) this.lastExerciseRun = d;
      }
      this.lastBattleRun = localStorage.getItem(LS_KEY_LAST_BATTLE_RUN) || '';
    } catch { /* ignore */ }
  }

  /** 注册一个定时方案任务 */
  registerScheduledTask(key: string, time: string): void {
    // 去重
    if (this.scheduledTasks.some(t => t.key === key)) return;
    this.scheduledTasks.push({ key, time, firedToday: false });
  }

  /** 移除定时方案任务 */
  unregisterScheduledTask(key: string): void {
    this.scheduledTasks = this.scheduledTasks.filter(t => t.key !== key);
  }

  /** 获取下一个演习时间点 (供 UI 显示) */
  getNextExerciseTime(): Date | null {
    if (!this.config.autoExercise) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    for (const h of EXERCISE_REFRESH_HOURS) {
      const t = new Date(today.getTime() + h * 3600_000);
      if (t > now) return t;
    }
    // 下一个是明天 0 点
    return new Date(today.getTime() + 24 * 3600_000);
  }

  // ── 核心 tick ──

  private tick(): void {
    const now = new Date();
    this.checkExercise(now);
    this.checkCampaign(now);
    this.checkScheduledTasks(now);
    this.resetDailyFlags(now);
  }

  /**
   * 检查演习:
   * 找到当前所属刷新时段的起始时间，若 lastExerciseRun 早于该时间则触发。
   */
  private checkExercise(now: Date): void {
    if (!this.config.autoExercise) return;
    if (this.exercisePending) return;

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

    // 当前时段的起始时间
    const slotStart = new Date(now);
    slotStart.setHours(slotHour, 0, 0, 0);

    // 上次运行在本时段之前 → 需要触发
    if (!this.lastExerciseRun || this.lastExerciseRun < slotStart) {
      this.exercisePending = true;
      this.log('info', `自动演习触发 (${slotHour}:00 时段, 舰队 ${this.config.exerciseFleetId})`);
      this.callbacks.onExerciseDue?.(this.config.exerciseFleetId);
    }
  }

  /**
   * 检查战役:
   * 战役每日 0 点刷新。若 lastBattleRun 的日期不是今天则触发。
   */
  private checkCampaign(now: Date): void {
    if (!this.config.autoBattle) return;
    if (this.battlePending) return;

    const todayStr = this.dateKey(now);
    if (this.lastBattleRun >= todayStr) return; // 今天已运行过

    this.battlePending = true;
    this.log('info', `自动战役触发 (${this.config.battleType} ×${this.config.battleTimes})`);
    this.callbacks.onCampaignDue?.(this.config.battleType, this.config.battleTimes);
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
    // 重置定时方案的 firedToday (0:00 附近)
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      for (const task of this.scheduledTasks) {
        task.firedToday = false;
      }
    }
  }

  private dateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private log(level: string, message: string): void {
    this.callbacks.onLog?.(level, message);
  }
}
