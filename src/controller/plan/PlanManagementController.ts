/** 管理计划目录状态，并把页面操作转换为受控仓储调用。 */
import {
  fleetPlannerRepository,
  type FleetPlannerRepository,
} from '../../adapter/IpcAdapter.js';
import type {
  PlanManagementResult,
  PlanPresetSource,
  UserPlanExportSelection,
} from '../../types/ipc.js';
import { PlanManagementView } from '../../view/plan/PlanManagementView.js';
import {
  showAlert,
  showConfirm,
  showPrompt,
  showSaveSuccess,
} from '../../view/shared/DialogHelper.js';
import {
  buildPlanManagementViewObject,
  type PlanManagementTaskGroup,
} from './planManagementViewObjects.js';

export type PlanManagementRepository = Pick<
  FleetPlannerRepository,
  | 'getPlanManagement'
  | 'exportUserPlans'
  | 'exportLegacy143Plans'
  | 'setPlanUnlinkedIgnored'
  | 'renameUserCombatPlan'
  | 'deleteUserCombatPlan'
  | 'deleteUserTeamPlan'
>;

export interface PlanManagementDialogs {
  alert(title: string, message?: string): Promise<void>;
  confirm(title: string, message?: string): Promise<boolean>;
  prompt(
    title: string,
    message?: string,
    defaultValue?: string,
  ): Promise<string | null>;
  success(message?: string): void;
}

const defaultDialogs: PlanManagementDialogs = {
  alert: showAlert,
  confirm: showConfirm,
  prompt: showPrompt,
  success: showSaveSuccess,
};

export class PlanManagementController {
  readonly view: PlanManagementView;
  private data: PlanManagementResult | null = null;
  private taskGroups: () => readonly PlanManagementTaskGroup[] = () => [];
  private openBattlePlanHandler: (
    (file: string, source: PlanPresetSource) => Promise<void>
  ) | null = null;
  private openTeamPlanHandler: (
    (file: string, source: PlanPresetSource) => Promise<void>
  ) | null = null;

  constructor(
    private readonly repository: PlanManagementRepository
      = fleetPlannerRepository,
    view = new PlanManagementView(),
    private readonly dialogs: PlanManagementDialogs = defaultDialogs,
  ) {
    this.view = view;
    this.view.onRefresh = () => this.load();
    this.view.onExportPlans = selections => this.exportPlans(selections);
    this.view.onExportLegacy143Plans = selections => (
      this.exportLegacy143Plans(selections)
    );
    this.view.onDeletePlans = selections => this.deletePlans(selections);
    this.view.onToggleUnlinked = (
      kind,
      source,
      file,
      ignored,
    ) => this.toggleUnlinked(kind, source, file, ignored);
    this.view.onRenameCombatPlan = file => this.renameCombatPlan(file);
    this.view.onDeleteCombatPlan = file => this.deleteCombatPlan(file);
    this.view.onDeleteTeamPlan = (
      file,
      name,
      warning,
    ) => this.deleteTeamPlan(file, name, warning);
    this.view.onOpenBattlePlan = (file, source) => (
      this.openBattlePlanHandler?.(file, source) ?? Promise.resolve()
    );
    this.view.onOpenTeamPlan = (file, source) => (
      this.openTeamPlanHandler?.(file, source) ?? Promise.resolve()
    );
  }

  set onOpenBattlePlan(
    handler: (
      (file: string, source: PlanPresetSource) => Promise<void>
    ) | null,
  ) {
    this.openBattlePlanHandler = handler;
  }

  set onOpenTeamPlan(
    handler: (
      (file: string, source: PlanPresetSource) => Promise<void>
    ) | null,
  ) {
    this.openTeamPlanHandler = handler;
  }

  setTaskGroupsProvider(
    provider: () => readonly PlanManagementTaskGroup[],
  ): void {
    this.taskGroups = provider;
  }

