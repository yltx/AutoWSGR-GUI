/** 展示编队方案选择器并发出加载方案意图。 */
import type {
  FleetShipViewObject,
  TeamPlanListViewObject,
  TeamPlanShipRuleViewObject,
  TeamPlanViewObject,
} from '../../types/view.js';
import {
  showAlert,
  showConfirm,
} from '../shared/DialogHelper';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';
import { createShipArtwork } from './ShipArtwork';
import {
  appendTeamPlanCardContent,
  compareTeamPlans,
  filterAndSortTeamPlans,
  teamPlanCardData,
} from './TeamPlanListUi';
import type { TeamPlanSortField } from './TeamPlanListUi';

const FLEET_SLOT_COUNT = 6;

export interface TeamPlanLoaderViewHost {
  ensureLibrary(): Promise<void>;
  loadPlans(): Promise<TeamPlanListViewObject>;
  ships(): readonly FleetShipViewObject[];
  colorfulBackgroundUrl(): string;
  shipTypeDisplay(ship: FleetShipViewObject): string;
  hasUnsavedChanges(): boolean;
  applyPlan(planId: string): Promise<{
    success: boolean;
    error?: string;
  }>;
}

export class TeamPlanLoaderView {
  private readonly dialog = document.getElementById('fleet-team-loader')!;
  private readonly search = document.getElementById(
    'fleet-team-loader-search',
  ) as HTMLInputElement;
  private readonly list = document.getElementById('fleet-team-loader-list')!;
  private readonly count = document.getElementById('fleet-team-loader-count')!;
  private readonly filterSystem = document.getElementById(
    'fleet-team-loader-filter-system',
  ) as HTMLInputElement;
  private readonly sortButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-team-loader-sort-field]',
    ),
  );
  private readonly sortAscending = document.getElementById(
    'fleet-team-loader-sort-asc',
  ) as HTMLInputElement;
  private readonly previewTitle = document.getElementById(
    'fleet-team-loader-preview-title',
  )!;
  private readonly previewSlots = document.getElementById(
    'fleet-team-loader-preview-slots',
  )!;
  private readonly backupTitle = document.getElementById(
    'fleet-team-loader-backup-title',
  )!;
  private readonly backupSlots = document.getElementById(
    'fleet-team-loader-backup-slots',
  )!;
  private readonly status = document.getElementById(
    'fleet-team-loader-status',
  )!;
  private readonly confirmButton = document.getElementById(
    'btn-confirm-team-loader',
  ) as HTMLButtonElement;

  private plans: TeamPlanViewObject[] = [];
  private selectedPlan: TeamPlanViewObject | null = null;
  private selectedPosition = 0;
  private sortField: TeamPlanSortField = 'modifiedAt';

  constructor(private readonly host: TeamPlanLoaderViewHost) {
    this.bindActions();
  }

  async open(targetId?: string): Promise<void> {
    await this.host.ensureLibrary();
    this.search.value = '';
    await this.refresh();
    if (targetId) {
      const selected = this.plans.find(plan => plan.id === targetId);
      if (!selected) {
        await showAlert('加载失败', '未找到对应的舰队方案');
        return;
      }
      this.selectedPlan = selected;
      this.selectedPosition = 0;
      if (await this.confirmLoad()) {
        document.querySelector<HTMLButtonElement>(
          '[data-plan-tab="fleet"]',
        )?.click();
      }
      return;
    }
    this.dialog.style.display = 'flex';
    this.search.focus();
  }

  close(): void {
    this.dialog.style.display = 'none';
  }

  private bindActions(): void {
    document.getElementById('btn-refresh-team-loader')
      ?.addEventListener('click', () => {
        void this.refresh();
      });
    document.getElementById('btn-cancel-team-loader')
      ?.addEventListener('click', () => this.close());
    this.confirmButton.addEventListener('click', () => {
      void this.confirmLoad();
    });
    this.search.addEventListener('input', () => this.render());
    this.filterSystem.addEventListener('change', () => {
      this.ensureVisibleSelection();
      this.render();
    });
    this.sortAscending.addEventListener('change', () => this.render());
    this.sortButtons.forEach(button => {
      button.addEventListener('click', () => {
        const field = button.dataset['teamLoaderSortField'];
        if (field !== 'name' && field !== 'modifiedAt') return;
        this.sortField = field;
        this.sortButtons.forEach(option => {
          option.classList.toggle('active', option === button);
        });
        this.render();
      });
    });
    this.list.addEventListener('click', event => {
      const item = (event.target as HTMLElement)
        .closest<HTMLButtonElement>('[data-team-plan-index]');
      if (!item) return;
      const index = Number(item.dataset['teamPlanIndex']);
      const plan = this.plans[index];
      if (!plan) return;
      this.selectedPlan = plan;
      this.selectedPosition = 0;
      this.list
        .querySelectorAll<HTMLButtonElement>('[data-team-plan-index]')
        .forEach(option => {
          const optionIndex = Number(option.dataset['teamPlanIndex']);
          option.classList.toggle('active', this.plans[optionIndex] === plan);
        });
      this.renderPreview();
    });
    this.previewSlots.addEventListener('click', event => {
      const item = (event.target as HTMLElement)
        .closest<HTMLButtonElement>('[data-team-preview-position]');
      if (!item) return;
      const position = Number(item.dataset['teamPreviewPosition']);
      if (!Number.isInteger(position) || position < 0) return;
      this.selectedPosition = position;
      this.renderPreview();
    });
    this.dialog.addEventListener('click', event => {
      if (event.target === this.dialog) this.close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.close();
    });
  }

  private async refresh(): Promise<void> {
    this.count.textContent = '正在读取编队预设…';
    this.status.textContent = '';
    try {
      const result = await this.host.loadPlans();
      this.plans = result.plans;
      const visiblePlans = this.visiblePlans();
      const firstSortedPlan = [...visiblePlans]
        .sort((left, right) => this.comparePlans(left, right))[0];
      this.selectedPlan = visiblePlans.find(plan => plan.selected)
        ?? firstSortedPlan
        ?? null;
      this.selectedPosition = 0;
      this.count.textContent = `共读取 ${result.plans.length} 个舰队预设`;
      this.status.textContent = result.errorCount > 0
        ? `有 ${result.errorCount} 个配置格式不合法，已跳过`
        : '';
      this.render();
    } catch (error) {
      this.plans = [];
      this.selectedPlan = null;
      this.selectedPosition = 0;
      this.count.textContent = '读取失败';
      this.status.textContent = error instanceof Error
        ? error.message
        : String(error);
      this.render();
    }
  }

  private render(): void {
    const scrollPosition = captureScrollPosition(this.list);
    const fragment = document.createDocumentFragment();
    const visiblePlans = filterAndSortTeamPlans(this.plans, {
      search: this.search.value,
      filterSystem: this.filterSystem.checked,
      sortField: this.sortField,
      ascending: this.sortAscending.checked,
    });
    visiblePlans.forEach(({ plan, index }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fleet-team-loader-item';
      button.dataset['teamPlanIndex'] = String(index);
      button.classList.toggle('active', plan === this.selectedPlan);
      appendTeamPlanCardContent(button, teamPlanCardData(plan));
      fragment.append(button);
    });
    if (!fragment.childNodes.length) {
      const empty = document.createElement('div');
      empty.className = 'fleet-library-empty';
      empty.textContent = this.plans.length > 0
        ? '没有符合当前过滤条件的舰队预设'
        : '系统和用户编队目录中没有可加载的配置';
      fragment.append(empty);
    }
    this.list.replaceChildren(fragment);
    restoreScrollPosition(this.list, scrollPosition);
    this.renderPreview();
  }

  private comparePlans(
    left: TeamPlanViewObject,
    right: TeamPlanViewObject,
  ): number {
    return compareTeamPlans(
      left,
      right,
      this.sortField,
      this.sortAscending.checked,
    );
  }

  private visiblePlans(): TeamPlanViewObject[] {
    return this.plans.filter(plan => (
      !this.filterSystem.checked || plan.source !== 'system'
    ));
  }

  private ensureVisibleSelection(): void {
    const visiblePlans = this.visiblePlans();
    if (!this.selectedPlan || !visiblePlans.includes(this.selectedPlan)) {
      this.selectedPlan = [...visiblePlans]
        .sort((left, right) => this.comparePlans(left, right))[0] ?? null;
      this.selectedPosition = 0;
    }
  }

  private renderPreview(): void {
    const plan = this.selectedPlan;
    this.confirmButton.disabled = !plan;
    this.previewTitle.textContent = `编队预览：${plan?.name ?? '未选择'}`;
    const fragment = document.createDocumentFragment();
    Array.from({ length: FLEET_SLOT_COUNT }, (_, index) => {
      const slot = plan?.ships[index];
      const backupCount = slot?.candidates.length ?? 0;
      const primary = slot?.primary;
      const item = document.createElement('div');
      item.className = 'fleet-team-main-item';
      const card = this.createPreviewCard(
        primary,
        'main',
        index,
        !primary && backupCount > 0,
      );
      card.dataset['teamPreviewPosition'] = String(index);
      card.classList.toggle(
        'active',
        Boolean(plan) && index === this.selectedPosition,
      );
      card.setAttribute(
        'aria-pressed',
        String(Boolean(plan) && index === this.selectedPosition),
      );
      if (card instanceof HTMLButtonElement) card.disabled = !plan;
      item.append(card);
      const levels = this.createLevelSummary(primary);
      if (levels) item.append(levels);
      fragment.append(item);
    });
    this.previewSlots.replaceChildren(fragment);
    this.renderBackupPreview();
  }

  private renderBackupPreview(): void {
    const plan = this.selectedPlan;
    const slot = plan?.ships[this.selectedPosition];
    const candidates = slot?.candidates ?? [];
    this.backupTitle.textContent = slot?.primary?.name
      ? `【${slot.primary.name}】的备选队列`
      : `【位置${this.selectedPosition + 1}】的备选队列`;
    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fleet-team-loader-preview-empty';
      empty.textContent = plan
        ? `位置 ${this.selectedPosition + 1} 没有备选船只`
        : '请先选择一个舰队预设';
      this.backupSlots.replaceChildren(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    candidates.forEach(candidate => {
      fragment.append(this.createPreviewCard(
        candidate,
        'backup',
        this.selectedPosition,
      ));
    });
    this.backupSlots.replaceChildren(fragment);
  }

  private createPreviewCard(
    rule: TeamPlanShipRuleViewObject | undefined,
    size: 'main' | 'backup',
    position: number,
    candidateOnly = false,
  ): HTMLElement {
    const card = document.createElement(size === 'main' ? 'button' : 'div');
    if (card instanceof HTMLButtonElement) card.type = 'button';
    card.className = `fleet-team-${size}-card`;
    const name = rule?.name ?? rule?.searchName ?? null;
    card.setAttribute(
      'aria-label',
      name ? `位置 ${position + 1}：${name}` : `位置 ${position + 1}：空`,
    );
    if (!name) {
      if (candidateOnly) {
        card.classList.add('candidate-only');
        const backgroundUrl = this.host.colorfulBackgroundUrl();
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
    const ships = this.host.ships();
    const ship = ships.find(item => item.name === name)
      ?? ships.find(item => item.searchName === name)
      ?? (
        rule?.searchName
          ? ships.find(
              item => item.searchName === rule.searchName,
            )
          : undefined
      );
    if (ship) {
      card.append(createShipArtwork(
        ship,
        this.host.shipTypeDisplay(ship),
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
    rule: TeamPlanShipRuleViewObject | undefined,
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

  private async confirmLoad(): Promise<boolean> {
    const plan = this.selectedPlan;
    if (!plan) return false;
    if (this.host.hasUnsavedChanges()) {
      const confirmed = await showConfirm(
        '未保存修改',
        '当前舰队编队存在未保存修改，继续加载将丢失这些修改，是否继续？',
      );
      if (!confirmed) return false;
    }
    try {
      const result = await this.host.applyPlan(plan.id);
      if (!result.success) {
        throw new Error(result.error || '当前 YAML 格式不符合规则');
      }
      this.close();
      return true;
    } catch (error) {
      await showAlert(
        '加载失败',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
}
