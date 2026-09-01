/** 渲染受管作战方案选择器，并收集搜索、筛选和舰队选择操作。 */
import type {
  ManagedBattlePlan,
  PlanPresetSource,
} from '../../types/ipc.js';
import {
  lootAutomationPlanKey,
  type LootAutomationPlan,
} from '../../shared/lootPlans.js';
import {
  MAX_NORMAL_FIGHT_DAILY_EXECUTIONS,
} from '../../shared/normalFightQuota.js';
import { LoaderDialog } from '../shared/LoaderDialog';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';
import { appendTeamPlanCardContent } from './TeamPlanListUi';

export type BattlePlanLoaderPurpose =
  | 'editor'
  | 'queue'
  | 'task-list'
  | 'automation'
  | 'loot-automation';

export type BattlePlanSortField = 'name' | 'modifiedAt';

export interface BattlePlanLoaderCallbacks {
  onCancel(): void;
  onImportLocal(): void;
  onRefresh(): void;
  onFiltersChange(): void;
  onSortFieldChange(field: BattlePlanSortField): void;
  onSelectPlan(file: string, source: PlanPresetSource): void;
  onSelectFleet(index: number): void;
  onAutomationDailyMaxChange(value: number): number;
  onAddLootPlan(file: string, source: PlanPresetSource): void;
  onDeleteLootPlan(source: PlanPresetSource, file: string): void;
  onConfirm(): void;
}

export interface BattlePlanLoaderFilters {
  keyword: string;
  excludeSystem: boolean;
  ascending: boolean;
}

export interface BattlePlanLoaderViewObject {
  plans: ManagedBattlePlan[];
  totalPlanCount: number;
  selectedPlan: ManagedBattlePlan | null;
  selectedFleetIndex: number | null;
  purpose: BattlePlanLoaderPurpose;
  lootPlans: LootAutomationPlan[];
  automationDailyMax: number;
  fleetSelectionEnabled: boolean;
  confirmEnabled: boolean;
}

export class BattlePlanLoaderView {
  private readonly dialogElement = document.getElementById(
    'battle-plan-loader',
  )!;
  private readonly dialog = new LoaderDialog(this.dialogElement);
  private callbacks: BattlePlanLoaderCallbacks | null = null;

