/** 将计划管理目录和任务组引用转换为只读页面行。 */
import type {
  PlanManagementResult,
  PlanPresetSource,
} from '../../types/ipc.js';
import type {
  PlanManagementRowViewObject,
  PlanManagementViewObject,
} from '../../types/view.js';

export interface PlanManagementTaskGroup {
  readonly name: string;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly path?: string;
    readonly managedSource?: PlanPresetSource;
    readonly managedFile?: string;
  }>;
}

interface BattlePlanRecord {
  readonly file: string;
  readonly name: string;
  readonly source: PlanPresetSource;
  readonly teams: Set<string>;
}

function planKey(source: PlanPresetSource, file: string): string {
  return `${source}:${file.trim().toLocaleLowerCase('zh-CN')}`;
}

function teamKey(name: string): string {
  return name.trim().toLocaleLowerCase('zh-CN');
}

function collectTaskGroupUsage(
  taskGroups: readonly PlanManagementTaskGroup[],
): Map<string, Set<string>> {
  const usage = new Map<string, Set<string>>();
  taskGroups.forEach(group => {
    group.items.forEach(item => {
      if (item.kind !== 'plan') return;
      let source = item.managedSource;
      let file = item.managedFile?.trim();
      if ((!source || !file) && item.path) {
        const normalizedPath = item.path.replace(/\\/g, '/');
        const lowerPath = normalizedPath.toLocaleLowerCase('zh-CN');
        if (/(^|\/)system_battle_plans\//.test(lowerPath)) {
          source = 'system';
        } else if (/(^|\/)user_battle_plans\//.test(lowerPath)) {
          source = 'user';
        }
        file = normalizedPath.split('/').pop()?.trim();
      }
      if (!source || !file) return;
      const key = planKey(source, file);
      const groups = usage.get(key) ?? new Set<string>();
      groups.add(group.name);
      usage.set(key, groups);
    });
  });
  return usage;
}

function collectBattlePlans(
  result: PlanManagementResult,
): Map<string, BattlePlanRecord> {
  const plans = new Map<string, BattlePlanRecord>();
  result.bindings.forEach(binding => {
    const key = planKey(binding.source, binding.planFile);
    let plan = plans.get(key);
    if (!plan) {
      plan = {
        file: binding.planFile,
        name: binding.planName,
        source: binding.source,
        teams: new Set<string>(),
      };
      plans.set(key, plan);
    }
    if (binding.teamName) plan.teams.add(binding.teamName);
  });
  return plans;
}

function teamDeleteWarning(
  result: PlanManagementResult,
  file: string,
  name: string,
  relations: readonly string[],
): string | undefined {
  if (relations.length === 0) return undefined;
  const normalizedName = teamKey(name);
  const hasOtherTeamWithSameName = result.teamPlans.some(plan => (
    plan.file !== file && teamKey(plan.name) === normalizedName
  ));
  return hasOtherTeamWithSameName
    ? `\n当前有 ${relations.length} 个出征计划引用该名称，删除后仍会匹配另一份同名舰队方案。`
    : `\n当前有 ${relations.length} 个出征计划引用该舰队；删除后这些计划会显示舰队文件缺失。`;
}

export function buildPlanManagementViewObject(
  result: PlanManagementResult,
  taskGroups: readonly PlanManagementTaskGroup[],
): PlanManagementViewObject {
  const taskGroupUsage = collectTaskGroupUsage(taskGroups);
  const battlePlans = collectBattlePlans(result);
  const availableTeams = new Set(
    result.teamPlans.map(plan => teamKey(plan.name)),
  );
  const teamUsage = new Map<string, Set<string>>();
  battlePlans.forEach(plan => {
    plan.teams.forEach(name => {
      const key = teamKey(name);
      const usedBy = teamUsage.get(key) ?? new Set<string>();
      usedBy.add(plan.name);
      teamUsage.set(key, usedBy);
    });
  });

  const ignored = new Set(result.ignoredUnlinkedPlans);
  const rows: PlanManagementRowViewObject[] = [];
  battlePlans.forEach(plan => {
    const relations = [...plan.teams];
    const missingRelations = relations.filter(name => (
      !availableTeams.has(teamKey(name))
    ));
    const ignoredUnlinked = ignored.has(
      `battle/${plan.source}/${plan.file}`,
    );
    const attention = (
      (relations.length === 0 && !ignoredUnlinked)
      || missingRelations.length > 0
    );
    rows.push({
      kind: 'battle',
      source: plan.source,
      name: plan.name,
      file: plan.file,
      relations,
      taskGroups: [
        ...(taskGroupUsage.get(planKey(plan.source, plan.file)) ?? []),
      ],
      missingRelations,
      status: relations.length === 0
        ? ignoredUnlinked
          ? ''
          : '未关联舰队'
        : missingRelations.length > 0
          ? '舰队文件缺失'
          : '关联正常',
      statusClass: ignoredUnlinked
        ? 'muted'
        : attention
          ? 'warning'
          : 'ok',
      attention,
      ignoredUnlinked,
    });
  });

  result.teamPlans.forEach(plan => {
    const relations = [...(teamUsage.get(teamKey(plan.name)) ?? [])];
    const ignoredUnlinked = ignored.has(
      `team/${plan.source}/${plan.file}`,
    );
    rows.push({
      kind: 'team',
      source: plan.source,
      name: plan.name,
      file: plan.file,
      relations,
      taskGroups: [],
      missingRelations: [],
      status: relations.length > 0
        ? `已被 ${relations.length} 个计划引用`
        : ignoredUnlinked
          ? ''
          : '未被引用',
      statusClass: relations.length > 0 ? 'ok' : 'muted',
      attention: relations.length === 0 && !ignoredUnlinked,
      ignoredUnlinked,
      deleteWarning: teamDeleteWarning(
        result,
        plan.file,
        plan.name,
        relations,
      ),
    });
  });

  result.errors.forEach(error => {
    rows.push({
      kind: error.kind,
      source: error.source,
      name: error.file.replace(/\.ya?ml$/i, ''),
      file: error.file,
      relations: [],
      taskGroups: error.kind === 'battle'
        ? [...(taskGroupUsage.get(planKey(error.source, error.file)) ?? [])]
        : [],
      missingRelations: [],
      status: '无法读取',
      statusClass: 'warning',
      attention: true,
      invalid: true,
      errorMessage: error.message,
    });
  });

  return {
    rows,
    errors: result.errors.map(error => ({
      source: error.source,
      file: error.file,
      message: error.message,
    })),
  };
}
