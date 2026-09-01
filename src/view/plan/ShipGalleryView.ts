/** 管理可复用舰船图库的筛选、排序、增量渲染和卡片交互。 */
import type {
  ShipLibraryLabels,
  ShipLibraryShip,
} from '../../types/ipc.js';
import type {
  ShipGalleryViewState,
} from '../../types/view.js';
import {
  SHIP_TYPE_FILTER_ORDER,
  TYPE_LABELS,
} from '../../shared/fleetShipTypes';
import {
  captureScrollPosition,
  restoreScrollPosition,
} from '../shared/scrollPosition';
import {
  calculateGalleryBatchSize,
  filterAndSortGalleryShips,
  type GallerySortField,
} from './GalleryShipCollection';
import { createShipArtwork } from './ShipArtwork';

type FilterKind = 'group' | 'type' | 'country';

const EMPTY_LABELS: ShipLibraryLabels = {
  ship_types: {},
  size_classes: {},
  role_classes: {},
  countries: {},
  variants: {},
};

export interface ShipGalleryElements {
  gallery: HTMLElement;
  countLabel: HTMLElement;
  searchInput: HTMLInputElement;
  filterButtons: readonly HTMLButtonElement[];
  filterCount: HTMLElement;
  filterPopover: HTMLElement;
  typeOptions: HTMLElement;
  countryOptions: HTMLElement;
  refitFilter: HTMLInputElement;
  sortDescending: HTMLInputElement;
  resetButton: HTMLButtonElement;
  confirmButton: HTMLButtonElement;
}

export interface ShipGalleryLibrary {
  labels: ShipLibraryLabels;
  ships: readonly ShipLibraryShip[];
  colorfulBackgroundUrl?: string;
}

export interface ShipGalleryDragBehavior {
  mime: string;
  serialize(ship: ShipLibraryShip): string;
  onStart?(): void;
  onEnd?(): void;
}

export interface ShipGalleryViewHost {
  activeSlotDescription(): string;
  isExcluded(ship: ShipLibraryShip): boolean;
  assignShip(ship: ShipLibraryShip): void;
  getGalleryState?(): ShipGalleryViewState | null;
  setGalleryState?(state: ShipGalleryViewState): void;
  shipDisplayName?(ship: ShipLibraryShip): string;
  getRefitFilter?(): boolean;
  setRefitFilter?(enabled: boolean): void;
  isInteractionEnabled?(): boolean;
  drag?: ShipGalleryDragBehavior;
  unavailableCountLabel?: string;
  unavailableMessage?: string;
}

export class ShipGalleryView {
  private readonly eventController = new AbortController();
  private readonly resizeObserver: ResizeObserver;
  private disposed = false;
  private labels: ShipLibraryLabels = EMPTY_LABELS;
  private shipItems: ShipLibraryShip[] = [];
  private visibleShips: ShipLibraryShip[] = [];
  private backgroundUrl = '';
  private renderedShipCount = 0;
  private groupFilter: string | null = 'all';
  private typeFilters = new Set<string>();
  private countryFilters = new Set<string>();
  private refitOnly: boolean;
  private sortField: GallerySortField = 'id';
  private descending = false;
  private dragScrollTop: number | null = null;
  private restoredScrollPosition: { top: number; left: number } | null = null;
  private restoredRenderedShipCount = 0;

  constructor(
    private readonly elements: ShipGalleryElements,
    private readonly host: ShipGalleryViewHost,
  ) {
    const restoredState = this.host.getGalleryState?.() ?? null;
    if (restoredState) {
      this.elements.searchInput.value = restoredState.searchText;
      this.groupFilter = restoredState.groupFilter;
      this.typeFilters = new Set(restoredState.typeFilters);
      this.countryFilters = new Set(restoredState.countryFilters);
      this.sortField = restoredState.sortField;
      this.descending = restoredState.descending;
      this.restoredScrollPosition = {
        top: restoredState.scrollTop,
        left: restoredState.scrollLeft,
      };
      this.restoredRenderedShipCount = restoredState.renderedShipCount;
    }
    this.refitOnly = restoredState?.refitOnly
      ?? this.host.getRefitFilter?.()
      ?? false;
    this.elements.refitFilter.checked = this.refitOnly;
    this.elements.sortDescending.checked = this.descending;
    this.bindActions();
    this.resizeObserver = new ResizeObserver(
      () => this.ensureGalleryFilled(),
    );
    this.resizeObserver.observe(this.elements.gallery);
  }

  ships(): readonly ShipLibraryShip[] {
    return this.shipItems;
  }

  shipById(id: number): ShipLibraryShip | undefined {
    return this.shipItems.find(ship => ship.id === id);
  }