  bindActions(callbacks: BattlePlanLoaderCallbacks): void {
    this.callbacks = callbacks;
    document.getElementById('btn-cancel-battle-plan-loader')?.addEventListener(
      'click',
      () => callbacks.onCancel(),
    );
    document.getElementById('btn-import-local-battle-plan')?.addEventListener(
      'click',
      () => callbacks.onImportLocal(),
    );
    document.getElementById('btn-refresh-battle-plan-loader')?.addEventListener(
      'click',
      () => callbacks.onRefresh(),
    );
    document.getElementById('battle-plan-loader-search')?.addEventListener(
      'input',
      () => callbacks.onFiltersChange(),
    );
    document.getElementById('battle-plan-loader-filter-system')?.addEventListener(
      'change',
      () => callbacks.onFiltersChange(),
    );
    document.getElementById('battle-plan-loader-sort-asc')?.addEventListener(
      'change',
      () => callbacks.onFiltersChange(),
    );
    document.querySelectorAll<HTMLElement>(
      '[data-battle-plan-sort-field]',
    ).forEach((button) => {
      button.addEventListener('click', () => {
        callbacks.onSortFieldChange(
          button.dataset['battlePlanSortField'] === 'name'
            ? 'name'
            : 'modifiedAt',
        );
      });
    });
    document.getElementById('battle-plan-loader-list')?.addEventListener(
      'click',
      (event) => {
        const addButton = (
          event.target as HTMLElement
        ).closest<HTMLButtonElement>('[data-loot-plan-add]');
        if (addButton) {
          const file = addButton.dataset['lootPlanFile'];
          const source = addButton.dataset['lootPlanSource'];
          if (file && (source === 'system' || source === 'user')) {
            callbacks.onAddLootPlan(file, source);
          }
          return;
        }
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
          '[data-battle-plan-file]',
        );
        const file = button?.dataset['battlePlanFile'];
        const source = button?.dataset['battlePlanSource'];
        if (
          file
          && (source === 'system' || source === 'user')
        ) {
          callbacks.onSelectPlan(file, source);
        }
      },
    );
    document.getElementById(
      'battle-plan-loader-preview-body',
    )?.addEventListener('click', (event) => {
      const button = (
        event.target as HTMLElement
      ).closest<HTMLButtonElement>('[data-loot-plan-delete]');
      const file = button?.dataset['lootPlanFile'];
      const source = button?.dataset['lootPlanSource'];
      if (file && (source === 'system' || source === 'user')) {
        callbacks.onDeleteLootPlan(source, file);
      }
    });
    document.getElementById('btn-confirm-battle-plan-loader')?.addEventListener(
      'click',
      () => callbacks.onConfirm(),
    );
    this.dialog.bindDismiss(callbacks.onCancel);
  }

  open(): void {
    this.dialog.open();
  }

  close(): void {
    this.dialog.close();
  }

  resetSearch(): void {
    const searchInput = document.getElementById(
      'battle-plan-loader-search',
    ) as HTMLInputElement | null;
    if (searchInput) searchInput.value = '';
  }

  focusSearch(): void {
    const searchInput = document.getElementById(
      'battle-plan-loader-search',
    ) as HTMLInputElement | null;
    searchInput?.focus();
  }

  getFilters(): BattlePlanLoaderFilters {
    const searchInput = document.getElementById(
      'battle-plan-loader-search',
    ) as HTMLInputElement | null;
    const filterSystem = document.getElementById(
      'battle-plan-loader-filter-system',
    ) as HTMLInputElement | null;
    const sortAsc = document.getElementById(
      'battle-plan-loader-sort-asc',
    ) as HTMLInputElement | null;
    return {
      keyword: (searchInput?.value ?? '').trim().toLocaleLowerCase('zh-CN'),
      excludeSystem: filterSystem?.checked ?? false,
      ascending: sortAsc?.checked ?? false,
    };
  }

  setSortField(field: BattlePlanSortField): void {
    document.querySelectorAll<HTMLElement>(
      '[data-battle-plan-sort-field]',
    ).forEach((item) => {
      item.classList.toggle(
        'active',
        item.dataset['battlePlanSortField'] === field,
      );
    });
  }

  setPurposeCopy(purpose: BattlePlanLoaderPurpose): void {
    const pickingForQueue = purpose === 'queue';
    const pickingForTaskList = purpose === 'task-list';
    const pickingForAutomation = purpose === 'automation';
    const pickingForLootAutomation = purpose === 'loot-automation';
    const title = document.getElementById('battle-plan-loader-title');
    const description = document.getElementById(
      'battle-plan-loader-description',
    );
    const confirm = document.getElementById(
      'btn-confirm-battle-plan-loader',
    );
    if (title) {
      title.textContent = pickingForQueue
        ? '加载计划到任务队列'
        : pickingForTaskList
          ? '添加计划到任务列表'
          : pickingForAutomation
            ? '加载自动出征计划'
            : pickingForLootAutomation
              ? '加载自动胖次计划'
            : '加载出征配置';
    }
    if (description) {
      description.textContent = pickingForQueue
        ? '选择加入任务队列的作战计划；计划包含编队时需选择本次使用的编队。'
        : pickingForTaskList
          ? '选择作战计划；计划包含编队时需选择本次使用的编队。'
          : pickingForAutomation
            ? '选择自动出征使用的作战计划和队伍。'
            : pickingForLootAutomation
              ? '将系统或用户出征计划加入自动胖次下拉列表。'
            : '读取系统与用户作战计划目录中的合法 YAML 配置。';
    }
    if (confirm) {
      confirm.textContent = pickingForQueue
        ? '加入队列'
        : pickingForTaskList
          ? '添加到列表'
          : pickingForLootAutomation
            ? '确认'
            : '加载';
    }
  }

  setStatus(message: string): void {
    const status = document.getElementById('battle-plan-loader-status');
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  }

  setCount(count: number): void {
    const element = document.getElementById('battle-plan-loader-count');
    if (element) element.textContent = `共读取 ${count} 个作战配置`;
  }

  setImportLoading(loading: boolean): void {
    const button = document.getElementById(
      'btn-import-local-battle-plan',
    ) as HTMLButtonElement | null;
    if (button) button.disabled = loading;
  }

  render(vo: BattlePlanLoaderViewObject): void {
    const list = document.getElementById('battle-plan-loader-list');
    if (!list) return;
    const scrollPosition = captureScrollPosition(list);
    list.replaceChildren();
    if (vo.plans.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fleet-team-loader-preview-empty';
      empty.textContent = vo.totalPlanCount === 0
        ? '未读取到合法的作战配置'
        : '没有符合当前条件的作战配置';
      list.append(empty);
      this.clearSelection(
        vo.purpose,
        vo.lootPlans,
        vo.confirmEnabled,
      );
      restoreScrollPosition(list, scrollPosition);
      return;
    }

    const lootPlanKeys = new Set(
      vo.lootPlans.map(plan => lootAutomationPlanKey(plan)),
    );
    vo.plans.forEach((plan) => {
      const card = document.createElement(
        vo.purpose === 'loot-automation' ? 'div' : 'button',
      );
      if (card instanceof HTMLButtonElement) card.type = 'button';
      card.className = 'fleet-team-loader-item battle-plan-loader-item';
      card.dataset['battlePlanFile'] = plan.file;
      card.dataset['battlePlanSource'] = plan.source;
      card.classList.toggle(
        'active',
        this.sameBattlePlan(plan, vo.selectedPlan),
      );
      if (vo.purpose === 'loot-automation') {
        card.classList.add('loot-automation-plan-card');
      }

      const heading = document.createElement('div');
      heading.className = 'fleet-team-loader-item-heading';
      const name = document.createElement('strong');
      name.textContent = plan.name;
      const badge = document.createElement('span');
      badge.className = `fleet-team-source-badge ${plan.source}`;
      badge.textContent = plan.source === 'system' ? '系统预设' : '用户预设';
      heading.append(name, badge);

      const fileName = document.createElement('span');
      fileName.className = 'battle-plan-loader-item-file';
      fileName.textContent = plan.file;
      fileName.title = plan.file;
      const meta = document.createElement('span');
      meta.className = 'battle-plan-loader-item-meta';
      meta.textContent = plan.kind === 'preset'
        ? `${this.taskPresetTypeLabel(plan)} · 任务预设`
        : plan.modifiedAt > 0
          ? `${this.battlePlanMapLabel(plan)} · ${plan.fleetCount} 支关联编队`
          : `${plan.fleetCount} 支关联编队 · 重启后显示完整摘要`;
      card.append(heading, fileName, meta);
      if (vo.purpose === 'loot-automation') {
        const addButton = document.createElement('button');
        const added = lootPlanKeys.has(lootAutomationPlanKey(plan));
        addButton.type = 'button';
        addButton.className = 'btn btn-small btn-primary loot-plan-add-button';
        addButton.dataset['lootPlanAdd'] = 'true';
        addButton.dataset['lootPlanFile'] = plan.file;
        addButton.dataset['lootPlanSource'] = plan.source;
        addButton.textContent = added ? '已加入' : '加入列表';
        addButton.disabled = added;
        card.append(addButton);
      }
      list.append(card);
    });
    if (vo.selectedPlan) {
      this.renderPreview(
        vo.selectedPlan,
        vo.selectedFleetIndex,
        vo.purpose,
        vo.lootPlans,
        vo.automationDailyMax,
        vo.fleetSelectionEnabled,
        vo.confirmEnabled,
      );
    }
    restoreScrollPosition(list, scrollPosition);
  }

  private renderPreview(
    plan: ManagedBattlePlan,
    selectedFleetIndex: number | null,
    purpose: BattlePlanLoaderPurpose,
    lootPlans: LootAutomationPlan[],
    automationDailyMax: number,
    fleetSelectionEnabled: boolean,
    confirmEnabled: boolean,
  ): void {
    const title = document.getElementById('battle-plan-loader-preview-title');
    const badge = document.getElementById('battle-plan-loader-preview-source');
    const body = document.getElementById('battle-plan-loader-preview-body');
    const confirmButton = document.getElementById(
      'btn-confirm-battle-plan-loader',
    ) as HTMLButtonElement | null;
    if (title) title.textContent = `配置预览：${plan.name}`;
    if (badge) {
      badge.hidden = false;
      badge.className = `fleet-team-source-badge ${plan.source}`;
      badge.textContent = plan.source === 'system' ? '系统预设' : '用户预设';
    }
    if (body) {
      const hasDetails = plan.modifiedAt > 0;
      if (plan.kind === 'preset') {
        body.replaceChildren(
          this.createPreviewField('任务类型', this.taskPresetTypeLabel(plan)),
          this.createPreviewField('执行次数', `${plan.times} 次`),
          this.createPreviewField(
            '任务参数',
            this.taskPresetParameterLabel(plan),
            true,
          ),
          this.createPreviewField(
            '完整配置',
            '加载后可在任务预设页面查看',
            true,
          ),
        );
      } else {
        const children: HTMLElement[] = [
          this.createPreviewField('章节关卡', this.battlePlanMapLabel(plan)),
          purpose === 'automation'
            ? this.createAutomationDailyMaxField(automationDailyMax)
            : this.createPreviewField(
                '执行次数',
                hasDetails ? `${plan.times} 次` : '重启后显示',
              ),
          this.createPreviewField(
            '维修方案',
            hasDetails
              ? `${this.battlePlanRepairLabel(plan.repairMode)}-${this.repairMethodLabel()}`
              : '重启后显示',
          ),
          this.createPreviewField(
            '终点战果判断',
            hasDetails ? this.battlePlanResultLabel(plan.result) : '重启后显示',
          ),
          this.createFleetPreview(
            plan,
            hasDetails,
            selectedFleetIndex,
            fleetSelectionEnabled,
          ),
        ];
        if (purpose === 'loot-automation') {
          children.push(this.createLootPlanListPreview(plan.name, lootPlans));
        } else {
          children.push(this.createStopPreview(plan, hasDetails));
        }
        body.replaceChildren(...children);
      }
    }
    if (confirmButton) {
      confirmButton.disabled = !confirmEnabled;
    }
  }

  private createLootPlanListPreview(
    selectedName: string,
    plans: readonly LootAutomationPlan[],
  ): HTMLElement {
    const section = document.createElement('section');
    section.className = (
      'battle-plan-preview-section wide loot-plan-list-preview'
    );
    const heading = document.createElement('div');
    heading.className = (
      'battle-plan-preview-heading loot-plan-list-preview-heading'
    );
    const title = document.createElement('h3');
    title.textContent = `列表预览：${selectedName}`;
    const note = document.createElement('span');
    note.textContent = '设置自动胖次的下拉列表';
    heading.append(title, note);
    const list = document.createElement('div');
    list.className = 'loot-plan-list-preview-cards';
    if (plans.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'battle-plan-preview-empty';
      empty.textContent = '列表为空，请从左侧加入计划';
      list.append(empty);
    } else {
      plans.forEach((plan) => {
        const card = document.createElement('div');
        card.className = 'loot-plan-list-preview-card';
        const name = document.createElement('strong');
        name.textContent = plan.name;
        name.title = plan.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-small loot-plan-delete-button';
        remove.dataset['lootPlanDelete'] = 'true';
        remove.dataset['lootPlanFile'] = plan.file;
        remove.dataset['lootPlanSource'] = plan.source;
        remove.textContent = '删除';
        card.append(name, remove);
        list.append(card);
      });
    }
    section.append(heading, list);
    return section;
  }

  private createPreviewField(
    label: string,
    value: string,
    wide = false,
  ): HTMLElement {
    const field = document.createElement('div');
    field.className = `battle-plan-preview-field${wide ? ' wide' : ''}`;
    const caption = document.createElement('span');
    caption.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value;
    content.title = value;
    field.append(caption, content);
    return field;
  }

  private createAutomationDailyMaxField(value: number): HTMLElement {
    const field = document.createElement('label');
    field.className = 'battle-plan-preview-field automation-daily-max-field';
    const caption = document.createElement('span');
    caption.textContent = '每日最大执行次数';
    const editor = document.createElement('span');
    editor.className = 'automation-daily-max-editor';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'input';
    input.min = '1';
    input.max = String(MAX_NORMAL_FIGHT_DAILY_EXECUTIONS);
    input.step = '1';
    input.value = String(value);
    input.addEventListener('input', () => {
      if (
        input.valueAsNumber >= 1
        && input.valueAsNumber <= MAX_NORMAL_FIGHT_DAILY_EXECUTIONS
      ) {
        this.callbacks?.onAutomationDailyMaxChange(input.valueAsNumber);
      }
    });
    input.addEventListener('change', () => {
      const normalized = this.callbacks?.onAutomationDailyMaxChange(
        input.valueAsNumber,
      ) ?? value;
      input.value = String(normalized);
    });
    const unit = document.createElement('strong');
    unit.textContent = '次';
    editor.append(input, unit);
    field.append(caption, editor);
    return field;
  }

  private createFleetPreview(
    plan: ManagedBattlePlan,
    hasDetails: boolean,
    selectedFleetIndex: number | null,
    fleetSelectionEnabled: boolean,
  ): HTMLElement {
    const section = document.createElement('section');
    section.className = 'battle-plan-preview-section wide';
    const heading = document.createElement('div');
    heading.className = 'battle-plan-preview-section-heading';
    const title = document.createElement('span');
    title.textContent = '使用舰队';
    const fleetId = document.createElement('strong');
    fleetId.textContent = hasDetails
      ? `舰队编号：第 ${plan.fleetId} 舰队`
      : '舰队编号：重启后显示';
    heading.append(title, fleetId);

    const list = document.createElement('div');
    list.className = 'battle-plan-preview-fleet-list';
    if (plan.fleets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'battle-plan-preview-empty';
      empty.textContent = fleetSelectionEnabled
        ? '未配置编队预设，将使用 YAML 的舰队编号和游戏当前编成'
        : '未配置编队预设';
      list.append(empty);
    } else {
      const selectable = fleetSelectionEnabled;
      plan.fleets.forEach((fleet, index) => {
        const card = document.createElement(selectable ? 'button' : 'div');
        if (card instanceof HTMLButtonElement) card.type = 'button';
        card.className = 'fleet-team-loader-item battle-plan-preview-fleet-card';
        card.classList.toggle('selectable', selectable);
        card.classList.toggle(
          'active',
          selectable && selectedFleetIndex === index,
        );
        appendTeamPlanCardContent(card, {
          name: fleet.name,
          source: fleet.source,
          primaryCount: fleet.primaryCount,
          backupCount: fleet.backupCount,
        });
        if (selectable) {
          const state = document.createElement('span');
          state.className = 'battle-plan-fleet-selection-state';
          state.textContent = selectedFleetIndex === index
            ? '已选择'
            : '点击选择';
          card.append(state);
          card.setAttribute(
            'aria-pressed',
            String(selectedFleetIndex === index),
          );
          card.addEventListener(
            'click',
            () => this.callbacks?.onSelectFleet(index),
          );
        }
        list.append(card);
      });
    }
    section.append(heading, list);
    return section;
  }

  private createStopPreview(
    plan: ManagedBattlePlan,
    hasDetails: boolean,
  ): HTMLElement {
    const field = document.createElement('section');
    field.className = 'battle-plan-preview-section wide';
    const heading = document.createElement('div');
    heading.className = 'battle-plan-preview-section-heading';
    const title = document.createElement('span');
    title.textContent = '停止检测';
    heading.append(title);

    const values = document.createElement('div');
    values.className = 'battle-plan-preview-stop-values';
    const loot = document.createElement('div');
    const lootLabel = document.createElement('span');
    lootLabel.textContent = '战利品检测';
    const lootValue = document.createElement('strong');
    lootValue.textContent = hasDetails
      ? this.stopCountLabel(plan.lootCountGe)
      : '重启后显示';
    loot.append(lootLabel, lootValue);
    const ship = document.createElement('div');
    const shipLabel = document.createElement('span');
    shipLabel.textContent = '掉落检测';
    const shipValue = document.createElement('strong');
    shipValue.textContent = hasDetails
      ? this.stopCountLabel(plan.shipCountGe)
      : '重启后显示';
    ship.append(shipLabel, shipValue);
    values.append(loot, ship);
    field.append(heading, values);
    return field;
  }

  private stopCountLabel(value: number): string {
    return value >= 0 ? String(value) : '未开启';
  }

  private clearSelection(
    purpose: BattlePlanLoaderPurpose,
    lootPlans: readonly LootAutomationPlan[],
    confirmEnabled: boolean,
  ): void {
    const title = document.getElementById('battle-plan-loader-preview-title');
    const badge = document.getElementById('battle-plan-loader-preview-source');
    const body = document.getElementById('battle-plan-loader-preview-body');
    const confirmButton = document.getElementById(
      'btn-confirm-battle-plan-loader',
    ) as HTMLButtonElement | null;
    if (title) title.textContent = '配置预览：未选择';
    if (badge) badge.hidden = true;
    if (body) {
      if (purpose === 'loot-automation') {
        body.replaceChildren(
          this.createLootPlanListPreview('未选择', lootPlans),
        );
      } else {
        const empty = document.createElement('div');
        empty.className = 'fleet-team-loader-preview-empty';
        empty.textContent = '从左侧选择一个出征配置查看摘要';
        body.replaceChildren(empty);
      }
    }
    if (confirmButton) {
      confirmButton.disabled = !confirmEnabled;
    }
  }

  private sameBattlePlan(
    left: ManagedBattlePlan | null,
    right: ManagedBattlePlan | null,
  ): boolean {
    return Boolean(
      left
      && right
      && left.file === right.file
      && left.source === right.source,
    );
  }

  private battlePlanMapLabel(plan: ManagedBattlePlan): string {
    if (plan.kind === 'preset') return this.taskPresetTypeLabel(plan);
    const chapter = String(plan.chapter).trim();
    const map = String(plan.map);
    if (chapter === '?' || map === '?') return '重启后显示';
    const normalizedChapter = chapter.toLocaleUpperCase('en-US');
    const normalizedMap = map.toLocaleUpperCase('en-US');
    if (normalizedChapter === 'E' || normalizedChapter === 'H') {
      return `${normalizedChapter}${normalizedMap}`;
    }
    if (normalizedChapter === 'EX') return `EX-${normalizedMap}`;
    return `${chapter}-${map}`;
  }

  private taskPresetTypeLabel(plan: ManagedBattlePlan): string {
    const labels: Record<string, string> = {
      normal_fight: '普通出击',
      event_fight: '活动出击',
      campaign: '战役',
      exercise: '演习',
      decisive: '决战',
    };
    return labels[plan.taskType ?? ''] ?? plan.taskType ?? '任务预设';
  }

  private taskPresetParameterLabel(plan: ManagedBattlePlan): string {
    if (plan.taskType === 'campaign') {
      return plan.campaignName || '未指定战役';
    }
    if (plan.taskType === 'exercise') {
      return `第 ${plan.fleetId} 舰队`;
    }
    if (plan.taskType === 'decisive') {
      return `第 ${plan.chapter} 章`;
    }
    return '引用受管出征计划';
  }

  private battlePlanRepairLabel(repairMode: number | number[]): string {
    const label = (value: number): string => {
      if (value === 1) return '中破就修';
      if (value === 2) return '大破才修';
      return String(value);
    };
    return Array.isArray(repairMode)
      ? `按舰位：${repairMode.map(label).join(' / ')}`
      : label(repairMode);
  }

  private repairMethodLabel(): string {
    const method = document.getElementById(
      'plan-edit-repair-method',
    ) as HTMLSelectElement | null;
    return method?.value === 'bath' ? '泡澡维修' : '快速维修';
  }

  private battlePlanResultLabel(result: ManagedBattlePlan['result']): string {
    if (!result) return '不判断';
    return result === 'SS' ? result : `${result}及以上`;
  }
}
