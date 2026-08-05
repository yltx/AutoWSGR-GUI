/** 渲染舰队槽位并处理选择、清空和拖拽排序意图。 */
import type {
  FleetCandidateDraftViewObject as FleetCandidateDraft,
  FleetDraftViewObject as FleetDraft,
  FleetShipViewObject,
  FleetSlotDraftViewObject as FleetSlotDraft,
} from '../../types/view.js';
import type {
  BackupFollowMode,
  FleetDraftEditIntent,
  FleetDraftEditResult,
  FleetEditorDragSource,
  FleetEditorSelection,
  FleetEditorSlotGroup,
  FleetRuleUpdate,
} from '../../types/fleetEditor.js';
import {
  showAlert,
  showConfirm,
} from '../shared/DialogHelper';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';
import { createShipArtwork } from './ShipArtwork';
import { FLEET_DRAG_MIME } from './FleetGalleryView';
import { FleetRuleView } from './FleetRuleView';

interface FleetDragData {
  source?: 'gallery' | FleetEditorSlotGroup;
  shipId?: number;
  position?: number;
  candidateIndex?: number;
}

export interface FleetEditorViewHost {
  currentDraft(): FleetDraft;
  editDraft(intent: FleetDraftEditIntent): FleetDraftEditResult;
  shipById(id: number): FleetShipViewObject | undefined;
  colorfulBackgroundUrl(): string;
  shipTypeDisplay(ship: FleetShipViewObject): string;
  renderGallerySelection(): void;
  updateGalleryCardTargets(): void;
  getBackupFollowMode(): BackupFollowMode;
  setBackupFollowMode(mode: BackupFollowMode): void;
}

const FLEET_SLOT_COUNT = 6;

export class FleetEditorView {
  private readonly slotList = document.getElementById('fleet-slot-list')!;
  private readonly backupSlotList = document.getElementById(
    'fleet-backup-slot-list',
  )!;
  private readonly backupScroll = this.backupSlotList.parentElement!;
  private readonly backupTitle = document.getElementById(
    'fleet-backup-title',
  )!;
  private readonly backupFollowButton = document.getElementById(
    'btn-backup-follow-mode',
  ) as HTMLButtonElement;
  private readonly backupCopyDialog = document.getElementById(
    'fleet-backup-copy-dialog',
  )!;
  private readonly backupCopyDescription = document.getElementById(
    'fleet-backup-copy-description',
  )!;
  private readonly backupCopyTargets = document.getElementById(
    'fleet-backup-copy-targets',
  )!;
  private readonly ruleView: FleetRuleView;

  private activeSlotGroup: FleetEditorSlotGroup = 'formation';
  private activePosition = 0;
  private activeBackupIndex = 0;
  private backupFollowMode: BackupFollowMode;
  private backupDragScroll:
    { top: number; left: number } | null = null;

  constructor(private readonly host: FleetEditorViewHost) {
    this.backupFollowMode = this.host.getBackupFollowMode();
    this.ruleView = new FleetRuleView({
      primaryRule: () => this.currentSlot(),
      backupRule: () => this.currentBackupRule(),
      updatePrimaryRule: update => this.updateRule(update),
      updateBackupRule: update => this.updateRule(
        update,
        this.activeBackupIndex,
      ),
    });
    this.bindActions();
  }

  render(): void {
    this.renderBackupFollowMode();
    this.renderSlots();
    this.renderBackupSlots();
    this.ruleView.render();
  }

  reset(): void {
    this.activeSlotGroup = 'formation';
    this.activePosition = 0;
    this.activeBackupIndex = 0;
    this.render();
    this.host.renderGallerySelection();
  }

  activeSlotDescription(): string {
    if (this.activeSlotGroup === 'formation') {
      return `编队位置 ${this.activePosition + 1}`;
    }
    return `位置 ${this.activePosition + 1} 的第 ${
      this.activeBackupIndex + 1
    } 个备选槽位`;
  }

