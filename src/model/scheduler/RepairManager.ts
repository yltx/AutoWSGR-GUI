/**
 * RepairManager —— 泡澡修理管理器
 *
 * 功能:
 *   - 在任务执行前检查编队舰船血量（按舰船名匹配阈值）
 *   - 将需要修理的舰船送入泡澡，追踪修理状态
 *   - 支持编队预设轮换：一套舰船在修时切换到另一套继续战斗
 *
 * 设计要点:
 *   - 修理阈值按舰船名设定（而非舰位），适配编队重组
 *   - 泡澡修理无需快修工具，靠等待完成
 *   - 被延迟的任务不消耗 remainingTimes
 */

import type { ApiClient } from '../ApiClient';
import type { ShipData } from '../../types/api';
import type { BathRepairConfig, RepairThreshold, ShipSlot } from '../../types/model';
import { Logger } from '../../utils/Logger';
import { toBackendName } from '../../data/shipData';

/** 正在泡澡的舰船记录 */
export interface BathingShip {
  /** 舰船名称 */
  name: string;
  /** 送入泡澡的时间 */
  startTime: number;
  /** 预计维修完成时间 (Date.now() 时间戳)。0 表示未知，需回退到轮询模式 */
  repairEndTime: number;
  /** 是否已发送修理请求到后端 */
  requestSent: boolean;
}

/** 修理检查结果 */
export interface RepairCheckResult {
  /** 是否可以执行任务（无船需要修理） */
  ready: boolean;
  /** 需要修理的舰船名称列表 */
  shipsNeedRepair: string[];
  /** 已在泡澡中的舰船 */
  shipsInBath: string[];
}

export class RepairManager {
  private api: ApiClient;
  /** 正在泡澡的舰船列表 (舰船名 → 记录) */
  private bathingShips: Map<string, BathingShip> = new Map();
  private static readonly STORAGE_KEY = 'autowsgr_bathing_ships';

  constructor(api: ApiClient) {
    this.api = api;
    this.restoreFromStorage();
  }

  /** 获取舰船的修理阈值（优先按名查找，回退到默认阈值） */
  private getThreshold(shipName: string, config: BathRepairConfig): RepairThreshold {
    if (config.shipThresholds) {
      // 直接匹配
      if (config.shipThresholds[shipName]) return config.shipThresholds[shipName];
      // UI 端用显示名（含 ·改），后端用基础名，需交叉匹配
      const normalized = toBackendName(shipName);
      for (const [key, value] of Object.entries(config.shipThresholds)) {
        if (toBackendName(key) === normalized) return value;
      }
    }
    return config.defaultThreshold;
  }

  /**
   * 检查指定编队的舰船是否需要修理（按舰船名匹配阈值）
   * @param fleetId 编队号 (1-4)
   * @param config 泡澡修理配置
   * @returns 检查结果
   */
  async checkFleetHealth(fleetId: number, config: BathRepairConfig): Promise<RepairCheckResult> {
    if (!config.enabled) {
      return { ready: true, shipsNeedRepair: [], shipsInBath: [] };
    }

    try {
      const resp = await this.api.gameContext();
      if (!resp.success || !resp.data?.fleets) {
        Logger.warn('无法获取编队信息，跳过修理检查', 'repair');
        return { ready: true, shipsNeedRepair: [], shipsInBath: [] };
      }

      const fleet = resp.data.fleets.find(f => f.fleet_id === fleetId);
      if (!fleet) {
        Logger.warn(`编队 ${fleetId} 不存在`, 'repair');
        return { ready: true, shipsNeedRepair: [], shipsInBath: [] };
      }

      const shipsNeedRepair: string[] = [];
      const shipsInBath: string[] = [];

      for (const ship of fleet.ships) {
        if (!ship || !ship.name) continue;

        const normalized = toBackendName(ship.name);
        const threshold = this.getThreshold(ship.name, config);
        if (this.needsRepair(ship, threshold)) {
          if (this.bathingShips.has(normalized)) {
            shipsInBath.push(ship.name);
          } else {
            shipsNeedRepair.push(ship.name);
          }
        } else {
          // 舰船已修好，清除泡澡记录
          if (this.bathingShips.has(normalized)) {
            Logger.info(`舰船「${ship.name}」已修复，移除泡澡记录`, 'repair');
            this.bathingShips.delete(normalized);
          }
        }
      }

      const ready = shipsNeedRepair.length === 0 && shipsInBath.length === 0;
      return { ready, shipsNeedRepair, shipsInBath };
    } catch (e) {
      Logger.error(`修理检查失败: ${e}`, 'repair');
      return { ready: true, shipsNeedRepair: [], shipsInBath: [] };
    }
  }

