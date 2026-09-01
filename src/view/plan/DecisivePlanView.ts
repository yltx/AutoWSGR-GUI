/** 渲染决战舰队配置并向 Controller 提交编辑意图。 */
/**
 * 旧决战计划编辑页。
 *
 * 主选区域复用舰队规划的六位置编队规则：
 * 1. 固定显示六个位置，舰船按位置顺序传给后端 level1。
 * 2. 图鉴填入当前位置；当前为空时优先填第一个空位。
 * 3. 同一舰船不会重复添加，删除后其余舰船向前压缩。
 * 4. 主选槽之间支持拖拽换位。
 *
 * 备选区域复用舰队规划的备选列表规则：
 * 1. 默认至少显示六个槽位，可通过“增加备选”继续扩展。
 * 2. 图鉴可填入或替换当前备选槽，删除后自动压缩。
 * 3. 备选槽支持拖拽排序，并可与主选槽互相拖动或交换。
 *
 * 保存时空槽不会写入 gui_settings.json。
 */
import type {
  ShipLibraryManifest,
  ShipLibraryShip,
} from '../../types/ipc.js';
import { findShipLibraryShip } from '../../shared/shipLibrary.js';
import type {
  ShipGalleryViewState,
} from '../../types/view.js';
import {
  showAlert,
  showConfirm,
  showSaveSuccess,
} from '../shared/DialogHelper';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';
import {
  ShipGalleryView,
} from './ShipGalleryView';
import { createShipArtwork } from './ShipArtwork';

export type DecisiveLevel = 'level1' | 'level2';

export interface DecisivePlanViewState {
  chapter: number;
  useQuickRepair: boolean;
  level1: readonly string[];
  level2: readonly string[];
  dirty: boolean;
}

export interface DecisivePlanSaveResult {
  success: boolean;
  error?: unknown;
}

export interface DecisivePlanViewHost {
  getState(): DecisivePlanViewState;
  getGalleryState(): ShipGalleryViewState | null;
  setGalleryState(state: ShipGalleryViewState): void;
  setChapter(chapter: number): void;
  changeChapter(chapter: number): Promise<DecisivePlanSaveResult>;
  setUseQuickRepair(useQuickRepair: boolean): void;
  findShip(name: string): { level: DecisiveLevel; index: number } | null;
  placeShip(
    name: string,
    level: DecisiveLevel,
    requestedIndex: number,
    maxIndex: number,
  ): number;
  removeShip(level: DecisiveLevel, index: number): boolean;
  moveShip(
    sourceLevel: DecisiveLevel,
    sourceIndex: number,
    targetLevel: DecisiveLevel,
    targetIndex: number,
  ): number | null;
  resetTeams(): Promise<DecisivePlanSaveResult>;
  save(): Promise<DecisivePlanSaveResult>;
}

interface DecisiveDragData {
  source?: 'gallery' | 'queue';
  shipId?: number;
  level?: DecisiveLevel;
  index?: number;
}

const LEVELS: DecisiveLevel[] = ['level1', 'level2'];
const LEVEL_LABELS: Record<DecisiveLevel, string> = {
  level1: '主选队列',
  level2: '备选队列',
};
const MAIN_SLOT_COUNT = 6;
const DEFAULT_BACKUP_SLOT_COUNT = 6;
const DECISIVE_DRAG_MIME = 'application/x-autowsgr-decisive-ship';

/** Keeps the exact normal, refit, or special variant selected in the gallery. */
export function decisiveGalleryShipName(
  ship: Pick<ShipLibraryShip, 'name'>,
): string {
  return ship.name;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少决战页面元素: #${id}`);
  return element as T;
}

