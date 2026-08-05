/** 展示舰船图鉴并管理筛选、排序和选择等 UI 状态。 */
import type {
  FleetShipLabelsViewObject,
  FleetShipLibraryViewObject,
  FleetShipViewObject,
} from '../../types/view.js';
import {
  SHIP_TYPE_FILTER_ORDER,
  TYPE_LABELS,
} from '../../shared/fleetShipTypes';
import { createShipArtwork } from './ShipArtwork';

type SortField = 'type' | 'name' | 'id';
type FilterKind = 'group' | 'type' | 'country';

export const FLEET_DRAG_MIME = 'application/x-autowsgr-fleet';

const MIN_GALLERY_BATCH_SIZE = 12;
const GALLERY_CARD_WIDTH = 128;
const GALLERY_CARD_HEIGHT = 200;
const GALLERY_GAP = 6;
const EMPTY_LABELS: FleetShipLabelsViewObject = {
  shipTypes: {},
  sizeClasses: {},
  roleClasses: {},
  countries: {},
  variants: {},
};

export interface FleetGalleryViewHost {
  getRefitFilter(): boolean;
  setRefitFilter(enabled: boolean): void;
  activeSlotDescription(): string;
  selectedShips(): readonly FleetShipViewObject[];
  assignShip(ship: FleetShipViewObject): void;
  rememberBackupScroll(): void;
  clearBackupDragScroll(): void;
}

