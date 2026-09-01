/** 渲染本地方案列表并发出导入、导出、重命名和删除意图。 */
import type {
  PlanPresetSource,
  UserPlanExportSelection,
} from '../../types/ipc.js';
import type {
  PlanManagementRowViewObject,
  PlanManagementViewObject,
} from '../../types/view.js';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';

type ManagementSource = PlanPresetSource | 'all';
type ManagementKind = 'battle' | 'team' | 'all';

/**
 * 计算当前筛选视图下已勾选、可执行批量操作的用户配置。
 * 勾选状态跨筛选条件保留，破坏性操作必须限定在过滤后的可见结果内。
 */
export function filterVisibleSelections(
  visibleSelections: readonly UserPlanExportSelection[],
  selections: ReadonlyMap<string, UserPlanExportSelection>,
  keyOf: (selection: UserPlanExportSelection) => string,
): UserPlanExportSelection[] {
  return visibleSelections.filter(selection =>
    selections.has(keyOf(selection)),
  );
}

export class PlanManagementView {
  onRefresh?: () => Promise<void>;
  onExportPlans?: (
    selections: readonly UserPlanExportSelection[],
  ) => Promise<void>;
  onExportLegacy143Plans?: (
    selections: readonly UserPlanExportSelection[],
  ) => Promise<void>;
  onDeletePlans?: (
    selections: readonly UserPlanExportSelection[],
  ) => Promise<void>;
  onToggleUnlinked?: (
    kind: 'battle' | 'team',
    source: PlanPresetSource,
    file: string,
    ignored: boolean,
  ) => Promise<void>;
  onRenameCombatPlan?: (file: string) => Promise<void>;
  onDeleteCombatPlan?: (file: string) => Promise<void>;
  onDeleteTeamPlan?: (
    file: string,
    name: string,
    warning: string,
  ) => Promise<void>;
  onOpenBattlePlan?: (
    file: string,
    source: PlanPresetSource,
  ) => Promise<void>;
  onOpenTeamPlan?: (
    file: string,
    source: PlanPresetSource,
  ) => Promise<void>;

