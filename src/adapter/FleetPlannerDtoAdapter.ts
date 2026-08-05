/** 在 Electron IPC DTO 与 renderer 编队领域合同之间显式转换。 */
import type {
  FleetShip,
  FleetShipLibrary,
  FleetTeamPlan,
  FleetTeamPlanListResult,
  FleetTeamPlanSaveResult,
  FleetTeamPlanSlot,
  FleetTeamShipRule,
} from '../types/fleet.js';
import type {
  ShipLibraryManifest,
  ShipLibraryShip,
  UserTeamPlan,
  UserTeamPlanListResult,
  UserTeamPlanResult,
  UserTeamPlanSlot,
  UserTeamShipRule,
} from '../types/ipc.js';

function copyExtensions(
  value: object,
  knownKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const known = new Set(knownKeys);
  const entries = Object.entries(value).filter(
    ([key, entry]) => !known.has(key) && entry !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toFleetShip(ship: ShipLibraryShip): FleetShip {
  return {
    id: ship.id,
    name: ship.name,
    searchName: ship.search_name,
    variant: ship.variant,
    rarity: ship.rarity,
    shipType: ship.ship_type,
    sizeClass: ship.size_class,
    roleClass: ship.role_class,
    country: ship.country,
    portraitUrl: ship.portraitUrl,
    backgroundUrl: ship.backgroundUrl,
    frameUrl: ship.frameUrl,
    typeIconUrl: ship.typeIconUrl,
    wikiUrl: ship.wiki_url,
  };
}

export function toFleetShipLibrary(
  manifest: ShipLibraryManifest,
): FleetShipLibrary {
  return {
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    labels: {
      locale: manifest.labels.locale,
      shipTypes: { ...manifest.labels.ship_types },
      sizeClasses: { ...manifest.labels.size_classes },
      roleClasses: { ...manifest.labels.role_classes },
      countries: { ...manifest.labels.countries },
      variants: { ...manifest.labels.variants },
    },
    typeGroups: {
      sizeClasses: { ...manifest.typeGroups.size_classes },
      roleClasses: { ...manifest.typeGroups.role_classes },
    },
    ships: manifest.ships.map(toFleetShip),
  };
}

function toFleetTeamShipRule(
  rule: UserTeamShipRule,
): FleetTeamShipRule {
  return {
    name: rule.name,
    searchName: rule.search_name,
    shipTypes: rule.ship_type ? [...rule.ship_type] : undefined,
    minLevel: rule.min_level,
    maxLevel: rule.max_level,
    extensions: copyExtensions(rule, [
      'name',
      'search_name',
      'ship_type',
      'min_level',
      'max_level',
    ]),
  };
}

function toFleetTeamPlanSlot(
  slot: UserTeamPlanSlot,
): FleetTeamPlanSlot {
  return {
    name: slot.name,
    searchName: slot.search_name,
    shipTypes: slot.ship_type ? [...slot.ship_type] : undefined,
    minLevel: slot.min_level,
    maxLevel: slot.max_level,
    candidates: slot.candidates?.map(toFleetTeamShipRule),
    extensions: copyExtensions(slot, [
      'name',
      'search_name',
      'ship_type',
      'min_level',
      'max_level',
      'candidates',
    ]),
  };
}

export function toFleetTeamPlan(plan: UserTeamPlan): FleetTeamPlan {
  return {
    file: plan.file,
    name: plan.name,
    ships: plan.ships.map(toFleetTeamPlanSlot),
    source: plan.source,
    modifiedAt: plan.modifiedAt,
    extensions: copyExtensions(plan, [
      'file',
      'name',
      'ships',
      'source',
      'modifiedAt',
    ]),
  };
}

function toUserTeamShipRule(
  rule: FleetTeamShipRule,
): UserTeamShipRule {
  return {
    ...rule.extensions,
    name: rule.name,
    search_name: rule.searchName,
    ship_type: rule.shipTypes ? [...rule.shipTypes] : undefined,
    min_level: rule.minLevel,
    max_level: rule.maxLevel,
  };
}

function toUserTeamPlanSlot(
  slot: FleetTeamPlanSlot,
): UserTeamPlanSlot {
  return {
    ...slot.extensions,
    name: slot.name,
    search_name: slot.searchName,
    ship_type: slot.shipTypes ? [...slot.shipTypes] : undefined,
    min_level: slot.minLevel,
    max_level: slot.maxLevel,
    candidates: slot.candidates?.map(toUserTeamShipRule),
  };
}

export function toUserTeamPlanDto(plan: FleetTeamPlan): UserTeamPlan {
  return {
    ...plan.extensions,
    file: plan.file,
    name: plan.name,
    ships: plan.ships.map(toUserTeamPlanSlot),
    source: plan.source,
    modifiedAt: plan.modifiedAt,
  };
}

export function toFleetTeamPlanSaveResult(
  result: UserTeamPlanResult,
): FleetTeamPlanSaveResult {
  return {
    success: result.success,
    exists: result.exists,
    file: result.file,
    plan: result.plan ? toFleetTeamPlan(result.plan) : undefined,
    error: result.error,
  };
}

export function toFleetTeamPlanListResult(
  result: UserTeamPlanListResult,
): FleetTeamPlanListResult {
  return {
    plans: result.plans.map(toFleetTeamPlan),
    errors: result.errors.map(error => ({
      file: error.file,
      source: error.source,
      kind: error.kind,
      message: error.message,
    })),
  };
}
