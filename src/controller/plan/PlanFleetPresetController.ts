/** 加载计划页舰队目录，并把添加、移除意图转换为新的领域预设列表。 */
import {
  fleetPlannerRepository,
  type FleetPlannerRepository,
} from '../../adapter/IpcAdapter.js';
import {
  fleetPresetIdentityKey,
} from '../../model/fleet/FleetPresetIdentity.js';
import type { FleetPreset } from '../../types/model.js';
import type { PlanPresetSource } from '../../types/ipc.js';
import type {
  FleetPresetCatalogStatus,
  PlanFleetPresetBindingViewObject,
  PlanFleetPresetSelectorViewObject,
} from '../../types/view.js';
import {
  cloneFleetPreset,
  toFleetShipLibraryViewObject,
  toTeamPlanSlotViewObject,
  toTeamPlanViewObject,
  userTeamPlanToFleetPreset,
} from './fleetViewObjects.js';

export type PlanFleetPresetRepository = Pick<
  FleetPlannerRepository,
  'getShipLibraryManifest' | 'listTeamPlans'
>;

interface FleetPresetCatalogRecord {
  readonly id: string;
  readonly preset: FleetPreset;
  readonly source: PlanPresetSource;
  readonly modifiedAt?: number;
}

export class PlanFleetPresetController {
  private readonly idsByIdentity = new Map<string, string>();
  private records: FleetPresetCatalogRecord[] = [];
  private status: FleetPresetCatalogStatus = 'loading';
  private message = '';
  private errorCount = 0;
  private shipLibrary: PlanFleetPresetSelectorViewObject['shipLibrary'] = null;
  private loadVersion = 0;
  private nextId = 1;

  constructor(
    private readonly repository: PlanFleetPresetRepository
      = fleetPlannerRepository,
  ) {}

  async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.status = 'loading';
    this.message = '';

    try {
      const [result, manifest] = await Promise.all([
        this.repository.listTeamPlans(),
        this.shipLibrary
          ? Promise.resolve(null)
          : this.repository.getShipLibraryManifest(),
      ]);
      if (version !== this.loadVersion) return;

      this.records = result.plans.map((plan, index) => {
        const source = plan.source ?? 'user';
        const preset = userTeamPlanToFleetPreset(plan);
        const identity = plan.file
          ? `${source}:${plan.file}`
          : `${source}:missing:${index}:${fleetPresetIdentityKey(preset)}`;
        let id = this.idsByIdentity.get(identity);
        if (!id) {
          id = `plan-team-${this.nextId}`;
          this.nextId += 1;
          this.idsByIdentity.set(identity, id);
        }
        return {
          id,
          preset,
          source,
          modifiedAt: plan.modifiedAt,
        };
      });
      if (manifest) {
        this.shipLibrary = toFleetShipLibraryViewObject(manifest);
      }
      this.errorCount = result.errors.length;
      this.status = 'ready';
    } catch (error) {
      if (version !== this.loadVersion) return;
      this.status = 'error';
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  appendPreset(
    selected: readonly FleetPreset[],
    planId: string,
  ): FleetPreset[] | null {
    const record = this.records.find(item => item.id === planId);
    if (!record) return null;
    const identity = fleetPresetIdentityKey(record.preset);
    if (selected.some(preset => fleetPresetIdentityKey(preset) === identity)) {
      return null;
    }
    return [
      ...selected.map(cloneFleetPreset),
      cloneFleetPreset(record.preset),
    ];
  }

  removePreset(
    selected: readonly FleetPreset[],
    index: number,
  ): FleetPreset[] | null {
    if (index < 0 || index >= selected.length) return null;
    return selected
      .filter((_, presetIndex) => presetIndex !== index)
      .map(cloneFleetPreset);
  }

  /** 使用目录中的最新编队替换当前计划内的同名或已改名引用。 */
  synchronizePreset(
    selected: readonly FleetPreset[],
    newName: string,
    previousName: string | null,
    source: PlanPresetSource,
  ): FleetPreset[] | null {
    const replacement = this.records.find(record => (
      record.source === source
      && record.preset.name === newName
    ));
    if (!replacement) return null;

    const matchedNames = new Set([newName]);
    if (previousName) matchedNames.add(previousName);
    if (!selected.some(preset => matchedNames.has(preset.name))) {
      return null;
    }

    let changed = false;
    let replacementAdded = false;
    const synchronized: FleetPreset[] = [];
    for (const preset of selected) {
      if (!matchedNames.has(preset.name)) {
        synchronized.push(cloneFleetPreset(preset));
        continue;
      }
      if (replacementAdded) {
        changed = true;
        continue;
      }
      const nextPreset = cloneFleetPreset(replacement.preset);
      synchronized.push(nextPreset);
      replacementAdded = true;
      if (
        fleetPresetIdentityKey(preset)
        !== fleetPresetIdentityKey(nextPreset)
      ) {
        changed = true;
      }
    }
    return changed ? synchronized : null;
  }

  toViewObject(
    selected: readonly FleetPreset[],
  ): PlanFleetPresetSelectorViewObject {
    const selectedIdentities = new Set(
      selected.map(fleetPresetIdentityKey),
    );
    const plans = this.records.map(record => toTeamPlanViewObject(
      record.id,
      record.preset,
      record.source,
      record.modifiedAt,
      selectedIdentities.has(fleetPresetIdentityKey(record.preset)),
    ));
    const bindings = selected.map<PlanFleetPresetBindingViewObject>(
      (preset, index) => {
        const identity = fleetPresetIdentityKey(preset);
        const exact = this.records.find(
          record => fleetPresetIdentityKey(record.preset) === identity,
        );
        const sourceRecord = exact ?? this.records.find(
          record => record.preset.name === preset.name,
        );
        return {
          index,
          catalogPlanId: sourceRecord?.id,
          name: preset.name,
          source: sourceRecord?.source ?? 'deleted',
          modifiedAt: sourceRecord?.modifiedAt,
          ships: preset.ships.map(toTeamPlanSlotViewObject),
        };
      },
    );
    return {
      status: this.status,
      message: this.message,
      errorCount: this.errorCount,
      plans,
      bindings,
      shipLibrary: this.shipLibrary,
    };
  }
}
