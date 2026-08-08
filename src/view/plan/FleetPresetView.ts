/** 渲染方案内舰队预设并提供应用、编辑和任务创建入口。 */
import type {
  FleetShipLibraryViewObject,
  PlanFleetPresetBindingViewObject,
  PlanFleetPresetSelectorViewObject,
  TeamPlanSlotViewObject,
  TeamPlanViewObject,
} from '../../types/view.js';
import type { BathRepairConfig } from '../../types/model.js';
import {
  appendTeamPlanCardContent,
  filterAndSortTeamPlans,
  teamPlanCardData,
} from './TeamPlanListUi';
import type {
  TeamPlanCardData,
  TeamPlanCardSource,
  TeamPlanSortField,
} from './TeamPlanListUi';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';
import { createShipArtwork } from './ShipArtwork';

interface ShipPreviewRule {
  name: string;
  minLevel?: number;
  maxLevel?: number;
}

export class FleetPresetView {
  private readonly fleetPresetSection: HTMLElement;
  private readonly fleetPresetListEl: HTMLElement;
  private readonly fleetBindingListEl: HTMLElement;
  private readonly mainPreview: HTMLElement;
  private readonly backupPreview: HTMLElement;
  private readonly previewTitle: HTMLElement;
  private readonly backupTitle: HTMLElement;
  private readonly selectorPanel: HTMLElement;
  private readonly nodeRoutePanel: HTMLElement;
  private readonly selectorSearch: HTMLInputElement;
  private readonly selectorCount: HTMLElement;
  private readonly selectorFilterSystem: HTMLInputElement;
  private readonly selectorSortButtons: HTMLButtonElement[];
  private readonly selectorSortAscending: HTMLInputElement;
  private readonly selectorStatus: HTMLElement;

  private userTeams: readonly TeamPlanViewObject[] = [];
  private bindings: readonly PlanFleetPresetBindingViewObject[] = [];
  private shipLibrary: FleetShipLibraryViewObject | null = null;
  private activePreviewTeamId: string | null = null;
  private activePreviewPosition = 0;
  private selectorSortField: TeamPlanSortField = 'modifiedAt';
  private draggedTeamId: string | null = null;
  private teamListDragScrollTop = 0;

  onAddFleetPreset?: (planId: string) => void;
  onRemoveFleetPreset?: (index: number) => void;

