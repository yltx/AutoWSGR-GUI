/** 加载静态舰船资料并提供舰名和国籍只读目录。 */
import rawShips from '../data/ship_details.json';

export interface ShipInfo {
  name: string;
  nation: string;
  ship_type: string;
}

export const ALL_SHIPS: readonly ShipInfo[] = rawShips.map(ship => ({
  name: ship.name,
  nation: ship.nation,
  ship_type: ship.ship_type,
}));