  colorfulBackgroundUrl(): string {
    return this.backgroundUrl;
  }

  shipTypeDisplay(ship: ShipLibraryShip): string {
    const typeName = TYPE_LABELS[ship.ship_type]
      ?? this.labels.ship_types[ship.ship_type]
      ?? ship.ship_type;
    return `${typeName}-${ship.ship_type.toUpperCase()}`;
  }

  showLibrary(library: ShipGalleryLibrary): void {
    const preserveCurrentPosition = this.shipItems.length > 0;
    this.labels = {
      ...EMPTY_LABELS,
      ...library.labels,
    };
    this.shipItems = [...library.ships];
    this.backgroundUrl = library.colorfulBackgroundUrl ?? '';
    this.renderFilterOptions();
    this.render(!preserveCurrentPosition);
  }

  clearLibrary(): void {
    this.labels = EMPTY_LABELS;
    this.shipItems = [];
    this.visibleShips = [];
    this.backgroundUrl = '';
  }

  showLoading(): void {
    this.elements.countLabel.textContent = '正在读取资料库…';
  }

  showLoadError(message: string): void {
    this.elements.countLabel.textContent = (
      this.host.unavailableCountLabel ?? '资料库不可用'
    );
    this.showMessage(message);
  }

  render(resetScroll = true): void {
    this.applyFilters(resetScroll);
  }

  renderSelection(): void {
    this.applyFilters(false);
  }

  updateCardTargets(): void {
    const shipsById = new Map(this.visibleShips.map(ship => [ship.id, ship]));
    this.elements.gallery
      .querySelectorAll<HTMLButtonElement>('[data-ship-id]')
      .forEach(card => {
        const ship = shipsById.get(Number(card.dataset['shipId']));
        if (ship) this.updateCard(card, ship);
      });
  }

  refreshInteractionState(): void {
    const enabled = this.isInteractionEnabled();
    this.elements.gallery.classList.toggle('is-locked', !enabled);
    this.updateCardTargets();
  }

  clearDragScroll(): void {
    this.dragScrollTop = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.persistState();
    this.eventController.abort();
    this.resizeObserver.disconnect();
  }