  selectedShips(): FleetShipViewObject[] {
    if (this.activeSlotGroup === 'formation') {
      return this.currentFleet().slots
        .map(slot => slot.primary)
        .filter((ship): ship is FleetShipViewObject => ship !== null);
    }
    return this.currentSlot().candidates
      .map(candidate => candidate.ship)
      .filter((ship): ship is FleetShipViewObject => ship !== null);
  }

  assignShip(ship: FleetShipViewObject): void {
    this.applyEdit({
      type: 'assign-ship',
      selection: this.currentSelection(),
      shipId: ship.id,
    });
    this.render();
    this.host.renderGallerySelection();
  }

  rememberBackupScroll(): void {
    this.backupDragScroll = {
      top: this.backupScroll.scrollTop,
      left: this.backupScroll.scrollLeft,
    };
  }

  clearBackupDragScroll(): void {
    this.backupDragScroll = null;
  }

  isSlotEmpty(slot: FleetSlotDraft): boolean {
    return slot.primary === null
      && slot.candidates.every(candidate => candidate.ship === null);
  }

  private bindActions(): void {
    this.slotList.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const removeButton = target.closest<HTMLButtonElement>(
        '[data-remove-slot]',
      );
      if (removeButton) {
        const slot = Number(removeButton.dataset['removeSlot']);
        if (Number.isInteger(slot) && slot >= 0 && slot < FLEET_SLOT_COUNT) {
          this.applyEdit({
            type: 'remove-primary',
            position: slot,
            selection: this.currentSelection(),
          });
          this.render();
          this.host.renderGallerySelection();
        }
        return;
      }
      const slotButton = target.closest<HTMLButtonElement>(
        '[data-fleet-slot]',
      );
      if (!slotButton) return;
      const slot = Number(slotButton.dataset['fleetSlot']);
      if (
        !Number.isInteger(slot)
        || slot < 0
        || slot >= FLEET_SLOT_COUNT
      ) {
        return;
      }
      const gallerySelectionChanged = this.activeSlotGroup !== 'formation';
      this.activeSlotGroup = 'formation';
      this.activePosition = slot;
      this.activeBackupIndex = 0;
      this.render();
      if (gallerySelectionChanged) {
        this.host.renderGallerySelection();
      } else {
        this.host.updateGalleryCardTargets();
      }
    });
    this.slotList.addEventListener('dragstart', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-fleet-slot]',
      );
      if (!slot || !event.dataTransfer) return;
      const position = Number(slot.dataset['fleetSlot']);
      const sourceSlot = this.currentFleet().slots[position];
      const movableCandidateOnly = (
        this.backupFollowMode === 'position'
        && sourceSlot
        && !sourceSlot.primary
        && !this.isSlotEmpty(sourceSlot)
      );
      if (!sourceSlot?.primary && !movableCandidateOnly) return;
      this.rememberBackupScroll();
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(
        FLEET_DRAG_MIME,
        JSON.stringify({ source: 'formation', position }),
      );
    });
    this.slotList.addEventListener('dragover', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-fleet-slot]',
      );
      if (!slot || !event.dataTransfer?.types.includes(FLEET_DRAG_MIME)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      slot.classList.add('drag-over');
    });
    this.slotList.addEventListener('dragleave', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-fleet-slot]',
      );
      if (slot && !slot.contains(event.relatedTarget as Node | null)) {
        slot.classList.remove('drag-over');
      }
    });
    this.slotList.addEventListener('drop', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-fleet-slot]',
      );
      if (!slot || !event.dataTransfer) return;
      event.preventDefault();
      slot.classList.remove('drag-over');
      this.handleFleetDrop(
        event.dataTransfer.getData(FLEET_DRAG_MIME),
        Number(slot.dataset['fleetSlot']),
      );
    });
    this.slotList.addEventListener('dragend', () => {
      this.slotList.querySelectorAll('.drag-over').forEach((slot) => {
        slot.classList.remove('drag-over');
      });
      this.clearBackupDragScroll();
    });

    this.backupSlotList.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const removeButton = target.closest<HTMLButtonElement>(
        '[data-remove-backup-slot]',
      );
      if (removeButton) {
        const slot = Number(removeButton.dataset['removeBackupSlot']);
        if (
          Number.isInteger(slot)
          && slot >= 0
          && slot < this.currentSlot().candidates.length
        ) {
          this.applyEdit({
            type: 'remove-candidate',
            position: this.activePosition,
            candidateIndex: slot,
          });
          this.render();
          this.host.renderGallerySelection();
        }
        return;
      }
      const slotButton = target.closest<HTMLButtonElement>(
        '[data-backup-slot]',
      );
      if (!slotButton) return;
      const slot = Number(slotButton.dataset['backupSlot']);
      if (
        !Number.isInteger(slot)
        || slot < 0
        || slot >= this.currentSlot().candidates.length
      ) {
        return;
      }
      const gallerySelectionChanged = this.activeSlotGroup !== 'backup';
      this.activeSlotGroup = 'backup';
      this.activeBackupIndex = slot;
      this.render();
      if (gallerySelectionChanged) {
        this.host.renderGallerySelection();
      } else {
        this.host.updateGalleryCardTargets();
      }
      this.scrollBackupSlotIntoView(slot);
    });
    this.backupSlotList.addEventListener('dragstart', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-backup-slot]',
      );
      if (!slot || !event.dataTransfer) return;
      const candidateIndex = Number(slot.dataset['backupSlot']);
      if (!this.currentSlot().candidates[candidateIndex]?.ship) return;
      this.rememberBackupScroll();
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(
        FLEET_DRAG_MIME,
        JSON.stringify({
          source: 'backup',
          position: this.activePosition,
          candidateIndex,
        }),
      );
    });
    this.backupSlotList.addEventListener('dragover', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-backup-slot]',
      );
      if (!slot || !event.dataTransfer?.types.includes(FLEET_DRAG_MIME)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      slot.classList.add('drag-over');
    });
    this.backupSlotList.addEventListener('dragleave', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-backup-slot]',
      );
      if (slot && !slot.contains(event.relatedTarget as Node | null)) {
        slot.classList.remove('drag-over');
      }
    });
    this.backupSlotList.addEventListener('drop', (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-backup-slot]',
      );
      if (!slot || !event.dataTransfer) return;
      event.preventDefault();
      slot.classList.remove('drag-over');
      this.handleBackupDrop(
        event.dataTransfer.getData(FLEET_DRAG_MIME),
        Number(slot.dataset['backupSlot']),
      );
    });
    this.backupSlotList.addEventListener('dragend', () => {
      this.backupSlotList.querySelectorAll('.drag-over').forEach((slot) => {
        slot.classList.remove('drag-over');
      });
      this.clearBackupDragScroll();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeBackupCopyDialog();
    });
    document.getElementById('btn-clear-fleet')?.addEventListener(
      'click',
      () => {
        this.applyEdit({ type: 'clear' });
        this.render();
        this.host.renderGallerySelection();
      },
    );
    this.backupFollowButton.addEventListener('click', () => {
      this.backupFollowMode = this.backupFollowMode === 'ship'
        ? 'position'
        : 'ship';
      this.host.setBackupFollowMode(this.backupFollowMode);
      this.renderBackupFollowMode();
      this.renderBackupSlots();
    });
    document.getElementById('btn-add-fleet-backup')?.addEventListener(
      'click',
      () => {
        const result = this.applyEdit({
          type: 'ensure-candidate',
          position: this.activePosition,
        });
        const target = result.selection?.candidateIndex
          ?? this.activeBackupIndex;
        this.render();
        requestAnimationFrame(() => {
          this.backupSlotList.querySelector<HTMLElement>(
            `[data-backup-slot="${target}"]`,
          )?.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
            behavior: 'smooth',
          });
        });
      },
    );
    document.getElementById('btn-copy-fleet-backup')?.addEventListener(
      'click',
      () => {
        void this.openBackupCopyDialog();
      },
    );
    document.getElementById('btn-cancel-backup-copy')?.addEventListener(
      'click',
      () => this.closeBackupCopyDialog(),
    );
    this.backupCopyDialog.addEventListener('click', (event) => {
      if (event.target === this.backupCopyDialog) {
        this.closeBackupCopyDialog();
      }
    });
    this.backupCopyTargets.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-backup-copy-position]',
      );
      if (!target || target.disabled) return;
      const position = Number(target.dataset['backupCopyPosition']);
      if (Number.isInteger(position)) {
        void this.copyBackupsToPosition(position);
      }
    });
  }

  private handleFleetDrop(raw: string, targetPosition: number): void {
    if (!raw || targetPosition < 0 || targetPosition >= FLEET_SLOT_COUNT) {
      return;
    }
    try {
      const data = JSON.parse(raw) as FleetDragData;
      const source = this.resolveDragSource(data);
      if (!source) return;
      const result = this.applyEdit({
        type: 'drop-formation',
        source,
        targetPosition,
        selection: this.currentSelection(),
        backupFollowMode: this.backupFollowMode,
      });
      if (!result.changed) return;
      this.render();
      this.host.renderGallerySelection();
    } catch {
      // Ignore drag data created outside the fleet planner.
    }
  }

  private handleBackupDrop(raw: string, targetIndex: number): void {
    const candidates = this.currentSlot().candidates;
    if (!raw || targetIndex < 0 || targetIndex >= candidates.length) return;
    try {
      const data = JSON.parse(raw) as FleetDragData;
      const source = this.resolveDragSource(data);
      if (!source) return;
      const result = this.applyEdit({
        type: 'drop-backup',
        source,
        targetPosition: this.activePosition,
        targetCandidateIndex: targetIndex,
      });
      if (!result.changed) return;
      this.render();
      this.host.renderGallerySelection();
    } catch {
      // Ignore drag data created outside the fleet planner.
    }
  }

  private backupQueuesEqual(
    source: readonly FleetCandidateDraft[],
    target: readonly FleetCandidateDraft[],
  ): boolean {
    const sourceBackups = source.filter(candidate => candidate.ship !== null);
    const targetBackups = target.filter(candidate => candidate.ship !== null);
    if (sourceBackups.length !== targetBackups.length) return false;

    return sourceBackups.every((candidate, index) => {
      const targetCandidate = targetBackups[index];
      const sameShipTypes = candidate.shipTypes.length
        === targetCandidate.shipTypes.length
        && candidate.shipTypes.every(
          shipType => targetCandidate.shipTypes.includes(shipType),
        );
      return candidate.ship?.id === targetCandidate.ship?.id
        && sameShipTypes
        && candidate.levelEnabled === targetCandidate.levelEnabled
        && candidate.minLevel === targetCandidate.minLevel
        && candidate.maxLevel === targetCandidate.maxLevel;
    });
  }

  private resolveDragSource(
    data: FleetDragData,
  ): FleetEditorDragSource | null {
    if (data.source === 'gallery' && Number.isInteger(data.shipId)) {
      const ship = this.host.shipById(data.shipId!);
      return ship ? { group: 'gallery', shipId: ship.id } : null;
    }
    if (
      data.source === 'formation'
      && Number.isInteger(data.position)
      && data.position! >= 0
      && data.position! < FLEET_SLOT_COUNT
    ) {
      return {
        group: 'formation',
        position: data.position!,
      };
    }
    if (
      data.source === 'backup'
      && Number.isInteger(data.position)
      && data.position! >= 0
      && data.position! < FLEET_SLOT_COUNT
      && Number.isInteger(data.candidateIndex)
    ) {
      return {
        group: 'backup',
        position: data.position!,
        candidateIndex: data.candidateIndex!,
      };
    }
    return null;
  }

  private currentSelection(): FleetEditorSelection {
    return {
      group: this.activeSlotGroup,
      position: this.activePosition,
      candidateIndex: this.activeBackupIndex,
    };
  }

  private applyEdit(intent: FleetDraftEditIntent): FleetDraftEditResult {
    const result = this.host.editDraft(intent);
    if (result.selection) {
      this.activeSlotGroup = result.selection.group;
      this.activePosition = result.selection.position;
      this.activeBackupIndex = result.selection.candidateIndex;
    }
    if (result.error) {
      void showAlert(result.error.title, result.error.message);
    }
    return result;
  }

  private updateRule(
    update: FleetRuleUpdate,
    candidateIndex?: number,
  ): void {
    this.applyEdit({
      type: 'update-rule',
      position: this.activePosition,
      candidateIndex,
      update,
    });
  }

  private renderSlots(): void {
    const scroll = this.slotList.closest<HTMLElement>('.fleet-slot-scroll');
    const scrollPosition = captureScrollPosition(scroll);
    const fragment = document.createDocumentFragment();
    this.currentFleet().slots.forEach((slot, index) => {
      fragment.append(this.createFleetSlot(
        slot.primary,
        index,
        'formation',
        slot.primary === null && !this.isSlotEmpty(slot),
      ));
    });
    this.slotList.replaceChildren(fragment);
    restoreScrollPosition(scroll, scrollPosition);
  }

  private renderBackupSlots(): void {
    const preservedScroll = this.backupDragScroll
      ?? captureScrollPosition(this.backupScroll);
    const fragment = document.createDocumentFragment();
    this.currentSlot().candidates.forEach((candidate, index) => {
      fragment.append(this.createFleetSlot(candidate.ship, index, 'backup'));
    });
    this.backupSlotList.replaceChildren(fragment);
    restoreScrollPosition(this.backupScroll, preservedScroll);
    const primary = this.currentSlot().primary;
    this.backupTitle.textContent = (
      this.backupFollowMode === 'ship' && primary
    )
      ? `${primary.name} 的备选队列`
      : `位置 ${this.activePosition + 1} 的备选队列`;
  }

  private renderBackupFollowMode(): void {
    const followsPosition = this.backupFollowMode === 'position';
    this.backupFollowButton.textContent = followsPosition
      ? '位置跟随'
      : '舰船跟随';
    this.backupFollowButton.dataset['mode'] = this.backupFollowMode;
    this.backupTitle.dataset['followMode'] = this.backupFollowMode;
    this.backupFollowButton.setAttribute(
      'aria-pressed',
      String(followsPosition),
    );
    this.backupFollowButton.title = followsPosition
      ? '备选固定在当前位置，点击切换为舰船跟随'
      : '备选跟随主选舰船移动，点击切换为位置跟随';
  }

  private scrollBackupSlotIntoView(index: number): void {
    requestAnimationFrame(() => {
      this.backupSlotList.querySelector<HTMLElement>(
        `[data-backup-slot="${index}"]`,
      )?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    });
  }

  private createFleetSlot(
    ship: FleetShipViewObject | null,
    index: number,
    group: FleetEditorSlotGroup,
    candidateOnly = false,
  ): HTMLButtonElement {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = `fleet-slot fleet-${group}-slot`;
    if (group === 'formation') {
      slot.dataset['fleetSlot'] = String(index);
    } else {
      slot.dataset['backupSlot'] = String(index);
    }
    const active = group === 'formation'
      ? index === this.activePosition
      : this.activeSlotGroup === 'backup'
        && index === this.activeBackupIndex;
    slot.classList.toggle('active', active);
    slot.classList.toggle('candidate-only', candidateOnly);
    slot.draggable = Boolean(ship)
      || (
        group === 'formation'
        && candidateOnly
        && this.backupFollowMode === 'position'
      );
    if (candidateOnly) {
      slot.setAttribute(
        'aria-label',
        `位置 ${index + 1} 没有主选，已有备选舰船`,
      );
      const colorfulBackgroundUrl = this.host.colorfulBackgroundUrl();
      if (colorfulBackgroundUrl) {
        const background = document.createElement('img');
        background.className = 'fleet-slot-placeholder-background';
        background.src = colorfulBackgroundUrl;
        background.alt = '';
        background.draggable = false;
        slot.append(background);
      }
    }

    if (ship) {
      slot.append(createShipArtwork(
        ship,
        this.host.shipTypeDisplay(ship),
      ));
      const remove = document.createElement('span');
      remove.className = 'fleet-slot-remove';
      if (group === 'formation') {
        remove.dataset['removeSlot'] = String(index);
      } else {
        remove.dataset['removeBackupSlot'] = String(index);
      }
      remove.setAttribute('role', 'button');
      remove.setAttribute('aria-label', `移除 ${ship.name}`);
      remove.textContent = '×';
      slot.append(remove);
    } else {
      const empty = document.createElement('span');
      empty.className = 'fleet-slot-empty';
      empty.textContent = candidateOnly
        ? '使用备选队列'
        : group === 'formation'
          ? `位置 ${index + 1}`
          : `备选 ${index + 1}`;
      slot.append(empty);
    }
    return slot;
  }

  private currentFleet(): FleetDraft {
    return this.host.currentDraft();
  }

  private currentSlot(): FleetSlotDraft {
    return this.currentFleet().slots[this.activePosition];
  }

  private currentBackupRule(): FleetCandidateDraft {
    return this.currentSlot().candidates[this.activeBackupIndex];
  }

  private async openBackupCopyDialog(): Promise<void> {
    const source = this.currentSlot();
    const sourceBackups = source.candidates.filter(
      candidate => candidate.ship !== null,
    );
    if (sourceBackups.length === 0) {
      await showAlert('无法复制', '当前位置没有可复制的备选舰船');
      return;
    }

    const sourceName = source.primary?.name
      ?? `位置${this.activePosition + 1}`;
    this.backupCopyDescription.textContent = (
      `将【${sourceName}】的 ${sourceBackups.length} 艘备选复制到其他位置。`
    );
    const fragment = document.createDocumentFragment();
    this.currentFleet().slots.forEach((slot, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fleet-backup-copy-target';
      button.dataset['backupCopyPosition'] = String(index);
      const sameBackupQueue = this.backupQueuesEqual(
        source.candidates,
        slot.candidates,
      );
      const backupCount = slot.candidates.filter(
        candidate => candidate.ship !== null,
      ).length;
      button.disabled = index === this.activePosition || sameBackupQueue;

      const name = document.createElement('strong');
      name.textContent = slot.primary
        ? `位置 ${index + 1} · ${slot.primary.name}`
        : `位置 ${index + 1} · 无主选`;
      const summary = document.createElement('span');
      summary.textContent = slot.primary
        ? `${backupCount} 艘现有备选`
        : backupCount > 0
          ? `${backupCount} 艘现有纯备选`
          : '空位置，可复制为纯备选';
      if (index === this.activePosition) {
        summary.textContent = '当前备选队列';
      } else if (sameBackupQueue) {
        summary.textContent = '备选队列完全一致';
      }
      button.append(name, summary);
      fragment.append(button);
    });
    this.backupCopyTargets.replaceChildren(fragment);
    this.backupCopyDialog.style.display = 'flex';
  }

  private closeBackupCopyDialog(): void {
    this.backupCopyDialog.style.display = 'none';
  }

  private async copyBackupsToPosition(targetPosition: number): Promise<void> {
    if (
      targetPosition < 0
      || targetPosition >= FLEET_SLOT_COUNT
      || targetPosition === this.activePosition
    ) {
      return;
    }
    const source = this.currentSlot();
    const target = this.currentFleet().slots[targetPosition];
    if (!target) return;

    const sourceBackups = source.candidates.filter(
      candidate => candidate.ship !== null,
    );
    if (sourceBackups.length === 0) return;
    if (this.backupQueuesEqual(source.candidates, target.candidates)) return;
    const targetBackupCount = target.candidates.filter(
      candidate => candidate.ship !== null,
    ).length;
    if (targetBackupCount > 0) {
      const targetName = target.primary?.name
        ?? `位置${targetPosition + 1}`;
      const overwrite = await showConfirm(
        '覆盖备选队列',
        `【${targetName}】已有 ${targetBackupCount} 艘备选，是否覆盖？`,
      );
      if (!overwrite) return;
    }

    const result = this.applyEdit({
      type: 'copy-backups',
      sourcePosition: this.activePosition,
      targetPosition,
    });
    if (!result.changed) return;
    this.closeBackupCopyDialog();
    this.render();
    this.host.renderGallerySelection();
  }
}
