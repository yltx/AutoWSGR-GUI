/** 将舰队规划的编辑契约接入共享舰船图库。 */
import type { ShipLibraryShip } from '../../types/ipc.js';
import type { ShipGalleryViewState } from '../../types/view.js';
import {
  ShipGalleryView,
} from './ShipGalleryView';

export const FLEET_DRAG_MIME = 'application/x-autowsgr-fleet';

export interface FleetGalleryViewHost {
  getRefitFilter(): boolean;
  setRefitFilter(enabled: boolean): void;
  getGalleryState(): ShipGalleryViewState | null;
  setGalleryState(state: ShipGalleryViewState): void;
  activeSlotDescription(): string;
  selectedShips(): readonly ShipLibraryShip[];
  assignShip(ship: ShipLibraryShip): void;
  rememberBackupScroll(): void;
  clearBackupDragScroll(): void;
}

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`缺少舰队图库元素: #${id}`);
  return target as T;
}

export class FleetGalleryView extends ShipGalleryView {
  constructor(host: FleetGalleryViewHost) {
    super({
      gallery: element('fleet-ship-gallery'),
      countLabel: element('fleet-library-count'),
      searchInput: element<HTMLInputElement>('fleet-ship-search'),
      filterButtons: Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-fleet-filter-trigger]',
        ),
      ),
      filterCount: element('fleet-filter-count'),
      filterPopover: element('fleet-filter-popover'),
      typeOptions: element('fleet-filter-types'),
      countryOptions: element('fleet-filter-countries'),
      refitFilter: element<HTMLInputElement>('fleet-filter-refit-only'),
      sortDescending: element<HTMLInputElement>('fleet-sort-desc'),
      resetButton: element<HTMLButtonElement>('btn-reset-fleet-filter'),
      confirmButton: element<HTMLButtonElement>('btn-confirm-fleet-filter'),
    }, {
      getRefitFilter: () => host.getRefitFilter(),
      setRefitFilter: enabled => host.setRefitFilter(enabled),
      getGalleryState: () => host.getGalleryState(),
      setGalleryState: state => host.setGalleryState(state),
      activeSlotDescription: () => host.activeSlotDescription(),
      isExcluded: ship => (
        host.selectedShips().some(selected => selected.id === ship.id)
      ),
      assignShip: ship => host.assignShip(ship),
      drag: {
        mime: FLEET_DRAG_MIME,
        serialize: ship => JSON.stringify({
          source: 'gallery',
          shipId: ship.id,
        }),
        onStart: () => host.rememberBackupScroll(),
        onEnd: () => host.clearBackupDragScroll(),
      },
    });
  }
}
