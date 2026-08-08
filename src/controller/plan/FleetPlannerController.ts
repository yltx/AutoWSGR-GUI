/** 持有普通舰队草稿并协调舰船库、规则编辑和计划管理。 */
import {
  fleetPlannerRepository,
} from '../../adapter/IpcAdapter';
import type {
  FleetPlannerRepository,
} from '../../adapter/IpcAdapter';
import {
  browserStorageStore,
} from '../../adapter/StorageAdapter';
import type {
  StorageStore,
} from '../../adapter/StorageAdapter';
import {
  createFleetDraft,
  fleetDraftFromTeamPlan,
  fleetDraftSnapshot,
  fleetDraftToTeamPlan,
  hasFleetDraftChanges,
} from '../../model/fleet/FleetDraft';
import type {
  FleetRuleDraft,
} from '../../model/fleet/FleetDraft';
import {
  applyFleetDraftEdit,
} from '../../model/fleet/FleetDraftEditor';
import type {
  BackupFollowMode,
  FleetDraftEditIntent,
  FleetDraftEditResult,
} from '../../types/fleetEditor.js';
import type {
  PlanPresetSource,
  UserTeamPlan,
} from '../../types/ipc.js';
import type {
  FleetDraftViewObject,
  FleetRuleDraftViewObject,
  FleetShipLibraryViewObject,
  FleetSlotDraftViewObject,
  TeamPlanListViewObject,
} from '../../types/view.js';
import {
  FleetPlannerView,
} from '../../view/plan/FleetPlannerView';
import type {
  PlanManagementTaskGroup,
} from './planManagementViewObjects.js';
import {
  toFleetShipLibraryViewObject,
  toTeamPlanViewObject,
  userTeamPlanToFleetPreset,
} from './fleetViewObjects.js';
import {
  PlanManagementController,
} from './PlanManagementController.js';

const REFIT_FILTER_STORAGE_KEY = 'fleetPlannerRefitFilter';
const BACKUP_FOLLOW_MODE_STORAGE_KEY = 'fleetPlannerBackupFollowMode';

export class FleetPlannerController {
  private draft = createFleetDraft();
  private savedDraftSnapshot = fleetDraftSnapshot(this.draft);
  private readonly view: FleetPlannerView;
  private readonly planManagementCtrl: PlanManagementController;
  private readonly teamPlans = new Map<string, UserTeamPlan>();
  private readonly teamPlanIds = new Map<string, string>();
  private shipLibrary: FleetShipLibraryViewObject | null = null;
  private shipLibraryLoading: Promise<void> | null = null;
  private nextTeamPlanId = 1;

  constructor(
    private readonly repository: FleetPlannerRepository
      = fleetPlannerRepository,
    private readonly storage: StorageStore = browserStorageStore,
  ) {
    this.view = new FleetPlannerView({
      loadShipLibrary: force => this.loadShipLibrary(force),
      loadTeamPlans: () => this.loadTeamPlans(),
      saveTeamPlan: name => this.saveTeamPlan(name),
      applyTeamPlan: planId => this.applyTeamPlan(planId),
      getRefitFilter: () => (
        this.storage.get(REFIT_FILTER_STORAGE_KEY) === 'true'
      ),
      setRefitFilter: enabled => (
        this.storage.set(REFIT_FILTER_STORAGE_KEY, String(enabled))
      ),
      getBackupFollowMode: (): BackupFollowMode => (
        this.storage.get(BACKUP_FOLLOW_MODE_STORAGE_KEY) === 'position'
          ? 'position'
          : 'ship'
      ),
      setBackupFollowMode: mode => (
        this.storage.set(BACKUP_FOLLOW_MODE_STORAGE_KEY, mode)
      ),
      currentDraft: () => this.toFleetDraftViewObject(),
      editDraft: intent => this.editDraft(intent),
      setDraftName: name => {
        this.draft.name = name;
      },
      resetDraft: () => this.resetDraft(),
      hasUnsavedDraftChanges: name => hasFleetDraftChanges(
        {
          ...this.draft,
          name,
        },
        this.savedDraftSnapshot,
      ),
    });
    this.planManagementCtrl = new PlanManagementController(repository);
    this.planManagementCtrl.onOpenTeamPlan = (
      file,
      source,
    ) => this.openTeamPlan(file, source);
  }

  set onOpenBattlePlan(
    handler: (
      (file: string, source: PlanPresetSource) => Promise<void>
    ) | null,
  ) {
    this.planManagementCtrl.onOpenBattlePlan = handler;
  }

  setTaskGroupsProvider(
    provider: () => ReadonlyArray<PlanManagementTaskGroup>,
  ): void {
    this.planManagementCtrl.setTaskGroupsProvider(provider);
  }

  load(force = false): Promise<void> {
    return this.loadShipLibrary(force);
  }

  loadManagement(): Promise<void> {
    return this.planManagementCtrl.load();
  }

