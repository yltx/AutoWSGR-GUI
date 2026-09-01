/** 加载舰船资料并把当前任务中的舰队规则转换为主页展示对象。 */
import {
  fleetPlannerRepository,
  type FleetPlannerRepository,
} from '../../adapter/IpcAdapter.js';
import type {
  ShipLibraryManifest,
} from '../../types/ipc.js';
import { findShipLibraryShip } from '../../shared/shipLibrary.js';
import type {
  SchedulerTaskRequest,
} from '../../types/scheduler.js';
import type { CurrentFleetShipVO } from '../../types/view.js';

export type CurrentFleetRepository = Pick<
  FleetPlannerRepository,
  'getShipLibraryManifest'
>;

interface RequestedFleetShip {
  readonly name: string;
  readonly searchName?: string;
}

function normalizedShipName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fleetRuleShip(rule: unknown): RequestedFleetShip | null {
  if (typeof rule === 'string') {
    const name = rule.trim();
    return name ? { name } : null;
  }
  if (!rule || typeof rule !== 'object') return null;
  const record = rule as Record<string, unknown>;
  const searchName = normalizedShipName(record['search_name']);
  const name = normalizedShipName(record['name']) || searchName;
  if (!name) return null;
  return searchName && searchName !== name
    ? { name, searchName }
    : { name };
}

function candidateShips(rule: unknown): RequestedFleetShip[] {
  if (!rule || typeof rule !== 'object') return [];
  const candidates = (rule as Record<string, unknown>)['candidates'];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map(fleetRuleShip)
    .filter((ship): ship is RequestedFleetShip => ship !== null);
}

function requestedFleet(
  request: SchedulerTaskRequest,
): RequestedFleetShip[] {
  if (request.type !== 'normal_fight' && request.type !== 'event_fight') {
    return [];
  }
  const rules = Array.isArray(request.plan?.fleet_rules)
    ? request.plan.fleet_rules
    : [];
  const fleet = Array.isArray(request.plan?.fleet)
    ? request.plan.fleet
    : [];
  const slotCount = Math.min(6, Math.max(rules.length, fleet.length));
  const ships: RequestedFleetShip[] = [];
  const usedNames = new Set<string>();
  for (let index = 0; index < slotCount; index += 1) {
    const fleetName = normalizedShipName(fleet[index]);
    const candidates = [
      fleetRuleShip(rules[index]),
      ...(fleetName ? [{ name: fleetName }] : []),
      ...candidateShips(rules[index]),
    ].filter((ship): ship is RequestedFleetShip => ship !== null);
    const ship = candidates.find(candidate => (
      !usedNames.has(candidate.name)
    ));
    if (!ship) continue;
    usedNames.add(ship.name);
    ships.push(ship);
  }
  return ships;
}

/** 主页当前舰队的唯一资料库读取者和 ViewObject 生成器。 */
export class CurrentFleetController {
  private manifest: ShipLibraryManifest | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;

  constructor(
    private readonly repository: CurrentFleetRepository
      = fleetPlannerRepository,
  ) {}

  load(force = false): Promise<void> {
    if (this.loading) return this.loading;
    if (this.loaded && !force) return Promise.resolve();

    this.loading = Promise.resolve()
      .then(() => this.repository.getShipLibraryManifest())
      .then(manifest => {
        this.manifest = manifest;
      })
      .catch(() => {
        this.manifest = null;
      })
      .finally(() => {
        this.loaded = true;
        this.loading = null;
      });
    return this.loading;
  }

  resolve(request: SchedulerTaskRequest): CurrentFleetShipVO[] {
    return requestedFleet(request).map(preview => {
      const ship = findShipLibraryShip(this.manifest?.ships ?? [], {
        name: preview.name,
        searchName: preview.searchName,
        allowBaseNameFallback: true,
      });
      return {
        name: preview.name,
        ship,
        shipTypeLabel: ship
          ? this.manifest?.labels.ship_types[ship.ship_type] ?? ship.ship_type
          : undefined,
      };
    });
  }
}
