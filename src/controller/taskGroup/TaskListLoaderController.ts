/** 协调任务列表文件选择、解析和批量载入。 */
/**
 * Task-list loader shown on the home page.
 *
 * The left column selects a saved task group. The right column previews the
 * group's plans and keeps drag sorting in memory until the user confirms.
 */
import type {
  TaskGroupItem,
  TaskGroupModel,
} from '../../model/TaskGroupModel';
import type { ManagedBattlePlan } from '../../types/ipc.js';
import {
  TaskListLoaderView,
  type TaskListLoaderItemViewObject,
  type TaskListLoaderViewObject,
} from '../../view/taskGroup/TaskListLoaderView';
import { showConfirm } from '../../view/shared/DialogHelper';
import {
  getTaskGroupRepository,
  type TaskGroupRepository,
} from '../../adapter/IpcAdapter';

export class TaskListLoaderController {
  private selectedGroupName = '';
  private draftItems: TaskGroupItem[] = [];
  private managedPlans: ManagedBattlePlan[] = [];

  constructor(
    private readonly model: TaskGroupModel,
    private readonly onLoaded: () => void,
    private readonly repository: TaskGroupRepository | undefined =
      getTaskGroupRepository(),
    private readonly view = new TaskListLoaderView(),
  ) {
    this.view.bindActions({
      onClose: () => this.close(),
      onConfirm: () => void this.confirm(),
      onSelectGroup: name => this.selectGroup(name),
      onDeleteGroup: name => void this.deleteGroup(name),
      onMoveItem: (fromIndex, toIndex) => {
        this.moveDraftItem(fromIndex, toIndex);
      },
    });
  }

  open(): void {
    const groups = this.model.groups;
    const activeExists = groups.some(
      group => group.name === this.model.activeGroupName,
    );
    this.selectGroup(
      activeExists
        ? this.model.activeGroupName
        : groups[0]?.name ?? '',
    );
    this.view.open();
    void this.refreshManagedPlans();
  }

  private async refreshManagedPlans(): Promise<void> {
    if (!this.repository?.getPlanManagement) return;
    try {
      const result = await this.repository.getPlanManagement();
      this.managedPlans = result.battlePlans;
      if (this.view.isOpen()) this.render();
    } catch {
      this.managedPlans = [];
    }
  }

  private close(): void {
    this.view.close();
  }

  private selectGroup(name: string): void {
    this.selectedGroupName = name;
    const group = name ? this.model.getGroup(name) : null;
    this.draftItems = group
      ? group.items.map(item => ({ ...item }))
      : [];
    this.render();
  }

  private render(): void {
    const viewObject: TaskListLoaderViewObject = {
      groupCount: this.model.groups.length,
      selectedGroupName: this.selectedGroupName,
      groups: this.model.groups.map(group => ({
        name: group.name,
        itemCount: group.items.length,
        selected: group.name === this.selectedGroupName,
      })),
      items: this.draftItems.map(item => this.toItemViewObject(item)),
    };
    this.view.render(viewObject);
  }

  private toItemViewObject(
    item: TaskGroupItem,
  ): TaskListLoaderItemViewObject {
    return {
      label: item.label,
      fileName: item.managedFile
        ?? item.path?.split(/[\\/]/).pop()
        ?? item.templateId
        ?? '-',
      times: item.times,
      fleetPresetName: this.fleetPresetName(item),
      sourceClass: this.sourceClass(item),
      sourceLabel: this.sourceLabel(item),
    };
  }

  private fleetPresetName(item: TaskGroupItem): string {
    if (
      item.kind !== 'plan'
      || !item.managedSource
      || !item.managedFile
    ) {
      return '';
    }
    const plan = this.managedPlans.find(candidate => (
      candidate.source === item.managedSource
      && candidate.file === item.managedFile
    ));
    const presetIndex = item.fleetPresetIndex ?? 0;
    return plan?.fleets[presetIndex]?.name ?? '';
  }

  private moveDraftItem(fromIndex: number, toIndex: number): void {
    if (
      fromIndex === toIndex
      || fromIndex < 0
      || fromIndex >= this.draftItems.length
      || toIndex < 0
      || toIndex >= this.draftItems.length
    ) {
      return;
    }
    const [item] = this.draftItems.splice(fromIndex, 1);
    this.draftItems.splice(toIndex, 0, item);
    this.render();
  }

  private async deleteGroup(name: string): Promise<void> {
    const groupIndex = this.model.groups.findIndex(
      group => group.name === name,
    );
    if (!name || groupIndex < 0) return;

    const confirmed = await showConfirm(
      '确认删除任务列表',
      `确定删除任务列表「${name}」？\n\n删除后无法恢复。`,
    );
    if (!confirmed || !this.model.deleteGroup(name)) return;

    await this.model.save();
    let nextGroupName = this.selectedGroupName;
    if (name === this.selectedGroupName) {
      const nextIndex = Math.min(groupIndex, this.model.groups.length - 1);
      nextGroupName = this.model.groups[nextIndex]?.name ?? '';
    }
    this.selectGroup(nextGroupName);
    this.onLoaded();
  }

  private async confirm(): Promise<void> {
    if (!this.selectedGroupName) return;
    this.model.upsertGroup(
      this.selectedGroupName,
      this.draftItems.map(item => ({ ...item })),
    );
    this.model.setActiveGroup(this.selectedGroupName);
    await this.model.save();
    this.onLoaded();
    this.close();
  }

  private sourceClass(item: TaskGroupItem): string {
    if (item.kind === 'daily') return 'daily';
    if (item.managedSource === 'system') return 'system';
    if (item.managedSource === 'user') return 'user';
    if (item.kind === 'template') return 'template';
    return 'local';
  }

  private sourceLabel(item: TaskGroupItem): string {
    if (item.kind === 'daily') return '日常任务';
    if (item.managedSource === 'system') return '系统预设';
    if (item.managedSource === 'user') return '用户预设';
    if (item.kind === 'template') return '任务模板';
    if (item.kind === 'preset') return '任务预设';
    return '本地文件';
  }
}
