/**
 * CronScheduler —— 基于系统时钟的定时任务调度器。
 *
 * 职责:
 *   - 每分钟检查一次系统时间
 *   - 在演习刷新时间 (0:00 / 12:00 / 18:00) 后自动生成演习任务
 *   - 每日自动生成战役任务
 *   - 支持 YAML 中 scheduled_time 定时触发
 *
 * 设计: 不直接操作 Scheduler 队列，而是通过回调通知外部 (Controller) 添加任务。
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

/** localStorage key */
const LS_KEY_CLOSE_TIME = 'cron_lastCloseTime';
const LS_KEY_FIRED_EXERCISE = 'cron_firedExercise';

// ════════════════════════════════════════
// CronScheduler 实现
// ════════════════════════════════════════

export class CronScheduler {
  private config: CronConfig;
  private callbacks: CronCallbacks = {};
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 记录每个演习刷新时段是否已触发 (key = "YYYY-MM-DD_HH") */
  private firedExercise = new Set<string>();
  /** 记录今日是否已触发战役 (key = "YYYY-MM-DD") */
  private firedCampaign = new Set<string>();
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
    this.loadState();
    this.checkMissedExercise();
    // 立即检查一次
    this.tick();
    // 每 60 秒检查
    this.timer = setInterval(() => this.tick(), 60_000);
  }

  /** 停止定时检查，保存关闭时间 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.saveState();
  }

  /**
   * 保存状态到 localStorage:
   *   - 当前时间作为关闭时间
   *   - 已触发的演习时段 (避免重复触发)
   */
  saveState(): void {
    try {
      localStorage.setItem(LS_KEY_CLOSE_TIME, new Date().toISOString());
      localStorage.setItem(LS_KEY_FIRED_EXERCISE, JSON.stringify([...this.firedExercise]));
    } catch { /* localStorage 不可用时静默 */ }
  }

  /** 从 localStorage 恢复状态 */
  private loadState(): void {
    try {
      const fired = localStorage.getItem(LS_KEY_FIRED_EXERCISE);
      if (fired) {
        const arr: string[] = JSON.parse(fired);
        // 只恢复今天的记录
        const today = this.dateKey(new Date());
        for (const k of arr) {
          if (k.startsWith(today)) this.firedExercise.add(k);
        }
      }
    } catch { /* 解析失败时忽略 */ }
  }

  /**
   * 检查 App 关闭期间是否有演习刷新窗口被错过。
   * 比较 lastCloseTime 与当前时间之间经过的刷新点，对未触发的时段补发任务。
   */
  private checkMissedExercise(): void {
    if (!this.config.autoExercise) return;

    let lastClose: Date | null = null;
    try {
      const raw = localStorage.getItem(LS_KEY_CLOSE_TIME);
      if (raw) lastClose = new Date(raw);
    } catch { /* ignore */ }
    if (!lastClose || isNaN(lastClose.getTime())) return;

    const now = new Date();
    if (now <= lastClose) return;

    // 收集 lastClose 到 now 之间所有刷新时间点
    const missed: { date: Date; slotKey: string }[] = [];
    const cursor = new Date(lastClose);
    // 向前对齐到 lastClose 当天 00:00
    cursor.setHours(0, 0, 0, 0);

    // 遍历 lastClose 当天到 now 当天 (最多跨几天)
    const endDay = new Date(now);
    endDay.setHours(23, 59, 59, 999);

    while (cursor <= endDay) {
      const dateStr = this.dateKey(cursor);
      for (const h of EXERCISE_REFRESH_HOURS) {
        const refreshTime = new Date(cursor);
        refreshTime.setHours(h, 0, 0, 0);
        // 刷新时间必须在 (lastClose, now] 区间内
        if (refreshTime > lastClose && refreshTime <= now) {
          const slotKey = `${dateStr}_${h}`;
          if (!this.firedExercise.has(slotKey)) {
            missed.push({ date: refreshTime, slotKey });
          }
        }
      }
      // 下一天
      cursor.setDate(cursor.getDate() + 1);
    }

    if (missed.length === 0) return;

    // 只补发最近一个时段 (避免重开后一次性刷出大量演习任务)
    const latest = missed[missed.length - 1];
    this.firedExercise.add(latest.slotKey);
    const hh = latest.date.getHours();
    this.log('info', `检测到关闭期间演习刷新 (${hh}:00 时段)，自动补发演习任务`);
    this.callbacks.onExerciseDue?.(this.config.exerciseFleetId);
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

  /** 检查演习: 0/12/18 点后尚未触发则触发 */
  private checkExercise(now: Date): void {
    if (!this.config.autoExercise) return;

    const dateStr = this.dateKey(now);
    const hour = now.getHours();

    // 找到当前所属的刷新时段 (最近一个 ≤ hour 的刷新小时)
    let currentSlot = -1;
    for (let i = EXERCISE_REFRESH_HOURS.length - 1; i >= 0; i--) {
      if (hour >= EXERCISE_REFRESH_HOURS[i]) {
        currentSlot = EXERCISE_REFRESH_HOURS[i];
        break;
      }
    }
    if (currentSlot < 0) return; // 不应该发生

    const slotKey = `${dateStr}_${currentSlot}`;
    if (this.firedExercise.has(slotKey)) return;

    // 标记并触发
    this.firedExercise.add(slotKey);
    this.log('info', `自动演习触发 (${currentSlot}:00 时段, 舰队 ${this.config.exerciseFleetId})`);
    this.callbacks.onExerciseDue?.(this.config.exerciseFleetId);
  }

  /** 检查战役: 每日触发一次 */
  private checkCampaign(now: Date): void {
    if (!this.config.autoBattle) return;

    const dateStr = this.dateKey(now);
    if (this.firedCampaign.has(dateStr)) return;

    this.firedCampaign.add(dateStr);
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
    const dateStr = this.dateKey(now);

    // 清理旧日期的演习和战役记录
    for (const key of this.firedExercise) {
      if (!key.startsWith(dateStr)) this.firedExercise.delete(key);
    }
    for (const key of this.firedCampaign) {
      if (key !== dateStr) this.firedCampaign.delete(key);
    }

    // 重置定时方案的 firedToday (简单检测: 0:00 附近)
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
