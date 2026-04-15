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
  ss_or_ssg: '潜艇/导潜',
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
 * 规则：
 *   1) 去掉 "·改" 后缀（改造型在游戏内与原型同名）
 *   2) 去掉尾部括号限定说明（如“(岛风型驱逐舰)”）
 * 例: "飞龙·改" → "飞龙", "岛风(岛风型驱逐舰)·改" → "岛风"
 */
export function toBackendName(displayName: string): string {
  const noRefit = displayName.endsWith('·改') ? displayName.slice(0, -2) : displayName;
  return noRefit.replace(/\s*[（(][^（）()]*[)）]\s*$/, '').trim();
}

// ════════════════════════════════════════
// 模糊匹配 (ShipFilter)
// ════════════════════════════════════════

import type { FleetRuleReq } from '../types/api';
import type { ShipFilter, ShipSlot } from '../types/model';

/** 将 ShipFilter 转为显示标签, 如 "德国 驱逐" */
export function shipFilterLabel(filter: ShipFilter): string {
  const parts: string[] = [];
  if (filter.name) {
    parts.push(filter.name);
  }
  if (filter.nation) parts.push(filter.nation);
  if (filter.ship_type) parts.push(shipTypeLabel(filter.ship_type));
  if (filter.priority && filter.priority.length > 0) {
    parts.push(`优先:${filter.priority.join(' > ')}`);
  }
  if (filter.min_level != null || filter.max_level != null) {
    if (filter.min_level != null && filter.max_level != null) {
      parts.push(`Lv${filter.min_level}-${filter.max_level}`);
    } else if (filter.min_level != null) {
      parts.push(`Lv>=${filter.min_level}`);
    } else if (filter.max_level != null) {
      parts.push(`Lv<=${filter.max_level}`);
    }
  }
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

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function matchShipType(filter: ShipFilter, shipType: string): boolean {
  if (!filter.ship_type) return true;
  if (filter.ship_type === 'ss_or_ssg') return shipType === 'ss' || shipType === 'ssg';
  return shipType === filter.ship_type;
}

function matchesFilter(filter: ShipFilter, ship: ShipInfo): boolean {
  if (filter.nation && ship.nation !== filter.nation) return false;
  if (!matchShipType(filter, ship.ship_type)) return false;
  if (filter.name) {
    if (toBackendName(ship.name) !== toBackendName(filter.name)) {
      return false;
    }
  }
  return true;
}

function sortByPriority(candidates: string[], filter: ShipFilter): string[] {
  if (!filter.priority || filter.priority.length === 0) return candidates;
  const priorityNames = dedupeNames(filter.priority.map(toBackendName));
  const candidateSet = new Set(candidates);
  const front = priorityNames.filter(name => candidateSet.has(name));
  const frontSet = new Set(front);
  return [...front, ...candidates.filter(name => !frontSet.has(name))];
}

function buildShipCandidates(filter: ShipFilter, exclude: string[]): string[] {
  const excludeSet = new Set(exclude.map(toBackendName));
  const matched = ALL_SHIPS.filter(ship => matchesFilter(filter, ship));
  const refit = matched
    .filter(ship => ship.name.endsWith('·改'))
    .map(ship => toBackendName(ship.name))
    .filter(name => !excludeSet.has(name));
  const normal = matched
    .filter(ship => !ship.name.endsWith('·改'))
    .map(ship => toBackendName(ship.name))
    .filter(name => !excludeSet.has(name));

  const candidates = dedupeNames([...refit, ...normal]);

  // 如果是固定舰名规则且数据集中未命中，仍保留该名称用于后端精确尝试。
  if (candidates.length === 0 && filter.name) {
    const normalized = toBackendName(filter.name);
    if (!excludeSet.has(normalized)) {
      candidates.push(normalized);
    }
  }

  return sortByPriority(candidates, filter);
}

/**
 * 解析单个模糊筛选条件，返回匹配的舰船名称。
 * 默认优先选择改造版本 (·改)，可通过 priority 字段调整优先顺序。
 */
export function resolveShipFilter(filter: ShipFilter, exclude: string[]): string | null {
  const candidates = buildShipCandidates(filter, exclude);
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * 解析编队预设中的所有槽位，将 ShipFilter 解析为具体舰船名。
 * 返回纯字符串数组，可直接传给后端。
 */
export function resolveFleetPreset(ships: ShipSlot[]): string[] {
  const resolved: string[] = [];
  for (const slot of ships) {
    if (typeof slot === 'string') {
      resolved.push(toBackendName(slot));
    } else {
      const name = resolveShipFilter(slot, resolved);
      if (name) resolved.push(name);
    }
  }
  return resolved;
}

/**
 * 解析编队预设槽位为后端规则。
 * - 字符串槽位: 直接使用具体舰名
 * - 模糊槽位: 生成候选列表（等级范围暂不下发）
 */
export function resolveFleetPresetRules(ships: ShipSlot[]): Array<string | FleetRuleReq> {
  const rules: Array<string | FleetRuleReq> = [];
  const reserved: string[] = [];

  for (const slot of ships) {
    if (typeof slot === 'string') {
      const name = toBackendName(slot);
      rules.push(name);
      reserved.push(name);
      continue;
    }

    const candidates = buildShipCandidates(slot, reserved);
    if (candidates.length === 0) continue;

    const rule: FleetRuleReq = { candidates };
    if (slot.name) {
      // 保留原始舰名作为搜索关键词，避免同名异型（如大淀）被归一化后无法区分。
      const searchName = String(slot.name).trim();
      if (searchName) rule.search_name = searchName;
    }
    if (slot.ship_type) {
      rule.ship_type = String(slot.ship_type).trim();
    }
    if (slot.min_level != null && Number.isFinite(slot.min_level)) {
      rule.min_level = Math.max(1, Math.floor(slot.min_level));
    }
    if (slot.max_level != null && Number.isFinite(slot.max_level)) {
      rule.max_level = Math.max(1, Math.floor(slot.max_level));
    }
    rules.push(rule);

    // 预留首选项，尽量避免后续槽位重复选中同名舰船。
    reserved.push(candidates[0]);
  }

  return rules;
}
