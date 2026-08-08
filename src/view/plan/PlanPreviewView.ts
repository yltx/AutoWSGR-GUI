/** 组合地图、节点编辑、舰队预设和方案参数预览。 */
/**
 * PlanPreviewView —— 方案预览 Facade。
 * 持有 MapView / NodeEditorView / FleetPresetView 三个子视图，
 * 对外 API 保持不变，Controller 无需感知内部拆分。
 */
import type {
  MapNodeType,
  PlanFleetPresetSelectorViewObject,
  PlanPreviewViewObject,
  PresetDetailVO,
  PresetFormValues,
} from '../../types/view.js';
import type {
  BathRepairConfig,
  EventChapter,
  EventMapCatalogEntry,
} from '../../types/model.js';
import { MapView } from './MapView';
import {
  NodeEditorView,
  type NodeEditorArgs,
  type NodeEditorValues,
} from './NodeEditorView';
import { FleetPresetView } from './FleetPresetView';

const MAP_COUNT_BY_CHAPTER: Record<string, number> = {
  '1': 5,
  '2': 6,
  '3': 4,
  '4': 4,
  '5': 5,
  '6': 4,
  '7': 5,
  '8': 5,
  '9': 5,
  '10': 1,
};

export class PlanPreviewView {
  private detailEl: HTMLElement;
  private chapterSelect: HTMLSelectElement;
  private mapSelect: HTMLSelectElement;
  private presetNameInput: HTMLInputElement;
  private repairSelect: HTMLSelectElement;
  private fightCondSelect: HTMLSelectElement;
  private fleetSelect: HTMLSelectElement;
  private timesInput: HTMLInputElement;
  private gapInput: HTMLInputElement;
  private lootEnabledInput: HTMLInputElement;
  private lootGeInput: HTMLInputElement;
  private lootFieldsEl: HTMLElement;
  private shipEnabledInput: HTMLInputElement;
  private shipGeInput: HTMLInputElement;
  private shipFieldsEl: HTMLElement;
  private eventMapCatalog: EventMapCatalogEntry[] = [];

  private mapView: MapView;
  private nodeEditor: NodeEditorView;
  private fleetPresetView: FleetPresetView;

  onNewPlan?: () => void;
  onLoadPlan?: () => void;
  onSavePlan?: () => void;
  onAddCurrentPlanToGroup?: () => void;
  onClosePreset?: () => void;
  onExecutePreset?: () => void;
  onAddPresetToGroup?: () => void;
  onNodeClick?: (nodeId: string) => void;
  onMapChange?: (chapter: string, map: number | string) => void;
  onPresetNameChange?: (name: string) => void;
  onPlanFieldChange?: (field: 'repair_mode' | 'fight_condition' | 'fleet_id' | 'times' | 'gap' | 'loot_count_ge' | 'ship_count_ge', value: number | undefined) => void;

  set onAddFleetPreset(
    fn: ((planId: string) => void) | undefined,
  ) {
    this.fleetPresetView.onAddFleetPreset = fn;
  }

  set onRemoveFleetPreset(
    fn: ((index: number) => void) | undefined,
  ) {
    this.fleetPresetView.onRemoveFleetPreset = fn;
  }

  set onCloseNodeEditor(fn: (() => void) | undefined) {
    this.nodeEditor.onClose = fn;
  }

  set onSaveNodeEditor(fn: (() => void) | undefined) {
    this.nodeEditor.onSave = fn;
  }

