/** 渲染节点属性和敌舰规则编辑对话框。 */
import type { MapNodeType } from '../../types/view.js';
import type { BattleResultGrade } from '../../types/model.js';
import {
  NODE_TYPE_ICON,
  NODE_TYPE_ICON_NIGHT,
  NODE_TYPE_NAME,
  NON_COMBAT_TYPES,
} from './MapView';

export interface NodeEditorValues {
  enabled: boolean;
  isEndpoint: boolean;
  result?: BattleResultGrade;
  formation: number;
  night: boolean;
  longMissileSupport: boolean;
  proceed: boolean;
  detour: boolean;
  slWhenDetourFails: boolean;
  rulesText: string;
}

export interface NodeEditorArgs {
  enabled: boolean;
  formation: number;
  night: boolean;
  longMissileSupport: boolean;
  proceed: boolean;
  detour: boolean;
  canDetour: boolean;
  slWhenDetourFails: boolean;
  isEndpoint: boolean;
  result?: BattleResultGrade;
  isTerminal: boolean;
  enemyRules: string;
}

export class NodeEditorView {
  private editorEl: HTMLElement;
  private editorIdEl: HTMLElement;
  private placeholderEl: HTMLElement;
  private drawerEl: HTMLElement;
  private enabledInput: HTMLInputElement;
  private currentNodeId: string | null = null;
  private disabledDrafts = new Map<string, NodeEditorValues>();
  private resizeAnimation: Animation | null = null;

  onClose?: () => void;
  onSave?: () => void;

  constructor() {
    this.editorEl = document.getElementById('node-editor')!;
    this.editorIdEl = document.getElementById('node-editor-id')!;
    this.placeholderEl = document.getElementById('node-editor-placeholder')!;
    this.drawerEl = document.getElementById('plan-node-info-drawer')!;
    this.enabledInput = document.getElementById(
      'node-edit-enabled',
    ) as HTMLInputElement;
    this.enabledInput.addEventListener('change', () => {
      if (!this.enabledInput.checked) {
        this.rememberDisabledDraft();
      }
      this.updateEnabledVisibility(true);
    });
    (document.getElementById('node-edit-endpoint') as HTMLInputElement)
      .addEventListener('change', () => this.updateEndpointResultVisibility());
    document.getElementById('btn-node-editor-close')?.addEventListener(
      'click',
      () => this.onClose?.(),
    );
    document.getElementById('btn-node-edit-save')?.addEventListener(
      'click',
      () => this.onSave?.(),
    );
  }

  show(
    nodeId: string,
    nodeType: MapNodeType,
    args: NodeEditorArgs,
    mapNight = false,
  ): void {
    this.cancelResizeAnimation();
    this.rememberDisabledDraft();
    this.currentNodeId = nodeId;
    const isCombatNode = !NON_COMBAT_TYPES.has(nodeType);
    const draft = this.disabledDrafts.get(nodeId);

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
    this.enabledInput.checked = args.enabled;
    const endpointInput = document.getElementById('node-edit-endpoint') as HTMLInputElement;
    endpointInput.checked = draft?.isEndpoint ?? args.isEndpoint;
    const result = draft ? draft.result : args.result;
    const resultInput = this.editorEl.querySelector<HTMLInputElement>(
      `input[name="node-edit-result"][value="${result ?? ''}"]`,
    ) ?? this.editorEl.querySelector<HTMLInputElement>(
      'input[name="node-edit-result"][value=""]',
    );
    if (resultInput) resultInput.checked = true;

    const detourGroup = document.getElementById('node-edit-detour-group') as HTMLElement;
    const detourHelp = document.getElementById('node-edit-detour-help') as HTMLElement;
    const detourInput = document.getElementById('node-edit-detour') as HTMLInputElement;
    if (args.canDetour) {
      detourGroup.style.display = '';
      detourHelp.style.display = 'none';
      detourHelp.textContent = '';
      detourInput.checked = draft?.detour ?? args.detour;
      (document.getElementById('node-edit-sl-when-detour-fails') as HTMLInputElement).checked =
        draft?.slWhenDetourFails ?? args.slWhenDetourFails;
    } else {
      detourGroup.style.display = 'none';
      detourHelp.style.display = '';
      detourHelp.textContent = '当前节点不是迂回点，索敌规则中 detour 不生效。';
      detourInput.checked = false;
      (document.getElementById('node-edit-sl-when-detour-fails') as HTMLInputElement).checked = false;
    }

    const combatFields = document.getElementById('node-editor-combat-fields') as HTMLElement;
    const nonCombatHint = document.getElementById('node-editor-non-combat-note') as HTMLElement;
    combatFields.style.display = isCombatNode ? '' : 'none';
    nonCombatHint.style.display = isCombatNode ? 'none' : '';

    const formationInput = this.editorEl.querySelector<HTMLInputElement>(
      `input[name="node-edit-formation"][value="${draft?.formation ?? args.formation}"]`,
    ) ?? this.editorEl.querySelector<HTMLInputElement>(
      'input[name="node-edit-formation"][value="2"]',
    );
    if (formationInput) formationInput.checked = true;
    const nightCheckbox = document.getElementById('node-edit-night') as HTMLInputElement;
    if (mapNight && nodeType === 'Normal') {
      nightCheckbox.checked = true;
      nightCheckbox.disabled = true;
    } else {
      nightCheckbox.checked = draft?.night ?? args.night;
      nightCheckbox.disabled = false;
    }
    (document.getElementById('node-edit-long-missile-support') as HTMLInputElement).checked =
      draft?.longMissileSupport ?? args.longMissileSupport;
    (document.getElementById('node-edit-proceed') as HTMLInputElement).checked =
      draft?.proceed ?? args.proceed;
    const proceedLabel = document.getElementById('node-edit-proceed-label') as HTMLElement;
    if (args.isTerminal) {
      proceedLabel.style.display = 'none';
    } else {
      proceedLabel.style.display = '';
    }
    (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value =
      draft?.rulesText ?? args.enemyRules;

    this.placeholderEl.style.display = 'none';
    this.editorEl.style.display = '';
    this.updateEnabledVisibility();
    this.updateEndpointResultVisibility();
    this.openDrawer();
  }

  hide(): void {
    this.cancelResizeAnimation();
    this.rememberDisabledDraft();
    this.currentNodeId = null;
    this.drawerEl.classList.remove('is-open');
    this.drawerEl.setAttribute('aria-hidden', 'true');
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && this.drawerEl.contains(activeElement)) {
      activeElement.blur();
    }
    const detourHelp = document.getElementById('node-edit-detour-help') as HTMLElement | null;
    if (detourHelp) {
      detourHelp.style.display = 'none';
      detourHelp.textContent = '';
    }
  }

