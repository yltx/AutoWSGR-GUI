/** 在舰队槽位规则和后端 fleet_rules 请求之间转换。 */
import type { FleetRuleReq, FleetShipRuleReq } from '../../types/api.js';
import type { ShipRule, ShipSlot } from '../../types/model.js';
import { buildShipCandidates } from './ShipMatcher.js';
import {
  resolveConfiguredShipSearchName,
  toBackendName,
} from '../../shared/shipNameNormalizer.js';

function toFleetShipRule(
  rule: ShipRule,
  aliases: Readonly<Record<string, string>>,
): FleetShipRuleReq {
  const result: FleetShipRuleReq = { name: rule.name };
  const explicitSearchName = rule.search_name?.trim();
  if (explicitSearchName) {
    result.search_name = explicitSearchName;
  } else {
    const searchName = resolveConfiguredShipSearchName(rule.name, aliases);
    if (searchName !== rule.name.trim()) result.search_name = searchName;
  }
  if (rule.ship_type) result.ship_type = [...rule.ship_type];
  if (rule.min_level != null && Number.isFinite(rule.min_level)) result.min_level = Math.max(1, Math.floor(rule.min_level));
  if (rule.max_level != null && Number.isFinite(rule.max_level)) result.max_level = Math.max(1, Math.floor(rule.max_level));
  if (rule.relaxed === true) result.relaxed = true;
  return result;
}

export function resolveFleetPresetRules(
  ships: ShipSlot[],
  aliases: Readonly<Record<string, string>> = {},
): Array<string | FleetRuleReq> {
  const rules: Array<string | FleetRuleReq> = [];
  const reserved: string[] = [];
  for (const slot of ships) {
    if (slot === null) continue;
    if (typeof slot === 'string') {
      const name = toBackendName(slot);
      const searchName = resolveConfiguredShipSearchName(name, aliases);
      rules.push(searchName === name ? name : { name, search_name: searchName });
      reserved.push(name);
      continue;
    }
    const candidates = buildShipCandidates(slot, reserved);
    if (candidates.length === 0) continue;
    const candidateOnly = !slot.name && (slot.candidates?.length ?? 0) > 0;
    const resolvedPrimary = candidateOnly ? undefined : slot.name ?? candidates[0];
    const rule: FleetRuleReq = {};
    if (resolvedPrimary) rule.name = resolvedPrimary;
    const explicitSearchName = slot.search_name?.trim();
    const searchName = explicitSearchName || (
      resolvedPrimary
        ? resolveConfiguredShipSearchName(resolvedPrimary, aliases)
        : undefined
    );
    if (searchName?.trim()) rule.search_name = searchName.trim();
    if (slot.ship_type) rule.ship_type = [...slot.ship_type];
    if (slot.min_level != null && Number.isFinite(slot.min_level)) rule.min_level = Math.max(1, Math.floor(slot.min_level));
    if (slot.max_level != null && Number.isFinite(slot.max_level)) rule.max_level = Math.max(1, Math.floor(slot.max_level));
    if (slot.relaxed === true) rule.relaxed = true;
    if (slot.candidates?.length) {
      rule.candidates = slot.candidates.map(
        candidate => toFleetShipRule(candidate, aliases),
      );
    }
    rules.push(rule);
    reserved.push(candidates[0]);
  }
  return rules;
}