  private bindActions(): void {
    const {
      gallery,
      searchInput,
      filterButtons,
      filterPopover,
      sortDescending,
      refitFilter,
      resetButton,
      confirmButton,
    } = this.elements;
    const listenerOptions = {
      signal: this.eventController.signal,
    };

    gallery.addEventListener('click', event => {
      const card = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-ship-id]',
      );
      if (!card || !this.isInteractionEnabled()) return;
      const ship = this.shipById(Number(card.dataset['shipId']));
      if (ship) this.host.assignShip(ship);
    }, listenerOptions);
    gallery.addEventListener('dragstart', event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-ship-id]',
      );
      const drag = this.host.drag;
      if (
        !card
        || !drag
        || !event.dataTransfer
        || !this.isInteractionEnabled()
      ) {
        return;
      }
      const ship = this.shipById(Number(card.dataset['shipId']));
      if (!ship) return;
      this.dragScrollTop = gallery.scrollTop;
      drag.onStart?.();
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(drag.mime, drag.serialize(ship));
    }, listenerOptions);
    gallery.addEventListener('dragend', () => {
      this.dragScrollTop = null;
      this.host.drag?.onEnd?.();
    }, listenerOptions);
    gallery.addEventListener('scroll', () => {
      const remaining = gallery.scrollHeight
        - gallery.scrollTop
        - gallery.clientHeight;
      if (remaining < 480) this.appendGalleryBatch();
      this.persistState();
    }, listenerOptions);

    searchInput.addEventListener(
      'input',
      () => this.render(),
      listenerOptions,
    );
    filterButtons.forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.setFilterPopoverOpen(filterPopover.hidden);
      }, listenerOptions);
    });
    filterPopover.addEventListener('click', event => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-filter-kind]',
      );
      if (option) {
        this.setFilter(
          option.dataset['filterKind'] as FilterKind,
          option.dataset['filterValue'] ?? 'all',
        );
      }
      const sortOption = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-sort-field]',
      );
      if (sortOption) {
        this.sortField = sortOption.dataset['sortField'] as GallerySortField;
        this.updateFilterControls();
        this.render();
      }
    }, listenerOptions);
    document.addEventListener('click', event => {
      const target = event.target as Node;
      if (
        !filterPopover.hidden
        && !filterPopover.contains(target)
        && !filterButtons.some(button => button.contains(target))
      ) {
        this.setFilterPopoverOpen(false);
      }
    }, listenerOptions);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.setFilterPopoverOpen(false);
    }, listenerOptions);
    confirmButton.addEventListener(
      'click',
      () => this.setFilterPopoverOpen(false),
      listenerOptions,
    );
    sortDescending.addEventListener('change', () => {
      this.descending = sortDescending.checked;
      this.updateFilterControls();
      this.render();
    }, listenerOptions);
    refitFilter.addEventListener('change', () => {
      this.refitOnly = refitFilter.checked;
      this.host.setRefitFilter?.(this.refitOnly);
      this.updateFilterControls();
      this.render();
    }, listenerOptions);
    resetButton.addEventListener('click', () => {
      this.groupFilter = 'all';
      this.typeFilters.clear();
      this.countryFilters.clear();
      this.refitOnly = false;
      this.host.setRefitFilter?.(false);
      this.sortField = 'id';
      this.descending = false;
      this.updateFilterControls();
      this.render();
    }, listenerOptions);
  }

  private isInteractionEnabled(): boolean {
    return this.host.isInteractionEnabled?.() ?? true;
  }

  private setFilter(kind: FilterKind, value: string): void {
    if (kind === 'group') {
      this.groupFilter = value;
      this.typeFilters.clear();
      if (value !== 'all') {
        this.shipItems.forEach(ship => {
          if (
            (ship.size_class === value || ship.role_class === value)
            && SHIP_TYPE_FILTER_ORDER.includes(ship.ship_type)
          ) {
            this.typeFilters.add(ship.ship_type);
          }
        });
      }
    } else {
      const filters = kind === 'type'
        ? this.typeFilters
        : this.countryFilters;
      if (kind === 'type') this.groupFilter = null;
      if (value === 'all') {
        filters.clear();
      } else if (filters.has(value)) {
        filters.delete(value);
      } else {
        filters.add(value);
      }
    }
    this.updateFilterControls();
    this.render();
  }

  private setFilterPopoverOpen(open: boolean): void {
    this.elements.filterPopover.hidden = !open;
    this.elements.filterButtons.forEach(button => {
      button.setAttribute('aria-expanded', String(open));
    });
  }

  private renderFilterOptions(): void {
    this.elements.typeOptions.replaceChildren(
      this.createFilterOption('type', 'all', '全部'),
      ...SHIP_TYPE_FILTER_ORDER
        .filter(code => this.labels.ship_types[code] !== undefined)
        .map(code => this.createFilterOption(
          'type',
          code,
          TYPE_LABELS[code] ?? this.labels.ship_types[code]!,
        )),
    );
    this.elements.countryOptions.replaceChildren(
      this.createFilterOption('country', 'all', '全部'),
      ...Object.entries(this.labels.countries)
        .map(([code, label]) => (
          this.createFilterOption('country', code, label)
        )),
    );
    this.updateFilterControls();
  }

  private createFilterOption(
    kind: FilterKind,
    value: string,
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fleet-filter-option';
    button.dataset['filterKind'] = kind;
    button.dataset['filterValue'] = value;
    button.setAttribute('aria-pressed', 'false');
    button.textContent = label;
    return button;
  }

  private updateFilterControls(): void {
    const {
      filterPopover,
      sortDescending,
      refitFilter,
      filterCount,
      filterButtons,
    } = this.elements;
    filterPopover
      .querySelectorAll<HTMLElement>('[data-filter-kind]')
      .forEach(item => {
        const kind = item.dataset['filterKind'];
        const value = item.dataset['filterValue'] ?? 'all';
        const active = kind === 'group'
          ? value === this.groupFilter
          : kind === 'type'
            ? value === 'all'
              ? this.typeFilters.size === 0
              : this.typeFilters.has(value)
            : value === 'all'
              ? this.countryFilters.size === 0
              : this.countryFilters.has(value);
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
    filterPopover
      .querySelectorAll<HTMLElement>('[data-sort-field]')
      .forEach(item => {
        item.classList.toggle(
          'active',
          item.dataset['sortField'] === this.sortField,
        );
      });
    sortDescending.checked = this.descending;
    refitFilter.checked = this.refitOnly;
    const activeFilterCount = [
      this.typeFilters.size > 0,
      this.countryFilters.size > 0,
      this.refitOnly,
    ].filter(Boolean).length;
    filterCount.textContent = activeFilterCount > 0
      ? String(activeFilterCount)
      : '';
    filterButtons.forEach(button => {
      button.classList.toggle(
        'active',
        activeFilterCount > 0
          || this.sortField !== 'id'
          || this.descending,
      );
    });
  }

  private applyFilters(resetScroll: boolean): void {
    const gallery = this.elements.gallery;
    const preservedScroll = captureScrollPosition(gallery);
    const restoringSavedPosition = resetScroll
      && this.restoredScrollPosition !== null;
    if (!resetScroll && this.dragScrollTop !== null) {
      preservedScroll.top = this.dragScrollTop;
    }
    const targetScrollPosition = restoringSavedPosition
      ? this.restoredScrollPosition!
      : resetScroll
        ? { top: 0, left: 0 }
        : preservedScroll;
    const previousRenderedCount = restoringSavedPosition
      ? this.restoredRenderedShipCount
      : resetScroll
        ? 0
        : this.renderedShipCount;
    this.visibleShips = filterAndSortGalleryShips(this.shipItems, {
      searchText: this.elements.searchInput.value,
      typeFilters: this.typeFilters,
      countryFilters: this.countryFilters,
      refitOnly: this.refitOnly,
      sortField: this.sortField,
      descending: this.descending,
      shipTypeLabels: this.labels.ship_types,
      isExcluded: ship => this.host.isExcluded(ship),
    });

    this.renderedShipCount = 0;
    gallery.replaceChildren();
    this.updateCount();
    if (this.visibleShips.length === 0) {
      this.showMessage(
        this.shipItems.length === 0
          ? this.host.unavailableMessage ?? '没有符合当前条件的舰娘'
          : '没有符合当前条件的舰娘',
      );
      restoreScrollPosition(gallery, { top: 0, left: 0 });
      this.restoredScrollPosition = null;
      this.restoredRenderedShipCount = 0;
      this.persistState();
      return;
    }
    this.appendGalleryBatch(Math.max(
      this.galleryBatchSize(),
      previousRenderedCount,
    ));
    while (
      restoringSavedPosition
      && this.renderedShipCount < this.visibleShips.length
      && gallery.scrollHeight
        < targetScrollPosition.top + gallery.clientHeight
    ) {
      this.appendGalleryBatch();
    }
    restoreScrollPosition(gallery, targetScrollPosition);
    this.restoredScrollPosition = null;
    this.restoredRenderedShipCount = 0;
    this.persistState();
  }

  private galleryBatchSize(): number {
    return calculateGalleryBatchSize(
      this.elements.gallery.clientWidth,
      this.elements.gallery.clientHeight,
    );
  }

  private ensureGalleryFilled(): void {
    if (this.visibleShips.length === 0) return;
    const missingCount = this.galleryBatchSize() - this.renderedShipCount;
    if (missingCount > 0) this.appendGalleryBatch(missingCount);
  }

  private appendGalleryBatch(count = this.galleryBatchSize()): void {
    if (this.renderedShipCount >= this.visibleShips.length) return;
    const gallery = this.elements.gallery;
    const preservedScroll = captureScrollPosition(gallery);
    const fragment = document.createDocumentFragment();
    const end = Math.min(
      this.renderedShipCount + count,
      this.visibleShips.length,
    );
    for (let index = this.renderedShipCount; index < end; index += 1) {
      fragment.append(this.createShipCard(this.visibleShips[index]));
    }
    this.renderedShipCount = end;
    gallery.append(fragment);
    restoreScrollPosition(gallery, preservedScroll);
  }

  private createShipCard(ship: ShipLibraryShip): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'fleet-ship-card';
    card.dataset['shipId'] = String(ship.id);
    card.append(createShipArtwork(ship, {
      shipTypeLabel: this.shipTypeDisplay(ship),
    }));
    this.updateCard(card, ship);
    return card;
  }

  private updateCard(
    card: HTMLButtonElement,
    ship: ShipLibraryShip,
  ): void {
    const enabled = this.isInteractionEnabled();
    card.disabled = !enabled;
    card.draggable = enabled;
    const shipName = this.host.shipDisplayName?.(ship) ?? ship.name;
    card.title = `将 ${shipName} 放入${this.host.activeSlotDescription()}`;
  }

  private updateCount(): void {
    this.elements.countLabel.textContent = this.shipItems.length === 0
      && this.host.unavailableCountLabel
      ? this.host.unavailableCountLabel
      : `显示 ${this.visibleShips.length} / ${this.shipItems.length} 艘`;
  }

  private persistState(): void {
    this.host.setGalleryState?.({
      searchText: this.elements.searchInput.value,
      groupFilter: this.groupFilter,
      typeFilters: [...this.typeFilters],
      countryFilters: [...this.countryFilters],
      refitOnly: this.refitOnly,
      sortField: this.sortField,
      descending: this.descending,
      scrollTop: this.elements.gallery.scrollTop,
      scrollLeft: this.elements.gallery.scrollLeft,
      renderedShipCount: this.renderedShipCount,
    });
  }

  private showMessage(message: string): void {
    const empty = document.createElement('div');
    empty.className = 'fleet-library-empty';
    empty.textContent = message;
    this.elements.gallery.replaceChildren(empty);
  }
}