  async load(): Promise<void> {
    this.view.showLoading();
    try {
      this.data = await this.repository.getPlanManagement();
      this.render();
    } catch (error) {
      this.view.showError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private render(): void {
    if (!this.data) return;
    this.view.render(buildPlanManagementViewObject(
      this.data,
      this.taskGroups(),
    ));
  }

  private async exportPlans(
    selections: readonly UserPlanExportSelection[],
  ): Promise<void> {
    try {
      const result = await this.repository.exportUserPlans([...selections]);
      if (result.canceled) return;
      if (!result.success) {
        await this.dialogs.alert(
          '导出失败',
          result.error || '未知错误',
        );
        return;
      }
      this.dialogs.success(
        `已导出 ${result.count ?? selections.length} 个用户配置`,
      );
    } catch (error) {
      await this.dialogs.alert(
        '导出失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async exportLegacy143Plans(
    selections: readonly UserPlanExportSelection[],
  ): Promise<void> {
    try {
      const result = await this.repository.exportLegacy143Plans(
        selections.filter(selection => selection.kind === 'battle'),
      );
      if (result.canceled) return;
      if (!result.success) {
        await this.dialogs.alert(
          '降级备份失败',
          result.error || '未知错误',
        );
        return;
      }
      this.dialogs.success(
        `已保存 ${result.count ?? 0} 个 1.4.3 兼容出征计划`,
      );
    } catch (error) {
      await this.dialogs.alert(
        '降级备份失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async deletePlans(
    selections: readonly UserPlanExportSelection[],
  ): Promise<void> {
    const battleCount = selections.filter(
      selection => selection.kind === 'battle',
    ).length;
    const teamCount = selections.length - battleCount;
    const confirmed = await this.dialogs.confirm(
      '批量删除用户配置',
      `即将删除 ${selections.length} 个用户配置`
        + `（出征计划 ${battleCount} 个，舰队方案 ${teamCount} 个）。\n`
        + '引用这些配置的任务不会一并删除，此操作无法撤销。是否继续？',
    );
    if (!confirmed) return;

    const failures: string[] = [];
    let deletedCount = 0;
    for (const selection of selections) {
      try {
        const result = selection.kind === 'battle'
          ? await this.repository.deleteUserCombatPlan(selection.file)
          : await this.repository.deleteUserTeamPlan(selection.file);
        if (!result.success) {
          failures.push(`${selection.file}：${result.error || '未知错误'}`);
        } else {
          deletedCount += 1;
        }
      } catch (error) {
        failures.push(
          `${selection.file}：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.load();
    if (failures.length > 0) {
      await this.dialogs.alert(
        '批量删除未全部完成',
        `成功删除 ${deletedCount} 个，失败 ${failures.length} 个。\n`
          + failures.join('\n'),
      );
    } else {
      this.dialogs.success(`已删除 ${deletedCount} 个用户配置`);
    }
  }

  private async toggleUnlinked(
    kind: 'battle' | 'team',
    source: PlanPresetSource,
    file: string,
    ignored: boolean,
  ): Promise<void> {
    try {
      const values = await this.repository.setPlanUnlinkedIgnored(
        kind,
        source,
        file,
        ignored,
      );
      if (this.data) {
        this.data = {
          ...this.data,
          ignoredUnlinkedPlans: [...values],
        };
        this.render();
      }
    } catch (error) {
      await this.dialogs.alert(
        '操作失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async renameCombatPlan(file: string): Promise<void> {
    const currentName = file
      .replace(/\.ya?ml$/i, '')
      .replace(/^bettle-/i, '');
    const newName = await this.dialogs.prompt(
      '重命名出征计划',
      '只修改用户计划文件名，不修改 YAML 的后端字段。',
      currentName,
    );
    if (newName === null || !newName.trim() || newName.trim() === currentName) {
      return;
    }
    try {
      const result = await this.repository.renameUserCombatPlan(
        file,
        newName.trim(),
      );
      if (!result.success) {
        await this.dialogs.alert(
          '重命名失败',
          result.error || '未知错误',
        );
        return;
      }
      await this.load();
    } catch (error) {
      await this.dialogs.alert(
        '重命名失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async deleteCombatPlan(file: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      '删除出征计划',
      `确定删除用户计划 ${file} 吗？此操作无法撤销。`,
    );
    if (!confirmed) return;
    try {
      const result = await this.repository.deleteUserCombatPlan(file);
      if (!result.success) {
        await this.dialogs.alert(
          '删除失败',
          result.error || '未知错误',
        );
        return;
      }
      await this.load();
    } catch (error) {
      await this.dialogs.alert(
        '删除失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async deleteTeamPlan(
    file: string,
    name: string,
    warning: string,
  ): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      '删除舰队方案',
      `确定删除舰队方案 ${name || file} 吗？${warning}\n此操作无法撤销。`,
    );
    if (!confirmed) return;
    try {
      const result = await this.repository.deleteUserTeamPlan(file);
      if (!result.success) {
        await this.dialogs.alert(
          '删除失败',
          result.error || '未知错误',
        );
        return;
      }
      await this.load();
    } catch (error) {
      await this.dialogs.alert(
        '删除失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
