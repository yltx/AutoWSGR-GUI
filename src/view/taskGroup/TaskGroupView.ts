/** 渲染任务组和任务条目，并发出选择、排序和菜单意图。 */
/**
 * TaskGroupView —— 任务组面板渲染。
 * 纯视图组件：渲染组列表、条目列表，暴露操作回调。
 */
import type {
  TaskGroupItemMeta,
  TaskGroupItemViewObject,
  TaskGroupViewObject,
} from '../../types/view.js';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';

export class TaskGroupView {
  private nameInput: HTMLInputElement;
  private itemsEl: HTMLElement;
  private countEl: HTMLElement | null;

  // ── 外部回调 ──
  onNewGroup?: () => void;
  onSaveGroup?: () => void;
  onOpenGroupLoader?: () => void;
  onLoadAll?: () => void;
  onAddManagedPlan?: () => void;
  onAddDailyPlan?: () => void;
  onRemoveItem?: (index: number) => void;
  onLoadItem?: (index: number) => void;
  onTimesChange?: (index: number, times: number) => void;
  onMoveItem?: (fromIndex: number, toIndex: number) => void;
  /** 将指定 index 的任务拖放到队列 */
  onDropToQueue?: (index: number) => void;
  /** 右键编辑 */
  onEditItem?: (index: number, x: number, y: number) => void;
  onContextMenuEdit?: () => void;

