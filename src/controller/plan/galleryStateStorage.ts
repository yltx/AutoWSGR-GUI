/** Reads and writes the persisted filter and scroll state of a ship gallery. */
import type {
  StorageStore,
} from '../../adapter/StorageAdapter.js';
import type {
  ShipGalleryViewState,
} from '../../types/view.js';

const SORT_FIELDS = new Set(['type', 'name', 'id']);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** Returns null when no usable state has been saved. */
export function loadGalleryViewState(
  storage: StorageStore,
  key: string,
): ShipGalleryViewState | null {
  try {
    const raw = storage.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const sortField = typeof parsed['sortField'] === 'string'
      && SORT_FIELDS.has(parsed['sortField'])
      ? parsed['sortField'] as ShipGalleryViewState['sortField']
      : 'id';
    return {
      searchText: typeof parsed['searchText'] === 'string'
        ? parsed['searchText']
        : '',
      groupFilter: parsed['groupFilter'] === null
        ? null
        : typeof parsed['groupFilter'] === 'string'
          ? parsed['groupFilter']
          : 'all',
      typeFilters: stringArray(parsed['typeFilters']),
      countryFilters: stringArray(parsed['countryFilters']),
      refitOnly: parsed['refitOnly'] === true,
      sortField,
      descending: parsed['descending'] === true,
      scrollTop: nonNegativeNumber(parsed['scrollTop']),
      scrollLeft: nonNegativeNumber(parsed['scrollLeft']),
      renderedShipCount: Math.floor(
        nonNegativeNumber(parsed['renderedShipCount']),
      ),
    };
  } catch {
    return null;
  }
}

/** Storage failures must not interrupt gallery interactions. */
export function saveGalleryViewState(
  storage: StorageStore,
  key: string,
  state: ShipGalleryViewState,
): void {
  try {
    storage.set(key, JSON.stringify(state));
  } catch {
    // Keep the current in-memory state when browser storage is unavailable.
  }
}
