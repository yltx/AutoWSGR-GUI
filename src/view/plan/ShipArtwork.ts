/** 创建舰船立绘元素并处理资源路径和加载失败回退。 */
/**
 * 舰娘图鉴展示框。
 *
 * 舰队规划、编队预览和决战图鉴共用同一套图片层级。
 * 背景、立绘、边框、编号、舰型图标和名称的样式由舰队规划样式统一维护。
 */
import type { FleetShipViewObject } from '../../types/view.js';

export function createShipArtwork(
  ship: FleetShipViewObject,
  shipTypeLabel = ship.shipType,
): HTMLSpanElement {
  const artwork = document.createElement('span');
  artwork.className = 'fleet-ship-artwork';

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

  const number = document.createElement('span');
  number.className = 'fleet-ship-number';
  number.textContent = `No.${String(ship.id).padStart(3, '0')}`;
  artwork.append(number);

  if (ship.typeIconUrl) {
    const typeIcon = document.createElement('img');
    typeIcon.className = 'fleet-ship-type-icon';
    typeIcon.src = ship.typeIconUrl;
    typeIcon.alt = shipTypeLabel;
    typeIcon.loading = 'lazy';
    typeIcon.draggable = false;
    artwork.append(typeIcon);
  }

  const name = document.createElement('span');
  name.className = 'fleet-ship-name';
  const nameText = document.createElement('strong');
  nameText.className = `fleet-ship-name-text rarity-${
    Math.max(1, Math.min(6, ship.rarity))
  }`;
  nameText.textContent = ship.name;
  name.append(nameText);
  artwork.append(name);
  return artwork;
}
