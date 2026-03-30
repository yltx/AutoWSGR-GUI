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
export const TYPE_LABELS: Record<string, string> = {
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

/** 所有出现过的国籍（去重，常用国家在前） */
export const ALL_NATIONS: string[] = (() => {
  const priority = ['中国', '日本', '德国', '美国', '英国', '苏联', '法国', '意大利'];
  const all = [...new Set(ALL_SHIPS.map(s => s.nation))];
  return [...priority.filter(n => all.includes(n)), ...all.filter(n => !priority.includes(n))];
})();

/**
 * 将前端显示名转换为后端 API 使用的名称。
 * 规则：去掉 "·改" 后缀（改造型在游戏内与原型同名）。
 * 例: "飞龙·改" → "飞龙", "岛风(岛风型驱逐舰)·改" → "岛风(岛风型驱逐舰)"
 */
export function toBackendName(displayName: string): string {
  return displayName.endsWith('·改') ? displayName.slice(0, -2) : displayName;
}

// ════════════════════════════════════════
// 模糊匹配 (ShipFilter)
// ════════════════════════════════════════

import type { ShipFilter, ShipSlot } from '../types/model';

/** 将 ShipFilter 转为显示标签, 如 "德国 驱逐" */
export function shipFilterLabel(filter: ShipFilter): string {
  const parts: string[] = [];
  if (filter.nation) parts.push(filter.nation);
  if (filter.ship_type) parts.push(shipTypeLabel(filter.ship_type));
  return parts.join(' ') || '任意舰船';
}

/** 判断 ShipSlot 是否为 ShipFilter 对象 */
export function isShipFilter(slot: ShipSlot): slot is ShipFilter {
  return typeof slot === 'object' && slot !== null;
}

/** 将 ShipSlot 转为显示文本 */
export function shipSlotLabel(slot: ShipSlot): string {
  return isShipFilter(slot) ? shipFilterLabel(slot) : slot;
}

/**
 * 解析单个模糊筛选条件，返回匹配的舰船名称。
 * 优先选择改造版本 (·改)。
 */
export function resolveShipFilter(filter: ShipFilter, exclude: string[]): string | null {
  const excludeSet = new Set(exclude);
  // 优先改造型
  const reformed = ALL_SHIPS.find(s => {
    if (excludeSet.has(s.name)) return false;
    if (!s.name.endsWith('·改')) return false;
    if (filter.nation && s.nation !== filter.nation) return false;
    if (filter.ship_type && s.ship_type !== filter.ship_type) return false;
    return true;
  });
  if (reformed) return reformed.name;
  // 退回普通型
  return ALL_SHIPS.find(s => {
    if (excludeSet.has(s.name)) return false;
    if (filter.nation && s.nation !== filter.nation) return false;
    if (filter.ship_type && s.ship_type !== filter.ship_type) return false;
    return true;
  })?.name ?? null;
}

/**
 * 解析编队预设中的所有槽位，将 ShipFilter 解析为具体舰船名。
 * 返回纯字符串数组，可直接传给后端。
 */
export function resolveFleetPreset(ships: ShipSlot[]): string[] {
  const resolved: string[] = [];
  for (const slot of ships) {
    if (typeof slot === 'string') {
      resolved.push(slot);
    } else {
      const name = resolveShipFilter(slot, resolved);
      if (name) resolved.push(name);
    }
  }
  return resolved;
}
