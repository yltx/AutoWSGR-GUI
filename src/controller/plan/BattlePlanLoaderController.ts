/** 管理受管作战方案选择器的加载、筛选、选择和结果返回流程。 */
import type {
  ManagedBattlePlan,
  ManagedBattlePlanSelection,
  ManagedTeamPlan,
  PlanPresetSource,
  PlanTeamBinding,
} from '../../types/ipc.js';
import type { NormalFightTaskConfig } from '../../types/model.js';
import {
  lootAutomationPlanKey,
  normalizeLootAutomationPlans,
  type LootAutomationPlan,
} from '../../shared/lootPlans.js';
import {
  normalFightDailyLimit,
} from '../../model/scheduler/NormalFightDailyQuota.js';
import {
  BattlePlanLoaderView,
  type BattlePlanLoaderPurpose,
  type BattlePlanSortField,
} from '../../view/plan/BattlePlanLoaderView';
import { Logger } from '../../utils/Logger';
import {
  showAlert,
  showConfirm,
  showSaveSuccess,
} from '../../view/shared/DialogHelper';
import {
  getManagedCombatPlanRepository,
  type ManagedCombatPlanRepository,
} from '../../adapter/IpcAdapter';

export interface BattlePlanLoaderHost {
  getCurrentPlanIdentity(): {
    file: string | null;
    source: PlanPresetSource;
  };
  openManagedPlan(file: string, source: PlanPresetSource): Promise<boolean>;
}

export class BattlePlanLoaderController {
  private plans: ManagedBattlePlan[] = [];
  private selectedPlan: ManagedBattlePlan | null = null;
  private selectedFleetIndex: number | null = null;
  private automationDailyMax = 1;
  private automationInitialTask: NormalFightTaskConfig | null = null;
  private sortField: BattlePlanSortField = 'modifiedAt';
  private purpose: BattlePlanLoaderPurpose = 'editor';
  private resolveSelection: (
    (selection: ManagedBattlePlanSelection | null) => void
  ) | null = null;
  private lootPlanDraft: LootAutomationPlan[] = [];
  private resolveLootPlans: (
    (plans: LootAutomationPlan[] | null) => void
  ) | null = null;

  constructor(
    private readonly view: BattlePlanLoaderView,
    private readonly host: BattlePlanLoaderHost,
    private readonly repository: ManagedCombatPlanRepository | undefined =
      getManagedCombatPlanRepository(),
  ) {}

  bindActions(): void {
    this.view.bindActions({
      onCancel: () => this.close(),
      onImportLocal: () => void this.importLocal(),
      onRefresh: () => void this.refresh(),
      onFiltersChange: () => this.render(),
      onSortFieldChange: (field) => {
        this.sortField = field;
        this.view.setSortField(field);
        this.render();
      },
      onSelectPlan: (file, source) => this.selectPlan(file, source),
      onSelectFleet: (index) => this.selectFleet(index),
      onAutomationDailyMaxChange: (value) => {
        this.automationDailyMax = normalFightDailyLimit(value);
        return this.automationDailyMax;
      },
      onAddLootPlan: (file, source) => this.addLootPlan(file, source),
      onDeleteLootPlan: (source, file) => {
        void this.deleteLootPlan(source, file);
      },
      onConfirm: () => void this.confirm(),
    });
    this.view.setSortField(this.sortField);
  }

  openForEditor(): Promise<void> {
    this.finishSelection(null);
    this.purpose = 'editor';
    this.selectedFleetIndex = null;
    this.automationInitialTask = null;
    this.prepareAndOpen();
    return this.refresh().then(() => this.view.focusSearch());
  }

  pick(
    purpose: Exclude<
      BattlePlanLoaderPurpose,
      'editor' | 'loot-automation'
    >,
    currentAutomationTask?: NormalFightTaskConfig,
  ): Promise<ManagedBattlePlanSelection | null> {
    this.finishSelection(null);
    this.purpose = purpose;
    this.selectedFleetIndex = null;
    this.automationInitialTask = purpose === 'automation'
      && currentAutomationTask
      ? structuredClone(currentAutomationTask)
      : null;
    this.automationDailyMax = normalFightDailyLimit(
      this.automationInitialTask?.times,
    );
    this.prepareAndOpen();
    void this.refresh().then(() => this.view.focusSearch());
    return new Promise((resolve) => {
      this.resolveSelection = resolve;
    });
  }