  constructor() {
    this.detailEl = document.getElementById('plan-detail')!;
    this.chapterSelect = document.getElementById('plan-edit-chapter') as HTMLSelectElement;
    this.mapSelect = document.getElementById('plan-edit-map') as HTMLSelectElement;
    this.presetNameInput = document.getElementById('plan-preset-name') as HTMLInputElement;
    this.repairSelect = document.getElementById('plan-edit-repair') as HTMLSelectElement;
    this.fightCondSelect = document.getElementById('plan-edit-fight-cond') as HTMLSelectElement;
    this.fleetSelect = document.getElementById('plan-edit-fleet') as HTMLSelectElement;
    this.timesInput = document.getElementById('plan-edit-times') as HTMLInputElement;
    this.gapInput = document.getElementById('plan-edit-gap') as HTMLInputElement;
    this.lootEnabledInput = document.getElementById('plan-edit-loot-enabled') as HTMLInputElement;
    this.lootGeInput = document.getElementById('plan-edit-loot-ge') as HTMLInputElement;
    this.lootFieldsEl = document.getElementById('plan-edit-loot-fields')!;
    this.shipEnabledInput = document.getElementById('plan-edit-ship-enabled') as HTMLInputElement;
    this.shipGeInput = document.getElementById('plan-edit-ship-ge') as HTMLInputElement;
    this.shipFieldsEl = document.getElementById('plan-edit-ship-fields')!;

    this.mapView = new MapView();
    this.nodeEditor = new NodeEditorView();
    this.fleetPresetView = new FleetPresetView();

    document.getElementById('btn-new-battle-plan')?.addEventListener(
      'click',
      () => this.onNewPlan?.(),
    );
    document.getElementById('btn-load-battle-plan')?.addEventListener(
      'click',
      () => this.onLoadPlan?.(),
    );
    document.getElementById('btn-save-plan')?.addEventListener(
      'click',
      () => this.onSavePlan?.(),
    );
    document.getElementById('btn-add-to-group')?.addEventListener(
      'click',
      () => this.onAddCurrentPlanToGroup?.(),
    );
    document.getElementById('btn-close-preset')?.addEventListener(
      'click',
      () => this.onClosePreset?.(),
    );
    document.getElementById('btn-tp-add-queue')?.addEventListener(
      'click',
      () => this.onExecutePreset?.(),
    );
    document.getElementById('btn-tp-add-group')?.addEventListener(
      'click',
      () => this.onAddPresetToGroup?.(),
    );
    const exerciseFleetToggle = document.getElementById(
      'tp-fleet-enable-ex',
    ) as HTMLInputElement | null;
    exerciseFleetToggle?.addEventListener('change', () => {
      const grid = document.getElementById('tp-fleet-grid-ex');
      if (grid) {
        grid.style.display = exerciseFleetToggle.checked ? '' : 'none';
      }
    });
    this.mapView.onNodeClick = (nodeId) => this.onNodeClick?.(nodeId);

    this.chapterSelect.addEventListener('change', () => {
      this.updateMapOptions(this.chapterSelect.value);
      this.emitMapChange();
    });
    this.mapSelect.addEventListener('change', () => {
      this.emitMapChange();
    });
    this.presetNameInput.addEventListener('input', () => {
      this.onPresetNameChange?.(this.presetNameInput.value);
    });

    // 方案级别字段变更事件
    this.repairSelect.addEventListener('change', () => {
      this.onPlanFieldChange?.('repair_mode', Number(this.repairSelect.value));
    });
    this.fightCondSelect.addEventListener('change', () => {
      this.onPlanFieldChange?.('fight_condition', Number(this.fightCondSelect.value));
    });
    this.fleetSelect.addEventListener('change', () => {
      this.onPlanFieldChange?.('fleet_id', Number(this.fleetSelect.value));
    });

    // 任务配置字段变更事件
    this.timesInput.addEventListener('change', () => {
      const v = parseInt(this.timesInput.value, 10);
      this.onPlanFieldChange?.('times', v > 0 ? v : 1);
    });
    this.gapInput.addEventListener('change', () => {
      const v = parseInt(this.gapInput.value, 10);
      this.onPlanFieldChange?.('gap', v >= 0 ? v : 0);
    });
    this.bindStopConditionControl(
      this.lootEnabledInput,
      this.lootGeInput,
      this.lootFieldsEl,
      'loot_count_ge',
      50,
    );
    this.bindStopConditionControl(
      this.shipEnabledInput,
      this.shipGeInput,
      this.shipFieldsEl,
      'ship_count_ge',
      500,
    );
  }

  /* ── 渲染 ── */

