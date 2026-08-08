/** 渲染迁移 YAML 冲突的强制双列表选择弹窗。 */
import type {
  MigrationConflictItem,
} from '../../shared/migrationConflicts.js';

export interface MigrationConflictViewCallbacks {
  onSubmit(keepIds: string[]): void;
}

/** 管理左右列表、卡片选择和移动，不执行任何文件操作。 */
export class MigrationConflictView {
  private readonly dialog = this.element('migration-conflict-dialog');
  private readonly count = this.element('migration-conflict-count');
  private readonly deleteTitle = this.element(
    'migration-conflict-delete-title',
  );
  private readonly keepTitle = this.element('migration-conflict-keep-title');
  private readonly deleteList = this.element(
    'migration-conflict-delete-list',
  );
  private readonly keepList = this.element('migration-conflict-keep-list');
  private readonly status = this.element('migration-conflict-status');
  private readonly selectAllDelete = this.button(
    'btn-select-all-migration-delete',
  );
  private readonly selectAllKeep = this.button(
    'btn-select-all-migration-keep',
  );
  private readonly moveKeep = this.button('btn-migration-move-keep');
  private readonly moveDelete = this.button('btn-migration-move-delete');
  private readonly keepAll = this.button('btn-migration-keep-all');
  private readonly confirm = this.button('btn-confirm-migration-conflicts');

  private conflicts: MigrationConflictItem[] = [];
  private readonly keepIds = new Set<string>();
  private readonly selectedDeleteIds = new Set<string>();
  private readonly selectedKeepIds = new Set<string>();

  constructor(private readonly callbacks: MigrationConflictViewCallbacks) {
    this.selectAllDelete.addEventListener('click', () => {
      this.toggleSelectAll(false);
    });
    this.selectAllKeep.addEventListener('click', () => {
      this.toggleSelectAll(true);
    });
    this.moveKeep.addEventListener('click', () => this.moveSelected(true));
    this.moveDelete.addEventListener('click', () => this.moveSelected(false));
    this.keepAll.addEventListener('click', () => {
      this.conflicts.forEach(conflict => this.keepIds.add(conflict.id));
      this.clearSelections();
      this.render();
    });
    this.confirm.addEventListener('click', () => {
      this.callbacks.onSubmit([...this.keepIds]);
    });
  }

  /** 打开弹窗；默认全部保留，避免用户误操作造成数据丢失。 */
  open(conflicts: MigrationConflictItem[]): void {
    this.conflicts = conflicts.map(conflict => structuredClone(conflict));
    this.keepIds.clear();
    this.conflicts.forEach(conflict => this.keepIds.add(conflict.id));
    this.clearSelections();
    this.setStatus('');
    this.setBusy(false);
    this.render();
    this.dialog.style.display = 'flex';
  }

  close(): void {
    this.dialog.style.display = 'none';
  }

  deleteCount(): number {
    return this.conflicts.length - this.keepIds.size;
  }

  setBusy(busy: boolean): void {
    [
      this.selectAllDelete,
      this.selectAllKeep,
      this.moveKeep,
      this.moveDelete,
      this.keepAll,
      this.confirm,
    ].forEach(button => {
      button.disabled = busy;
    });
    this.confirm.textContent = busy ? '正在处理...' : '确认处理';
  }

  setStatus(message: string): void {
    this.status.textContent = message;
    this.status.hidden = !message;
  }

  /** 删除失败时只保留仍需用户处理的项目。 */
  replace(conflicts: MigrationConflictItem[]): void {
    this.open(conflicts);
  }

