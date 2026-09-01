/** 舰船资料库中的统一名称匹配规则。 */
import type { ShipLibraryShip } from '../types/ipc.js';

export interface ShipLibraryReference {
  /** 精确形态名称，例如“U-47·改”。 */
  readonly name?: string | null;
  /** 用于兼容旧配置和别名的检索名称。 */
  readonly searchName?: string | null;
  /** 名称和检索名称均失败时，是否允许移除“·形态”后缀重试。 */
  readonly allowBaseNameFallback?: boolean;
}

function normalizedName(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function distinctNames(
  values: readonly (string | null | undefined)[],
): string[] {
  return values
    .map(normalizedName)
    .filter((value, index, names) => (
      Boolean(value) && names.indexOf(value) === index
    ));
}

function findBySearchName(
  ships: readonly ShipLibraryShip[],
  searchName: string,
): ShipLibraryShip | undefined {
  return ships.find(ship => (
    ship.search_name === searchName && ship.variant === 'normal'
  )) ?? ships.find(ship => ship.search_name === searchName);
}

/**
 * 精确形态名称优先，search_name 只负责兼容检索，禁止覆盖已命中的形态。
 */
export function findShipLibraryShip(
  ships: readonly ShipLibraryShip[],
  reference: ShipLibraryReference,
): ShipLibraryShip | undefined {
  const name = normalizedName(reference.name);
  const searchName = normalizedName(reference.searchName);

  if (name) {
    const exact = ships.find(ship => ship.name === name);
    if (exact) return exact;
  }
  if (searchName && searchName !== name) {
    const exactSearchName = ships.find(ship => ship.name === searchName);
    if (exactSearchName) return exactSearchName;
  }

  for (const candidate of distinctNames([searchName, name])) {
    const match = findBySearchName(ships, candidate);
    if (match) return match;
  }

  if (!reference.allowBaseNameFallback) return undefined;
  const baseNames = distinctNames([name, searchName].map(value => (
    value.split('·')[0]
  )));
  for (const baseName of baseNames) {
    const match = ships.find(ship => ship.name === baseName)
      ?? findBySearchName(ships, baseName);
    if (match) return match;
  }
  return undefined;
}
