/**
 * 舰船数据 — 从 yltx/asgrgui 项目 resource/ship_details.json 导入
 * 仅保留 name / nation / ship_type 用于自动补全
 */

export interface ShipInfo {
  name: string;
  nation: string;
  ship_type: string;
}

// ship_type 代号 → 中文
const TYPE_LABELS: Record<string, string> = {
  bb: '战列', bbv: '航战', bbg: '导战',
  bc: '战巡', cbg: '大巡',
  cv: '航母', cvl: '轻母', av: '装母',
  ca: '重巡', cav: '航巡',
  cl: '轻巡', clt: '雷巡', cf: '旗舰',
  dd: '驱逐', ddg: '导驱', ddgaa: '防驱',
  ss: '潜艇', sc: '炮潜', ssg: '导潜',
  bm: '重炮', ap: '补给', cg: '导巡', cgaa: '防巡',
};

export function shipTypeLabel(code: string): string {
  return TYPE_LABELS[code] || code;
}

import rawShips from './ship_details.json';

/** 全部舰船（包含改造版本） */
export const ALL_SHIPS: ShipInfo[] = (rawShips as any[]).map(s => ({
  name: s.name as string,
  nation: s.nation as string,
  ship_type: s.ship_type as string,
}));

/**
 * 将前端显示名转换为后端 API 使用的名称。
 * 规则：去掉 "·改" 后缀（改造型在游戏内与原型同名）。
 * 例: "飞龙·改" → "飞龙", "岛风(岛风型驱逐舰)·改" → "岛风(岛风型驱逐舰)"
 */
export function toBackendName(displayName: string): string {
  return displayName.endsWith('·改') ? displayName.slice(0, -2) : displayName;
}
