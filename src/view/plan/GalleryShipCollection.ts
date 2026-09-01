/** 提供舰船图库共用的无状态搜索、筛选、排序和批量计算。 */
import type {
  ShipLibraryShip,
} from '../../types/ipc.js';

export type GallerySortField = 'type' | 'name' | 'id';

export interface GalleryShipQuery {
  searchText: string;
  typeFilters: ReadonlySet<string>;
  countryFilters: ReadonlySet<string>;
  refitOnly: boolean;
  sortField: GallerySortField;
  descending: boolean;
  shipTypeLabels: Readonly<Record<string, string>>;
  isExcluded(ship: ShipLibraryShip): boolean;
}

const MIN_GALLERY_BATCH_SIZE = 12;
const GALLERY_CARD_WIDTH = 128;
const GALLERY_CARD_HEIGHT = 200;
const GALLERY_GAP = 6;

export function normalizeGallerySearch(value: string): string {
  return value
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s·•._-]+/g, '');
}

export function filterAndSortGalleryShips(
  ships: readonly ShipLibraryShip[],
  query: GalleryShipQuery,
): ShipLibraryShip[] {
  const search = normalizeGallerySearch(query.searchText);
  const refitSearchNames = query.refitOnly
    ? new Set(
        ships
          .filter(ship => ship.variant === 'refit')
          .map(ship => ship.search_name),
      )
    : null;
  const visibleShips = ships.filter(ship => {
    const typeMatches = query.typeFilters.size === 0
      || query.typeFilters.has(ship.ship_type);
    const countryMatches = query.countryFilters.size === 0
      || query.countryFilters.has(ship.country);
    const refitMatches = refitSearchNames === null
      || ship.variant === 'refit'
      || !refitSearchNames.has(ship.search_name);
    const searchMatches = !search || [
      ship.name,
      ship.search_name,
      String(ship.id),
      query.shipTypeLabels[ship.ship_type] ?? '',
      ship.ship_type,
    ].some(value => normalizeGallerySearch(value).includes(search));
    return !query.isExcluded(ship)
      && typeMatches
      && countryMatches
      && refitMatches
      && searchMatches;
  });

  const direction = query.descending ? -1 : 1;
  visibleShips.sort((left, right) => {
    let result = 0;
    if (query.sortField === 'name') {
      result = left.name.localeCompare(right.name, 'zh-CN');
    } else if (query.sortField === 'type') {
      const leftType = query.shipTypeLabels[left.ship_type] ?? left.ship_type;
      const rightType = query.shipTypeLabels[right.ship_type] ?? right.ship_type;
      result = leftType.localeCompare(rightType, 'zh-CN');
    } else {
      result = left.id - right.id;
    }
    return (result || left.id - right.id) * direction;
  });

  return visibleShips;
}

export function calculateGalleryBatchSize(
  width: number,
  height: number,
): number {
  const columns = Math.max(
    1,
    Math.floor(
      (width + GALLERY_GAP)
      / (GALLERY_CARD_WIDTH + GALLERY_GAP),
    ),
  );
  const visibleRows = Math.max(
    1,
    Math.ceil(
      (height + GALLERY_GAP)
      / (GALLERY_CARD_HEIGHT + GALLERY_GAP),
    ),
  );
  return Math.max(
    MIN_GALLERY_BATCH_SIZE,
    columns * (visibleRows + 2),
  );
}