  private render(): void {
    const deleteConflicts = this.conflicts.filter(conflict => (
      !this.keepIds.has(conflict.id)
    ));
    const keepConflicts = this.conflicts.filter(conflict => (
      this.keepIds.has(conflict.id)
    ));
    this.count.textContent = `${this.conflicts.length} 项冲突`;
    this.deleteTitle.textContent = `删除（${deleteConflicts.length}）`;
    this.keepTitle.textContent = `保留（${keepConflicts.length}）`;
    this.renderColumn(
      this.deleteList,
      deleteConflicts,
      this.selectedDeleteIds,
      '暂无待删除配置',
    );
    this.renderColumn(
      this.keepList,
      keepConflicts,
      this.selectedKeepIds,
      '暂无保留配置',
    );
    this.updateSelectionButton(
      this.selectAllDelete,
      deleteConflicts,
      this.selectedDeleteIds,
    );
    this.updateSelectionButton(
      this.selectAllKeep,
      keepConflicts,
      this.selectedKeepIds,
    );
    this.moveKeep.disabled = this.selectedDeleteIds.size === 0;
    this.moveDelete.disabled = this.selectedKeepIds.size === 0;
  }

  private renderColumn(
    target: HTMLElement,
    conflicts: MigrationConflictItem[],
    selected: Set<string>,
    emptyText: string,
  ): void {
    target.innerHTML = '';
    if (conflicts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'migration-conflict-empty';
      empty.textContent = emptyText;
      target.appendChild(empty);
      return;
    }
    for (const conflict of conflicts) {
      target.appendChild(this.createCard(conflict, selected));
    }
  }

  /** 卡片沿用任务队列的紧凑结构，并在下方补充冲突原因。 */
  private createCard(
    conflict: MigrationConflictItem,
    selected: Set<string>,
  ): HTMLElement {
    const card = document.createElement('label');
    card.className = 'task-queue-item migration-conflict-card';
    const mainRow = document.createElement('span');
    mainRow.className = 'tq-main-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(conflict.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(conflict.id);
      else selected.delete(conflict.id);
      this.render();
    });
    const name = document.createElement('span');
    name.className = 'tq-name';
    name.textContent = conflict.name;
    const kind = document.createElement('span');
    kind.className = 'tq-priority';
    kind.textContent = conflict.kind === 'daily' ? '日常任务' : '出征计划';
    mainRow.append(checkbox, name, kind);

    const file = document.createElement('span');
    file.className = 'migration-conflict-file';
    file.textContent = conflict.file;
    const reasons = document.createElement('span');
    reasons.className = 'migration-conflict-reasons';
    for (const conflictReason of conflict.reasons) {
      const reason = document.createElement('span');
      reason.textContent = `冲突原因：${conflictReason.reason}`;
      reasons.appendChild(reason);
    }
    card.append(mainRow, file, reasons);
    return card;
  }

  private toggleSelectAll(keepColumn: boolean): void {
    const conflicts = this.conflicts.filter(conflict => (
      this.keepIds.has(conflict.id) === keepColumn
    ));
    const selected = keepColumn
      ? this.selectedKeepIds
      : this.selectedDeleteIds;
    const allSelected = (
      conflicts.length > 0
      && conflicts.every(conflict => selected.has(conflict.id))
    );
    selected.clear();
    if (!allSelected) {
      conflicts.forEach(conflict => selected.add(conflict.id));
    }
    this.render();
  }

  private moveSelected(toKeep: boolean): void {
    const selected = toKeep
      ? this.selectedDeleteIds
      : this.selectedKeepIds;
    for (const id of selected) {
      if (toKeep) this.keepIds.add(id);
      else this.keepIds.delete(id);
    }
    this.clearSelections();
    this.render();
  }

  private updateSelectionButton(
    button: HTMLButtonElement,
    conflicts: MigrationConflictItem[],
    selected: Set<string>,
  ): void {
    const allSelected = (
      conflicts.length > 0
      && conflicts.every(conflict => selected.has(conflict.id))
    );
    button.textContent = allSelected ? '取消全选' : '全选';
    button.disabled = conflicts.length === 0;
  }

  private clearSelections(): void {
    this.selectedDeleteIds.clear();
    this.selectedKeepIds.clear();
  }

  private element(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少迁移冲突界面元素：${id}`);
    return element;
  }

  private button(id: string): HTMLButtonElement {
    return this.element(id) as HTMLButtonElement;
  }
}
