/**
 * PlanController —— 方案 & 任务预设子控制器（瘦身版）。
 * 核心逻辑委托给 importExport / presetFlow / nodeEditor / rendering 模块。
 */
import { PlanPreviewView } from '../../view/plan/PlanPreviewView';
import type { PlanModel } from '../../model/PlanModel';
import type { CombatPlanReq, NodeDecisionReq, NormalFightReq } from '../../types/api';
import type { Scheduler } from '../../model/scheduler';
import { TaskPriority } from '../../model/scheduler';
import type { NodeArgs, TaskPreset } from '../../types/model';
import { getNodeType, isNightNode } from '../../model/MapDataLoader';
import type { MapData } from '../../model/MapDataLoader';
import { toBackendName, resolveFleetPreset, shipSlotLabel } from '../../data/shipData';
import { Logger } from '../../utils/Logger';
import { importPlanFlow, exportPlanFlow, confirmNewPlanFlow, type PlanSetters } from './importExport';
import { importTaskPresetFlow, showPresetDetailFlow, closePresetDetailFlow, executePresetFlow, type PresetState } from './presetFlow';
import { saveNodeEditorValues } from './nodeEditor';
import { buildPlanPreviewVO } from './rendering';

export interface PlanHost {
  readonly scheduler: Scheduler;
  plansDir: string;
  renderMain(): void;
  switchPage(page: string): void;
}

export class PlanController {
  private currentPlan: PlanModel | null = null;
  private currentMapData: MapData | null = null;
  private editingNodeId: string | null = null;
  private currentPreset: TaskPreset | null = null;
  private currentPresetFilePath = '';

  constructor(
    private readonly planView: PlanPreviewView,
    readonly host: PlanHost,
  ) {}

  // ── 公共访问器 ──

  getCurrentPlan(): PlanModel | null { return this.currentPlan; }

  setCurrentPlan(plan: PlanModel, mapData: MapData | null): void {
    this.currentPlan = plan;
    this.currentMapData = mapData;
  }

  getCurrentPresetInfo(): { preset: TaskPreset; filePath: string } | null {
    return this.currentPreset && this.currentPresetFilePath
      ? { preset: this.currentPreset, filePath: this.currentPresetFilePath }
      : null;
  }

  // ── PresetState 适配（供 presetFlow 函数读写） ──

  private get presetState(): PresetState {
    // 返回可变引用，presetFlow 函数直接读写 controller 字段
    const self = this;
    return {
      get currentPreset() { return self.currentPreset; },
      set currentPreset(v) { self.currentPreset = v; },
      get currentPresetFilePath() { return self.currentPresetFilePath; },
      set currentPresetFilePath(v) { self.currentPresetFilePath = v; },
    };
  }

  private get planSetters(): PlanSetters {
    return {
      setCurrentPlan: (plan) => { this.currentPlan = plan; },
      setCurrentMapData: (mapData) => { this.currentMapData = mapData; },
      renderPlanPreview: () => this.renderPlanPreview(),
      importTaskPreset: (preset, fp) => this.importTaskPreset(preset, fp),
    };
  }

  // ════════════════════════════════════════
  // 事件绑定
  // ════════════════════════════════════════

