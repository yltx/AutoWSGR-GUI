/** 解析舰队预设、匹配舰船规则并生成槽位显示文本。 */
import type { ShipFilter, ShipSlot } from '../../types/model.js';
import { shipTypeLabel } from '../../shared/fleetShipTypes.js';
import { ALL_SHIPS, type ShipInfo } from '../../shared/shipCatalog.js';
import { toBackendName } from '../../shared/shipNameNormalizer.js';

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter(name => name && !seen.has(name) && seen.add(name));
}

function matchShipType(filter: ShipFilter, shipType: string): boolean {
  if (!filter.ship_type || filter.ship_type.length === 0) return true;
  return filter.ship_type.some(rule => rule === 'ss_or_ssg'
    ? shipType === 'ss' || shipType === 'ssg'
    : shipType === rule);
}

function matchesFilter(filter: ShipFilter, ship: ShipInfo): boolean {
  if (filter.nation && ship.nation !== filter.nation) return false;
  if (!matchShipType(filter, ship.ship_type)) return false;
  return !filter.name || toBackendName(ship.name) === toBackendName(filter.name);
}

export function buildShipCandidates(filter: ShipFilter, exclude: string[] = []): string[] {
  const excluded = new Set(exclude.map(toBackendName));
  const matched = ALL_SHIPS.filter(ship => matchesFilter(filter, ship));
  const refit = matched.filter(ship => ship.name.endsWith('·改')).map(ship => toBackendName(ship.name));
  const normal = matched.filter(ship => !ship.name.endsWith('·改')).map(ship => toBackendName(ship.name));
  const candidates = dedupeNames([...refit, ...normal]).filter(name => !excluded.has(name));
  if (candidates.length === 0 && filter.name) {
    const normalized = toBackendName(filter.name);
    if (!excluded.has(normalized)) candidates.push(normalized);
  }
  return candidates;
}

export function resolveShipFilter(filter: ShipFilter, exclude: string[] = []): string | null {
  return buildShipCandidates(filter, exclude)[0] ?? null;
}

export function resolveFleetPreset(ships: ShipSlot[]): string[] {
  const resolved: string[] = [];
  for (const slot of ships) {
    if (slot === null) continue;
    if (typeof slot === 'string') resolved.push(toBackendName(slot));
    else {
      const name = resolveShipFilter(slot, resolved);
      if (name) resolved.push(name);
    }
  }
  return resolved;
}

export function shipFilterLabel(filter: ShipFilter): string {
  const parts: string[] = [];
  if (filter.name) parts.push(filter.name);
  else if (filter.search_name) parts.push(filter.search_name);
  if (filter.nation) parts.push(filter.nation);
  if (filter.ship_type) {
    parts.push(filter.ship_type.map(shipTypeLabel).join('/'));
  }
  if (filter.candidates?.length) {
    parts.push(
      `备选:${filter.candidates.map(rule => rule.name).join(' > ')}`,
    );
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

export function isShipFilter(slot: ShipSlot): slot is ShipFilter {
  return typeof slot === 'object' && slot !== null;
}

export function shipSlotLabel(slot: ShipSlot): string {
  if (slot === null) return '空';
  return isShipFilter(slot) ? shipFilterLabel(slot) : slot;
}