export class DecisivePlanView {
  private readonly chapter = requiredElement<HTMLSelectElement>(
    'decisive-plan-chapter',
  );
  private readonly quickRepair = requiredElement<HTMLInputElement>(
    'decisive-plan-quick-repair',
  );
  private readonly editEnabled = requiredElement<HTMLInputElement>(
    'decisive-plan-edit-enabled',
  );
  private readonly resetButton = requiredElement<HTMLButtonElement>(
    'btn-reset-decisive-plan',
  );
  private readonly addBackupButton = requiredElement<HTMLButtonElement>(
    'btn-add-decisive-backup',
  );
  private readonly status = requiredElement<HTMLElement>(
    'decisive-plan-status',
  );
  private readonly mainList = requiredElement<HTMLElement>(
    'decisive-level1-list',
  );
  private readonly backupList = requiredElement<HTMLElement>(
    'decisive-level2-list',
  );
  private readonly backupScroll = this.backupList.parentElement!;
  private readonly galleryView: ShipGalleryView;
  private shipSearchNameByName = new Map<string, string>();
  private galleryLevel: DecisiveLevel = 'level1';
  private activeMainIndex = 0;
  private activeBackupIndex = 0;
  private backupSlotCount = DEFAULT_BACKUP_SLOT_COUNT;
  private backupDragScroll: { top: number; left: number } | null = null;

