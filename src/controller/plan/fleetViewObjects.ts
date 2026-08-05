/** 将编队领域对象转换为只读展示对象。 */
import { shipTypeLabel } from '../../shared/fleetShipTypes.js';
import type {
  FleetPlanSource,
  FleetShip,
  FleetShipLibrary,
  FleetTeamPlan,
  FleetTeamPlanSlot,
  FleetTeamShipRule,
} from '../../types/fleet.js';
import type {
  FleetShipLibraryViewObject,
  FleetShipViewObject,
  TeamPlanShipRuleViewObject,
  TeamPlanSlotViewObject,
  TeamPlanViewObject,
} from '../../types/view.js';

function toRuleViewObject(
  rule: FleetTeamShipRule,
  name = rule.name,
): TeamPlanShipRuleViewObject {
  return {
    name,
    searchName: rule.searchName,
    shipTypes: [...(rule.shipTypes ?? [])],
    minLevel: rule.minLevel,
    maxLevel: rule.maxLevel,
  };
}

function anonymousPrimaryLabel(slot: FleetTeamPlanSlot): string | null {
  const labels: string[] = [];
  if (slot.shipTypes?.length) {
    labels.push(slot.shipTypes.map(shipTypeLabel).join('/'));
  }
  if (slot.minLevel !== undefined) {
    labels.push(`等级不低于 ${slot.minLevel}`);
  }
  if (slot.maxLevel !== undefined) {
    labels.push(`等级不高于 ${slot.maxLevel}`);
  }
  return labels.length > 0 ? labels.join('，') : null;
}

export function toTeamPlanSlotViewObject(
  slot: FleetTeamPlanSlot,
): TeamPlanSlotViewObject {
  const primaryName = slot.name
    ?? slot.searchName
    ?? anonymousPrimaryLabel(slot);
  return {
    primary: primaryName
      ? toRuleViewObject(
          {
            name: slot.name ?? primaryName,
            searchName: slot.searchName,
            shipTypes: slot.shipTypes,
            minLevel: slot.minLevel,
            maxLevel: slot.maxLevel,
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
  plan: FleetTeamPlan,
  source: FleetPlanSource,
  modifiedAt: number | undefined,
  selected: boolean,
): TeamPlanViewObject {
  return {
    id,
    name: plan.name,
    source,
    modifiedAt,
    selected,
    ships: plan.ships.map(toTeamPlanSlotViewObject),
  };
}

export function toFleetShipViewObject(
  ship: FleetShip,
): FleetShipViewObject {
  return {
    id: ship.id,
    name: ship.name,
    searchName: ship.searchName,
    variant: ship.variant,
    rarity: ship.rarity,
    shipType: ship.shipType,
    sizeClass: ship.sizeClass,
    roleClass: ship.roleClass,
    country: ship.country,
    portraitUrl: ship.portraitUrl,
    backgroundUrl: ship.backgroundUrl,
    frameUrl: ship.frameUrl,
    typeIconUrl: ship.typeIconUrl,
    wikiUrl: ship.wikiUrl,
  };
}

export function toFleetShipLibraryViewObject(
  library: FleetShipLibrary,
): FleetShipLibraryViewObject {
  const ships = library.ships.filter(ship => (
    Number.isFinite(ship.id)
    && Boolean(ship.name)
    && Boolean(ship.portraitUrl)
  )).map(toFleetShipViewObject);
  return {
    labels: {
      locale: library.labels.locale,
      shipTypes: { ...library.labels.shipTypes },
      sizeClasses: { ...library.labels.sizeClasses },
      roleClasses: { ...library.labels.roleClasses },
      countries: { ...library.labels.countries },
      variants: { ...library.labels.variants },
    },
    ships,
    colorfulBackgroundUrl: ships.find(
      ship => ship.rarity === 6 && Boolean(ship.backgroundUrl),
    )?.backgroundUrl ?? '',
  };
}
