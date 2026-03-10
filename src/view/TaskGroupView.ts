/**
 * TaskGroupView —— 任务组面板渲染。
 * 纯视图组件：渲染组列表、条目列表，暴露操作回调。
 */
import type { TaskGroup, TaskGroupItem } from '../model/TaskGroupModel';

/** 任务条目的元数据（从 YAML 异步解析） */
export interface TaskGroupItemMeta {
  /** 地图标识，如 "9-2" 或 "Ex-3" */
  mapName?: string;
  /** 编队号 */
  fleetId?: number;
  /** 维修模式文本 */
  repairMode?: string;
  /** 任务类型标签 (预设) */
  typeLabel?: string;
  /** 编队舰船列表 */
  fleet?: string[];
}

/** 渲染所需的 VO */
export interface TaskGroupViewObject {
  groups: ReadonlyArray<{ name: string; itemCount: number }>;
  activeGroupName: string;
  items: ReadonlyArray<TaskGroupItem>;
  /** 各条目的元数据（按 index 对应） */
  itemMetas?: ReadonlyArray<TaskGroupItemMeta | null>;
}

export class TaskGroupView {
  private selectEl: HTMLSelectElement;
  private itemsEl: HTMLElement;

  // ── 外部回调 ──
  onSelectGroup?: (name: string) => void;
  onNewGroup?: () => void;
  onDeleteGroup?: () => void;
  onRenameGroup?: () => void;
  onLoadAll?: () => void;
  onAddFile?: () => void;
  onRemoveItem?: (index: number) => void;
  onTimesChange?: (index: number, times: number) => void;
  onMoveItem?: (fromIndex: number, toIndex: number) => void;
  onExportGroup?: () => void;
  onImportGroup?: () => void;
  /** 将指定 index 的任务拖放到队列 */
  onDropToQueue?: (index: number) => void;
  /** 右键编辑 */
  onEditItem?: (index: number, x: number, y: number) => void;

  constructor() {
    this.selectEl = document.getElementById('task-group-select') as HTMLSelectElement;
    this.itemsEl = document.getElementById('task-group-items')!;

    // 绑定固定按钮
    this.selectEl.addEventListener('change', () => {
      this.onSelectGroup?.(this.selectEl.value);
    });
    document.getElementById('btn-tg-new')?.addEventListener('click', () => this.onNewGroup?.());
    document.getElementById('btn-tg-delete')?.addEventListener('click', () => this.onDeleteGroup?.());
    document.getElementById('btn-tg-rename')?.addEventListener('click', () => this.onRenameGroup?.());
    document.getElementById('btn-tg-load-all')?.addEventListener('click', () => this.onLoadAll?.());
    document.getElementById('btn-tg-add-file')?.addEventListener('click', () => this.onAddFile?.());
    document.getElementById('btn-tg-export')?.addEventListener('click', () => this.onExportGroup?.());
    document.getElementById('btn-tg-import')?.addEventListener('click', () => this.onImportGroup?.());
  }

  render(vo: TaskGroupViewObject): void {
    // ── 组选择器 ──
    const prevVal = this.selectEl.value;
    this.selectEl.innerHTML = '';
    if (vo.groups.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(无任务组)';
      this.selectEl.appendChild(opt);
    } else {
      for (const g of vo.groups) {
        const opt = document.createElement('option');
        opt.value = g.name;
        opt.textContent = `${g.name} (${g.itemCount})`;
        this.selectEl.appendChild(opt);
      }
    }
    this.selectEl.value = vo.activeGroupName || prevVal;

    // ── 条目列表 ──
    this.itemsEl.innerHTML = '';
    if (vo.items.length === 0) {
      this.itemsEl.innerHTML = '<p class="tg-empty">暂无任务条目，导入方案后点击「加入任务组」添加</p>';
      return;
    }

    for (let i = 0; i < vo.items.length; i++) {
      const item = vo.items[i];
      const meta = vo.itemMetas?.[i] ?? null;
      this.itemsEl.appendChild(this.createItemRow(item, i, meta));
    }
  }

  private createItemRow(item: TaskGroupItem, index: number, meta: TaskGroupItemMeta | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tg-item';
    row.draggable = true;
    row.dataset['index'] = String(index);

    // 拖拽手柄
    const handle = document.createElement('span');
    handle.className = 'tg-drag-handle';
    handle.textContent = '⠿';
    row.appendChild(handle);

    // 名称
    const label = document.createElement('span');
    label.className = 'tg-label';
    label.textContent = item.label;
    label.title = item.path;
    row.appendChild(label);

    // 类型标签
    const kind = document.createElement('span');
    kind.className = 'tg-kind';
    kind.textContent = item.kind === 'plan' ? '方案' : '预设';
    row.appendChild(kind);

    // 详情：显示任务元数据（与名称同行）
    const detail = document.createElement('span');
    detail.className = 'tg-detail';
    if (meta) {
      const parts: string[] = [];
      if (meta.typeLabel) parts.push(meta.typeLabel);
      if (meta.mapName) parts.push(meta.mapName);
      if (meta.fleetId) parts.push(`编队${meta.fleetId}`);
      if (meta.repairMode) parts.push(meta.repairMode);
      if (meta.fleet && meta.fleet.length > 0) {
        parts.push(meta.fleet.filter(Boolean).join(' / '));
      }
      detail.textContent = parts.join(' · ') || item.path;
    } else {
      detail.textContent = item.path;
    }
    detail.title = item.path;
    row.appendChild(detail);

    // 次数标签 + 输入
    const timesLabel = document.createElement('span');
    timesLabel.className = 'tg-times-label';
    timesLabel.textContent = '次数';
    row.appendChild(timesLabel);

    const times = document.createElement('input');
    times.type = 'number';
    times.className = 'input tg-times';
    times.min = '1';
    times.max = '9999';
    times.title = '执行次数';
    times.value = String(item.times);
    times.addEventListener('change', () => {
      this.onTimesChange?.(index, Math.max(1, parseInt(times.value, 10) || 1));
    });
    row.appendChild(times);

    // 删除
    const remove = document.createElement('button');
    remove.className = 'tg-remove';
    remove.title = '移除';
    remove.textContent = '✕';
    remove.addEventListener('click', () => this.onRemoveItem?.(index));
    row.appendChild(remove);

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
}