  private readonly body = document.getElementById(
    'plan-team-management-body',
  ) as HTMLTableSectionElement | null;
  private readonly tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-plan-management-source]',
    ),
  );
  private readonly kindButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-plan-management-kind]',
    ),
  );
  private readonly search = document.getElementById(
    'plan-management-search',
  ) as HTMLInputElement | null;
  private readonly attentionOnly = document.getElementById(
    'plan-management-attention-only',
  ) as HTMLInputElement | null;
  private readonly selectAll = document.getElementById(
    'plan-management-select-all',
  ) as HTMLInputElement | null;
  private readonly exportButton = document.getElementById(
    'btn-export-user-plans',
  ) as HTMLButtonElement | null;
  private readonly deleteButton = document.getElementById(
    'btn-delete-user-plans',
  ) as HTMLButtonElement | null;
  private readonly legacyExportButton = document.getElementById(
    'btn-export-legacy-143-plans',
  ) as HTMLButtonElement | null;

  private source: ManagementSource = 'all';
  private kind: ManagementKind = 'all';
  private query = '';
  private viewObject: PlanManagementViewObject = {
    rows: [],
    errors: [],
  };
  private selections = new Map<string, UserPlanExportSelection>();
  private visibleSelections: UserPlanExportSelection[] = [];
  private exporting = false;
  private deleting = false;

  constructor() {
    this.bindActions();
  }

  showLoading(): void {
    if (!this.body) return;
    this.body.innerHTML = '<tr><td colspan="7">正在读取计划…</td></tr>';
  }

  showError(message: string): void {
    if (!this.body) return;
    this.body.innerHTML = '';
    const row = this.body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 7;
    cell.className = 'plan-management-empty';
    cell.textContent = message;
  }

  render(viewObject: PlanManagementViewObject): void {
    this.viewObject = viewObject;
    this.renderCurrent();
  }

  private bindActions(): void {
    document.getElementById('btn-refresh-plan-management')
      ?.addEventListener('click', () => {
        void this.onRefresh?.();
      });
    this.exportButton?.addEventListener('click', () => {
      void this.exportSelectedPlans();
    });
    this.legacyExportButton?.addEventListener('click', () => {
      const selections = filterVisibleSelections(
        this.visibleSelections,
        this.selections,
        selection => this.selectionKey(selection),
      ).filter(selection => selection.kind === 'battle');
      void this.onExportLegacy143Plans?.(selections);
    });
    this.deleteButton?.addEventListener('click', () => {
      void this.deleteSelectedPlans();
    });
    this.selectAll?.addEventListener('change', () => {
      const selected = this.selectAll?.checked === true;
      this.visibleSelections.forEach(selection => {
        const key = this.selectionKey(selection);
        if (selected) {
          this.selections.set(key, selection);
        } else {
          this.selections.delete(key);
        }
      });
      this.renderCurrent();
    });
    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const source = tab.dataset['planManagementSource'];
        if (source !== 'all' && source !== 'system' && source !== 'user') {
          return;
        }
        this.source = source;
        this.renderCurrent();
      });
    });
    this.kindButtons.forEach(button => {
      button.addEventListener('click', () => {
        const kind = button.dataset['planManagementKind'];
        if (kind !== 'all' && kind !== 'battle' && kind !== 'team') return;
        this.kind = kind;
        this.renderCurrent();
      });
    });
    this.search?.addEventListener('input', () => {
      this.query = this.search?.value.trim() ?? '';
      this.renderCurrent();
    });
    this.attentionOnly?.addEventListener('change', () => {
      this.renderCurrent();
    });
    this.body?.addEventListener('change', event => {
      const checkbox = (event.target as HTMLElement)
        .closest<HTMLInputElement>('[data-plan-selection]');
      if (!checkbox) return;
      const kind = checkbox.dataset['planKind'];
      const file = checkbox.dataset['planFile'];
      if ((kind !== 'battle' && kind !== 'team') || !file) return;
      const selection: UserPlanExportSelection = { kind, file };
      const key = this.selectionKey(selection);
      if (checkbox.checked) {
        this.selections.set(key, selection);
      } else {
        this.selections.delete(key);
      }
      this.updateSelectionControls();
    });
    this.body?.addEventListener('click', event => {
      const button = (event.target as HTMLElement)
        .closest<HTMLButtonElement>('[data-plan-operation]');
      if (!button) return;
      const file = button.dataset['planFile'];
      if (!file) return;
      const operation = button.dataset['planOperation'];
      if (operation === 'rename') {
        void this.renameCombatPlan(file);
      } else if (operation === 'delete') {
        void this.deleteCombatPlan(file);
      } else if (operation === 'edit-battle') {
        const source = button.dataset['planSource'] === 'system'
          ? 'system'
          : 'user';
        void this.onOpenBattlePlan?.(file, source);
      } else if (operation === 'edit-team') {
        const source = button.dataset['planSource'] === 'system'
          ? 'system'
          : 'user';
        void this.onOpenTeamPlan?.(file, source);
      } else if (operation === 'delete-team') {
        void this.deleteTeamPlan(
          file,
          button.dataset['planName'] ?? '',
          button.dataset['planWarning'] ?? '',
        );
      } else if (operation === 'toggle-unlinked') {
        const kind = button.dataset['planKind'] === 'team'
          ? 'team'
          : 'battle';
        const source = button.dataset['planSource'] === 'system'
          ? 'system'
          : 'user';
        void this.toggleUnlinkedIgnored(
          kind,
          file,
          source,
          button.dataset['planIgnored'] !== 'true',
        );
      }
    });
  }

  private renderCurrent(): void {
    if (!this.body) return;
    const scroll = this.body.closest<HTMLElement>(
      '.plan-team-management-table-wrap',
    );
    const scrollPosition = captureScrollPosition(scroll);
    this.renderActiveFilters();

    const rows = this.viewObject.rows;

    const sourceRows = rows.filter(row => (
      this.source === 'all' || row.source === this.source
    ));
    this.renderCountsAndWarnings(sourceRows);
    const visibleRows = this.filterRows(sourceRows);
    this.syncSelections(rows, visibleRows);
    this.body.replaceChildren();
    if (visibleRows.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.className = 'plan-management-empty';
      cell.textContent = sourceRows.length > 0
        ? '没有符合当前筛选条件的 YAML'
        : '当前目录中没有可读取的 YAML';
      row.append(cell);
      this.body.append(row);
      restoreScrollPosition(scroll, scrollPosition);
      return;
    }

    const fragment = document.createDocumentFragment();
    visibleRows.forEach(item => fragment.append(this.createRow(item)));
    this.body.append(fragment);
    restoreScrollPosition(scroll, scrollPosition);
  }

  private renderActiveFilters(): void {
    this.tabs.forEach(tab => {
      const active = tab.dataset['planManagementSource'] === this.source;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    this.kindButtons.forEach(button => {
      const active = button.dataset['planManagementKind'] === this.kind;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  private renderCountsAndWarnings(
    rows: readonly PlanManagementRowViewObject[],
  ): void {
    const filteredErrors = this.viewObject.errors.filter(error => (
      this.source === 'all' || error.source === this.source
    ));
    const linkedCount = rows.filter(row => (
      row.kind === 'battle'
      && row.relations.length > 0
      && !row.attention
    )).length;
    const setCount = (id: string, value: number): void => {
      const element = document.getElementById(id);
      if (element) element.textContent = String(value);
    };
    setCount(
      'plan-management-battle-count',
      rows.filter(row => row.kind === 'battle').length,
    );
    setCount(
      'plan-management-team-count',
      rows.filter(row => row.kind === 'team').length,
    );
    setCount('plan-management-linked-count', linkedCount);
    setCount(
      'plan-management-attention-count',
      rows.filter(row => row.attention).length,
    );

    const warning = document.getElementById('plan-management-warning');
    if (!warning) return;
    warning.hidden = filteredErrors.length === 0;
    warning.textContent = filteredErrors.length > 0
      ? `有 ${filteredErrors.length} 个 YAML 无法读取，可在下方查看并处理。`
      : '';
    warning.title = filteredErrors
      .map(error => `${error.source}/${error.file}: ${error.message}`)
      .join('\n');
  }

  private filterRows(
    rows: readonly PlanManagementRowViewObject[],
  ): PlanManagementRowViewObject[] {
    const query = this.query.toLocaleLowerCase('zh-CN');
    const attentionOnly = this.attentionOnly?.checked ?? false;
    return rows.filter(row => {
      if (this.kind !== 'all' && row.kind !== this.kind) return false;
      if (attentionOnly && !row.attention) return false;
      if (!query) return true;
      return [
        row.name,
        row.file,
        row.errorMessage ?? '',
        ...row.relations,
        ...row.taskGroups,
      ].some(value => value.toLocaleLowerCase('zh-CN').includes(query));
    }).sort((left, right) => {
      if (left.attention !== right.attention) return left.attention ? -1 : 1;
      if (left.kind !== right.kind) return left.kind === 'battle' ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  }

  private syncSelections(
    rows: readonly PlanManagementRowViewObject[],
    visibleRows: readonly PlanManagementRowViewObject[],
  ): void {
    const availableKeys = new Set(
      rows
        .filter(row => row.source === 'user')
        .map(row => this.selectionKey({
          kind: row.kind,
          file: row.file,
        })),
    );
    this.selections.forEach((_selection, key) => {
      if (!availableKeys.has(key)) this.selections.delete(key);
    });
    this.visibleSelections = visibleRows
      .filter(row => row.source === 'user')
      .map(row => ({ kind: row.kind, file: row.file }));
    this.updateSelectionControls();
  }

  private createRow(
    item: PlanManagementRowViewObject,
  ): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.classList.toggle('needs-attention', item.attention);
    const selectionCell = this.createSelectionCell(item);
    const planCell = this.createPlanCell(item);
    const sourceCell = this.createSourceCell(item);
    const relationCell = this.createRelationCell(item);
    const taskGroupCell = this.createTaskGroupCell(item);
    const statusCell = document.createElement('td');
    if (item.status) {
      const status = document.createElement('span');
      status.className = `plan-management-status ${item.statusClass}`;
      status.textContent = item.status;
      statusCell.append(status);
    }
    row.append(
      selectionCell,
      planCell,
      sourceCell,
      relationCell,
      taskGroupCell,
      statusCell,
      this.createActionCell(item),
    );
    return row;
  }

  private createSelectionCell(
    item: PlanManagementRowViewObject,
  ): HTMLTableCellElement {
    const cell = document.createElement('td');
    cell.className = 'plan-management-selection-cell';
    if (item.source !== 'user') {
      cell.title = '系统预设不支持导出';
      return cell;
    }
    const selection: UserPlanExportSelection = {
      kind: item.kind,
      file: item.file,
    };
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset['planSelection'] = 'true';
    checkbox.dataset['planKind'] = item.kind;
    checkbox.dataset['planFile'] = item.file;
    checkbox.checked = this.selections.has(this.selectionKey(selection));
    checkbox.disabled = this.exporting || this.deleting;
    checkbox.setAttribute('aria-label', `选择用户配置 ${item.name}`);
    cell.append(checkbox);
    return cell;
  }

  private createPlanCell(
    item: PlanManagementRowViewObject,
  ): HTMLTableCellElement {
    const cell = document.createElement('td');
    const kind = document.createElement('span');
    kind.className = `plan-kind-badge ${item.kind}`;
    kind.textContent = item.kind === 'battle' ? '出征' : '舰队';
    const identity = document.createElement('span');
    identity.className = 'plan-management-identity';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const file = document.createElement('small');
    file.textContent = item.file;
    identity.append(name, file);
    cell.append(kind, identity);
    return cell;
  }

  private createSourceCell(
    item: PlanManagementRowViewObject,
  ): HTMLTableCellElement {
    const cell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `plan-source-badge ${item.source}`;
    badge.textContent = item.source === 'system' ? '系统' : '用户';
    cell.append(badge);
    return cell;
  }

  private createRelationCell(
    item: PlanManagementRowViewObject,
  ): HTMLTableCellElement {
    const cell = document.createElement('td');
    if (item.invalid) {
      cell.textContent = item.errorMessage || 'YAML 格式不合法';
      cell.className = 'plan-management-relation-error';
    } else if (item.relations.length === 0) {
      cell.textContent = item.kind === 'battle'
        ? item.ignoredUnlinked
          ? '该计划已设为无需舰队方案'
          : '未关联舰队方案'
        : item.ignoredUnlinked
          ? '该舰队方案已忽略引用检查'
          : '尚未被出征计划引用';
      cell.className = 'plan-management-relation-empty';
    } else {
      const list = document.createElement('div');
      list.className = 'plan-management-relations';
      item.relations.forEach(relation => {
        const chip = document.createElement('span');
        chip.className = item.missingRelations.includes(relation)
          ? 'plan-relation-chip missing'
          : 'plan-relation-chip';
        chip.textContent = relation;
        if (item.missingRelations.includes(relation)) {
          chip.title = '未找到同名舰队方案';
        }
        list.append(chip);
      });
      cell.append(list);
    }
    return cell;
  }

  private createTaskGroupCell(
    item: PlanManagementRowViewObject,
  ): HTMLTableCellElement {
    const cell = document.createElement('td');
    if (item.kind === 'team') {
      cell.textContent = '—';
      cell.className = 'plan-management-relation-empty';
    } else if (item.taskGroups.length === 0) {
      cell.textContent = '未加入任务分组';
      cell.className = 'plan-management-relation-empty';
    } else {
      const list = document.createElement('div');
      list.className = 'plan-management-relations';
      item.taskGroups.forEach(groupName => {
        const chip = document.createElement('span');
        chip.className = 'plan-relation-chip';
        chip.textContent = groupName;
        list.append(chip);
      });
      cell.append(list);
    }
    return cell;
  }

  private createActionCell(
    item: PlanManagementRowViewObject,
  ): HTMLTableCellElement {
    const cell = document.createElement('td');
    cell.className = 'plan-management-actions';
    if (item.invalid) {
      if (item.source === 'user') {
        cell.append(this.actionButton(
          '删除',
          item.kind === 'battle' ? 'delete' : 'delete-team',
          item.file,
          true,
          item.source,
          item.name,
          item.deleteWarning,
        ));
      } else {
        cell.textContent = '只读';
      }
      return cell;
    }

    if (item.kind === 'battle') {
      cell.append(this.actionButton(
        item.source === 'system' ? '查看' : '编辑',
        'edit-battle',
        item.file,
        false,
        item.source,
      ));
      if (item.relations.length === 0) {
        cell.append(this.unlinkedButton(item));
      }
      if (item.source === 'user') {
        cell.append(
          this.actionButton('重命名', 'rename', item.file),
          this.actionButton('删除', 'delete', item.file, true),
        );
      }
    } else {
      cell.append(this.actionButton(
        item.source === 'system' ? '查看' : '编辑',
        'edit-team',
        item.file,
        false,
        item.source,
      ));
      if (item.relations.length === 0) {
        cell.append(this.unlinkedButton(item));
      }
      if (item.source === 'user') {
        cell.append(this.actionButton(
          '删除',
          'delete-team',
          item.file,
          true,
          item.source,
          item.name,
          item.deleteWarning,
        ));
      }
    }
    return cell;
  }

  private unlinkedButton(
    item: PlanManagementRowViewObject,
  ): HTMLButtonElement {
    const button = this.actionButton(
      item.ignoredUnlinked ? '恢复检查' : '忽略提示',
      'toggle-unlinked',
      item.file,
      false,
      item.source,
    );
    button.dataset['planIgnored'] = String(item.ignoredUnlinked === true);
    button.dataset['planKind'] = item.kind;
    return button;
  }

  private selectionKey(selection: UserPlanExportSelection): string {
    return `${selection.kind}:${selection.file.toLocaleLowerCase('en-US')}`;
  }

  /** 当前筛选视图下已勾选、可执行批量删除的用户配置。 */
  private selectedVisibleSelections(): UserPlanExportSelection[] {
    return filterVisibleSelections(
      this.visibleSelections,
      this.selections,
      selection => this.selectionKey(selection),
    );
  }

  private updateSelectionControls(): void {
    const visibleSelected = this.selectedVisibleSelections();
    const visibleSelectedCount = visibleSelected.length;
    if (this.selectAll) {
      this.selectAll.checked = (
        this.visibleSelections.length > 0
        && visibleSelectedCount === this.visibleSelections.length
      );
      this.selectAll.indeterminate = (
        visibleSelectedCount > 0
        && visibleSelectedCount < this.visibleSelections.length
      );
      this.selectAll.disabled = (
        this.exporting
        || this.deleting
        || this.visibleSelections.length === 0
      );
    }
    if (this.exportButton) {
      this.exportButton.disabled = (
        this.exporting || this.deleting || this.selections.size === 0
      );
      this.exportButton.title = this.selections.size > 0
        ? `导出已选择的 ${this.selections.size} 个用户配置`
        : '请先选择用户配置';
    }
    if (this.legacyExportButton) {
      const battleCount = [...this.selections.values()].filter(
        selection => selection.kind === 'battle',
      ).length;
      this.legacyExportButton.disabled = (
        this.exporting || this.deleting || battleCount === 0
      );
      this.legacyExportButton.title = battleCount > 0
        ? `导出 ${battleCount} 个 1.4.3 兼容出征计划`
        : '请先选择用户出征计划';
    }
    if (this.deleteButton) {
      this.deleteButton.disabled = (
        this.exporting || this.deleting || visibleSelected.length === 0
      );
      this.deleteButton.title = visibleSelected.length > 0
        ? `删除当前筛选下已选择的 ${visibleSelected.length} 个用户配置`
        : '当前筛选下没有已选择的用户配置';
    }
    this.body
      ?.querySelectorAll<HTMLInputElement>('[data-plan-selection]')
      .forEach(checkbox => {
        checkbox.disabled = this.exporting || this.deleting;
      });
  }

  private async exportSelectedPlans(): Promise<void> {
    if (this.exporting || this.deleting || this.selections.size === 0) return;
    const selections = [...this.selections.values()];
    this.exporting = true;
    this.updateSelectionControls();
    try {
      await this.onExportPlans?.(selections);
    } finally {
      this.exporting = false;
      this.updateSelectionControls();
    }
  }

  private async deleteSelectedPlans(): Promise<void> {
    if (this.exporting || this.deleting || this.selections.size === 0) return;
    const selections = this.selectedVisibleSelections();
    if (selections.length === 0) return;
    this.deleting = true;
    this.updateSelectionControls();
    try {
      await this.onDeletePlans?.(selections);
    } finally {
      this.deleting = false;
      this.updateSelectionControls();
    }
  }

  private actionButton(
    label: string,
    operation:
      | 'rename'
      | 'delete'
      | 'edit-battle'
      | 'edit-team'
      | 'delete-team'
      | 'toggle-unlinked',
    file: string,
    danger = false,
    source?: PlanPresetSource,
    name?: string,
    warning?: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    const primary = label === '编辑'
      && (operation === 'edit-battle' || operation === 'edit-team');
    button.className = [
      'btn',
      'btn-small',
      danger ? 'btn-danger' : '',
      primary ? 'btn-primary' : '',
    ].filter(Boolean).join(' ');
    button.dataset['planOperation'] = operation;
    button.dataset['planFile'] = file;
    if (source) button.dataset['planSource'] = source;
    if (name) button.dataset['planName'] = name;
    if (warning) button.dataset['planWarning'] = warning;
    button.textContent = label;
    return button;
  }

  private async toggleUnlinkedIgnored(
    kind: 'battle' | 'team',
    file: string,
    source: PlanPresetSource,
    ignored: boolean,
  ): Promise<void> {
    await this.onToggleUnlinked?.(kind, source, file, ignored);
  }

  private async renameCombatPlan(file: string): Promise<void> {
    await this.onRenameCombatPlan?.(file);
  }

  private async deleteCombatPlan(file: string): Promise<void> {
    await this.onDeleteCombatPlan?.(file);
  }

  private async deleteTeamPlan(
    file: string,
    name: string,
    warning: string,
  ): Promise<void> {
    await this.onDeleteTeamPlan?.(file, name, warning);
  }
}
