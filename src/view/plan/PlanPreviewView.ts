/**
 * PlanPreviewView —— 方案预览 Facade。
 * 持有 MapView / NodeEditorView / FleetPresetView 三个子视图，
 * 对外 API 保持不变，Controller 无需感知内部拆分。
 */
import type { PlanPreviewViewObject, MapNodeType, FleetPresetVO, PresetDetailVO, PresetFormValues, NewPlanFormValues } from '../../types/view';
import type { BathRepairConfig } from '../../types/model';
import { MapView } from './MapView';
import { NodeEditorView } from './NodeEditorView';
import { FleetPresetView } from './FleetPresetView';

export class PlanPreviewView {
  private emptyEl: HTMLElement;
  private detailEl: HTMLElement;
  private mapNameEl: HTMLElement;
  private fileNameEl: HTMLElement;
  private repairSelect: HTMLSelectElement;
  private fightCondSelect: HTMLSelectElement;
  private fleetSelect: HTMLSelectElement;
  private commentEl: HTMLElement;
  private timesInput: HTMLInputElement;
  private gapInput: HTMLInputElement;
  private lootGeInput: HTMLInputElement;
  private shipGeInput: HTMLInputElement;
  private taskConfigEl: HTMLElement;

  private mapView: MapView;
  private nodeEditor: NodeEditorView;
  private fleetPresetView: FleetPresetView;

  onNodeClick?: (nodeId: string) => void;
  onPlanFieldChange?: (field: 'repair_mode' | 'fight_condition' | 'fleet_id' | 'times' | 'gap' | 'loot_count_ge' | 'ship_count_ge', value: number | undefined) => void;
  onCommentChange?: (comment: string) => void;

  set onFleetPresetChange(fn: ((action: 'add' | 'edit' | 'delete', index: number, preset?: FleetPresetVO) => void) | undefined) {
    this.fleetPresetView.onFleetPresetChange = fn;
  }

  get selectedFleetPresetIndices(): Set<number> {
    return this.fleetPresetView.selectedFleetPresetIndices;
  }
  set selectedFleetPresetIndices(val: Set<number>) {
    this.fleetPresetView.selectedFleetPresetIndices = val;
  }

  constructor() {
    this.emptyEl = document.getElementById('plan-empty')!;
    this.detailEl = document.getElementById('plan-detail')!;
    this.mapNameEl = document.getElementById('plan-map-name')!;
    this.fileNameEl = document.getElementById('plan-file-name')!;
    this.repairSelect = document.getElementById('plan-edit-repair') as HTMLSelectElement;
    this.fightCondSelect = document.getElementById('plan-edit-fight-cond') as HTMLSelectElement;
    this.fleetSelect = document.getElementById('plan-edit-fleet') as HTMLSelectElement;
    this.commentEl = document.getElementById('plan-comment')!;
    this.timesInput = document.getElementById('plan-edit-times') as HTMLInputElement;
    this.gapInput = document.getElementById('plan-edit-gap') as HTMLInputElement;
    this.lootGeInput = document.getElementById('plan-edit-loot-ge') as HTMLInputElement;
    this.shipGeInput = document.getElementById('plan-edit-ship-ge') as HTMLInputElement;
    this.taskConfigEl = document.getElementById('plan-task-config')!;

    this.mapView = new MapView();
    this.nodeEditor = new NodeEditorView();
    this.fleetPresetView = new FleetPresetView();

    this.mapView.onNodeClick = (nodeId) => this.onNodeClick?.(nodeId);

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
    this.lootGeInput.addEventListener('change', () => {
      const v = parseInt(this.lootGeInput.value, 10);
      this.onPlanFieldChange?.('loot_count_ge', v >= 0 ? v : undefined);
    });
    this.shipGeInput.addEventListener('change', () => {
      const v = parseInt(this.shipGeInput.value, 10);
      this.onPlanFieldChange?.('ship_count_ge', v >= 0 ? v : undefined);
    });

    // 点击注释区域进入编辑模式
    this.commentEl.addEventListener('click', () => {
      this.startCommentEdit();
    });
  }

  /* ── 渲染 ── */