  constructor() {
    this.nameInput = document.getElementById(
      'task-group-name',
    ) as HTMLInputElement;
    this.itemsEl = document.getElementById('task-group-items')!;
    this.countEl = document.getElementById('task-group-count');

    // 绑定固定按钮
    document.getElementById('btn-tg-new')?.addEventListener('click', () => this.onNewGroup?.());
    document.getElementById('btn-tg-save')?.addEventListener('click', () => this.onSaveGroup?.());
    document.getElementById('btn-tg-open-loader')?.addEventListener(
      'click',
      () => this.onOpenGroupLoader?.(),
    );
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.onSaveGroup?.();
    });
    document.getElementById('btn-tg-load-all')?.addEventListener('click', () => this.onLoadAll?.());
    document.getElementById('btn-tg-add-managed-plan')?.addEventListener(
      'click',
      () => this.onAddManagedPlan?.(),
    );
    document.getElementById('btn-tg-add-daily-plan')?.addEventListener(
      'click',
      () => this.onAddDailyPlan?.(),
    );
    document.addEventListener('click', () => this.hideContextMenu());
    document.getElementById('ctx-edit')?.addEventListener('click', () => {
      this.hideContextMenu();
      this.onContextMenuEdit?.();
    });
  }

  showContextMenu(x: number, y: number): void {
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = '';
  }

  hideContextMenu(): void {
    const menu = document.getElementById('context-menu');
    if (menu) menu.style.display = 'none';
  }

  render(vo: TaskGroupViewObject): void {
    const scrollPosition = captureScrollPosition(this.itemsEl);
    if (this.nameInput.dataset['activeGroup'] !== vo.activeGroupName) {
      this.nameInput.value = vo.activeGroupName;
      this.nameInput.dataset['activeGroup'] = vo.activeGroupName;
    }
    if (this.countEl) this.countEl.textContent = `${vo.items.length} 项`;

    // ── 条目列表 ──
    this.itemsEl.innerHTML = '';
    if (vo.items.length === 0) {
      this.itemsEl.innerHTML = '<p class="tg-empty">暂无任务，可通过「加载计划」或「加载日常任务」添加。</p>';
      restoreScrollPosition(this.itemsEl, scrollPosition);
      return;
    }

    for (let i = 0; i < vo.items.length; i++) {
      const item = vo.items[i];
      const meta = vo.itemMetas?.[i] ?? null;
      this.itemsEl.appendChild(this.createItemRow(item, i, meta));
    }
    restoreScrollPosition(this.itemsEl, scrollPosition);
  }

  getGroupName(): string {
    return this.nameInput.value.trim();
  }

  private createItemRow(
    item: TaskGroupItemViewObject,
    index: number,
    meta: TaskGroupItemMeta | null,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tg-item';
    row.draggable = true;
    row.dataset['index'] = String(index);

    const handle = document.createElement('span');
    handle.className = 'tg-drag-handle';
    handle.textContent = '⠿';
    row.appendChild(handle);

    const order = document.createElement('span');
    order.className = 'tg-order';
    order.textContent = String(index + 1).padStart(2, '0');
    row.appendChild(order);

    const content = document.createElement('div');
    content.className = 'tg-content';
    const heading = document.createElement('div');
    heading.className = 'tg-item-heading';

    const label = document.createElement('span');
    label.className = 'tg-label';
    label.textContent = item.label;
    label.title = item.dailyFile
      ?? item.managedFile
      ?? item.path
      ?? item.templateId
      ?? '';

    const fleetTag = document.createElement('span');
    fleetTag.className = 'tg-fleet-tag';
    fleetTag.textContent = meta?.fleetPresetName ?? '';
    fleetTag.title = `使用队伍：${meta?.fleetPresetName ?? ''}`;
    fleetTag.hidden = !meta?.fleetPresetName;

    const source = document.createElement('span');
    source.className = `tg-source ${this.sourceClass(item)}`;
    source.textContent = this.sourceLabel(item);
    heading.append(label, fleetTag, source);

    const detail = document.createElement('span');
    detail.className = 'tg-detail';
    const fileName = item.dailyFile
      ?? item.managedFile
      ?? item.path?.split(/[\\/]/).pop()
      ?? item.templateId
      ?? item.label;
    const parts = [fileName];
    if (meta) {
      if (meta.typeLabel) parts.push(meta.typeLabel);
      if (meta.mapName) parts.push(meta.mapName);
      if (meta.fleetId) parts.push(`第 ${meta.fleetId} 舰队`);
      if (meta.repairMode) parts.push(meta.repairMode);
    }
    detail.textContent = parts.filter(Boolean).join(' · ');
    detail.title = [
      item.managedFile ?? item.path ?? '',
      meta?.fleet?.filter(Boolean).join(' / ') ?? '',
    ].filter(Boolean).join('\n');
    content.append(heading, detail);
    row.appendChild(content);

    const controls = document.createElement('div');
    controls.className = 'tg-controls';
    const timesField = document.createElement('label');
    timesField.className = 'tg-times-field';
    const timesLabel = document.createElement('span');
    timesLabel.textContent = '执行';

    const times = document.createElement('input');
    times.type = 'number';
    times.className = 'input tg-times';
    times.min = '1';
    times.max = '9999';
    times.title = '执行次数';
    times.value = String(item.times);
    times.disabled = item.dailyTaskType === 'exercise';
    times.addEventListener('change', () => {
      this.onTimesChange?.(index, Math.max(1, parseInt(times.value, 10) || 1));
    });
    const timesUnit = document.createElement('span');
    timesUnit.textContent = '次';
    timesField.append(timesLabel, times, timesUnit);

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'btn btn-small tg-load-item';
    load.textContent = '加入队列';
    load.addEventListener('click', () => this.onLoadItem?.(index));

    const remove = document.createElement('button');
    remove.className = 'tg-remove';
    remove.title = '移除';
    remove.textContent = '✕';
    remove.addEventListener('click', () => this.onRemoveItem?.(index));
    controls.append(timesField, load, remove);
    row.appendChild(controls);

    // ── 右键菜单 ──
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onEditItem?.(index, e.clientX, e.clientY);
    });

    // ── 拖拽事件 ──
    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'copyMove';
      e.dataTransfer!.setData('text/plain', String(index));
      e.dataTransfer!.setData('application/x-tg-item', String(index));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      // 清理所有 drag-over
      this.itemsEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      // 高亮当前 row
      this.itemsEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromStr = e.dataTransfer!.getData('text/plain');
      const from = parseInt(fromStr, 10);
      const to = parseInt(row.dataset['index']!, 10);
      if (!isNaN(from) && !isNaN(to) && from !== to) {
        this.onMoveItem?.(from, to);
      }
    });

    return row;
  }

  private sourceClass(item: TaskGroupItemViewObject): string {
    if (item.kind === 'daily') return 'daily';
    if (item.managedSource === 'system') return 'system';
    if (item.managedSource === 'user') return 'user';
    if (item.kind === 'template') return 'template';
    return 'local';
  }

  private sourceLabel(item: TaskGroupItemViewObject): string {
    if (item.kind === 'daily') return '日常任务';
    if (item.managedSource === 'system') return '系统预设';
    if (item.managedSource === 'user') return '用户预设';
    if (item.kind === 'template') return '任务模板';
    if (item.kind === 'preset') return '任务预设';
    return '本地文件';
  }
}
