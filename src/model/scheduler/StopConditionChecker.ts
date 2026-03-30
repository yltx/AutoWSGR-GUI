/**
 * StopConditionChecker — 停止条件检查器。
 * 从 Scheduler 中拆出，负责判断任务是否满足停止条件。
 */
import type { ApiClient } from '../ApiClient';
import type { StopCondition } from '../../types/model';
import { Logger } from '../../utils/Logger';

export class StopConditionChecker {
  /** 从后端 [UI] 日志 OCR 中解析的战利品/舰船当前值 */
  trackedLootCount: number | null = null;
  trackedShipCount: number | null = null;

  private api: ApiClient;
  private emitLog: (level: string, message: string) => void;

  constructor(api: ApiClient, emitLog: (level: string, message: string) => void) {
    this.api = api;
    this.emitLog = emitLog;
  }

  /** 更新从日志解析的跟踪值 */
  updateTracked(loot: number | null, ship: number | null): void {
    if (loot != null) this.trackedLootCount = loot;
    if (ship != null) this.trackedShipCount = ship;
  }

  /** 任务执行中实时检查停止条件，返回是否满足 */
  checkRunning(cond: StopCondition): boolean {
    let met = false;
    if (cond.loot_count_ge != null && this.trackedLootCount != null && this.trackedLootCount >= cond.loot_count_ge) {
      this.emitLog('info', `战利品已达 ${this.trackedLootCount}/${cond.loot_count_ge}，实时触发停止`);
      met = true;
    }
    if (cond.ship_count_ge != null && this.trackedShipCount != null && this.trackedShipCount >= cond.ship_count_ge) {
      this.emitLog('info', `舰船已达 ${this.trackedShipCount}/${cond.ship_count_ge}，实时触发停止`);
      met = true;
    }
    return met;
  }

  /**
   * 预飞检查：在发起 taskStart 之前确认停止条件是否已满足。
   * 仅依赖 OCR：调用 /api/game/acquisition 读取出征面板数量。
   */
  async preflightCheck(cond: StopCondition, taskName: string): Promise<boolean> {
    Logger.debug(`[StopCond] 预飞OCR检查: 「${taskName}」 条件=${JSON.stringify(cond)}`, 'scheduler');

    try {
      const resp = await this.api.gameAcquisition();
      if (resp.success && resp.data) {
        const { loot_count, ship_count } = resp.data;
        Logger.debug(`[StopCond] acquisition OCR: loot=${loot_count} ship=${ship_count}`, 'scheduler');

        if (loot_count != null) this.trackedLootCount = loot_count;
        if (ship_count != null) this.trackedShipCount = ship_count;

        if (cond.loot_count_ge != null && loot_count != null && loot_count >= cond.loot_count_ge) {
          this.emitLog('info', `[预飞] OCR: 战利品 ${loot_count} ≥ ${cond.loot_count_ge}，满足停止条件`);
          return true;
        }
        if (cond.ship_count_ge != null && ship_count != null && ship_count >= cond.ship_count_ge) {
          this.emitLog('info', `[预飞] OCR: 舰船 ${ship_count} ≥ ${cond.ship_count_ge}，满足停止条件`);
          return true;
        }

        this.emitLog('info', `[预飞] OCR: 战利品=${loot_count ?? '-'} 舰船=${ship_count ?? '-'}，未达停止条件`);
      } else {
        this.emitLog('warn', `[预飞] OCR 检查失败: ${resp.error ?? 'unknown error'}`);
      }
    } catch (e) {
      this.emitLog('warn', `[预飞] OCR 检查异常: ${String(e)}`);
    }

    Logger.debug(`[StopCond] 预飞OCR检查: 未满足停止条件，任务将启动`, 'scheduler');
    return false;
  }

  /** 检查停止条件是否满足（优先使用 OCR 日志中跟踪的计数，回退到 gameContext API） */
  async checkCondition(cond: StopCondition, _taskName: string): Promise<boolean> {
    if (cond.loot_count_ge != null && this.trackedLootCount != null && this.trackedLootCount >= cond.loot_count_ge) {
      this.emitLog('info', `战利品已达 ${this.trackedLootCount}，满足停止条件 (≥${cond.loot_count_ge})`);
      return true;
    }
    if (cond.ship_count_ge != null && this.trackedShipCount != null && this.trackedShipCount >= cond.ship_count_ge) {
      this.emitLog('info', `舰船获取已达 ${this.trackedShipCount}，满足停止条件 (≥${cond.ship_count_ge})`);
      return true;
    }

    try {
      const resp = await this.api.gameContext();
      if (!resp.success || !resp.data) return false;
      const data = resp.data;

      if (cond.loot_count_ge != null && data.dropped_loot_count != null && data.dropped_loot_count >= cond.loot_count_ge) {
        this.emitLog('info', `战利品已达 ${data.dropped_loot_count}，满足停止条件 (≥${cond.loot_count_ge})`);
        return true;
      }
      if (cond.ship_count_ge != null && data.dropped_ship_count != null && data.dropped_ship_count >= cond.ship_count_ge) {
        this.emitLog('info', `舰船获取已达 ${data.dropped_ship_count}，满足停止条件 (≥${cond.ship_count_ge})`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