  render(vo: PlanPreviewViewObject | null): void {
    if (!vo) {
      this.emptyEl.style.display = '';
      this.detailEl.style.display = 'none';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.detailEl.style.display = 'flex';

    this.mapNameEl.textContent = vo.mapName;
    this.fileNameEl.textContent = vo.fileName;
    this.repairSelect.value = String(vo.repairModeValue);
    this.fightCondSelect.value = String(vo.fightConditionValue);
    this.fleetSelect.value = String(vo.fleetId);
    this.commentEl.textContent = vo.comment || '';

    this.timesInput.value = String(vo.times ?? 1);
    this.gapInput.value = String(vo.gap ?? 0);
    this.lootGeInput.value = vo.lootCountGe != null ? String(vo.lootCountGe) : '-1';
    this.shipGeInput.value = vo.shipCountGe != null ? String(vo.shipCountGe) : '-1';

    this.fleetPresetView.render(vo.fleetPresets);
    this.mapView.renderNodes(vo.allNodes, vo.selectedNodes, vo.edges);
  }

  renderFleetPresets(presets?: FleetPresetVO[]): void {
    this.fleetPresetView.render(presets);
  }

  /* ── 节点编辑（委托 + 跨视图协调） ── */

  showNodeEditor(nodeId: string, nodeType: MapNodeType, args: { enabled: boolean; formation: number; night: boolean; longMissileSupport: boolean; proceed: boolean; detour: boolean; canDetour: boolean; slWhenDetourFails: boolean; isEndpoint: boolean; enemyRules: string }, mapNight = false): void {
    this.nodeEditor.show(nodeId, nodeType, args, mapNight);
    this.fleetPresetView.hideSection();
    this.taskConfigEl.style.display = 'none';
  }

  showNodeInfo(nodeId: string, nodeType: MapNodeType): void {
    this.nodeEditor.showInfo(nodeId, nodeType, () => this.hideNodeEditor());
    this.fleetPresetView.hideSection();
    this.taskConfigEl.style.display = 'none';
  }

  hideNodeEditor(): void {
    this.nodeEditor.hide();
    this.fleetPresetView.showSection();
    this.taskConfigEl.style.display = '';
    this.mapView.clearSelection();
  }

  collectNodeEditorValues(): { enabled: boolean; isEndpoint: boolean; formation: number; night: boolean; longMissileSupport: boolean; proceed: boolean; detour: boolean; slWhenDetourFails: boolean; rulesText: string } {
    return this.nodeEditor.collectValues();
  }

  /* ── 编队预设 / 泡澡修理 ── */

  getSelectedPresets(): FleetPresetVO[] {
    return this.fleetPresetView.getSelectedPresets();
  }

  getBathRepairConfig(): BathRepairConfig | undefined {
    return this.fleetPresetView.getBathRepairConfig();
  }

  /* ── 注释编辑 ── */

  private startCommentEdit(): void {
    const currentText = this.commentEl.textContent || '';
    const textarea = document.createElement('textarea');
    textarea.className = 'plan-comment-editing';
    textarea.value = currentText;
    textarea.rows = Math.max(2, currentText.split('\n').length + 1);

    this.commentEl.style.display = 'none';
    this.commentEl.parentElement!.insertBefore(textarea, this.commentEl.nextSibling);
    textarea.focus();

    const commit = () => {
      const newText = textarea.value.trim();
      this.commentEl.textContent = newText;
      this.commentEl.style.display = '';
      textarea.remove();
      this.onCommentChange?.(newText);
    };

    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.commentEl.style.display = '';
        textarea.remove();
      }
    });
  }

  /* ── 预设详情面板 ── */

  showPresetDetail(): void {
    const presetEl = document.getElementById('task-preset-detail');
    if (this.emptyEl) this.emptyEl.style.display = 'none';
    if (this.detailEl) this.detailEl.style.display = 'none';
    const tplCard = document.getElementById('template-library-card');
    if (tplCard) tplCard.style.display = 'none';
    if (presetEl) presetEl.style.display = '';
  }

  hidePresetDetail(): void {
    const presetEl = document.getElementById('task-preset-detail');
    if (presetEl) presetEl.style.display = 'none';
    if (this.emptyEl) this.emptyEl.style.display = '';
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

  /* ── 新建方案对话框 ── */

  getNewPlanFormValues(): NewPlanFormValues {
    return {
      chapter: (document.getElementById('new-plan-chapter') as HTMLSelectElement).value,
      map: parseInt((document.getElementById('new-plan-map') as HTMLSelectElement).value, 10),
    };
  }

  showNewPlanDialog(): void {
    document.getElementById('new-plan-dialog')!.style.display = '';
  }

  hideNewPlanDialog(): void {
    document.getElementById('new-plan-dialog')!.style.display = 'none';
  }

  /* ── 视图切换 ── */

  showPlanView(): void {
    const tplCard = document.getElementById('template-library-card');
    const presetEl = document.getElementById('task-preset-detail');
    if (tplCard) tplCard.style.display = 'none';
    if (presetEl) presetEl.style.display = 'none';
  }

  setPlansDir(dir: string): void {
    const hintEl = document.getElementById('plans-dir-hint');
    if (hintEl) {
      hintEl.textContent = dir;
      hintEl.title = dir;
    }
  }
}