  render(vo: PlanPreviewViewObject | null): void {
    if (!vo) {
      this.detailEl.style.display = 'none';
      return;
    }

    this.detailEl.style.display = 'flex';

    this.renderMapSelection(vo);
    this.repairSelect.value = String(vo.repairModeValue);
    this.fightCondSelect.value = String(vo.fightConditionValue);
    this.fleetSelect.value = String(vo.fleetId);

    this.timesInput.value = String(vo.times ?? 1);
    this.gapInput.value = String(vo.gap ?? 0);
    this.renderStopConditionControl(
      this.lootEnabledInput,
      this.lootGeInput,
      this.lootFieldsEl,
      vo.lootCountGe,
      50,
    );
    this.renderStopConditionControl(
      this.shipEnabledInput,
      this.shipGeInput,
      this.shipFieldsEl,
      vo.shipCountGe,
      500,
    );

    this.fleetPresetView.render(vo.fleetPresetSelector);
    this.mapView.renderNodes(
      vo.allNodes,
      vo.selectedNodes,
      vo.edges,
      vo.mapAspectRatio,
    );
  }

  private bindStopConditionControl(
    enabledInput: HTMLInputElement,
    valueInput: HTMLInputElement,
    fieldsEl: HTMLElement,
    field: 'loot_count_ge' | 'ship_count_ge',
    max: number,
  ): void {
    enabledInput.addEventListener('change', () => {
      fieldsEl.hidden = !enabledInput.checked;
      valueInput.disabled = !enabledInput.checked;
      if (!enabledInput.checked) {
        this.onPlanFieldChange?.(field, -1);
        return;
      }

      const value = this.clampStopConditionValue(valueInput.value, max);
      valueInput.value = String(value);
      this.onPlanFieldChange?.(field, value);
    });

    valueInput.addEventListener('change', () => {
      if (!enabledInput.checked) return;
      const value = this.clampStopConditionValue(valueInput.value, max);
      valueInput.value = String(value);
      this.onPlanFieldChange?.(field, value);
    });
  }

  private renderStopConditionControl(
    enabledInput: HTMLInputElement,
    valueInput: HTMLInputElement,
    fieldsEl: HTMLElement,
    value: number | undefined,
    max: number,
  ): void {
    const enabled = value !== undefined && value >= 1;
    enabledInput.checked = enabled;
    fieldsEl.hidden = !enabled;
    valueInput.disabled = !enabled;
    valueInput.value = String(
      enabled
        ? this.clampStopConditionValue(String(value), max)
        : 1,
    );
  }

