/**
 * TaskGroupController —— 任务组控制器（瘦身版）。
 * 核心逻辑委托给 importExport / addItems / queueLoader / contextMenu / metaLoader 模块。
 */
import { TaskGroupModel, type TaskGroupItem } from '../../model/TaskGroupModel';
import { TaskGroupView, type TaskGroupItemMeta } from '../../view/taskGroup/TaskGroupView';
import { TemplateModel } from '../../model/TemplateModel';
import type { PlanModel } from '../../model/PlanModel';
import type { Scheduler } from '../../model/scheduler';
import type { TaskPreset } from '../../types/model';
import type { MapData } from '../../model/MapDataLoader';
import { showPrompt, showConfirm, showAlert } from '../shared/DialogHelper';
import { exportTaskGroupFlow, importTaskGroupFlow } from './importExport';
import { addCurrentPlanToGroup, addFileToGroup, addPresetToGroup } from './addItems';
import { loadGroupToQueue, loadSingleItemToQueue } from './queueLoader';
import { showContextMenuForItem, hideContextMenu, handleContextMenuEdit, type ContextMenuTarget, type ContextMenuHost } from './contextMenu';
import { loadItemMetas } from './metaLoader';

export interface TaskGroupHost {
  readonly scheduler: Scheduler;
  plansDir: string;
  renderMain(): void;
  switchPage(page: string): void;
  importTaskPreset(preset: TaskPreset, filePath: string): void;
  getCurrentPlan(): PlanModel | null;
  setCurrentPlan(plan: PlanModel, mapData: MapData | null): void;
  renderPlanPreview(): void;
  closePresetDetail(): void;
  executePreset(): void;
  getCurrentPresetInfo(): { preset: TaskPreset; filePath: string } | null;
}

export class TaskGroupController {
  private contextMenuTarget: ContextMenuTarget | null = null;

  constructor(
    private readonly taskGroupModel: TaskGroupModel,
    private readonly taskGroupView: TaskGroupView,
    private readonly templateModel: TemplateModel,
    private readonly mainView: { onDropFromTaskGroup?: (index: number) => void; onEditQueueItem?: (taskId: string, x: number, y: number) => void },
    readonly host: TaskGroupHost,
  ) {}

  bindActions(): void {
    this.taskGroupView.onSelectGroup = (name) => {
      this.taskGroupModel.setActiveGroup(name);
      this.render();
    };

    this.taskGroupView.onNewGroup = async () => {
      const name = await showPrompt('新建任务列表', '请输入名称：');
      if (!name?.trim()) return;
      const trimmed = name.trim();
      if (this.taskGroupModel.getGroup(trimmed)) {
        await showAlert('提示', `任务列表「${trimmed}」已存在，请换一个名称或直接选择它。`);
        return;
      }
      this.taskGroupModel.upsertGroup(trimmed);
      this.taskGroupModel.setActiveGroup(trimmed);
      this.taskGroupModel.save();
      this.render();
    };

    this.taskGroupView.onDeleteGroup = async () => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      const yes = await showConfirm('删除确认', `确认删除任务列表「${active.name}」？`);
      if (!yes) return;
      this.taskGroupModel.deleteGroup(active.name);
      this.taskGroupModel.save();
      this.render();
    };

    this.taskGroupView.onRenameGroup = async () => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      const newName = await showPrompt('重命名', '新名称：', active.name);
      if (!newName?.trim() || newName.trim() === active.name) return;
      const trimmed = newName.trim();
      if (!this.taskGroupModel.renameGroup(active.name, trimmed)) {
        await showAlert('提示', `名称「${trimmed}」已被占用。`);
        return;
      }
      this.taskGroupModel.save();
      this.render();
    };

    this.taskGroupView.onRemoveItem = (index) => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      this.taskGroupModel.removeItem(active.name, index);
      this.taskGroupModel.save();
      this.render();
    };

    this.taskGroupView.onTimesChange = (index, times) => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      this.taskGroupModel.updateItemTimes(active.name, index, times);
      this.taskGroupModel.save();
    };

    this.taskGroupView.onMoveItem = (from, to) => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      this.taskGroupModel.moveItem(active.name, from, to);
      this.taskGroupModel.save();
      this.render();
    };

    this.taskGroupView.onLoadAll = () => loadGroupToQueue(this.taskGroupModel, this.templateModel, this.host);
    this.taskGroupView.onAddFile = () => addFileToGroup(this.taskGroupModel, this.host.plansDir, () => this.render());
    this.taskGroupView.onExportGroup = () => exportTaskGroupFlow(this.taskGroupModel);
    this.taskGroupView.onImportGroup = () => importTaskGroupFlow(this.taskGroupModel, () => this.render());

    this.taskGroupView.onDropToQueue = () => {};
    this.mainView.onDropFromTaskGroup = (index) => loadSingleItemToQueue(index, this.taskGroupModel, this.templateModel, this.host);

    this.taskGroupView.onEditItem = (index, x, y) => {
      this.contextMenuTarget = showContextMenuForItem('taskgroup', index, x, y);
    };
    this.mainView.onEditQueueItem = (taskId, x, y) => {
      this.contextMenuTarget = showContextMenuForItem('queue', taskId, x, y);
    };

    document.addEventListener('click', () => hideContextMenu());
    document.getElementById('ctx-edit')?.addEventListener('click', () => {
      handleContextMenuEdit(this.contextMenuTarget, this.taskGroupModel, this.host as ContextMenuHost);
      this.contextMenuTarget = null;
    });

    document.getElementById('btn-add-to-group')?.addEventListener('click', () => {
      addCurrentPlanToGroup(
        this.taskGroupModel,
        () => this.host.getCurrentPlan(),
        this.host.plansDir,
        () => this.render(),
      ).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        void showAlert('加入任务组失败', msg);
      });
    });

    document.getElementById('btn-close-preset')?.addEventListener('click', () => this.host.closePresetDetail());
    document.getElementById('btn-tp-add-queue')?.addEventListener('click', () => this.host.executePreset());
    document.getElementById('btn-tp-add-group')?.addEventListener('click', () =>
      addPresetToGroup(this.taskGroupModel, () => this.host.getCurrentPresetInfo(), () => this.render()));

    document.getElementById('tp-fleet-enable-ex')?.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      document.getElementById('tp-fleet-grid-ex')!.style.display = checked ? '' : 'none';
    });
  }

  render(): void {
    const groups = this.taskGroupModel.groups;
    const active = this.taskGroupModel.getActiveGroup();
    const items = active?.items ?? [];

    this.taskGroupView.render({
      groups: groups.map(g => ({ name: g.name, itemCount: g.items.length })),
      activeGroupName: this.taskGroupModel.activeGroupName,
      items,
    });

    if (items.length > 0) {
      loadItemMetas(items, this.templateModel).then(metas => {
        if (this.taskGroupModel.getActiveGroup()?.name !== active?.name) return;
        this.taskGroupView.render({
          groups: groups.map(g => ({ name: g.name, itemCount: g.items.length })),
          activeGroupName: this.taskGroupModel.activeGroupName,
          items,
          itemMetas: metas,
        });
      });
    }
  }
}
