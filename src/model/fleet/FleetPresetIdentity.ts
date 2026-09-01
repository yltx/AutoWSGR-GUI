/** 统一编队规则格式，并生成规则标识和“名称 + 规则”的预设身份标识。 */
import type {
  FleetPreset,
  ShipFilter,
  ShipRule,
  ShipSlot,
} from '../../types/model.js';

function normalizeText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function normalizeShipTypes(values: string[] | undefined): string[] | null {
  if (!values || values.length === 0) return null;
  const normalized = [...new Set(
    values.map(value => value.trim()).filter(Boolean),
  )].sort();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRule(rule: ShipRule): Record<string, unknown> {
  return {
    name: rule.name.trim(),
    search_name: normalizeText(rule.search_name),
    ship_type: normalizeShipTypes(rule.ship_type),
    min_level: rule.min_level ?? null,
    max_level: rule.max_level ?? null,
    relaxed: rule.relaxed === true,
  };
}

function normalizeSlot(slot: ShipSlot): unknown {
  if (slot === null) return null;
  if (typeof slot === 'string') {
    return normalizeFilter({ name: slot });
  }
  return normalizeFilter(slot);
}

function normalizeFilter(filter: ShipFilter): Record<string, unknown> {
  return {
    name: normalizeText(filter.name),
    candidates: filter.candidates?.length
      ? filter.candidates.map(normalizeRule)
      : null,
    search_name: normalizeText(filter.search_name),
    nation: normalizeText(filter.nation),
    ship_type: normalizeShipTypes(filter.ship_type),
    min_level: filter.min_level ?? null,
    max_level: filter.max_level ?? null,
    relaxed: filter.relaxed === true,
  };
}

export function fleetPresetRuleKey(
  preset: Pick<FleetPreset, 'ships'>,
): string {
  return JSON.stringify(preset.ships.map(normalizeSlot));
}

export function fleetPresetIdentityKey(
  preset: Pick<FleetPreset, 'name' | 'ships'>,
): string {
  return JSON.stringify([
    preset.name.trim(),
    fleetPresetRuleKey(preset),
  ]);
}
