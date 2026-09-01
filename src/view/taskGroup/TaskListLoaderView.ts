/** 渲染任务列表选择浮窗，并把选择、删除和排序意图回传给 Controller。 */
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';
import { LoaderDialog } from '../shared/LoaderDialog';

export interface TaskListLoaderGroupViewObject {
  name: string;
  itemCount: number;
  selected: boolean;
}

export interface TaskListLoaderItemViewObject {
  label: string;
  fileName: string;
  times: number;
  fleetPresetName: string;
  sourceClass: string;
  sourceLabel: string;
}

export interface TaskListLoaderViewObject {
  groupCount: number;
  selectedGroupName: string;
  groups: TaskListLoaderGroupViewObject[];
  items: TaskListLoaderItemViewObject[];
}

export interface TaskListLoaderViewActions {
  onClose(): void;
  onConfirm(): void;
  onSelectGroup(name: string): void;
  onDeleteGroup(name: string): void;
  onMoveItem(fromIndex: number, toIndex: number): void;
}

export class TaskListLoaderView {
  private readonly dialog: HTMLElement;
  private readonly count: HTMLElement;
  private readonly groups: HTMLElement;
  private readonly previewTitle: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly modal: LoaderDialog;
  private actions: TaskListLoaderViewActions | null = null;
  private draggedIndex: number | null = null;

  constructor() {
    this.dialog = document.getElementById('task-list-loader')!;
    this.count = document.getElementById('task-list-loader-count')!;
    this.groups = document.getElementById('task-list-loader-groups')!;
    this.previewTitle = document.getElementById(
      'task-list-loader-preview-title',
    )!;
    this.preview = document.getElementById('task-list-loader-preview')!;
    this.confirmButton = document.getElementById(
      'btn-confirm-task-list-loader',
    ) as HTMLButtonElement;
    this.modal = new LoaderDialog(this.dialog);
  }

  bindActions(actions: TaskListLoaderViewActions): void {
    this.actions = actions;
    document.getElementById('btn-cancel-task-list-loader')
      ?.addEventListener('click', actions.onClose);
    this.confirmButton.addEventListener('click', actions.onConfirm);
    this.modal.bindDismiss(actions.onClose);
  }

  open(): void {
    this.modal.open();
  }

  close(): void {
    this.modal.close();
    this.draggedIndex = null;
  }

  isOpen(): boolean {
    return this.modal.isOpen();
  }

  render(viewObject: TaskListLoaderViewObject): void {
    this.count.textContent = `共 ${viewObject.groupCount} 个计划组`;
    this.confirmButton.disabled = !viewObject.selectedGroupName;
    this.renderGroups(viewObject.groups);
    this.renderPreview(viewObject);
  }

  private renderGroups(
    groups: readonly TaskListLoaderGroupViewObject[],
  ): void {
    const scrollPosition = captureScrollPosition(this.groups);
    this.groups.innerHTML = '';
    if (groups.length === 0) {
      this.appendEmpty(this.groups, '暂无已保存的任务列表');
      restoreScrollPosition(this.groups, scrollPosition);
      return;
    }

    groups.forEach((group) => {
      const card = document.createElement('div');
      card.className = 'task-list-loader-group-card';
      card.classList.toggle('active', group.selected);

      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'task-list-loader-group-select';
      const name = document.createElement('strong');
      name.textContent = group.name;
      const count = document.createElement('span');
      count.textContent = `${group.itemCount} 个出征计划`;
      selectButton.append(name, count);
      selectButton.addEventListener('click', () => {
        this.actions?.onSelectGroup(group.name);
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'task-list-loader-group-delete';
      deleteButton.textContent = '删除';
      deleteButton.title = `删除任务列表「${group.name}」`;
      deleteButton.addEventListener('click', () => {
        this.actions?.onDeleteGroup(group.name);
      });

      card.append(selectButton, deleteButton);
      this.groups.appendChild(card);
    });
    restoreScrollPosition(this.groups, scrollPosition);
  }

  private renderPreview(viewObject: TaskListLoaderViewObject): void {
    this.previewTitle.textContent = viewObject.selectedGroupName
      ? `计划列表预览：${viewObject.selectedGroupName}`
      : '计划列表预览：未选择';
    this.preview.innerHTML = '';

    if (!viewObject.selectedGroupName) {
      this.appendEmpty(this.preview, '从左侧选择一个计划组');
      return;
    }
    if (viewObject.items.length === 0) {
      this.appendEmpty(this.preview, '该计划组尚未关联出征计划');
      return;
    }
    viewObject.items.forEach((item, index) => {
      this.preview.appendChild(this.createPreviewCard(item, index));
    });
  }

  private createPreviewCard(
    item: TaskListLoaderItemViewObject,
    index: number,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'task-list-loader-plan-card';
    card.draggable = true;
    card.dataset['index'] = String(index);

    const handle = document.createElement('span');
    handle.className = 'tg-drag-handle';
    handle.textContent = '⠿';

    const order = document.createElement('span');
    order.className = 'tg-order';
    order.textContent = String(index + 1).padStart(2, '0');

    const content = document.createElement('div');
    content.className = 'tg-content';
    const heading = document.createElement('div');
    heading.className = 'tg-item-heading';
    const label = document.createElement('strong');
    label.className = 'tg-label';
    label.textContent = item.label;
    const fleetTag = document.createElement('span');
    fleetTag.className = 'tg-fleet-tag';
    fleetTag.textContent = item.fleetPresetName;
    fleetTag.title = `使用队伍：${item.fleetPresetName}`;
    fleetTag.hidden = !item.fleetPresetName;
    const source = document.createElement('span');
    source.className = `tg-source ${item.sourceClass}`;
    source.textContent = item.sourceLabel;
    heading.append(label, fleetTag, source);

    const fileName = document.createElement('span');
    fileName.className = 'tg-detail';
    fileName.textContent = item.fileName;
    content.append(heading, fileName);

    const times = document.createElement('span');
    times.className = 'task-list-loader-plan-times';
    times.textContent = `执行 ${item.times} 次`;
    card.append(handle, order, content, times);

    card.addEventListener('dragstart', (event) => {
      this.draggedIndex = index;
      card.classList.add('dragging');
      event.dataTransfer!.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      this.draggedIndex = null;
      card.classList.remove('dragging');
      this.preview.querySelectorAll('.drag-over').forEach((element) => {
        element.classList.remove('drag-over');
      });
    });
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      card.classList.add('drag-over');
      event.dataTransfer!.dropEffect = 'move';
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drag-over');
      const fromIndex = this.draggedIndex;
      this.draggedIndex = null;
      if (fromIndex !== null) {
        this.actions?.onMoveItem(fromIndex, index);
      }
    });
    return card;
  }

  private appendEmpty(container: HTMLElement, message: string): void {
    const empty = document.createElement('div');
    empty.className = 'fleet-team-loader-preview-empty';
    empty.textContent = message;
    container.appendChild(empty);
  }
}