  constructor(private readonly host: DecisivePlanViewHost) {
    this.galleryView = new ShipGalleryView({
      gallery: requiredElement('decisive-ship-gallery'),
      countLabel: requiredElement('decisive-gallery-count'),
      searchInput: requiredElement<HTMLInputElement>('decisive-gallery-search'),
      filterButtons: Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-decisive-filter-trigger]',
        ),
      ),
      filterCount: requiredElement('decisive-filter-count'),
      filterPopover: requiredElement('decisive-filter-popover'),
      typeOptions: requiredElement('decisive-filter-types'),
      countryOptions: requiredElement('decisive-filter-countries'),
      refitFilter: requiredElement<HTMLInputElement>(
        'decisive-filter-refit-only',
      ),
      sortDescending: requiredElement<HTMLInputElement>('decisive-sort-desc'),
      resetButton: requiredElement<HTMLButtonElement>(
        'btn-reset-decisive-filter',
      ),
      confirmButton: requiredElement<HTMLButtonElement>(
        'btn-confirm-decisive-filter',
      ),
    }, {
      activeSlotDescription: () => this.activeSlotDescription(),
      isExcluded: ship => this.findConfiguredShip(ship) !== null,
      assignShip: ship => this.assignGalleryShip(ship),
      getGalleryState: () => this.host.getGalleryState(),
      setGalleryState: state => this.host.setGalleryState(state),
      shipDisplayName: ship => decisiveGalleryShipName(ship),
      isInteractionEnabled: () => this.editEnabled.checked,
      drag: {
        mime: DECISIVE_DRAG_MIME,
        serialize: ship => JSON.stringify({
          source: 'gallery',
          shipId: ship.id,
        } satisfies DecisiveDragData),
        onStart: () => this.rememberBackupScroll(),
        onEnd: () => {
          this.backupDragScroll = null;
          this.clearDragOver();
        },
      },
      unavailableCountLabel: '图鉴不可用',
      unavailableMessage: '舰船资料库不可用',
    });
  }

  bindActions(): void {
    this.chapter.addEventListener('change', () => {
      void this.changeChapter(Number(this.chapter.value));
    });
    this.quickRepair.addEventListener('change', () => {
      this.host.setUseQuickRepair(this.quickRepair.checked);
      this.markDirty();
    });
    this.editEnabled.addEventListener('change', () => {
      this.renderEditState();
      this.renderQueues();
    });
    this.bindSlotList(this.mainList, 'level1');
    this.bindSlotList(this.backupList, 'level2');
    this.addBackupButton.addEventListener('click', () => {
      if (!this.editEnabled.checked) return;
      this.backupSlotCount = Math.max(
        this.backupSlotCount,
        this.host.getState().level2.length,
        DEFAULT_BACKUP_SLOT_COUNT,
      ) + 1;
      this.galleryLevel = 'level2';
      this.activeBackupIndex = this.backupSlotCount - 1;
      this.renderQueues();
      this.renderGalleryTarget();
    });
    requiredElement<HTMLButtonElement>('btn-save-decisive-plan')
      .addEventListener('click', () => void this.save());
    this.resetButton.addEventListener('click', () => void this.resetTeam());
  }

  dispose(): void {
    this.galleryView.dispose();
  }

  showLoaded(manifest: ShipLibraryManifest): void {
    this.loadShipLibrary(manifest);
    this.backupSlotCount = Math.max(
      DEFAULT_BACKUP_SLOT_COUNT,
      this.host.getState().level2.length,
    );
    this.render();
    this.setStatus('配置已加载');
  }

  showLoadFailure(): void {
    this.loadShipLibrary(null);
    this.backupSlotCount = Math.max(
      DEFAULT_BACKUP_SLOT_COUNT,
      this.host.getState().level2.length,
    );
    this.render();
    this.setStatus('读取失败，已使用默认队伍', true);
  }

  showChapterLoaded(): void {
    this.backupSlotCount = Math.max(
      DEFAULT_BACKUP_SLOT_COUNT,
      this.host.getState().level2.length,
    );
    this.render();
    this.setStatus(`第 ${this.host.getState().chapter} 章配置已加载`);
  }

  private bindSlotList(
    list: HTMLElement,
    level: DecisiveLevel,
  ): void {
    list.addEventListener('click', event => {
      const target = event.target as HTMLElement;
      const remove = target.closest<HTMLButtonElement>(
        '[data-decisive-remove-index]',
      );
      if (remove) {
        if (!this.editEnabled.checked) return;
        event.stopPropagation();
        const index = Number(remove.dataset['decisiveRemoveIndex']);
        this.removeShip(level, index);
        return;
      }
      const slot = target.closest<HTMLButtonElement>('[data-decisive-slot-index]');
      if (!slot) return;
      const index = Number(slot.dataset['decisiveSlotIndex']);
      if (!Number.isInteger(index) || index < 0) return;
      this.selectSlot(level, index);
    });
  }

  private loadShipLibrary(manifest: ShipLibraryManifest | null): void {
    if (!manifest?.ships) {
      this.shipSearchNameByName.clear();
      this.galleryView.clearLibrary();
      this.galleryView.showLoadError('舰船资料库不可用');
      return;
    }

    const ships = manifest.ships.filter(ship => (
      Number.isFinite(ship.id)
      && Boolean(ship.name)
      && Boolean(ship.search_name)
      && Boolean(ship.portraitUrl)
    ));
    this.shipSearchNameByName = new Map(
      ships.map(ship => [ship.name, ship.search_name]),
    );
    this.galleryView.showLibrary({
      labels: manifest.labels,
      ships,
    });
  }

  private render(): void {
    const state = this.host.getState();
    this.chapter.value = String(state.chapter);
    this.quickRepair.checked = state.useQuickRepair;
    this.editEnabled.checked = false;
    this.renderEditState();
    this.renderQueues();
    this.galleryView.render(false);
    this.renderGalleryTarget();
  }

  private renderEditState(): void {
    const editing = this.editEnabled.checked;
    this.resetButton.disabled = !editing;
    this.addBackupButton.disabled = !editing;
    this.galleryView.refreshInteractionState();
  }

  private renderQueues(): void {
    const state = this.host.getState();
    const mainScroll = this.mainList.closest<HTMLElement>('.fleet-slot-scroll');
    const mainScrollPosition = captureScrollPosition(mainScroll);
    const mainFragment = document.createDocumentFragment();
    const mainQueue = state.level1;
    for (let index = 0; index < MAIN_SLOT_COUNT; index += 1) {
      mainFragment.append(
        this.createFleetSlot('level1', index, mainQueue[index]),
      );
    }
    this.mainList.replaceChildren(mainFragment);
    restoreScrollPosition(mainScroll, mainScrollPosition);

    const backupScrollPosition = this.backupDragScroll
      ?? captureScrollPosition(this.backupScroll);
    this.backupSlotCount = Math.max(
      DEFAULT_BACKUP_SLOT_COUNT,
      this.backupSlotCount,
      state.level2.length,
    );
    const backupQueue = state.level2;
    const backupFragment = document.createDocumentFragment();
    for (let index = 0; index < this.backupSlotCount; index += 1) {
      backupFragment.append(
        this.createFleetSlot('level2', index, backupQueue[index]),
      );
    }
    this.backupList.replaceChildren(backupFragment);
    restoreScrollPosition(this.backupScroll, backupScrollPosition);

    requiredElement<HTMLElement>('decisive-level2-count').textContent =
      `${backupQueue.length} 艘`;
  }

  private createFleetSlot(
    level: DecisiveLevel,
    index: number,
    name?: string,
  ): HTMLButtonElement {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = `fleet-slot fleet-${
      level === 'level1' ? 'formation' : 'backup'
    }-slot`;
    slot.dataset['decisiveSlotIndex'] = String(index);
    slot.dataset['decisiveSlotLevel'] = level;
    const active = level === this.galleryLevel
      && index === (
        level === 'level1' ? this.activeMainIndex : this.activeBackupIndex
      );
    slot.classList.toggle('active', active);
    slot.draggable = this.editEnabled.checked && Boolean(name);
    slot.title = name
      ? `${LEVEL_LABELS[level]}第 ${index + 1} 位：${name}`
      : `${LEVEL_LABELS[level]}第 ${index + 1} 个空槽`;

    if (name) {
      const ship = this.findDisplayShip(name);
      if (ship) {
        slot.append(createShipArtwork(ship, {
          shipTypeLabel: this.galleryView.shipTypeDisplay(ship),
          displayName: name,
        }));
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'fleet-slot-empty';
        fallback.textContent = name;
        slot.append(fallback);
      }
      if (this.editEnabled.checked) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'fleet-slot-remove';
        remove.dataset['decisiveRemoveIndex'] = String(index);
        remove.title = `移除 ${name}`;
        remove.setAttribute('aria-label', `移除 ${name}`);
        remove.textContent = '×';
        slot.append(remove);
      }
    } else {
      const empty = document.createElement('span');
      empty.className = 'fleet-slot-empty';
      empty.textContent = level === 'level1'
        ? `位置 ${index + 1}`
        : `备选 ${index + 1}`;
      slot.append(empty);
    }

    if (this.editEnabled.checked && name) {
      slot.addEventListener('dragstart', event => {
        if (!event.dataTransfer) return;
        this.rememberBackupScroll();
        slot.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData(
          DECISIVE_DRAG_MIME,
          JSON.stringify({
            source: 'queue',
            level,
            index,
          } satisfies DecisiveDragData),
        );
      });
      slot.addEventListener('dragend', () => {
        this.backupDragScroll = null;
        slot.classList.remove('is-dragging');
        this.clearDragOver();
      });
    }
    if (this.editEnabled.checked) {
      slot.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types.includes(DECISIVE_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        slot.classList.add('drag-over');
      });
      slot.addEventListener('dragleave', event => {
        if (!slot.contains(event.relatedTarget as Node | null)) {
          slot.classList.remove('drag-over');
        }
      });
      slot.addEventListener('drop', event => {
        if (!event.dataTransfer) return;
        event.preventDefault();
        slot.classList.remove('drag-over');
        this.handleDrop(
          event.dataTransfer.getData(DECISIVE_DRAG_MIME),
          level,
          index,
        );
      });
    }
    return slot;
  }

  private selectSlot(level: DecisiveLevel, index: number): void {
    this.galleryLevel = level;
    if (level === 'level1') {
      if (index >= MAIN_SLOT_COUNT) return;
      this.activeMainIndex = index;
    } else {
      if (index >= this.backupSlotCount) return;
      this.activeBackupIndex = index;
    }
    this.renderQueues();
    this.renderGalleryTarget();
    if (level === 'level2') this.scrollBackupSlotIntoView(index);
  }

  private assignGalleryShip(ship: ShipLibraryShip): void {
    if (!this.editEnabled.checked) return;
    const existing = this.findConfiguredShip(ship);
    if (existing) {
      this.selectSlot(existing.level, existing.index);
      return;
    }

    const level = this.galleryLevel;
    let target: number;
    let replacing: boolean;
    const state = this.host.getState();
    if (level === 'level1') {
      const queueLength = state.level1.length;
      const firstEmpty = queueLength < MAIN_SLOT_COUNT
        ? queueLength
        : -1;
      replacing = this.activeMainIndex < queueLength;
      target = replacing || firstEmpty < 0
        ? this.activeMainIndex
        : firstEmpty;
    } else {
      const queueLength = state.level2.length;
      const firstEmpty = queueLength < this.backupSlotCount
        ? queueLength
        : -1;
      replacing = this.activeBackupIndex < queueLength;
      target = replacing || firstEmpty < 0
        ? this.activeBackupIndex
        : firstEmpty;
    }
    this.placeGalleryShip(ship, level, target, !replacing);
  }

  private placeGalleryShip(
    ship: ShipLibraryShip,
    level: DecisiveLevel,
    requestedIndex: number,
    advanceToNextEmpty: boolean,
  ): void {
    if (!this.editEnabled.checked) return;
    const existing = this.findConfiguredShip(ship);
    if (existing) {
      this.selectSlot(existing.level, existing.index);
      return;
    }

    const maxIndex = level === 'level1'
      ? MAIN_SLOT_COUNT - 1
      : this.backupSlotCount - 1;
    const target = this.host.placeShip(
      decisiveGalleryShipName(ship),
      level,
      requestedIndex,
      maxIndex,
    );
    const queueLength = this.host.getState()[level].length;

    this.galleryLevel = level;
    if (level === 'level1') {
      this.activeMainIndex = target;
      if (advanceToNextEmpty && queueLength < MAIN_SLOT_COUNT) {
        this.activeMainIndex = queueLength;
      }
    } else {
      this.activeBackupIndex = target;
      if (advanceToNextEmpty && target + 1 < this.backupSlotCount) {
        this.activeBackupIndex = target + 1;
      }
    }
    this.markDirty();
    this.renderQueues();
    this.galleryView.renderSelection();
    this.renderGalleryTarget();
    if (level === 'level2') this.scrollBackupSlotIntoView(this.activeBackupIndex);
  }

  private removeShip(level: DecisiveLevel, index: number): void {
    if (!this.host.removeShip(level, index)) return;
    if (level === 'level1') {
      this.activeMainIndex = Math.min(this.activeMainIndex, MAIN_SLOT_COUNT - 1);
    } else {
      this.backupSlotCount = Math.max(
        DEFAULT_BACKUP_SLOT_COUNT,
        this.host.getState().level2.length,
      );
      this.activeBackupIndex = Math.min(
        this.activeBackupIndex,
        this.backupSlotCount - 1,
      );
    }
    this.markDirty();
    this.renderQueues();
    this.galleryView.renderSelection();
  }

  private handleDrop(
    raw: string,
    targetLevel: DecisiveLevel,
    targetIndex: number,
  ): void {
    if (!this.editEnabled.checked) return;
    try {
      const source = JSON.parse(raw) as DecisiveDragData;
      if (source.source === 'gallery') {
        const ship = this.galleryView.shipById(Number(source.shipId));
        if (ship) this.placeGalleryShip(ship, targetLevel, targetIndex, false);
        return;
      }
      if (
        source.source !== 'queue'
        || !LEVELS.includes(source.level as DecisiveLevel)
        || !Number.isInteger(source.index)
      ) {
        return;
      }
      this.moveQueueShip(
        source.level as DecisiveLevel,
        Number(source.index),
        targetLevel,
        targetIndex,
      );
    } catch {
      // 忽略非本页面产生的拖拽数据。
    } finally {
      this.galleryView.clearDragScroll();
      this.backupDragScroll = null;
      this.clearDragOver();
    }
  }

  private moveQueueShip(
    sourceLevel: DecisiveLevel,
    sourceIndex: number,
    targetLevel: DecisiveLevel,
    targetIndex: number,
  ): void {
    const movedTarget = this.host.moveShip(
      sourceLevel,
      sourceIndex,
      targetLevel,
      targetIndex,
    );
    if (movedTarget === null) return;
    targetIndex = movedTarget;

    this.galleryLevel = targetLevel;
    if (targetLevel === 'level1') {
      this.activeMainIndex = Math.min(targetIndex, MAIN_SLOT_COUNT - 1);
    } else {
      this.activeBackupIndex = targetIndex;
    }
    this.backupSlotCount = Math.max(
      DEFAULT_BACKUP_SLOT_COUNT,
      this.host.getState().level2.length,
    );
    this.markDirty();
    this.renderQueues();
    this.galleryView.renderSelection();
    this.renderGalleryTarget();
    if (targetLevel === 'level2') this.scrollBackupSlotIntoView(targetIndex);
  }

  private clearDragOver(): void {
    document
      .querySelectorAll('.decisive-plan-card .fleet-slot.drag-over')
      .forEach(slot => slot.classList.remove('drag-over'));
  }

  private rememberBackupScroll(): void {
    this.backupDragScroll = captureScrollPosition(this.backupScroll);
  }

  private scrollBackupSlotIntoView(index: number): void {
    requestAnimationFrame(() => {
      this.backupList.querySelector<HTMLElement>(
        `[data-decisive-slot-index="${index}"]`,
      )?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    });
  }

  private findDisplayShip(name: string): ShipLibraryShip | undefined {
    return findShipLibraryShip(this.galleryView.ships(), { name });
  }

  private findConfiguredShip(
    ship: ShipLibraryShip,
  ): { level: DecisiveLevel; index: number } | null {
    const exact = this.host.findShip(ship.name);
    if (exact) return exact;
    const state = this.host.getState();
    for (const level of LEVELS) {
      const index = state[level].findIndex(name => (
        (this.shipSearchNameByName.get(name) ?? name) === ship.search_name
      ));
      if (index >= 0) return { level, index };
    }
    return null;
  }

  private renderGalleryTarget(): void {
    this.galleryView.updateCardTargets();
  }

  private activeSlotDescription(): string {
    if (this.galleryLevel === 'level1') {
      return `主选位置 ${this.activeMainIndex + 1}`;
    }
    return `第 ${this.activeBackupIndex + 1} 个备选槽位`;
  }

  private async resetTeam(): Promise<void> {
    if (!this.editEnabled.checked) return;
    const confirmed = await showConfirm(
      '恢复默认决战队伍',
      '将按照GUI2.0提供的默认配置恢复当前队伍队列，此行为将会覆盖继承至旧目录的决战配置。恢复后请点击保存配置。',
    );
    if (!confirmed) return;
    const result = await this.host.resetTeams();
    if (!result.success) {
      this.setStatus('恢复默认配置失败', true);
      await showAlert(
        '恢复失败',
        result.error instanceof Error
          ? result.error.message
          : String(result.error ?? '未知错误'),
      );
      return;
    }
    this.activeMainIndex = 0;
    this.activeBackupIndex = 0;
    this.galleryLevel = 'level1';
    this.backupSlotCount = Math.max(
      DEFAULT_BACKUP_SLOT_COUNT,
      this.host.getState().level2.length,
    );
    this.markDirty();
    this.renderQueues();
    this.galleryView.renderSelection();
    this.renderGalleryTarget();
  }

  private async changeChapter(chapter: number): Promise<void> {
    const previousChapter = this.host.getState().chapter;
    if (chapter === previousChapter) return;
    if (this.host.getState().dirty) {
      const confirmed = await showConfirm(
        '切换决战章节',
        `第 ${previousChapter} 章有未保存修改，切换章节将放弃这些修改。是否继续？`,
      );
      if (!confirmed) {
        this.chapter.value = String(previousChapter);
        return;
      }
    }

    this.chapter.disabled = true;
    this.setStatus(`正在读取第 ${chapter} 章配置…`);
    const result = await this.host.changeChapter(chapter);
    this.chapter.disabled = false;
    if (result.success) {
      this.showChapterLoaded();
      return;
    }

    this.chapter.value = String(previousChapter);
    this.setStatus(`第 ${chapter} 章配置读取失败`, true);
    await showAlert(
      '切换章节失败',
      result.error instanceof Error
        ? result.error.message
        : String(result.error ?? '未知错误'),
    );
  }

  private async save(showSavedStatus = true): Promise<boolean> {
    this.host.setChapter(Number(this.chapter.value));
    this.host.setUseQuickRepair(this.quickRepair.checked);
    const result = await this.host.save();
    if (result.success) {
      if (showSavedStatus) {
        this.setStatus('配置已保存');
        showSaveSuccess('决战配置保存成功');
      }
      return true;
    }
    this.setStatus('配置保存失败', true);
    await showAlert(
      '保存失败',
      result.error instanceof Error
        ? result.error.message
        : String(result.error ?? '未知错误'),
    );
    return false;
  }

  private markDirty(): void {
    this.setStatus('有未保存修改');
  }

  private setStatus(message: string, error = false): void {
    this.status.textContent = message;
    this.status.classList.toggle('is-error', error);
    this.status.classList.toggle(
      'is-dirty',
      this.host.getState().dirty && !error,
    );
  }

}
