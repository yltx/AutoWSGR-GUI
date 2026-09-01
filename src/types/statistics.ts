/** 今日出征统计在 Model、Controller 和 View 之间共享的数据结构。 */

export const BATTLE_GRADES = ['SS', 'S', 'A', 'B', 'C', 'D'] as const;

export type BattleGrade = typeof BATTLE_GRADES[number];

export type BattleGradeCounts = Record<BattleGrade, number>;

export interface ShipDropCount {
  name: string;
  count: number;
}

export interface ShipDropNotice {
  shipName: string;
  dailyIndex: number;
  visibleUntil: number;
}

export interface DailySortieStatsSnapshot {
  battleCount: number;
  grades: BattleGradeCounts;
  quickRepairCount: number;
  bathRepairCount: number;
  lootCount: number;
  lootLimit: number;
  shipCount: number;
  shipLimit: number;
  expeditionCount: number;
  shipDrops: ShipDropCount[];
  dropNotice: ShipDropNotice | null;
}