  resetDrafts(): void {
    this.disabledDrafts.clear();
    this.currentNodeId = null;
  }

  collectValues(): NodeEditorValues {
    const values = this.readValues();
    if (this.currentNodeId) {
      if (values.enabled) {
        this.disabledDrafts.delete(this.currentNodeId);
      } else {
        this.disabledDrafts.set(this.currentNodeId, values);
      }
    }
    return values;
  }

  private readValues(): NodeEditorValues {
    const formationInput = this.editorEl.querySelector<HTMLInputElement>(
      'input[name="node-edit-formation"]:checked',
    );
    const resultInput = this.editorEl.querySelector<HTMLInputElement>(
      'input[name="node-edit-result"]:checked',
    );
    return {
      enabled: this.enabledInput.checked,
      isEndpoint: (document.getElementById('node-edit-endpoint') as HTMLInputElement).checked,
      result: (resultInput?.value || undefined) as BattleResultGrade | undefined,
      formation: Number.parseInt(formationInput?.value ?? '2', 10),
      night: (document.getElementById('node-edit-night') as HTMLInputElement).checked,
      longMissileSupport: (document.getElementById('node-edit-long-missile-support') as HTMLInputElement).checked,
      proceed: (document.getElementById('node-edit-proceed') as HTMLInputElement).checked,
      detour: (document.getElementById('node-edit-detour') as HTMLInputElement).checked,
      slWhenDetourFails: (document.getElementById('node-edit-sl-when-detour-fails') as HTMLInputElement).checked,
      rulesText: (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value,
    };
  }

  private rememberDisabledDraft(): void {
    if (!this.currentNodeId || this.enabledInput.checked) return;
    this.disabledDrafts.set(
      this.currentNodeId,
      this.readValues(),
    );
  }

  private updateEnabledVisibility(animate = false): void {
    const update = (): void => {
      const hidden = !this.enabledInput.checked;
      this.editorEl
        .querySelectorAll<HTMLElement>(
          '.node-enable-dependent',
        )
        .forEach((element) => {
          element.hidden = hidden;
        });
      this.updateEndpointResultVisibility();
    };

    if (
      !animate
      || !this.drawerEl.classList.contains('is-open')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      update();
      return;
    }

    const before = this.drawerEl.getBoundingClientRect();
    this.resizeAnimation?.cancel();
    update();
    const after = this.drawerEl.getBoundingClientRect();
    if (
      Math.abs(before.width - after.width) < 1
      && Math.abs(before.height - after.height) < 1
    ) {
      return;
    }

    this.drawerEl.style.overflow = 'hidden';
    const animation = this.drawerEl.animate(
      [
        {
          width: `${before.width}px`,
          height: `${before.height}px`,
        },
        {
          width: `${after.width}px`,
          height: `${after.height}px`,
        },
      ],
      {
        duration: 160,
        easing: 'cubic-bezier(0.2, 0.72, 0.2, 1)',
      },
    );
    this.resizeAnimation = animation;
    void animation.finished
      .catch(() => undefined)
      .then(() => {
        if (this.resizeAnimation !== animation) return;
        this.resizeAnimation = null;
        this.drawerEl.style.removeProperty('overflow');
      });
  }

  private updateEndpointResultVisibility(): void {
    const endpointInput = document.getElementById('node-edit-endpoint') as HTMLInputElement;
    const resultGroup = document.getElementById('node-edit-result-group') as HTMLElement;
    resultGroup.hidden = !this.enabledInput.checked || !endpointInput.checked;
  }

  private cancelResizeAnimation(): void {
    this.resizeAnimation?.cancel();
    this.resizeAnimation = null;
    this.drawerEl.style.removeProperty('overflow');
  }

  private openDrawer(): void {
    this.drawerEl.setAttribute('aria-hidden', 'false');
    this.drawerEl.classList.add('is-open');
  }
}
