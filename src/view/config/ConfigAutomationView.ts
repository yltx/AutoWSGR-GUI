/** 管理设置页自动出征摘要与战利品计划选择的局部视图状态。 */
import type { NormalFightTaskConfig } from '../../types/model.js';
import {
  findLootAutomationPlan,
  lootAutomationPlanKey,
  normalizeLootAutomationPlans,
  type LootAutomationPlan,
  type LootPlanSource,
} from '../../shared/lootPlans.js';
import {
  normalFightDailyLimit,
  normalFightTaskKey,
} from '../../shared/normalFightQuota.js';
import { updateSettingSelectWidth } from './settingSelectWidth';

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`设置控件不存在: ${id}`);
  return target as T;
}

export class ConfigAutomationView {
  private readonly normalFightTaskList = element<HTMLElement>(
    'cfg-normal-fight-tasks',
  );
  private readonly lootPlan = element<HTMLSelectElement>('cfg-loot-plan');
  private normalFightTasks: NormalFightTaskConfig[] = [];
  private normalFightRemaining: number | null = null;
  private normalFightFleetNames = new Map<string, string>();
  private lootPlans: LootAutomationPlan[] = [];

  constructor() {
    this.lootPlan.addEventListener(
      'change',
      () => this.updateLootPlanSelect(),
    );
  }

  showNormalFightTasks(
    tasks: readonly NormalFightTaskConfig[],
    remaining: number | null,
  ): void {
    this.normalFightTasks = structuredClone([...tasks]);
    this.normalFightRemaining = remaining;
    this.normalFightFleetNames.clear();
    this.renderNormalFightTasks();
  }

  setNormalFightPlan(
    task: NormalFightTaskConfig,
    fleetName: string,
    remaining: number,
  ): void {
    this.normalFightTasks = [structuredClone(task)];
    this.normalFightRemaining = Math.max(0, Math.trunc(remaining));
    this.normalFightFleetNames.clear();
    this.normalFightFleetNames.set(
      this.normalFightFleetKey(
        task.name,
        task.fleet_preset_index ?? 0,
      ),
      fleetName,
    );
    this.renderNormalFightTasks();
  }

  getNormalFightTasks(): NormalFightTaskConfig[] {
    return structuredClone(this.normalFightTasks);
  }

  getNormalFightRemaining(): number | null {
    return this.normalFightRemaining;
  }

  setNormalFightRemaining(
    tasks: readonly NormalFightTaskConfig[],
    remaining: number,
  ): void {
    const signature = (task: NormalFightTaskConfig): string => (
      JSON.stringify([
        normalFightTaskKey(task),
        normalFightDailyLimit(task.times),
      ])
    );
    if (
      JSON.stringify(this.normalFightTasks.map(signature))
      !== JSON.stringify(tasks.map(signature))
    ) {
      return;
    }
    this.normalFightRemaining = Math.max(0, Math.trunc(remaining));
    this.renderNormalFightTasks();
  }

  showLootPlans(
    plans: readonly LootAutomationPlan[],
    source?: LootPlanSource,
    file?: string,
  ): void {
    this.lootPlans = normalizeLootAutomationPlans(plans, []);
    this.renderLootPlanOptions(source, file);
  }

  getLootPlans(): LootAutomationPlan[] {
    return structuredClone(this.lootPlans);
  }

  setLootPlans(plans: readonly LootAutomationPlan[]): void {
    const selected = this.selectedLootPlan();
    this.lootPlans = normalizeLootAutomationPlans(plans, []);
    this.renderLootPlanOptions(selected?.source, selected?.file);
  }

  hasLootPlans(): boolean {
    return this.lootPlans.length > 0;
  }

  selectedLootPlan(): LootAutomationPlan | null {
    return this.lootPlans.find(plan => (
      lootAutomationPlanKey(plan) === this.lootPlan.value
    )) ?? null;
  }

  private renderNormalFightTasks(): void {
    this.normalFightTaskList.replaceChildren();
    const primaryTask = this.normalFightTasks[0];
    if (!primaryTask) {
      const empty = document.createElement('span');
      empty.className = 'config-empty-note';
      empty.textContent = '尚未加载计划';
      this.normalFightTaskList.append(empty);
      return;
    }

    const fileName = primaryTask.name.split(/[\\/]/).pop() ?? primaryTask.name;
    const displayName = fileName
      .replace(/\.ya?ml$/i, '')
      .replace(/^bettle-/i, '');
    const name = document.createElement('span');
    name.className = 'config-task-name';
    name.title = this.normalFightTasks.map(task => task.name).join('\n');
    name.textContent = this.normalFightTasks.length > 1
      ? `${displayName} 等 ${this.normalFightTasks.length} 个任务`
      : displayName;
    this.normalFightTaskList.append(name);

    const remaining = document.createElement('span');
    remaining.className = 'config-task-remaining';
    remaining.textContent = (
      `今日剩余执行次数：${this.normalFightRemaining ?? 0}`
    );
    this.normalFightTaskList.append(remaining);

    if (primaryTask.fleet_preset_index == null) return;
    const fleetIndex = primaryTask.fleet_preset_index;
    const fleetName = this.normalFightFleetNames.get(
      this.normalFightFleetKey(primaryTask.name, fleetIndex),
    ) ?? `队伍 ${fleetIndex + 1}`;
    const fleetTag = document.createElement('span');
    fleetTag.className = 'tg-fleet-tag';
    fleetTag.textContent = fleetName;
    fleetTag.title = `使用队伍：${fleetName}`;
    this.normalFightTaskList.append(fleetTag);
  }

  private normalFightFleetKey(
    path: string,
    fleetPresetIndex: number,
  ): string {
    return `${path.toLowerCase()}\u0000${fleetPresetIndex}`;
  }

  private renderLootPlanOptions(
    source?: LootPlanSource,
    file?: string,
  ): void {
    const selected = findLootAutomationPlan(this.lootPlans, source, file)
      ?? this.lootPlans[0]
      ?? null;
    this.lootPlan.replaceChildren(
      ...this.lootPlans.map(plan => {
        const option = document.createElement('option');
        option.value = lootAutomationPlanKey(plan);
        option.textContent = plan.name;
        option.title = `${plan.name} (${plan.file})`;
        return option;
      }),
    );
    this.lootPlan.disabled = this.lootPlans.length === 0;
    this.lootPlan.value = selected
      ? lootAutomationPlanKey(selected)
      : '';
    this.updateLootPlanSelect();
  }

  private updateLootPlanSelect(): void {
    const option = this.lootPlan.selectedOptions[0];
    this.lootPlan.title = option?.title
      || option?.textContent?.trim()
      || '任务预设';
    updateSettingSelectWidth(this.lootPlan);
  }
}
