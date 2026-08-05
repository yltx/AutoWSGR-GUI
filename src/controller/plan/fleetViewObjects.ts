/** 将舰队持久化 DTO 和领域预设转换为只读展示对象。 */
import { shipFilterLabel } from '../../model/fleet/ShipMatcher.js';
import type {
  FleetPreset,
  ShipFilter,
  ShipRule,
  ShipSlot,
} from '../../types/model.js';
import type {
  PlanPresetSource,
  ShipLibraryManifest,
  UserTeamPlan,
  UserTeamPlanSlot,
} from '../../types/ipc.js';
import type {
  FleetShipLibraryViewObject,
  TeamPlanShipRuleViewObject,
  TeamPlanSlotViewObject,
  TeamPlanViewObject,
} from '../../types/view.js';

function cloneShipRule(rule: ShipRule): ShipRule {
  return {
    ...rule,
    ship_type: rule.ship_type ? [...rule.ship_type] : undefined,
  };
}

function cloneShipSlot(slot: ShipSlot): ShipSlot {
  if (slot === null || typeof slot === 'string') return slot;
  return {
    ...slot,
    candidates: slot.candidates?.map(cloneShipRule),
    ship_type: slot.ship_type ? [...slot.ship_type] : undefined,
  };
}

export function cloneFleetPreset(preset: FleetPreset): FleetPreset {
  return {
    name: preset.name,
    ships: preset.ships.map(cloneShipSlot),
  };
}

function userTeamSlotToShipSlot(slot: UserTeamPlanSlot): ShipFilter {
  return {
    name: slot.name,
    search_name: slot.search_name,
    ship_type: slot.ship_type ? [...slot.ship_type] : undefined,
    candidates: slot.candidates?.map(cloneShipRule),
    min_level: slot.min_level,
    max_level: slot.max_level,
    relaxed: slot.relaxed,
  };
}

export function userTeamPlanToFleetPreset(
  plan: UserTeamPlan,
): FleetPreset {
  return {
    name: plan.name,
    ships: plan.ships.map(userTeamSlotToShipSlot),
  };
}

function toRuleViewObject(
  rule: ShipRule,
  name = rule.name,
): TeamPlanShipRuleViewObject {
  return {
    name,
    searchName: rule.search_name,
    shipTypes: [...(rule.ship_type ?? [])],
    minLevel: rule.min_level,
    maxLevel: rule.max_level,
  };
}

function anonymousPrimaryLabel(filter: ShipFilter): string | null {
  const hasPrimaryRule = Boolean(
    filter.search_name
    || filter.nation
    || filter.ship_type?.length
    || filter.min_level !== undefined
    || filter.max_level !== undefined,
  );
  if (!hasPrimaryRule) return null;
  return shipFilterLabel({
    ...filter,
    candidates: undefined,
  });
}

export function toTeamPlanSlotViewObject(
  slot: ShipSlot,
): TeamPlanSlotViewObject {
  if (slot === null) {
    return {
      candidates: [],
    };
  }
  if (typeof slot === 'string') {
    return {
      primary: toRuleViewObject({ name: slot }),
      candidates: [],
    };
  }

  const primaryName = slot.name
    ?? slot.search_name
    ?? anonymousPrimaryLabel(slot);
  return {
    primary: primaryName
      ? toRuleViewObject(
          {
            name: slot.name ?? primaryName,
            search_name: slot.search_name,
            ship_type: slot.ship_type,
            min_level: slot.min_level,
            max_level: slot.max_level,
            relaxed: slot.relaxed,
          },
          primaryName,
        )
      : undefined,
    candidates: (slot.candidates ?? []).map(candidate => (
      toRuleViewObject(candidate)
    )),
  };
}

export function toTeamPlanViewObject(
  id: string,
  preset: FleetPreset,
  source: PlanPresetSource,
  modifiedAt: number | undefined,
  selected: boolean,
): TeamPlanViewObject {
  return {
    id,
    name: preset.name,
    source,
    modifiedAt,
    selected,
    ships: preset.ships.map(toTeamPlanSlotViewObject),
  };
}

export function toFleetShipLibraryViewObject(
  manifest: ShipLibraryManifest,
): FleetShipLibraryViewObject {
  const ships = manifest.ships.filter(ship => (
    Number.isFinite(ship.id)
    && Boolean(ship.name)
    && Boolean(ship.portraitUrl)
  ));
  return {
    labels: manifest.labels,
    ships,
    colorfulBackgroundUrl: ships.find(
      ship => ship.rarity === 6 && Boolean(ship.backgroundUrl),
    )?.backgroundUrl ?? '',
  };
}
