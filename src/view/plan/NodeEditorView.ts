import type { MapNodeType } from '../../types/view';
import { NODE_TYPE_ICON, NODE_TYPE_ICON_NIGHT, NODE_TYPE_NAME, NON_COMBAT_TYPES, escapeHtml } from './MapView';

export class NodeEditorView {
  private editorEl: HTMLElement;
  private editorIdEl: HTMLElement;
  private placeholderEl: HTMLElement;
  private infoEl: HTMLElement;

  constructor() {
    this.editorEl = document.getElementById('node-editor')!;
    this.editorIdEl = document.getElementById('node-editor-id')!;
    this.placeholderEl = document.getElementById('node-editor-placeholder')!;
    this.infoEl = document.getElementById('node-info')!;
  }

  show(nodeId: string, nodeType: MapNodeType, args: { enabled: boolean; formation: number; night: boolean; longMissileSupport: boolean; proceed: boolean; detour: boolean; canDetour: boolean; slWhenDetourFails: boolean; isEndpoint: boolean; isTerminal: boolean; enemyRules: string }, mapNight = false): void {
    this.infoEl.style.display = 'none';
    const isCombatNode = !NON_COMBAT_TYPES.has(nodeType);

    const isNightBattle = mapNight && nodeType === 'Normal';
    const icon = isNightBattle ? NODE_TYPE_ICON_NIGHT : (NODE_TYPE_ICON[nodeType] || '');
    const typeName = isNightBattle ? '夜战点' : NODE_TYPE_NAME[nodeType];
    const typeCls = isNightBattle ? 'node-type-night' : `node-type-${nodeType.toLowerCase()}`;
    const headerEl = this.editorEl.querySelector('.node-editor-header')!;
    const badgeEl = headerEl.querySelector('.node-info-badge');
    const typeSpan = headerEl.querySelector('.node-editor-type');
    if (badgeEl) {
      badgeEl.className = `node-info-badge ${typeCls}`;
      badgeEl.innerHTML = icon;
    }
    if (typeSpan) {
      typeSpan.textContent = typeName;
    }
    this.editorIdEl.textContent = nodeId;
    (document.getElementById('node-edit-enabled') as HTMLInputElement).checked = args.enabled;
    (document.getElementById('node-edit-endpoint') as HTMLInputElement).checked = args.isEndpoint;

    const detourGroup = document.getElementById('node-edit-detour-group') as HTMLElement;
    const detourHelp = document.getElementById('node-edit-detour-help') as HTMLElement;
    const detourInput = document.getElementById('node-edit-detour') as HTMLInputElement;
    if (args.canDetour) {
      detourGroup.style.display = '';
      detourHelp.style.display = '';
      detourHelp.textContent = '可通过勾选"迂回"直接迂回，也可在索敌规则中返回 detour 触发条件迂回。';
      detourInput.checked = args.detour;
      (document.getElementById('node-edit-sl-when-detour-fails') as HTMLInputElement).checked = args.slWhenDetourFails;
    } else {
      detourGroup.style.display = 'none';
      detourHelp.style.display = '';
      detourHelp.textContent = '当前节点不是迂回点，索敌规则中的 detour 动作会被忽略。';
      detourInput.checked = false;
      (document.getElementById('node-edit-sl-when-detour-fails') as HTMLInputElement).checked = false;
    }

    const combatFields = document.getElementById('node-editor-combat-fields') as HTMLElement;
    const nonCombatHint = document.getElementById('node-editor-non-combat-note') as HTMLElement;
    combatFields.style.display = isCombatNode ? '' : 'none';
    nonCombatHint.style.display = isCombatNode ? 'none' : '';

    (document.getElementById('node-edit-formation') as HTMLSelectElement).value = String(args.formation);
    const nightCheckbox = document.getElementById('node-edit-night') as HTMLInputElement;
    if (mapNight && nodeType === 'Normal') {
      nightCheckbox.checked = true;
      nightCheckbox.disabled = true;
    } else {
      nightCheckbox.checked = args.night;
      nightCheckbox.disabled = false;
    }
    (document.getElementById('node-edit-long-missile-support') as HTMLInputElement).checked = args.longMissileSupport;
    (document.getElementById('node-edit-proceed') as HTMLInputElement).checked = args.proceed;
    const proceedLabel = document.getElementById('node-edit-proceed-label') as HTMLElement;
    if (args.isTerminal) {
      proceedLabel.style.display = 'none';
    } else {
      proceedLabel.style.display = '';
    }
    (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value = args.enemyRules;

    this.placeholderEl.style.display = 'none';
    this.editorEl.style.display = '';
  }

  showInfo(nodeId: string, nodeType: MapNodeType, onClose: () => void): void {
    this.editorEl.style.display = 'none';
    this.placeholderEl.style.display = 'none';
    this.infoEl.style.display = '';

    const icon = NODE_TYPE_ICON[nodeType] || '';
    const name = NODE_TYPE_NAME[nodeType];
    const typeCls = `node-type-${nodeType.toLowerCase()}`;

    let desc = '';
    switch (nodeType) {
      case 'Start': desc = '舰队从此处出击，无战斗或设置。'; break;
      case 'Resource': desc = '经过此点可获取资源，无需战斗。'; break;
      case 'Penalty': desc = '经过此点会扣除资源，无需战斗。'; break;
    }

    this.infoEl.innerHTML =
      `<div class="node-info-header">` +
        `<div class="node-info-badge ${typeCls}">${icon}</div>` +
        `<div><h3>${escapeHtml(nodeId)} 点</h3><span class="node-info-type">${escapeHtml(name)}</span></div>` +
        `<button class="btn btn-small" id="btn-node-info-close">✕</button>` +
      `</div>` +
      `<p class="node-info-desc">${escapeHtml(desc)}</p>` +
      `<p class="node-info-note">此类型节点没有可配置的战斗设置。</p>`;

    this.infoEl.querySelector('#btn-node-info-close')?.addEventListener('click', onClose);
  }

  hide(): void {
    this.editorEl.style.display = 'none';
    this.infoEl.style.display = 'none';
    this.placeholderEl.style.display = '';
    const detourHelp = document.getElementById('node-edit-detour-help') as HTMLElement | null;
    if (detourHelp) {
      detourHelp.style.display = 'none';
      detourHelp.textContent = '';
    }
  }

  collectValues(): { enabled: boolean; isEndpoint: boolean; formation: number; night: boolean; longMissileSupport: boolean; proceed: boolean; detour: boolean; slWhenDetourFails: boolean; rulesText: string } {
    return {
      enabled: (document.getElementById('node-edit-enabled') as HTMLInputElement).checked,
      isEndpoint: (document.getElementById('node-edit-endpoint') as HTMLInputElement).checked,
      formation: parseInt((document.getElementById('node-edit-formation') as HTMLSelectElement).value, 10),
      night: (document.getElementById('node-edit-night') as HTMLInputElement).checked,
      longMissileSupport: (document.getElementById('node-edit-long-missile-support') as HTMLInputElement).checked,
      proceed: (document.getElementById('node-edit-proceed') as HTMLInputElement).checked,
      detour: (document.getElementById('node-edit-detour') as HTMLInputElement).checked,
      slWhenDetourFails: (document.getElementById('node-edit-sl-when-detour-fails') as HTMLInputElement).checked,
      rulesText: (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value,
    };
  }
}