  pickLootPlans(
    currentPlans: readonly LootAutomationPlan[],
  ): Promise<LootAutomationPlan[] | null> {
    this.finishSelection(null);
    this.finishLootPlans(null);
    this.purpose = 'loot-automation';
    this.selectedFleetIndex = null;
    this.automationInitialTask = null;
    this.lootPlanDraft = normalizeLootAutomationPlans(currentPlans, []);
    this.prepareAndOpen();
    void this.refresh().then(() => this.view.focusSearch());
    return new Promise((resolve) => {
      this.resolveLootPlans = resolve;
    });
  }

  private prepareAndOpen(): void {
    this.view.setPurposeCopy(this.purpose);
    this.view.resetSearch();
    this.view.open();
  }

  private close(): void {
    this.view.close();
    this.finishSelection(null);
    this.finishLootPlans(null);
    this.selectedFleetIndex = null;
    this.automationInitialTask = null;
    this.purpose = 'editor';
    this.view.setPurposeCopy(this.purpose);
  }

  private finishSelection(
    selection: ManagedBattlePlanSelection | null,
  ): void {
    const resolve = this.resolveSelection;
    this.resolveSelection = null;
    resolve?.(selection);
  }

  private finishLootPlans(plans: LootAutomationPlan[] | null): void {
    const resolve = this.resolveLootPlans;
    this.resolveLootPlans = null;
    resolve?.(plans);
  }