  /** 判断单船是否需要修理 */
  private needsRepair(ship: ShipData, threshold: RepairThreshold): boolean {
    if (ship.max_health <= 0) return false;
    const hpRatio = ship.health / ship.max_health;

    if (threshold.type === 'percent') {
      return hpRatio <= threshold.value / 100;
    } else {
      return ship.health <= threshold.value;
    }
  }

  /**
   * 校验后端返回的维修秒数是否在合理范围内。
   * 合理范围: 60 秒 ~ 86400 秒（24 小时）。不合理时返回 0，回退到轮询模式。
   */
  private static validateRepairSeconds(seconds: unknown): number {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
      return 0;
    }
    if (seconds >= 60 && seconds <= 86400) {
      return seconds;
    }
    Logger.warn(`维修秒数 ${seconds}s 超出合理范围 [60, 86400]，回退到轮询模式`, 'repair');
    return 0;
  }

  /**
   * 将舰船送入泡澡
   */
  async sendToBath(shipNames: string[]): Promise<void> {
    for (const name of shipNames) {
      const key = toBackendName(name);
      if (this.bathingShips.has(key)) continue;

      this.bathingShips.set(key, {
        name,
        startTime: Date.now(),
        repairEndTime: 0,
        requestSent: false,
      });

      try {
        const resp = await this.api.repairShip(name);
        const entry = this.bathingShips.get(key);
        if (!entry) continue;

        const rawSeconds: unknown = (resp.data as any)?.repair_seconds;
        const validatedSeconds = RepairManager.validateRepairSeconds(rawSeconds);

        if (validatedSeconds > 0) {
          entry.repairEndTime = Date.now() + validatedSeconds * 1000;
          Logger.info(
            `舰船「${name}」已送入泡澡修理，预计 ${validatedSeconds} 秒后完成`,
            'repair',
          );
        } else {
          entry.repairEndTime = 0;
          Logger.info(
            `舰船「${name}」已送入泡澡修理（维修时间未知，将轮询检查）`,
            'repair',
          );
        }

        entry.requestSent = true;
        this.saveToStorage();
      } catch (e) {
        Logger.error(`舰船「${name}」送入泡澡失败: ${e}`, 'repair');
        const entry = this.bathingShips.get(key);
        if (entry) {
          entry.requestSent = false;
        }
      }
    }
  }

  /**
   * 刷新泡澡状态: 通过 gameContext 检查舰船血量，移除已修好的记录
   */
  async refreshBathingStatus(fleetId: number, config: BathRepairConfig): Promise<void> {
    if (this.bathingShips.size === 0) return;

    try {
      const resp = await this.api.gameContext();
      if (!resp.success || !resp.data?.fleets) return;

      // 收集所有编队中的舰船数据
      const allShips = new Map<string, ShipData>();
      for (const fleet of resp.data.fleets) {
        for (const ship of fleet.ships) {
          if (ship?.name) allShips.set(ship.name, ship);
        }
      }

      // 检查泡澡中的舰船是否已修理完成
      for (const [name] of this.bathingShips) {
        const ship = allShips.get(name);
        if (!ship) {
          // 舰船不在任何编队（可能被卸下），保留记录等下次检查
          continue;
        }
        const threshold = this.getThreshold(name, config);
        if (!this.needsRepair(ship, threshold)) {
          Logger.info(`舰船「${name}」泡澡修理完成`, 'repair');
          this.bathingShips.delete(name);
          this.saveToStorage();
        }
      }
    } catch (e) {
      Logger.debug(`刷新泡澡状态失败: ${e}`, 'repair');
    }
  }

  /**
   * 从编队预设列表中找到一个所有舰船都不在泡澡中的预设
   * @param presets 编队预设列表 (name + ships[])
   * @param skipIndex 跳过的预设索引（当前正在使用的）
   * @returns 可用预设的索引，或 -1（全部有船在泡澡）
   */
  findHealthyPreset(presets: Array<{ name: string; ships: ShipSlot[] }>, skipIndex: number): number {
    for (let i = 0; i < presets.length; i++) {
      if (i === skipIndex) continue;
      const preset = presets[i];
      const hasShipInBath = preset.ships.some(slot => {
        if (typeof slot !== 'string') return false; // 模糊槽位不视为泡澡中
        return this.bathingShips.has(toBackendName(slot));
      });
      if (!hasShipInBath) {
        return i;
      }
    }
    return -1;
  }

  /** 是否有舰船正在泡澡 */
  get hasBathingShips(): boolean {
    return this.bathingShips.size > 0;
  }

  /** 获取正在泡澡的舰船列表 */
  get bathingShipNames(): string[] {
    return Array.from(this.bathingShips.keys());
  }

  /** 获取泡澡中舰船列表（只读引用，供 TaskQueue 计算动态延迟） */
  getBathingShips(): ReadonlyMap<string, BathingShip> {
    return this.bathingShips;
  }

  /** 清除所有泡澡记录 */
  clearAll(): void {
    this.bathingShips.clear();
    this.saveToStorage();
  }

  /**
   * 将 bathingShips 持久化到 localStorage。
   * 仅保存尚未完成的维修记录。
   */
  private saveToStorage(): void {
    try {
      const now = Date.now();
      const data = Array.from(this.bathingShips.entries())
        .filter(([, ship]) => {
          if (ship.repairEndTime === 0) return true;
          return ship.repairEndTime > now;
        })
        .map(([key, ship]) => ({
          key,
          name: ship.name,
          startTime: ship.startTime,
          repairEndTime: ship.repairEndTime,
          requestSent: ship.requestSent,
        }));

      if (data.length === 0) {
        localStorage.removeItem(RepairManager.STORAGE_KEY);
      } else {
        localStorage.setItem(RepairManager.STORAGE_KEY, JSON.stringify(data));
      }
    } catch (e) {
      Logger.warn(`保存泡澡状态失败: ${e}`, 'repair');
    }
  }

  /**
   * 从 localStorage 恢复泡澡状态。
   * 在构造函数中调用，用于 GUI 重启后恢复维修记录。
   */
  private restoreFromStorage(): void {
    try {
      const raw = localStorage.getItem(RepairManager.STORAGE_KEY);
      if (!raw) return;

      const data: Array<{
        key: string;
        name: string;
        startTime: number;
        repairEndTime: number;
        requestSent: boolean;
      }> = JSON.parse(raw);

      if (!Array.isArray(data)) {
        Logger.warn('泡澡状态数据格式异常，已清空', 'repair');
        localStorage.removeItem(RepairManager.STORAGE_KEY);
        return;
      }

      const now = Date.now();
      let restoredCount = 0;

      for (const item of data) {
        if (!item.key || !item.name) continue;
        if (item.repairEndTime > 0 && item.repairEndTime <= now) continue;

        this.bathingShips.set(item.key, {
          name: item.name,
          startTime: item.startTime,
          repairEndTime: item.repairEndTime,
          requestSent: item.requestSent,
        });
        restoredCount++;
      }

      if (restoredCount > 0) {
        Logger.info(
          `从本地存储恢复了 ${restoredCount} 艘泡澡中的舰船，将在下次任务前确认状态`,
          'repair',
        );
      }
    } catch (e) {
      Logger.warn(`恢复泡澡状态失败，已清空: ${e}`, 'repair');
      this.bathingShips.clear();
      localStorage.removeItem(RepairManager.STORAGE_KEY);
    }
  }
}