  constructor() {
    this.fleetPresetSection = document.getElementById('fleet-preset-section')!;
    this.fleetPresetListEl = document.getElementById('fleet-preset-list')!;
    this.fleetBindingListEl = document.getElementById('fleet-binding-list')!;
    this.mainPreview = document.getElementById('fleet-team-main-preview')!;
    this.backupPreview = document.getElementById('fleet-team-backup-preview')!;
    this.previewTitle = document.getElementById('fleet-team-preview-title')!;
    this.backupTitle = document.getElementById('fleet-team-backup-title')!;
    this.selectorPanel = document.getElementById('fleet-selector-panel')!;
    this.nodeRoutePanel = document.getElementById('plan-node-route-panel')!;
    this.selectorSearch = document.getElementById(
      'plan-team-selector-search',
    ) as HTMLInputElement;
    this.selectorCount = document.getElementById(
      'plan-team-selector-count',
    )!;
    this.selectorFilterSystem = document.getElementById(
      'plan-team-selector-filter-system',
    ) as HTMLInputElement;
    this.selectorSortButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-plan-team-sort-field]',
      ),
    );
    this.selectorSortAscending = document.getElementById(
      'plan-team-selector-sort-asc',
    ) as HTMLInputElement;
    this.selectorStatus = document.getElementById(
      'plan-team-selector-status',
    )!;

    document.getElementById('btn-open-fleet-selector')?.addEventListener(
      'click',
      () => this.showSelector(),
    );
    document.getElementById('btn-close-fleet-selector')?.addEventListener(
      'click',
      () => this.hideSelector(),
    );
    this.selectorSearch.addEventListener('input', () => {
      this.renderTeamList();
    });
    this.selectorFilterSystem.addEventListener('change', () => {
      this.renderTeamList();
    });
    this.selectorSortAscending.addEventListener('change', () => {
      this.renderTeamList();
    });
    this.selectorSortButtons.forEach(button => {
      button.addEventListener('click', () => {
        const field = button.dataset['planTeamSortField'];
        if (field !== 'name' && field !== 'modifiedAt') return;
        this.selectorSortField = field;
        this.selectorSortButtons.forEach(option => {
          option.classList.toggle('active', option === button);
        });
        this.renderTeamList();
      });
    });
    this.fleetBindingListEl.addEventListener('dragover', event => {
      if (this.draggedTeamId === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      this.fleetBindingListEl.classList.add('drag-active');
    });
    this.fleetBindingListEl.addEventListener('dragleave', event => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node
        && this.fleetBindingListEl.contains(nextTarget)
      ) {
        return;
      }
      this.fleetBindingListEl.classList.remove('drag-active');
    });
    this.fleetBindingListEl.addEventListener('drop', event => {
      if (this.draggedTeamId === null) return;
      event.preventDefault();
      this.applyTeamPreset(this.draggedTeamId);
      this.fleetBindingListEl.classList.remove('drag-active');
    });
  }

  showSelector(): void {
    this.nodeRoutePanel.hidden = true;
    this.selectorPanel.hidden = false;
  }
  hideSelector(): void {
    this.selectorPanel.hidden = true;
    this.nodeRoutePanel.hidden = false;
  }

  render(viewObject: PlanFleetPresetSelectorViewObject): void {
    this.fleetPresetSection.style.display = '';
    this.userTeams = viewObject.plans;
    this.bindings = viewObject.bindings;
    this.shipLibrary = viewObject.shipLibrary;
    const activePlan = this.userTeams.find(
      plan => plan.id === this.activePreviewTeamId,
    );
    if (!activePlan) {
      this.activePreviewTeamId = this.userTeams.find(
        plan => plan.selected,
      )?.id ?? (
        this.bindings.length === 0
          ? this.userTeams[0]?.id ?? null
          : null
      );
    }

    if (viewObject.status === 'loading') {
      this.selectorCount.textContent = '正在读取编队预设…';
      this.selectorStatus.textContent = '';
    } else if (viewObject.status === 'error') {
      this.selectorCount.textContent = '读取失败';
      this.selectorStatus.textContent = viewObject.message;
    } else {
      this.selectorCount.textContent =
        `共读取 ${this.userTeams.length} 个舰队预设`;
      this.selectorStatus.textContent = viewObject.errorCount > 0
        ? `有 ${viewObject.errorCount} 个配置格式不合法，已跳过`
        : '';
    }

    this.renderTeamList();
    this.renderBindings();
    this.renderPreview(
      this.userTeams.find(
        plan => plan.id === this.activePreviewTeamId,
      )?.ships ?? this.bindings[0]?.ships,
    );
  }

  private renderTeamList(): void {
    const scrollPosition = captureScrollPosition(this.fleetPresetListEl);
    const visibleTeams = filterAndSortTeamPlans(this.userTeams, {
      search: this.selectorSearch.value,
      filterSystem: this.selectorFilterSystem.checked,
      sortField: this.selectorSortField,
      ascending: this.selectorSortAscending.checked,
    });
    const previousPreviewId = this.activePreviewTeamId;
    const firstVisibleId = visibleTeams[0]?.plan.id;
    const activePreviewVisible = visibleTeams.some(
      ({ plan }) => plan.id === this.activePreviewTeamId,
    );
    if (
      this.activePreviewTeamId === null
      && this.bindings.length === 0
      && firstVisibleId !== undefined
    ) {
      this.activePreviewTeamId = firstVisibleId;
    } else if (
      this.activePreviewTeamId !== null
      && !activePreviewVisible
    ) {
      this.activePreviewTeamId = firstVisibleId ?? null;
    }

    this.fleetPresetListEl.replaceChildren();
    if (this.userTeams.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fleet-team-empty';
      empty.textContent = '暂无编队预设，请先在“舰队规划”中保存';
      this.fleetPresetListEl.append(empty);
      restoreScrollPosition(this.fleetPresetListEl, scrollPosition);
      return;
    }

    if (visibleTeams.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fleet-team-empty';
      empty.textContent = '没有符合当前过滤条件的舰队预设';
      this.fleetPresetListEl.append(empty);
    }

    visibleTeams.forEach(({ plan }) => {
      const item = document.createElement('div');
      item.className = 'fleet-team-loader-item fleet-preset-item';
      item.dataset['teamPlanId'] = plan.id;
      item.draggable = true;
      item.title = `拖拽“${plan.name}”到编队配置`;
      item.classList.toggle(
        'selected',
        plan.selected,
      );
      item.classList.toggle(
        'previewing',
        this.activePreviewTeamId === plan.id,
      );

      const previewButton = document.createElement('button');
      previewButton.type = 'button';
      previewButton.className = 'fleet-preset-preview-button';
      appendTeamPlanCardContent(previewButton, teamPlanCardData(plan));

      previewButton.addEventListener('click', () => {
        this.activePreviewTeamId = plan.id;
        this.fleetPresetListEl
          .querySelectorAll<HTMLElement>('[data-team-plan-id]')
          .forEach(option => {
            option.classList.toggle(
              'previewing',
              option.dataset['teamPlanId'] === plan.id,
            );
          });
        this.renderPreview(plan.ships);
      });
      item.append(previewButton);

      item.addEventListener('dragstart', event => {
        this.draggedTeamId = plan.id;
        this.teamListDragScrollTop = this.fleetPresetListEl.scrollTop;
        item.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('text/plain', plan.id);
        }
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        this.draggedTeamId = null;
        this.fleetBindingListEl.classList.remove('drag-active');
        this.restoreTeamListScroll();
      });
      this.fleetPresetListEl.append(item);
    });

    if (this.activePreviewTeamId !== previousPreviewId) {
      this.renderPreview(
        this.userTeams.find(
          plan => plan.id === this.activePreviewTeamId,
        )?.ships,
      );
    }
    restoreScrollPosition(this.fleetPresetListEl, scrollPosition);
  }

  /** 当前没有生产入口引用，保留给泡澡维修配置后续接入。 */
  getBathRepairConfig(): BathRepairConfig | undefined {
    const method = document.getElementById(
      'plan-edit-repair-method',
    ) as HTMLSelectElement | null;
    if (method?.value !== 'bath') return undefined;

    return {
      enabled: true,
      defaultThreshold: { type: 'percent', value: 50 },
    };
  }


  private renderBindings(): void {
    this.fleetBindingListEl.replaceChildren();
    if (this.bindings.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fleet-team-empty fleet-binding-empty';
      empty.textContent = '拖拽预设卡片到这里';
      this.fleetBindingListEl.append(empty);
      return;
    }

    this.bindings.forEach((binding) => {
      const record = document.createElement('div');
      record.className = 'fleet-team-loader-item fleet-binding-record';

      const previewButton = document.createElement('button');
      previewButton.type = 'button';
      previewButton.className = 'fleet-binding-preview';
      appendTeamPlanCardContent(
        previewButton,
        this.boundTeamCardData(
          binding,
          binding.source,
          binding.modifiedAt,
        ),
      );

      previewButton.addEventListener('click', () => {
        this.showSelector();
        const sourcePlan = this.userTeams.find(
          plan => plan.id === binding.catalogPlanId,
        );
        if (sourcePlan) {
          this.selectorSearch.value = '';
          if (sourcePlan.source === 'system') {
            this.selectorFilterSystem.checked = false;
          }
        }
        this.activePreviewTeamId = sourcePlan?.id ?? null;
        this.renderTeamList();
        this.renderPreview(binding.ships);
      });

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'fleet-binding-remove';
      removeButton.setAttribute('aria-label', `移除${binding.name}`);
      removeButton.title = `从编队配置中移除“${binding.name}”`;
      removeButton.textContent = '×';
      removeButton.addEventListener('click', () => {
        this.onRemoveFleetPreset?.(binding.index);
      });

      record.append(previewButton, removeButton);
      this.fleetBindingListEl.append(record);
    });
  }

  private boundTeamCardData(
    binding: PlanFleetPresetBindingViewObject,
    source: TeamPlanCardSource,
    modifiedAt?: number,
  ): TeamPlanCardData {
    return {
      name: binding.name,
      source,
      primaryCount: binding.ships.filter(
        slot => Boolean(slot.primary),
      ).length,
      backupCount: binding.ships.reduce(
        (count, slot) => count + slot.candidates.length,
        0,
      ),
      modifiedAt,
    };
  }

  private applyTeamPreset(planId: string): void {
    const plan = this.userTeams.find(item => item.id === planId);
    if (!plan || plan.selected) {
      this.restoreTeamListScroll();
      return;
    }
    this.onAddFleetPreset?.(planId);
    this.restoreTeamListScroll();
  }

  private restoreTeamListScroll(): void {
    const scrollTop = this.teamListDragScrollTop;
    this.fleetPresetListEl.scrollTop = scrollTop;
    requestAnimationFrame(() => {
      this.fleetPresetListEl.scrollTop = scrollTop;
    });
  }

  private renderPreview(
    ships?: readonly TeamPlanSlotViewObject[],
  ): void {
    const slots = Array.from({ length: 6 }, (_, index) => (
      this.previewSlot(ships?.[index])
    ));
    this.activePreviewPosition = 0;
    this.previewTitle.textContent = '编队预览';

    const mainFragment = document.createDocumentFragment();
    slots.forEach((slot, index) => {
      const item = document.createElement('div');
      item.className = 'fleet-team-main-item';
      const card = this.createPreviewCard(
        slot.primary,
        'main',
        index,
        slot.backups.length > 0,
      );
      card.classList.toggle('active', index === this.activePreviewPosition);
      card.addEventListener('click', () => {
        this.activePreviewPosition = index;
        this.mainPreview.querySelectorAll('.fleet-team-main-card').forEach(
          (mainCard, cardIndex) => mainCard.classList.toggle(
            'active',
            cardIndex === index,
          ),
        );
        this.renderBackupPosition(slots, index);
      });
      item.append(card);
      const level = this.createLevelSummary(slot.primary);
      if (level) item.append(level);
      mainFragment.append(item);
    });
    this.mainPreview.replaceChildren(mainFragment);
    this.renderBackupPosition(slots, this.activePreviewPosition);
  }

  private renderBackupPosition(
    slots: Array<{
      primary: ShipPreviewRule | null;
      backups: ShipPreviewRule[];
    }>,
    position: number,
  ): void {
    const backupFragment = document.createDocumentFragment();
    const slot = slots[position];
    this.backupTitle.textContent = slot.primary?.name
      ? `【${slot.primary.name}】的备选队列`
      : `【位置${position + 1}】的备选队列`;
    slot.backups.forEach((rule) => {
      backupFragment.append(this.createPreviewCard(rule, 'backup', position));
    });
    if (slot.backups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fleet-team-empty';
      empty.textContent = '该位置没有备选舰娘';
      backupFragment.append(empty);
    }
    this.backupPreview.replaceChildren(backupFragment);
  }

  private previewSlot(slot?: TeamPlanSlotViewObject): {
    primary: ShipPreviewRule | null;
    backups: ShipPreviewRule[];
  } {
    return {
      primary: slot?.primary
        ? {
            name: slot.primary.name,
            minLevel: slot.primary.minLevel,
            maxLevel: slot.primary.maxLevel,
          }
        : null,
      backups: (slot?.candidates ?? []).map(candidate => ({
        name: candidate.name,
        minLevel: candidate.minLevel,
        maxLevel: candidate.maxLevel,
      })),
    };
  }

  private createPreviewCard(
    rule: ShipPreviewRule | null,
    size: 'main' | 'backup',
    position: number,
    candidateOnly = false,
  ): HTMLElement {
    const card = document.createElement(size === 'main' ? 'button' : 'div');
    if (card instanceof HTMLButtonElement) card.type = 'button';
    card.className = `fleet-team-${size}-card`;
    const name = rule?.name ?? null;
    card.setAttribute(
      'aria-label',
      name ? `位置 ${position + 1}：${name}` : `位置 ${position + 1}：空`,
    );
    if (!name) {
      if (candidateOnly) {
        card.classList.add('candidate-only');
        const backgroundUrl = this.shipLibrary?.colorfulBackgroundUrl;
        if (backgroundUrl) {
          const background = document.createElement('img');
          background.className = 'fleet-team-placeholder-background';
          background.src = backgroundUrl;
          background.alt = '';
          background.draggable = false;
          card.append(background);
        }
      }
      const empty = document.createElement('span');
      empty.className = 'fleet-team-card-empty';
      empty.textContent = candidateOnly ? '使用备选队列' : '空';
      card.append(empty);
      return card;
    }

    card.title = name;
    card.dataset['name'] = name;
    const ship = this.findShip(name);
    if (ship) {
      card.append(createShipArtwork(
        ship,
        this.shipLibrary?.labels.ship_types[ship.ship_type] ?? ship.ship_type,
      ));
    } else {
      const unknown = document.createElement('span');
      unknown.className = 'fleet-team-card-empty fleet-team-card-unknown';
      unknown.textContent = name;
      card.append(unknown);
    }
    return card;
  }

  private createLevelSummary(
    rule: ShipPreviewRule | null,
  ): HTMLElement | null {
    if (
      !rule
      || (rule.minLevel === undefined && rule.maxLevel === undefined)
    ) {
      return null;
    }
    const summary = document.createElement('span');
    summary.className = 'fleet-team-level-summary';
    if (rule.minLevel !== undefined) {
      const min = document.createElement('span');
      min.textContent = `最小等级：${rule.minLevel}`;
      summary.append(min);
    }
    if (rule.maxLevel !== undefined) {
      const max = document.createElement('span');
      max.textContent = `最大等级：${rule.maxLevel}`;
      summary.append(max);
    }
    return summary;
  }

  private findShip(
    name: string,
  ): FleetShipLibraryViewObject['ships'][number] | undefined {
    return this.shipLibrary?.ships.find(ship => ship.name === name)
      ?? this.shipLibrary?.ships.find(ship => ship.search_name === name);
  }

}