  private async importLocal(): Promise<void> {
    if (!this.repository?.importLocalCombatPlan) {
      await showAlert('导入失败', '请完整重启 GUI 后再操作');
      return;
    }
    this.view.setImportLoading(true);
    try {
      const result = await this.repository.importLocalCombatPlan();
      if (result.canceled) return;
      if (!result.success || !result.file) {
        throw new Error(result.error || '本地 YAML 导入失败');
      }

      await this.refresh();
      const imported = this.plans.find(plan => (
        plan.source === 'user' && plan.file === result.file
      ));
      if (imported) this.selectPlan(imported.file, imported.source);
      Logger.info(`本地出征计划已升级并导入: ${result.file}`);
      showSaveSuccess(
        result.kind === 'preset'
          ? '已添加本地任务预设'
          : `已添加本地 YAML，并升级 ${
            result.teamFiles?.length ?? 0
          } 支关联编队`,
      );
    } catch (error) {
      await showAlert(
        '导入失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.view.setImportLoading(false);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.repository?.getPlanManagement) {
      this.view.setStatus('请完整重启 GUI 后再操作');
      return;
    }
    this.view.setStatus('正在读取作战计划...');
    try {
      const result = await this.repository.getPlanManagement();
      const detailedPlans = (
        result as typeof result & { battlePlans?: ManagedBattlePlan[] }
      ).battlePlans;
      const compatibilityMode = !Array.isArray(detailedPlans)
        || detailedPlans.some(plan => (
          !Array.isArray(plan.fleets)
          || typeof plan.fleetId !== 'number'
        ));
      this.plans = compatibilityMode
        ? this.plansFromBindings(result.bindings, result.teamPlans)
        : detailedPlans;
      const visiblePlans = this.visiblePlans();
      const current = this.host.getCurrentPlanIdentity();
      const initialAutomationTask = this.automationInitialTask;
      const currentAutomationPlan = initialAutomationTask
        ? visiblePlans.find(plan => (
            this.matchesAutomationTask(plan, initialAutomationTask)
          ))
        : null;
      this.selectedPlan = currentAutomationPlan ?? visiblePlans.find(plan => (
        Boolean(current.file)
        && plan.file === current.file
        && plan.source === current.source
      )) ?? visiblePlans[0] ?? null;
      this.resetFleetSelection(this.selectedPlan);
      this.resetAutomationDailyMax(this.selectedPlan);
      this.view.setCount(this.plans.length);
      const errorCount = result.errors.filter(
        error => error.kind === 'battle',
      ).length;
      const message = compatibilityMode
        ? '当前主进程未更新，已显示基础列表；完整重启 GUI 后显示计划摘要'
        : errorCount > 0
          ? `${errorCount} 个 YAML 无法读取，已从列表中排除`
          : '';
      this.view.setStatus(message);
      this.render();
    } catch (error) {
      this.plans = [];
      this.selectedPlan = null;
      this.selectedFleetIndex = null;
      this.view.setStatus(
        `读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
      this.render();
    }
  }

  private plansFromBindings(
    bindings: PlanTeamBinding[],
    teamPlans: ManagedTeamPlan[],
  ): ManagedBattlePlan[] {
    const plans = new Map<string, ManagedBattlePlan>();
    bindings.forEach((binding) => {
      const key = `${binding.source}/${binding.planFile}`;
      const existing = plans.get(key);
      if (existing) {
        if (binding.teamName) {
          existing.fleets.push(this.compatibilityFleetSummary(
            binding.teamName,
            binding.source,
            teamPlans,
          ));
          existing.fleetCount = existing.fleets.length;
        }
        return;
      }
      const fleets = binding.teamName
        ? [this.compatibilityFleetSummary(
          binding.teamName,
          binding.source,
          teamPlans,
        )]
        : [];
      plans.set(key, {
        kind: 'battle',
        file: binding.planFile,
        name: binding.planName,
        source: binding.source,
        modifiedAt: 0,
        chapter: '?',
        map: '?',
        times: 0,
        gap: 0,
        fleetId: 1,
        repairMode: 1,
        result: null,
        lootCountGe: -1,
        shipCountGe: -1,
        fleetCount: fleets.length,
        nodeCount: 0,
        fleets,
      });
    });
    return [...plans.values()];
  }

  private compatibilityFleetSummary(
    name: string,
    battleSource: PlanPresetSource,
    teamPlans: ManagedTeamPlan[],
  ): ManagedBattlePlan['fleets'][number] {
    const matchingPlan = teamPlans.find(plan => (
      plan.name === name && plan.source === battleSource
    )) ?? teamPlans.find(plan => plan.name === name);
    return {
      name,
      source: matchingPlan?.source ?? 'deleted',
      primaryCount: 0,
      backupCount: 0,
    };
  }

  private visiblePlans(): ManagedBattlePlan[] {
    const filters = this.view.getFilters();
    const direction = filters.ascending ? 1 : -1;
    return this.plans
      .filter(plan => (
        (
          this.purpose !== 'automation'
          && this.purpose !== 'loot-automation'
        )
        || plan.kind === 'battle'
      ))
      .filter(plan => !filters.excludeSystem || plan.source !== 'system')
      .filter((plan) => {
        if (!filters.keyword) return true;
        return [
          plan.name,
          plan.file,
          String(plan.chapter),
          String(plan.map),
          `${plan.chapter}-${plan.map}`,
          plan.taskType ?? '',
          plan.campaignName ?? '',
        ].some(value => (
          value.toLocaleLowerCase('zh-CN').includes(filters.keyword)
        ));
      })
      .sort((left, right) => {
        const result = this.sortField === 'name'
          ? left.name.localeCompare(right.name, 'zh-CN')
          : left.modifiedAt - right.modifiedAt;
        return (
          result || left.name.localeCompare(right.name, 'zh-CN')
        ) * direction;
      });
  }

  private render(): void {
    const visiblePlans = this.visiblePlans();
    const previousSelection = this.selectedPlan;
    if (
      !this.selectedPlan
      || !visiblePlans.some(plan => (
        this.samePlan(plan, this.selectedPlan)
      ))
    ) {
      this.selectedPlan = visiblePlans[0] ?? null;
    }
    if (!this.samePlan(this.selectedPlan, previousSelection)) {
      this.resetFleetSelection(this.selectedPlan);
      this.resetAutomationDailyMax(this.selectedPlan);
    }
    const fleetSelectionEnabled = this.isPickingWithFleet();
    const requiresFleetSelection = this.selectedPlan
      ? this.requiresFleetSelection(this.selectedPlan)
      : false;
    this.view.render({
      plans: visiblePlans,
      totalPlanCount: this.plans.length,
      selectedPlan: this.selectedPlan,
      selectedFleetIndex: this.selectedFleetIndex,
      purpose: this.purpose,
      lootPlans: this.lootPlanDraft,
      automationDailyMax: this.automationDailyMax,
      fleetSelectionEnabled,
      confirmEnabled: (
        this.purpose === 'loot-automation'
        || (
          this.selectedPlan !== null
          && (
            !requiresFleetSelection
            || this.selectedFleetIndex !== null
          )
        )
      ),
    });
  }

  private selectPlan(file: string, source: PlanPresetSource): void {
    const selected = this.plans.find(plan => (
      plan.file === file && plan.source === source
    ));
    if (!selected) return;
    if (!this.samePlan(selected, this.selectedPlan)) {
      this.resetFleetSelection(selected);
      this.resetAutomationDailyMax(selected);
    }
    this.selectedPlan = selected;
    this.render();
  }

  private resetFleetSelection(plan: ManagedBattlePlan | null): void {
    this.selectedFleetIndex = (
      this.isPickingWithFleet()
      && plan?.kind === 'battle'
      && plan.fleets.length === 1
    ) ? 0 : null;
  }

  private resetAutomationDailyMax(plan: ManagedBattlePlan | null): void {
    if (this.purpose !== 'automation') return;
    const initialLimit = plan
      && this.automationInitialTask
      && this.matchesAutomationTask(plan, this.automationInitialTask)
      ? this.automationInitialTask.times
      : plan?.times;
    this.automationDailyMax = normalFightDailyLimit(initialLimit);
  }

  private matchesAutomationTask(
    plan: ManagedBattlePlan,
    task: NormalFightTaskConfig,
  ): boolean {
    if (task.source && task.source !== plan.source) return false;
    const taskPath = task.name
      .trim()
      .replace(/\\/g, '/')
      .toLocaleLowerCase();
    const planFile = plan.file
      .trim()
      .replace(/\\/g, '/')
      .toLocaleLowerCase();
    return taskPath === planFile
      || (!task.source && taskPath.endsWith(`/${planFile}`));
  }

  private selectFleet(index: number): void {
    if (
      !this.isPickingWithFleet()
      || !this.selectedPlan?.fleets[index]
    ) {
      return;
    }
    this.selectedFleetIndex = index;
    this.render();
  }

  private addLootPlan(
    file: string,
    source: PlanPresetSource,
  ): void {
    if (this.purpose !== 'loot-automation') return;
    const plan = this.plans.find(item => (
      item.kind === 'battle'
      && item.file === file
      && item.source === source
    ));
    if (!plan) return;
    const next: LootAutomationPlan = {
      source: plan.source,
      file: plan.file,
      name: plan.name,
    };
    const key = lootAutomationPlanKey(next);
    if (
      this.lootPlanDraft.some(item => (
        lootAutomationPlanKey(item) === key
      ))
    ) {
      return;
    }
    this.lootPlanDraft.push(next);
    this.render();
  }

  private async deleteLootPlan(
    source: PlanPresetSource,
    file: string,
  ): Promise<void> {
    if (this.purpose !== 'loot-automation') return;
    const target = this.lootPlanDraft.find(plan => (
      plan.source === source && plan.file === file
    ));
    if (!target) return;
    const confirmed = await showConfirm(
      '删除自动胖次计划',
      `确定从自动胖次下拉列表中删除「${target.name}」吗？`,
    );
    if (!confirmed) return;
    this.lootPlanDraft = this.lootPlanDraft.filter(plan => (
      plan.source !== source || plan.file !== file
    ));
    this.render();
  }

  private async confirm(): Promise<void> {
    if (this.purpose === 'loot-automation') {
      this.finishLootPlans(structuredClone(this.lootPlanDraft));
      this.close();
      return;
    }
    if (!this.selectedPlan) return;
    if (this.isPickingWithFleet()) {
      if (
        this.requiresFleetSelection(this.selectedPlan)
        && this.selectedFleetIndex === null
      ) {
        return;
      }
      this.finishSelection({
        plan: this.selectedPlan,
        ...(this.selectedFleetIndex === null
          ? {}
          : { fleetPresetIndex: this.selectedFleetIndex }),
        ...(this.purpose === 'automation'
          ? { dailyMaxExecutions: this.automationDailyMax }
          : {}),
      });
      this.close();
      return;
    }
    const { file, source } = this.selectedPlan;
    const loaded = await this.host.openManagedPlan(file, source);
    if (loaded) this.close();
  }

  private isPickingWithFleet(): boolean {
    return (
      this.purpose === 'queue'
      || this.purpose === 'task-list'
      || this.purpose === 'automation'
    );
  }

  private requiresFleetSelection(plan: ManagedBattlePlan): boolean {
    if (plan.kind === 'preset') return false;
    return this.isPickingWithFleet() && plan.fleets.length > 0;
  }

  private samePlan(
    left: ManagedBattlePlan | null,
    right: ManagedBattlePlan | null,
  ): boolean {
    return Boolean(
      left
      && right
      && left.file === right.file
      && left.source === right.source,
    );
  }
}
