/**
 * 舰娘图鉴展示框。
 *
 * 背景、立绘、边框和舰型图标是所有场景共用的基础图层。
 * 编号和舰名按页面需要开启，业务标记与交互由页面外层负责。
 */
import type { ShipLibraryShip } from '../../types/ipc.js';

export type ShipArtworkNameStyle = 'rarity' | 'plain';

export interface ShipArtworkOptions {
  readonly shipTypeLabel?: string;
  readonly showNumber?: boolean;
  readonly showName?: boolean;
  readonly displayName?: string;
  readonly nameStyle?: ShipArtworkNameStyle;
}

/** 创建共用舰船图片层，可按场景关闭编号和舰名。 */
export function createShipArtwork(
  ship: ShipLibraryShip,
  options: ShipArtworkOptions = {},
): HTMLSpanElement {
  const {
    shipTypeLabel = ship.ship_type,
    showNumber = true,
    showName = true,
    displayName = ship.name,
    nameStyle = 'rarity',
  } = options;
  const artwork = document.createElement('span');
  artwork.className = 'fleet-ship-artwork';
  artwork.dataset['shipName'] = ship.name;
  artwork.dataset['searchName'] = ship.search_name;

  if (ship.backgroundUrl) {
    const background = document.createElement('img');
    background.className = 'fleet-ship-background';
    background.src = ship.backgroundUrl;
    background.alt = '';
    background.loading = 'lazy';
    background.draggable = false;
    artwork.append(background);
  }

  const portraitWindow = document.createElement('span');
  portraitWindow.className = 'fleet-ship-portrait-window';
  const portrait = document.createElement('img');
  portrait.className = 'fleet-ship-portrait';
  portrait.src = ship.portraitUrl;
  portrait.alt = ship.name;
  portrait.loading = 'lazy';
  portrait.draggable = false;
  portraitWindow.append(portrait);
  artwork.append(portraitWindow);

  if (ship.frameUrl) {
    const frame = document.createElement('img');
    frame.className = 'fleet-ship-frame';
    frame.src = ship.frameUrl;
    frame.alt = '';
    frame.loading = 'lazy';
    frame.draggable = false;
    artwork.append(frame);
  }

  if (showNumber) {
    const number = document.createElement('span');
    number.className = 'fleet-ship-number';
    number.textContent = `No.${String(ship.id).padStart(3, '0')}`;
    artwork.append(number);
  }

  if (ship.typeIconUrl) {
    const typeIcon = document.createElement('img');
    typeIcon.className = 'fleet-ship-type-icon';
    typeIcon.src = ship.typeIconUrl;
    typeIcon.alt = shipTypeLabel;
    typeIcon.loading = 'lazy';
    typeIcon.draggable = false;
    artwork.append(typeIcon);
  }

  if (showName) {
    const name = document.createElement('span');
    name.className = [
      'fleet-ship-name',
      nameStyle === 'plain' ? 'is-plain' : '',
    ].filter(Boolean).join(' ');
    const nameText = document.createElement('strong');
    nameText.className = nameStyle === 'plain'
      ? 'fleet-ship-name-text'
      : `fleet-ship-name-text rarity-${
        Math.max(1, Math.min(6, ship.rarity))
      }`;
    nameText.textContent = displayName;
    name.append(nameText);
    artwork.append(name);
  }
  return artwork;
}