export class FleetGalleryView {
  private readonly gallery = document.getElementById(
    'fleet-ship-gallery',
  )!;
  private readonly countLabel = document.getElementById(
    'fleet-library-count',
  )!;
  private readonly searchInput = document.getElementById(
    'fleet-ship-search',
  ) as HTMLInputElement;
  private readonly filterButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-fleet-filter-trigger]',
    ),
  );
  private readonly filterCount = document.getElementById(
    'fleet-filter-count',
  )!;
  private readonly filterPopover = document.getElementById(
    'fleet-filter-popover',
  )!;
  private readonly typeOptions = document.getElementById(
    'fleet-filter-types',
  )!;
  private readonly countryOptions = document.getElementById(
    'fleet-filter-countries',
  )!;
  private readonly refitFilter = document.getElementById(
    'fleet-filter-refit-only',
  ) as HTMLInputElement;
  private readonly sortDescending = document.getElementById(
    'fleet-sort-desc',
  ) as HTMLInputElement;
  private readonly resizeObserver: ResizeObserver;

  private labels: FleetShipLabelsViewObject = EMPTY_LABELS;
  private shipItems: FleetShipViewObject[] = [];
  private visibleShips: FleetShipViewObject[] = [];
  private backgroundUrl = '';
  private renderedShipCount = 0;
  private groupFilter: string | null = 'all';
  private typeFilters = new Set<string>();
  private countryFilters = new Set<string>();
  private refitOnly: boolean;
  private sortField: SortField = 'id';
  private descending = false;
  private searchText = '';
  private dragScrollTop: number | null = null;

  constructor(private readonly host: FleetGalleryViewHost) {
    this.refitOnly = this.host.getRefitFilter();
    this.refitFilter.checked = this.refitOnly;
    this.bindActions();
    this.resizeObserver = new ResizeObserver(
      () => this.ensureGalleryFilled(),
    );
    this.resizeObserver.observe(this.gallery);
  }

  ships(): readonly FleetShipViewObject[] {
    return this.shipItems;
  }

  shipById(id: number): FleetShipViewObject | undefined {
    return this.shipItems.find(ship => ship.id === id);
  }

  colorfulBackgroundUrl(): string {
    return this.backgroundUrl;
  }

  shipTypeDisplay(ship: FleetShipViewObject): string {
    const typeName = TYPE_LABELS[ship.shipType]
      ?? this.labels.shipTypes[ship.shipType]
      ?? ship.shipType;
    return `${typeName}-${ship.shipType.toUpperCase()}`;
  }

  renderSelection(): void {
    const scrollTop = this.dragScrollTop ?? this.gallery.scrollTop;
    this.applyFilters(false, scrollTop);
    requestAnimationFrame(() => {
      this.gallery.scrollTop = scrollTop;
    });
  }

  updateCardTargets(): void {
    const description = this.host.activeSlotDescription();
    const shipsById = new Map(this.visibleShips.map(ship => [ship.id, ship]));
    this.gallery
      .querySelectorAll<HTMLButtonElement>('[data-ship-id]')
      .forEach(card => {
        const ship = shipsById.get(Number(card.dataset['shipId']));
        if (ship) card.title = `将 ${ship.name} 放入${description}`;
      });
  }

  showLibrary(library: FleetShipLibraryViewObject): void {
    this.labels = {
      ...EMPTY_LABELS,
      ...library.labels,
    };
    this.shipItems = [...library.ships];
    this.backgroundUrl = library.colorfulBackgroundUrl;
    this.renderFilterOptions();
    this.applyFilters();
  }

  showLoading(): void {
    this.countLabel.textContent = '正在读取资料库…';
  }

  showLoadError(message: string): void {
    this.countLabel.textContent = '资料库不可用';
    this.showMessage(message);
  }

  private bindActions(): void {
    this.gallery.addEventListener('click', (event) => {
      const card = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-ship-id]',
      );
      if (!card) return;
      const ship = this.shipById(Number(card.dataset['shipId']));
      if (ship) this.host.assignShip(ship);
    });
    this.gallery.addEventListener('dragstart', (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-ship-id]',
      );
      if (!card || !event.dataTransfer) return;
      this.dragScrollTop = this.gallery.scrollTop;
      this.host.rememberBackupScroll();
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(
        FLEET_DRAG_MIME,
        JSON.stringify({
          source: 'gallery',
          shipId: Number(card.dataset['shipId']),
        }),
      );
    });
    this.gallery.addEventListener('dragend', () => {
      this.dragScrollTop = null;
      this.host.clearBackupDragScroll();
    });
    this.gallery.addEventListener('scroll', () => {
      const remaining = this.gallery.scrollHeight
        - this.gallery.scrollTop
        - this.gallery.clientHeight;
      if (remaining < 480) this.appendGalleryBatch();
    });

    this.searchInput.addEventListener('input', () => {
      this.searchText = this.searchInput.value;
      this.applyFilters();
    });
    this.filterButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.setFilterPopoverOpen(
          this.filterPopover.hidden ? 'filter' : null,
        );
      });
    });
    this.filterPopover.addEventListener('click', (event) => {
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
        this.sortField = sortOption.dataset['sortField'] as SortField;
        this.updateFilterControls();
        this.applyFilters();
      }
    });
    document.addEventListener('click', (event) => {
      const target = event.target as Node;
      if (
        !this.filterPopover.hidden
        && !this.filterPopover.contains(target)
        && !this.filterButtons.some(button => button.contains(target))
      ) {
        this.setFilterPopoverOpen(null);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.setFilterPopoverOpen(null);
    });
    document.getElementById('btn-confirm-fleet-filter')?.addEventListener(
      'click',
      () => this.setFilterPopoverOpen(null),
    );
    this.sortDescending.addEventListener('change', () => {
      this.descending = this.sortDescending.checked;
      this.updateFilterControls();
      this.applyFilters();
    });
    this.refitFilter.addEventListener('change', () => {
      this.refitOnly = this.refitFilter.checked;
      this.host.setRefitFilter(this.refitOnly);
      this.updateFilterControls();
      this.applyFilters();
    });
    document.getElementById('btn-reset-fleet-filter')?.addEventListener(
      'click',
      () => {
        this.groupFilter = 'all';
        this.typeFilters.clear();
        this.countryFilters.clear();
        this.refitOnly = false;
        this.host.setRefitFilter(false);
        this.sortField = 'id';
        this.descending = false;
        this.updateFilterControls();
        this.applyFilters();
      },
    );
  }

  private setFilter(kind: FilterKind, value: string): void {
    if (kind === 'group') {
      this.groupFilter = value;
      this.typeFilters.clear();
      if (value !== 'all') {
        this.shipItems.forEach((ship) => {
          if (
            (ship.sizeClass === value || ship.roleClass === value)
            && SHIP_TYPE_FILTER_ORDER.includes(ship.shipType)
          ) {
            this.typeFilters.add(ship.shipType);
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
    this.applyFilters();
  }

  private setFilterPopoverOpen(target: 'filter' | null): void {
    this.filterPopover.hidden = target !== 'filter';
    this.filterButtons.forEach((button) => {
      button.setAttribute(
        'aria-expanded',
        String(button.dataset['fleetFilterTrigger'] === target),
      );
    });
  }

  private renderFilterOptions(): void {
    this.typeOptions.replaceChildren(
      this.createFilterOption('type', 'all', '全部'),
      ...SHIP_TYPE_FILTER_ORDER
        .filter(code => this.labels.shipTypes[code] !== undefined)
        .map(code => this.createFilterOption(
          'type',
          code,
          TYPE_LABELS[code] ?? this.labels.shipTypes[code]!,
        )),
    );
    this.countryOptions.replaceChildren(
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
    this.filterPopover
      .querySelectorAll<HTMLElement>('[data-filter-kind]')
      .forEach((item) => {
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
    this.filterPopover
      .querySelectorAll<HTMLElement>('[data-sort-field]')
      .forEach((item) => {
        item.classList.toggle(
          'active',
          item.dataset['sortField'] === this.sortField,
        );
      });
    this.sortDescending.checked = this.descending;
    this.refitFilter.checked = this.refitOnly;
    const activeFilterCount = [
      this.typeFilters.size > 0,
      this.countryFilters.size > 0,
      this.refitOnly,
    ].filter(Boolean).length;
    this.filterCount.textContent = activeFilterCount > 0
      ? String(activeFilterCount)
      : '';
    this.filterButtons.forEach((button) => {
      const active = activeFilterCount > 0
        || this.sortField !== 'id'
        || this.descending;
      button.classList.toggle('active', active);
    });
  }

  private applyFilters(
    resetScroll = true,
    preservedScrollTop?: number,
  ): void {
    const previousScrollTop = resetScroll
      ? 0
      : preservedScrollTop ?? this.gallery.scrollTop;
    const previousRenderedShipCount = resetScroll
      ? 0
      : this.renderedShipCount;
    const search = this.normalizeSearch(this.searchText);
    const selectedIds = new Set(
      this.host.selectedShips().map(ship => ship.id),
    );
    const refitSearchNames = this.refitOnly
      ? new Set(
          this.shipItems
            .filter(ship => ship.variant === 'refit')
            .map(ship => ship.searchName),
        )
      : null;
    this.visibleShips = this.shipItems.filter((ship) => {
      const typeMatches = this.typeFilters.size === 0
        || this.typeFilters.has(ship.shipType);
      const countryMatches = this.countryFilters.size === 0
        || this.countryFilters.has(ship.country);
      const refitMatches = refitSearchNames === null
        || ship.variant === 'refit'
        || !refitSearchNames.has(ship.searchName);
      const searchMatches = !search || [
        ship.name,
        ship.searchName,
        String(ship.id),
        this.labels.shipTypes[ship.shipType] ?? '',
        ship.shipType,
      ].some(value => this.normalizeSearch(value).includes(search));
      return !selectedIds.has(ship.id)
        && typeMatches
        && countryMatches
        && refitMatches
        && searchMatches;
    });

    const direction = this.descending ? -1 : 1;
    this.visibleShips.sort((left, right) => {
      let result = 0;
      if (this.sortField === 'name') {
        result = left.name.localeCompare(right.name, 'zh-CN');
      } else if (this.sortField === 'type') {
        const leftType = this.labels.shipTypes[left.shipType]
          ?? left.shipType;
        const rightType = this.labels.shipTypes[right.shipType]
          ?? right.shipType;
        result = leftType.localeCompare(rightType, 'zh-CN');
      } else {
        result = left.id - right.id;
      }
      return (result || left.id - right.id) * direction;
    });

    this.countLabel.textContent = (
      `显示 ${this.visibleShips.length} / ${this.shipItems.length} 艘`
    );
    this.renderedShipCount = 0;
    this.gallery.replaceChildren();
    if (this.visibleShips.length === 0) {
      this.showMessage('没有符合当前条件的舰娘');
      return;
    }
    this.appendGalleryBatch(Math.max(
      this.galleryBatchSize(),
      previousRenderedShipCount,
    ));
    this.gallery.scrollTop = previousScrollTop;
  }

  private galleryBatchSize(): number {
    const columns = Math.max(
      1,
      Math.floor(
        (this.gallery.clientWidth + GALLERY_GAP)
        / (GALLERY_CARD_WIDTH + GALLERY_GAP),
      ),
    );
    const visibleRows = Math.max(
      1,
      Math.ceil(
        (this.gallery.clientHeight + GALLERY_GAP)
        / (GALLERY_CARD_HEIGHT + GALLERY_GAP),
      ),
    );
    return Math.max(
      MIN_GALLERY_BATCH_SIZE,
      columns * (visibleRows + 2),
    );
  }

  private ensureGalleryFilled(): void {
    if (this.visibleShips.length === 0) return;
    const missingCount = this.galleryBatchSize() - this.renderedShipCount;
    if (missingCount > 0) this.appendGalleryBatch(missingCount);
  }

  private appendGalleryBatch(count = this.galleryBatchSize()): void {
    if (this.renderedShipCount >= this.visibleShips.length) return;
    const scrollTop = this.gallery.scrollTop;
    const fragment = document.createDocumentFragment();
    const end = Math.min(
      this.renderedShipCount + count,
      this.visibleShips.length,
    );
    for (let index = this.renderedShipCount; index < end; index += 1) {
      fragment.append(this.createShipCard(this.visibleShips[index]));
    }
    this.renderedShipCount = end;
    this.gallery.append(fragment);
    this.gallery.scrollTop = scrollTop;
  }

  private createShipCard(ship: FleetShipViewObject): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'fleet-ship-card';
    card.dataset['shipId'] = String(ship.id);
    card.draggable = true;
    card.title = `将 ${ship.name} 放入${this.host.activeSlotDescription()}`;
    card.append(createShipArtwork(ship, this.shipTypeDisplay(ship)));
    return card;
  }

  private showMessage(message: string): void {
    const empty = document.createElement('div');
    empty.className = 'fleet-library-empty';
    empty.textContent = message;
    this.gallery.replaceChildren(empty);
  }

  private normalizeSearch(value: string): string {
    return value
      .toLocaleLowerCase('zh-CN')
      .replace(/[\s·•._-]+/g, '');
  }
}