  bindActions(): void {
    document.getElementById('btn-import-plan')?.addEventListener('click', () => this.importPlan());
    document.getElementById('btn-import-plan-2')?.addEventListener('click', () => this.importPlan());
    document.getElementById('btn-close-plan')?.addEventListener('click', () => this.closePlan());
    document.getElementById('btn-execute-plan')?.addEventListener('click', () => this.executePlan());

    // 节点编辑
    this.planView.onNodeClick = (nodeId) => {
      if (!this.currentPlan) return;
      const mapData = this.currentMapData;
      const nodeType = mapData ? getNodeType(mapData, nodeId) : 'Normal';
      const NON_COMBAT: Set<string> = new Set(['Start', 'Resource', 'Penalty']);
      if (NON_COMBAT.has(nodeType)) {
        this.editingNodeId = null;
        this.planView.showNodeInfo(nodeId, nodeType);
        return;
      }
      this.editingNodeId = nodeId;
      const args = this.currentPlan.getNodeArgs(nodeId);
      const rulesText = (args.enemy_rules ?? []).map(r => `${r[0]}, ${r[1]}`).join('\n');
      const mapNight = this.currentMapData ? isNightNode(this.currentMapData, nodeId) : false;
      this.planView.showNodeEditor(nodeId, nodeType as any, {
        formation: args.formation ?? 2,
        night: args.night ?? false,
        proceed: args.proceed ?? true,
        enemyRules: rulesText,
      }, mapNight);
    };

    document.getElementById('btn-node-editor-close')?.addEventListener('click', () => {
      this.editingNodeId = null;
      this.planView.hideNodeEditor();
    });

    document.getElementById('btn-node-edit-save')?.addEventListener('click', () => {
      if (saveNodeEditorValues(this.planView, this.currentPlan, this.editingNodeId)) {
        this.editingNodeId = null;
        this.renderPlanPreview();
      }
    });

    document.getElementById('btn-export-plan')?.addEventListener('click', () =>
      exportPlanFlow(this.currentPlan, this.host, () => this.renderPlanPreview()));

    document.getElementById('btn-new-plan')?.addEventListener('click', () => this.planView.showNewPlanDialog());
    document.getElementById('btn-new-plan-confirm')?.addEventListener('click', () =>
      confirmNewPlanFlow(this.planView, this.host, this.planSetters));
    document.getElementById('btn-new-plan-cancel')?.addEventListener('click', () => this.planView.hideNewPlanDialog());

    document.getElementById('new-plan-chapter')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      const mapSelect = document.getElementById('new-plan-map') as HTMLSelectElement;
      const count = val === 'Ex' ? 12 : 6;
      mapSelect.innerHTML = Array.from({ length: count }, (_, i) =>
        `<option value="${i + 1}">${i + 1}</option>`).join('');
    });

    this.planView.onPlanFieldChange = (field, value) => {
      if (!this.currentPlan) return;
      if (field === 'repair_mode') this.currentPlan.data.repair_mode = value as number;
      else if (field === 'fight_condition') this.currentPlan.data.fight_condition = value as number;
      else if (field === 'fleet_id') this.currentPlan.data.fleet_id = value as number;
      else if (field === 'times') this.currentPlan.data.times = value as number;
      else if (field === 'gap') this.currentPlan.data.gap = value as number;
      else if (field === 'loot_count_ge' || field === 'ship_count_ge') {
        if (!this.currentPlan.data.stop_condition) this.currentPlan.data.stop_condition = {};
        this.currentPlan.data.stop_condition[field] = value as number | undefined;
        const sc = this.currentPlan.data.stop_condition;
        if (sc.loot_count_ge == null && sc.ship_count_ge == null) this.currentPlan.data.stop_condition = undefined;
      }
      if (this.currentPlan.fileName) {
        window.electronBridge?.saveFile(this.currentPlan.fileName, this.currentPlan.toYaml());
      }
    };

    this.planView.onFleetPresetChange = (action, index, preset) => {
      if (!this.currentPlan) return;
      if (!this.currentPlan.data.fleet_presets) this.currentPlan.data.fleet_presets = [];
      const presets = this.currentPlan.data.fleet_presets;
      if (action === 'add' && preset) presets.push({ name: preset.name, ships: preset.ships });
      else if (action === 'edit' && preset && index >= 0 && index < presets.length) presets[index] = { name: preset.name, ships: preset.ships };
      else if (action === 'delete' && index >= 0 && index < presets.length) presets.splice(index, 1);
      if (this.currentPlan.fileName) window.electronBridge?.saveFile(this.currentPlan.fileName, this.currentPlan.toYaml());
      this.planView.renderFleetPresets(presets.map(p => ({ name: p.name, ships: p.ships })));
    };

    this.planView.onCommentChange = (comment) => {
      if (!this.currentPlan) return;
      this.currentPlan.comment = comment;
      if (this.currentPlan.fileName) window.electronBridge?.saveFile(this.currentPlan.fileName, this.currentPlan.toYaml());
    };
  }

  // ── 委托方法 ──

  async importPlan(): Promise<void> {
    return importPlanFlow(this.planView, this.host, this.planSetters);
  }

  importTaskPreset(preset: TaskPreset, filePath: string): void {
    importTaskPresetFlow(preset, filePath, this.planView, this.host, this.presetState);
  }

  closePresetDetail(): void {
    closePresetDetailFlow(this.planView, this.presetState);
  }

  executePreset(): void {
    executePresetFlow(this.planView, this.host, this.presetState);
  }

  closePlan(): void {
    this.currentPlan = null;
    this.currentMapData = null;
    this.editingNodeId = null;
    this.planView.render(null);
    this.planView.hideNodeEditor();
    this.planView.hidePresetDetail();
  }

  renderPlanPreview(): void {
    if (!this.currentPlan) { this.planView.render(null); return; }
    const vo = buildPlanPreviewVO(this.currentPlan, this.currentMapData);
    this.planView.render(vo);
    this.planView.showPlanView();
  }

  // ── 执行方案 ──

  private toNodeDecisionReq(args?: NodeArgs): NodeDecisionReq | undefined {
    if (!args) return undefined;
    const mapped: NodeDecisionReq = {};
    if (args.formation != null) mapped.formation = args.formation;
    if (args.night != null) mapped.night = args.night;
    if (args.proceed != null) mapped.proceed = args.proceed;
    if (args.proceed_stop != null) mapped.proceed_stop = args.proceed_stop;
    if (args.enemy_rules && args.enemy_rules.length > 0) {
      mapped.enemy_rules = args.enemy_rules.map(([cond, action]) => [String(cond), String(action)]);
    }
    return Object.keys(mapped).length > 0 ? mapped : undefined;
  }

  private buildInlinePlan(plan: PlanModel): CombatPlanReq {
    const inlinePlan: CombatPlanReq = {
      chapter: plan.data.chapter,
      map: plan.data.map,
      selected_nodes: [...plan.data.selected_nodes],
    };

    if (plan.data.fleet_id != null) inlinePlan.fleet_id = plan.data.fleet_id;
    if (plan.data.repair_mode != null) {
      inlinePlan.repair_mode = Array.isArray(plan.data.repair_mode)
        ? [...plan.data.repair_mode]
        : [plan.data.repair_mode];
    }
    if (plan.data.fight_condition != null) inlinePlan.fight_condition = plan.data.fight_condition;

    const nodeDefaults = this.toNodeDecisionReq(plan.data.node_defaults);
    if (nodeDefaults) inlinePlan.node_defaults = nodeDefaults;

    if (plan.data.node_args) {
      const nodeArgs: Record<string, NodeDecisionReq> = {};
      for (const [nodeId, nodeArg] of Object.entries(plan.data.node_args)) {
        const mapped = this.toNodeDecisionReq(nodeArg);
        if (mapped) nodeArgs[nodeId] = mapped;
      }
      if (Object.keys(nodeArgs).length > 0) inlinePlan.node_args = nodeArgs;
    }

    return inlinePlan;
  }

  private executePlan(): void {
    if (!this.currentPlan) return;
    const plan = this.currentPlan;
    const times = plan.data.times ?? 1;
    const stopCondition = plan.data.stop_condition;
    const selectedPresets = this.planView.getSelectedPresets();
    const firstPreset = selectedPresets.length > 0 ? selectedPresets[0] : undefined;

    const req: NormalFightReq = { type: 'normal_fight', times: 1, gap: plan.data.gap ?? 0 };

    if (plan.fileName?.trim()) {
      req.plan_id = plan.fileName;
    } else {
      req.plan = this.buildInlinePlan(plan);
      Logger.warn('当前方案尚未导出 YAML，将以内存方案直接执行');
    }

    if (firstPreset && firstPreset.ships.length > 0) {
      const resolved = resolveFleetPreset(firstPreset.ships);
      if (resolved.length > 0) {
        if (!req.plan) req.plan = {};
        req.plan.fleet = resolved.map(toBackendName);
        req.plan.fleet_id = plan.data.fleet_id;
      }
    }

    const bathRepairConfig = this.planView.getBathRepairConfig();
    const fleetId = plan.data.fleet_id ?? 1;
    const fleetPresets = selectedPresets.length > 1 ? selectedPresets : undefined;
    const currentPresetIndex = fleetPresets ? 0 : undefined;

    this.host.scheduler.addTask(
      plan.mapName, 'normal_fight', req, TaskPriority.USER_TASK, times,
      stopCondition, bathRepairConfig, fleetId, fleetPresets, currentPresetIndex,
    );
    const planRef = req.plan_id ?? '(inline-unsaved)';
    Logger.debug(`executePlan: map=${plan.mapName} plan_id=${planRef} times=${times} gap=${req.gap}${firstPreset ? ' fleet=' + firstPreset.ships.map(s => shipSlotLabel(s)).join(',') : ''}${fleetPresets ? ' rotation=' + fleetPresets.length + '套' : ''}`);

    this.planView.selectedFleetPresetIndices.clear();
    this.host.switchPage('main');
    this.host.renderMain();

    if (stopCondition) {
      const parts: string[] = [`×${times}`];
      if (stopCondition.loot_count_ge) parts.push(`战利品≥${stopCondition.loot_count_ge}时停止`);
      if (stopCondition.ship_count_ge) parts.push(`舰船≥${stopCondition.ship_count_ge}时停止`);
      Logger.info(`任务「${plan.mapName}」已加入队列 (${parts.join(', ')})`);
    }
  }
}
