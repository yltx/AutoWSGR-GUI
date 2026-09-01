/** 统一舰名别名、后端标准名和搜索名转换。 */
import type { DecisiveReq } from '../types/api.js';
import type { ShipLibraryShip } from '../types/ipc.js';

export function toBackendName(displayName: string): string {
  const noRefit = displayName.endsWith('·改')
    ? displayName.slice(0, -2)
    : displayName;
  return noRefit.replace(/\s*[（(][^（）()]*[)）]\s*$/, '').trim();
}

type DecisiveShipNames = Pick<
  DecisiveReq,
  'level1' | 'level2' | 'flagship_priority'
>;

export function toBackendDecisiveShipNames(
  names: DecisiveShipNames,
  ships?: readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[],
): Required<DecisiveShipNames> {
  const backendNames = ships === undefined
    ? null
    : new Map(
      ships.map(ship => [ship.name.trim(), ship.search_name.trim()]),
    );
  const convert = (value?: string[]): string[] => {
    const values = Array.isArray(value) ? value : [];
    return backendNames
      ? values
        .map(name => name.trim())
        .filter(Boolean)
        .map(name => backendNames.get(name) ?? name)
      : values;
  };
  return {
    level1: convert(names.level1),
    level2: convert(names.level2),
    flagship_priority: convert(names.flagship_priority),
  };
}

export function resolveConfiguredShipSearchName(
  name: string,
  aliases: Readonly<Record<string, string>>,
): string {
  const normalizedName = toBackendName(name);
  for (const [alias, standardName] of Object.entries(aliases)) {
    const normalizedAlias = alias.trim();
    if (
      normalizedAlias
      && toBackendName(standardName) === normalizedName
    ) {
      return normalizedAlias;
    }
  }
  return name.trim();
}