  private loadShipLibrary(force: boolean): Promise<void> {
    if (this.shipLibraryLoading) return this.shipLibraryLoading;
    if (this.shipLibrary && !force) {
      this.view.showShipLibrary(this.shipLibrary);
      return Promise.resolve();
    }

    this.view.showShipLibraryLoading();
    this.shipLibraryLoading = this.repository.getShipLibraryManifest()
      .then(manifest => {
        this.shipLibrary = toFleetShipLibraryViewObject(manifest);
        this.view.showShipLibrary(this.shipLibrary);
      })
      .catch(error => {
        this.view.showShipLibraryError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        this.shipLibraryLoading = null;
      });
    return this.shipLibraryLoading;
  }

  private toFleetRuleViewObject(
    rule: FleetRuleDraft,
  ): FleetRuleDraftViewObject {
    return {
      shipTypes: [...rule.shipTypes],
      levelEnabled: rule.levelEnabled,
      minLevel: rule.minLevel,
      maxLevel: rule.maxLevel,
      relaxed: rule.relaxed,
    };
  }

  private toFleetDraftViewObject(): FleetDraftViewObject {
    return {
      name: this.draft.name,
      slots: this.draft.slots.map((slot): FleetSlotDraftViewObject => ({
        primary: slot.primary,
        candidates: slot.candidates.map(candidate => ({
          ship: candidate.ship,
          ...this.toFleetRuleViewObject(candidate),
        })),
        ...this.toFleetRuleViewObject(slot),
      })),
    };
  }

  private editDraft(intent: FleetDraftEditIntent): FleetDraftEditResult {
    return applyFleetDraftEdit(this.draft, intent);
  }

  private async loadTeamPlans(): Promise<TeamPlanListViewObject> {
    const result = await this.repository.listTeamPlans();
    this.teamPlans.clear();
    const plans = result.plans.map((plan, index) => {
      const source = plan.source ?? 'user';
      const identity = this.teamPlanIdentity(
        source,
        plan.file ?? `missing-${index}-${plan.name}`,
      );
      let id = this.teamPlanIds.get(identity);
      if (!id) {
        id = `team-plan-${this.nextTeamPlanId}`;
        this.nextTeamPlanId += 1;
        this.teamPlanIds.set(identity, id);
      }
      this.teamPlans.set(id, plan);
      const selected = Boolean(
        plan.file
        && this.draft.file
        && source === this.draft.source
        && this.teamPlanIdentity(source, plan.file)
          === this.teamPlanIdentity(this.draft.source, this.draft.file),
      );
      return toTeamPlanViewObject(
        id,
        userTeamPlanToFleetPreset(plan),
        source,
        plan.modifiedAt,
        selected,
      );
    });
    return {
      plans,
      errorCount: result.errors.length,
    };
  }

  private async saveTeamPlan(rawName: string): Promise<void> {
    try {
      const plan = fleetDraftToTeamPlan(this.draft, rawName);
      const currentFile = this.draft.file ?? undefined;
      const currentSource = this.draft.source;
      let result = await this.repository.saveUserTeamPlan(
        plan,
        false,
        currentFile,
        currentSource,
      );
      if (result.exists) {
        if (!await this.view.confirmTeamPlanOverwrite()) return;
        result = await this.repository.saveUserTeamPlan(
          plan,
          true,
          currentFile,
          currentSource,
        );
      }
      if (!result.success) {
        throw new Error(result.error || '保存失败');
      }

      this.draft.name = plan.name;
      this.draft.file = result.file ?? result.plan?.file ?? null;
      this.draft.source = result.plan?.source ?? 'user';
      this.savedDraftSnapshot = fleetDraftSnapshot(this.draft);
      this.view.showDraftName(plan.name);
      this.view.showTeamPlanSaved(plan.name);
    } catch (error) {
      await this.view.showTeamPlanSaveError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async applyTeamPlan(
    planId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const plan = this.teamPlans.get(planId);
    if (!plan) {
      return {
        success: false,
        error: '未找到对应的舰队方案',
      };
    }
    try {
      this.draft = fleetDraftFromTeamPlan(
        plan,
        this.shipLibrary?.ships ?? [],
      );
      this.savedDraftSnapshot = fleetDraftSnapshot(this.draft);
      this.view.showDraft(this.draft.name);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async openTeamPlan(
    file: string,
    source: PlanPresetSource,
  ): Promise<void> {
    await this.loadShipLibrary(false);
    await this.loadTeamPlans();
    const id = this.teamPlanIds.get(this.teamPlanIdentity(source, file));
    if (!id || !this.teamPlans.has(id)) {
      await this.view.showTeamPlanLoadError('未找到对应的舰队方案');
      return;
    }
    await this.view.openTeamPlan(id);
  }

  private resetDraft(): void {
    this.draft = createFleetDraft();
    this.savedDraftSnapshot = fleetDraftSnapshot(this.draft);
  }

  private teamPlanIdentity(
    source: PlanPresetSource,
    file: string,
  ): string {
    return `${source}:${file.trim().toLocaleLowerCase('en-US')}`;
  }
}