  private clampStopConditionValue(value: string, max: number): number {
    const parsed = parseInt(value, 10);
    return Math.min(max, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
  }

  getPresetName(): string {
    return this.presetNameInput.value.trim();
  }

  setPresetName(name: string): void {
    this.presetNameInput.value = name;
  }

  focusPresetName(): void {
    this.presetNameInput.focus();
  }

  private eventChapterValue(
    event: string,
    chapter: EventChapter,
  ): string {
    return `event:${event}:${chapter}`;
  }

  private parseEventChapter(
    value: string,
  ): { event: string; chapter: EventChapter } | null {
    const match = value.match(/^event:([^:]+):(E|H)$/);
    if (!match) return null;
    return {
      event: match[1],
      chapter: match[2] === 'E' ? 'E' : 'H',
    };
  }

  private eventMapsFor(chapterValue: string): string[] {
    const selection = this.parseEventChapter(chapterValue);
    if (!selection) return [];
    const event = this.eventMapCatalog.find(
      entry => entry.event === selection.event,
    );
    return event?.chapters[selection.chapter] ?? [];
  }

  private emitMapChange(): void {
    if (this.mapSelect.disabled || !this.mapSelect.value) return;
    const chapter = this.chapterSelect.value;
    const map = this.parseEventChapter(chapter)
      ? this.mapSelect.value
      : Number(this.mapSelect.value);
    this.onMapChange?.(chapter, map);
  }

  private eventMapLabel(map: string): string {
    const match = map.match(/^(\d+)([ab])$/);
    if (!match) return map;
    return `${match[1]} ${match[2] === 'a' ? 'α' : 'β'}`;
  }

  private renderEventChapterOptions(vo: PlanPreviewViewObject): void {
    this.chapterSelect
      .querySelectorAll('option[data-event-map]')
      .forEach(option => option.remove());

    const entries = [...this.eventMapCatalog];
    if (
      vo.event
      && !entries.some(entry => entry.event === vo.event)
    ) {
      const chapter = String(vo.chapter).toUpperCase();
      entries.push({
        event: vo.event,
        chapters: {
          E: chapter === 'E' ? [String(vo.map)] : [],
          H: chapter === 'H' ? [String(vo.map)] : [],
        },
      });
    }

    for (const entry of entries) {
      const chapters: EventChapter[] = ['E', 'H'];
      for (const chapter of chapters) {
        if (entry.chapters[chapter].length === 0) continue;
        const option = document.createElement('option');
        option.value = this.eventChapterValue(entry.event, chapter);
        option.textContent = `${entry.event} ${chapter}`;
        option.title =
          `活动 ${entry.event} ${chapter === 'E' ? '简单' : '困难'}`;
        option.dataset.eventMap = 'true';
        this.chapterSelect.appendChild(option);
      }
    }
  }

  private updateMapOptions(
    chapter: string,
    selectedMap?: number | string,
  ): void {
    const eventMaps = this.eventMapsFor(chapter);
    if (this.parseEventChapter(chapter)) {
      const selected = selectedMap === undefined
        ? eventMaps[0] ?? ''
        : String(selectedMap);
      const maps = !selected || eventMaps.includes(selected)
        ? eventMaps
        : [...eventMaps, selected];
      this.mapSelect.replaceChildren(...maps.map((map) => {
        const option = document.createElement('option');
        option.value = map;
        option.textContent = this.eventMapLabel(map);
        return option;
      }));
      this.mapSelect.value = selected;
      this.mapSelect.disabled = maps.length === 0;
      return;
    }

    const count = MAP_COUNT_BY_CHAPTER[chapter] ?? 1;
    this.mapSelect.replaceChildren(...Array.from({ length: count }, (_, index) => {
      const option = document.createElement('option');
      option.value = String(index + 1);
      option.textContent = String(index + 1);
      return option;
    }));
    const selected = Number(selectedMap ?? 1);
    this.mapSelect.value = String(
      Math.min(Math.max(Number.isFinite(selected) ? selected : 1, 1), count),
    );
    this.mapSelect.disabled = false;
  }

  private renderMapSelection(vo: PlanPreviewViewObject): void {
    this.eventMapCatalog = vo.eventMaps;
    this.renderEventChapterOptions(vo);
    const activityChapter = String(vo.chapter).toUpperCase();
    if (
      vo.event
      && (activityChapter === 'E' || activityChapter === 'H')
    ) {
      const chapter: EventChapter =
        activityChapter === 'E' ? 'E' : 'H';
      const chapterValue = this.eventChapterValue(vo.event, chapter);
      this.chapterSelect.value = chapterValue;
      this.updateMapOptions(chapterValue, vo.map);
      return;
    }

    const chapter = String(vo.chapter);
    if (chapter in MAP_COUNT_BY_CHAPTER) {
      this.chapterSelect.value = chapter;
      this.updateMapOptions(chapter, vo.map);
      return;
    }

    this.chapterSelect.value = '1';
    this.updateMapOptions('1', 1);
    this.mapSelect.disabled = true;
  }

  /* ── 节点编辑（委托 + 跨视图协调） ── */

  showNodeEditor(
    nodeId: string,
    nodeType: MapNodeType,
    args: NodeEditorArgs,
    mapNight = false,
  ): void {
    this.fleetPresetView.hideSelector();
    this.nodeEditor.show(nodeId, nodeType, args, mapNight);
  }

  hideNodeEditor(): void {
    this.nodeEditor.hide();
    this.mapView.clearSelection();
  }

  resetNodeEditorDrafts(): void {
    this.nodeEditor.resetDrafts();
  }

  collectNodeEditorValues(): NodeEditorValues {
    return this.nodeEditor.collectValues();
  }

  /* ── 编队预设 / 泡澡修理 ── */

  renderFleetPresetSelector(
    viewObject: PlanFleetPresetSelectorViewObject,
  ): void {
    this.fleetPresetView.render(viewObject);
  }

  /** 当前没有生产入口引用，保留给泡澡维修配置后续接入。 */
  getBathRepairConfig(): BathRepairConfig | undefined {
    return this.fleetPresetView.getBathRepairConfig();
  }

  /* ── 预设详情面板 ── */

  showPresetDetail(): void {
    const presetEl = document.getElementById('task-preset-detail');
    if (this.detailEl) this.detailEl.style.display = 'none';
    const tplCard = document.getElementById('template-library-card');
    if (tplCard) tplCard.style.display = 'none';
    if (presetEl) presetEl.style.display = '';
  }

  hidePresetDetail(): void {
    const presetEl = document.getElementById('task-preset-detail');
    if (presetEl) presetEl.style.display = 'none';
    const tplCard = document.getElementById('template-library-card');
    if (tplCard) tplCard.style.display = '';
  }

  fillPresetDetailForm(vo: PresetDetailVO): void {
    document.getElementById('tp-name')!.textContent = vo.name;
    document.getElementById('tp-type-badge')!.textContent = vo.typeLabel;

    for (const id of ['tp-cfg-exercise', 'tp-cfg-campaign', 'tp-cfg-decisive', 'tp-cfg-fight']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }

    switch (vo.taskType) {
      case 'exercise': {
        document.getElementById('tp-cfg-exercise')!.style.display = '';
        (document.getElementById('tp-exercise-fleet') as HTMLSelectElement).value = String(vo.exerciseFleetId ?? 1);
        const cb = document.getElementById('tp-fleet-enable-ex') as HTMLInputElement;
        cb.checked = false;
        document.getElementById('tp-fleet-grid-ex')!.style.display = 'none';
        document.querySelectorAll<HTMLInputElement>('.tp-ship-ex').forEach(inp => { inp.value = ''; });
        break;
      }
      case 'campaign':
        document.getElementById('tp-cfg-campaign')!.style.display = '';
        (document.getElementById('tp-campaign-name') as HTMLSelectElement).value = vo.campaignName ?? '困难潜艇';
        break;
      case 'decisive':
        document.getElementById('tp-cfg-decisive')!.style.display = '';
        (document.getElementById('tp-decisive-chapter') as HTMLSelectElement).value = String(vo.chapter ?? 6);
        (document.getElementById('tp-decisive-level1') as HTMLTextAreaElement).value = (vo.level1 ?? []).join('\n');
        (document.getElementById('tp-decisive-level2') as HTMLTextAreaElement).value = (vo.level2 ?? []).join('\n');
        (document.getElementById('tp-decisive-flagship') as HTMLTextAreaElement).value = (vo.flagshipPriority ?? []).join('\n');
        (document.getElementById('tp-decisive-quick-repair') as HTMLInputElement).checked = vo.useQuickRepair !== false;
        break;
      case 'normal_fight':
      case 'event_fight':
        document.getElementById('tp-cfg-fight')!.style.display = '';
        (document.getElementById('tp-fight-plan') as HTMLInputElement).value = vo.planId ?? '';
        (document.getElementById('tp-fight-fleet') as HTMLSelectElement).value = String(vo.fleetId ?? 1);
        break;
    }

    const timesGroup = document.getElementById('tp-times-group')!;
    const timesEl = document.getElementById('tp-times') as HTMLInputElement;
    if (vo.taskType === 'exercise') {
      timesGroup.style.display = 'none';
    } else {
      timesGroup.style.display = '';
      timesEl.value = String(vo.times ?? 1);
      timesEl.disabled = vo.taskType === 'decisive';
    }
  }

  collectPresetFormValues(): PresetFormValues {
    const parseLines = (id: string) =>
      (document.getElementById(id) as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      times: Math.max(1, parseInt((document.getElementById('tp-times') as HTMLInputElement).value, 10) || 1),
      exerciseFleetId: parseInt((document.getElementById('tp-exercise-fleet') as HTMLSelectElement).value),
      campaignName: (document.getElementById('tp-campaign-name') as HTMLSelectElement).value,
      chapter: parseInt((document.getElementById('tp-decisive-chapter') as HTMLSelectElement).value),
      level1: parseLines('tp-decisive-level1'),
      level2: parseLines('tp-decisive-level2'),
      flagshipPriority: parseLines('tp-decisive-flagship'),
      useQuickRepair: (document.getElementById('tp-decisive-quick-repair') as HTMLInputElement).checked,
      planId: (document.getElementById('tp-fight-plan') as HTMLInputElement).value || undefined,
      fightFleetId: parseInt((document.getElementById('tp-fight-fleet') as HTMLSelectElement).value),
    };
  }

  /* ── 视图切换 ── */

  showPlanView(): void {
    const tplCard = document.getElementById('template-library-card');
    const presetEl = document.getElementById('task-preset-detail');
    if (tplCard) tplCard.style.display = 'none';
    if (presetEl) presetEl.style.display = 'none';
  }
}
