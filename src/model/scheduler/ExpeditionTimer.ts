/**
 * ExpeditionTimer — 远征定时器。
 * 从 Scheduler 中拆出，负责远征检查的定时触发和倒计时。
 */

const EXPEDITION_TIMER_TICK_MS = 1000;

export interface ExpeditionTimerCallbacks {
  /** 倒计时 tick (秒) */
  onTick?: (remainingSeconds: number) => void;
  /** 定时器触发，由调用方决定是否插入远征任务 */
  onTrigger: () => void;
}

export class ExpeditionTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastCheck = 0;
  private _intervalMs: number;
  private callbacks: ExpeditionTimerCallbacks;

  constructor(intervalMs: number, callbacks: ExpeditionTimerCallbacks) {
    this._intervalMs = intervalMs;
    this.callbacks = callbacks;
  }

  get intervalMs(): number { return this._intervalMs; }

  /** 更新间隔（毫秒），如果正在运行则自动重启 */
  setInterval(ms: number): void {
    this._intervalMs = ms;
    if (this.timer) {
      this.start();
    }
  }

  start(): void {
    this.lastCheck = Date.now();
    this.stop();

    this.timer = setInterval(() => {
      this.lastCheck = Date.now();
      this.callbacks.onTrigger();
    }, this._intervalMs);

    this.tickTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastCheck;
      const remaining = Math.max(0, this._intervalMs - elapsed);
      this.callbacks.onTick?.(Math.ceil(remaining / 1000));
    }, EXPEDITION_TIMER_TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer != null;
  }
}
