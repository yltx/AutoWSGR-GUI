/** 协调作战方案加载、预览、编辑、保存和任务执行。 */
/**
 * 编排受管方案、任务预设、节点编辑和计划预览。
 */
import { PlanPreviewView } from '../../view/plan/PlanPreviewView';
import { PlanModel } from '../../model/PlanModel';
import type {
  EventMapCatalogEntry,
  FleetPreset,
  NormalFightTaskConfig,
  TaskPreset,
} from '../../types/model.js';
import {
  getNodeType,
  isNightNode,
  isDetourNode,
  isTerminalNode,
  loadEventMapCatalog,
  loadMapData,
  loadEventMapData,
} from '../../model/MapDataLoader';
import type { MapData } from '../../model/MapDataLoader';
import type {
  ManagedBattlePlanSelection,
  PlanPresetSource,
  ShipLibraryShip,
  UserTeamPlan,
} from '../../types/ipc.js';
import { taskPresetCodec } from '../../shared/taskPreset';
import { BattlePlanLoaderView } from '../../view/plan/BattlePlanLoaderView';
import { Logger } from '../../utils/Logger';
import {
  showAlert,
  showConfirm,
  showSaveSuccess,
  showWarningNotice,
} from '../../view/shared/DialogHelper';
import { importTaskPresetFlow, closePresetDetailFlow, executePresetFlow, type PresetState } from './presetFlow';
import { jsonCodec, parseYamlRecord } from '../../adapter';
import {
  getManagedCombatPlanRepository,
  type ManagedCombatPlanRepository,
} from '../../adapter/IpcAdapter';
import { saveNodeEditorValues } from './nodeEditor';
import { buildPlanPreviewVO } from './rendering';
import { BattlePlanLoaderController } from './BattlePlanLoaderController';
import type { LootAutomationPlan } from '../../shared/lootPlans.js';
import {
  PlanFleetPresetController,
  type PlanFleetPresetRepository,
} from './PlanFleetPresetController.js';
import { initialSelectedNodesForNewPlan } from './selectedNodes';
import type { PlanHost } from '../contracts.js';

export class PlanController {
  private currentPlan: PlanModel | null = null;
  private currentMapData: MapData | null = null;
  private editingNodeId: string | null = null;
  private currentPreset: TaskPreset | null = null;
  private currentPresetFilePath = '';
  private currentPresetSource: PlanPresetSource = 'user';
  private mapLoadVersion = 0;
  private planPresetName = '';
  private currentManagedPlanFile: string | null = null;
  private currentPlanSource: PlanPresetSource = 'user';
  private savedPlanSnapshot = '';
  private eventMapCatalog: EventMapCatalogEntry[] = [];
  private readonly battlePlanLoader: BattlePlanLoaderController;
  private readonly fleetPresetController: PlanFleetPresetController;

  constructor(
    private readonly planView: PlanPreviewView,
    readonly host: PlanHost,
    fleetPresetRepository?: PlanFleetPresetRepository,
    private readonly managedPlans: ManagedCombatPlanRepository | undefined =
      getManagedCombatPlanRepository(),
  ) {
    this.fleetPresetController = new PlanFleetPresetController(
      fleetPresetRepository,
    );
    this.battlePlanLoader = new BattlePlanLoaderController(
      new BattlePlanLoaderView(),
      {
        getCurrentPlanIdentity: () => ({
          file: this.currentManagedPlanFile,
          source: this.currentPlanSource,
        }),
        openManagedPlan: (file, source) => (
          this.openManagedPlan(file, source)
        ),
      },
      this.managedPlans,
    );
  }

  // ── 公共访问器 ──

  getCurrentPlan(): PlanModel | null { return this.currentPlan; }

  async synchronizeTeamPlan(
    previousName: string | null,
    plan: UserTeamPlan,
  ): Promise<void> {
    await this.fleetPresetController.load();
    if (!this.currentPlan) {
      this.renderFleetPresetSelector();
      return;
    }

    const hadUnsavedChanges = this.hasUnsavedPlanChanges();
    const previousNameForCurrentPlan = this.currentPlanSource === 'user'
      ? previousName
      : null;
    const synchronized = this.fleetPresetController.synchronizePreset(
      this.currentPlan.data.fleet_presets ?? [],
      plan.name,
      previousNameForCurrentPlan,
      'user',
    );
    if (!synchronized) {
      this.renderFleetPresetSelector();
      return;
    }

    this.applyFleetPresets(synchronized);
    if (!hadUnsavedChanges) {
      this.savedPlanSnapshot = this.planDraftSnapshot();
    }
    this.renderPlanPreview();
  }

  pickManagedBattlePlan(): Promise<ManagedBattlePlanSelection | null> {
    return this.battlePlanLoader.pick('task-list');
  }

  async pickManagedBattlePlanForQueue(): Promise<ManagedBattlePlanSelection | null> {
    if (this.hasUnsavedPlanChanges()) {
      const confirmed = await showConfirm(
        '未保存修改',
        '当前出征规划存在未保存修改，是否先保存再选择加入队列？',
      );
      if (!confirmed || !await this.savePlan()) return null;
    }
    return this.battlePlanLoader.pick('queue');
  }

  pickManagedBattlePlanForAutomation(
    currentTask?: NormalFightTaskConfig,
  ): Promise<ManagedBattlePlanSelection | null> {
    return this.battlePlanLoader.pick('automation', currentTask);
  }

  pickManagedLootPlans(
    currentPlans: readonly LootAutomationPlan[],
  ): Promise<LootAutomationPlan[] | null> {
    return this.battlePlanLoader.pickLootPlans(currentPlans);
  }

  setCurrentPlan(plan: PlanModel, mapData: MapData | null): void {
    this.editingNodeId = null;
    this.planView.resetNodeEditorDrafts();
    this.planView.hideNodeEditor();
    this.mapLoadVersion++;
    this.currentPlan = plan;
    this.currentMapData = mapData;
    this.planPresetName = this.planNameFromPath(plan.fileName);
    this.currentManagedPlanFile = null;
    this.currentPlanSource = 'user';
    this.savedPlanSnapshot = this.planDraftSnapshot();
    this.refreshFleetPresetCatalog();
  }

  private async ensureEventMapCatalog(): Promise<void> {
    this.eventMapCatalog = await loadEventMapCatalog();
  }

  getCurrentPresetInfo(): {
    preset: TaskPreset;
    filePath: string;
    source: PlanPresetSource;
  } | null {
    return this.currentPreset && this.currentPresetFilePath
      ? {
          preset: this.currentPreset,
          filePath: this.currentPresetFilePath,
          source: this.currentPresetSource,
        }
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
      get currentPresetSource() { return self.currentPresetSource; },
      set currentPresetSource(v) { self.currentPresetSource = v; },
    };
  }

  // ════════════════════════════════════════
  // 事件绑定
  // ════════════════════════════════════════

  bindActions(): void {
    this.planView.onNewPlan = () => void this.newPlan();
    this.planView.onLoadPlan = () => void this.loadPlan();
    this.planView.onSavePlan = () => void this.savePlan();
    this.battlePlanLoader.bindActions();

    // 节点编辑
    this.planView.onNodeClick = (nodeId) => {
      if (!this.currentPlan) return;
      const mapData = this.currentMapData;
      const nodeType = mapData ? getNodeType(mapData, nodeId) : 'Normal';
      this.editingNodeId = nodeId;
      const args = this.currentPlan.getNodeArgs(nodeId);
      const rulesText = (args.enemy_rules ?? []).map(r => `${r[0]}, ${r[1]}`).join('\n');
      const mapNight = this.currentMapData ? isNightNode(this.currentMapData, nodeId) : false;
      const isEnabled = this.currentPlan.data.selected_nodes.includes(nodeId);
      const canDetour = this.currentMapData ? isDetourNode(this.currentMapData, nodeId) : false;
      const isEndpoint = (this.currentPlan.data.endpoint_nodes ?? []).includes(nodeId);
      const isTerminal = this.currentMapData ? isTerminalNode(this.currentMapData, nodeId) : false;
      this.planView.showNodeEditor(nodeId, nodeType, {
        enabled: isEnabled,
        formation: args.formation ?? 2,
        night: args.night ?? false,
        longMissileSupport: args.long_missile_support ?? false,
        proceed: args.proceed ?? true,
        detour: args.detour ?? false,
        canDetour,
        slWhenDetourFails: args.SL_when_detour_fails ?? true,
        isEndpoint,
        result: this.currentPlan.data.result,
        isTerminal,
        enemyRules: rulesText,
      }, mapNight);
    };

    this.planView.onCloseNodeEditor = () => {
      this.editingNodeId = null;
      this.planView.hideNodeEditor();
    };

    this.planView.onSaveNodeEditor = () => {
      if (saveNodeEditorValues(this.planView, this.currentPlan, this.editingNodeId)) {
        this.editingNodeId = null;
        this.renderPlanPreview();
      }
    };

    this.planView.onMapChange = (chapter, map) => {
      void this.changeMap(chapter, map);
    };
    this.planView.onPresetNameChange = (name) => {
      this.planPresetName = name;
    };

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
      } else if (field === 'collect_result_info') {
        this.currentPlan.data.collect_result_info = value as boolean;
      }
    };

    this.planView.onAddFleetPreset = (planId) => {
      if (!this.currentPlan) return;
      const presets = this.fleetPresetController.appendPreset(
        this.currentPlan.data.fleet_presets ?? [],
        planId,
      );
      if (!presets) return;
      this.applyFleetPresets(presets);
      this.renderFleetPresetSelector();
    };
    this.planView.onRemoveFleetPreset = (index) => {
      if (!this.currentPlan) return;
      const presets = this.fleetPresetController.removePreset(
        this.currentPlan.data.fleet_presets ?? [],
        index,
      );
      if (!presets) return;
      this.applyFleetPresets(presets);
      this.renderFleetPresetSelector();
    };
  }

  private applyFleetPresets(presets: FleetPreset[]): void {
    if (!this.currentPlan) return;
    this.currentPlan.data.fleet_presets = presets.map(team => ({
      name: team.name,
      ships: team.ships.map(slot => (
        slot === null || typeof slot === 'string'
          ? slot
          : {
              name: slot.name,
              candidates: slot.candidates
                ? slot.candidates.map(candidate => ({
                    ...candidate,
                    ship_type: candidate.ship_type
                      ? [...candidate.ship_type]
                      : undefined,
                  }))
                : undefined,
              search_name: slot.search_name,
              ship_type: slot.ship_type
                ? [...slot.ship_type]
                : undefined,
              min_level: slot.min_level,
              max_level: slot.max_level,
              relaxed: slot.relaxed,
            }
      )),
    }));
  }

  private renderFleetPresetSelector(): void {
    if (!this.currentPlan) return;
    this.planView.renderFleetPresetSelector(
      this.fleetPresetController.toViewObject(
        this.currentPlan.data.fleet_presets ?? [],
      ),
    );
  }

  private refreshFleetPresetCatalog(): void {
    const loading = this.fleetPresetController.load();
    this.renderFleetPresetSelector();
    void loading.then(() => {
      this.renderFleetPresetSelector();
    });
  }

  // ── 委托方法 ──

  async openManagedPlan(
    file: string,
    source: PlanPresetSource,
    skipDiscardConfirm = false,
  ): Promise<boolean> {
    if (
      !skipDiscardConfirm
      && !(await this.confirmDiscardUnsaved())
    ) {
      return false;
    }
    if (!this.managedPlans?.readManagedCombatPlan) {
      await showAlert('加载失败', '请完整重启 GUI 后再操作');
      return false;
    }
    try {
      const result = await this.managedPlans.readManagedCombatPlan(
        source,
        file,
      );
      if (!result.success || !result.path || result.content === undefined) {
        await showAlert('加载失败', result.error || '无法读取出征计划');
        return false;
      }
      const parsed = parseYamlRecord(result.content, '任务文件');
      if (taskPresetCodec.isStandalone(parsed)) {
        this.importTaskPreset(
          taskPresetCodec.normalize(parsed),
          result.path,
          source,
        );
        return true;
      }
      const plan = PlanModel.fromYaml(result.content, result.path);
      await this.ensureEventMapCatalog();
      const { chapter, map } = plan.data;
      const mapData = plan.isEvent
        ? await loadEventMapData(plan.data.event ?? '', chapter, map)
        : await loadMapData(Number(chapter), Number(map));
      this.setCurrentPlan(plan, mapData);
      this.currentManagedPlanFile = file;
      this.currentPlanSource = source;
      this.savedPlanSnapshot = this.planDraftSnapshot();
      this.renderPlanPreview();
      this.host.switchPage('plan');
      if (result.missingTeamNames?.length) {
        showWarningNotice(
          `当前 YAML 关联的编队配置不存在：${
            result.missingTeamNames.join('、')
          }，请检查`,
        );
      }
      return true;
    } catch (error) {
      await showAlert(
        '加载失败',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  private async newPlan(): Promise<void> {
    if (this.hasUnsavedPlanChanges()) {
      const confirmed = await showConfirm(
        '新建出征预设',
        '当前出征规划存在未保存修改，继续新建将丢失这些修改，是否继续？',
      );
      if (!confirmed) return;
    }
    this.planView.resetNodeEditorDrafts();
    this.currentPlan = null;
    this.currentMapData = null;
    this.planPresetName = '';
    this.currentManagedPlanFile = null;
    this.currentPlanSource = 'user';
    this.planView.hideNodeEditor();
    this.refreshFleetPresetCatalog();
    await this.changeMap('1', 1);
    this.savedPlanSnapshot = this.planDraftSnapshot();
    this.planView.focusPresetName();
  }

  private async loadPlan(): Promise<void> {
    await this.battlePlanLoader.openForEditor();
  }

  private async confirmDiscardUnsaved(
    action: '加载' = '加载',
  ): Promise<boolean> {
    if (!this.hasUnsavedPlanChanges()) return true;
    return showConfirm(
      '未保存修改',
      `当前出征规划存在未保存修改，继续${action}将丢失这些修改，是否继续？`,
    );
  }

  private planDraftSnapshot(): string {
    if (!this.currentPlan) return '';
    return jsonCodec.stringify({
      name: this.planPresetName,
      yaml: this.currentPlan.toYaml(),
    });
  }

  private hasUnsavedPlanChanges(): boolean {
    return this.planDraftSnapshot() !== this.savedPlanSnapshot;
  }

  private planNameFromPath(filePath: string): string {
    const file = filePath.split(/[\\/]/).pop() ?? '';
    return file
      .replace(/\.ya?ml$/i, '')
      .replace(/^bettle-/i, '');
  }

  private normalizePlanName(value: string): string {
    return value
      .trim()
      .replace(/\.ya?ml$/i, '')
      .replace(/^bettle-/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 100);
  }

  private async savePlan(): Promise<boolean> {
    if (!this.currentPlan) return false;
    if (!this.managedPlans?.saveManagedCombatPlan) {
      await showAlert('保存失败', '当前环境不支持保存出征规划');
      return false;
    }
    const name = this.normalizePlanName(this.planView.getPresetName());
    if (!name) {
      await showAlert('保存失败', '请先填写预设名称');
      return false;
    }

    try {
      const content = this.currentPlan.toYaml();
      const copiedFromSystem = this.currentPlanSource === 'system';
      const currentFile = copiedFromSystem
        ? undefined
        : this.currentManagedPlanFile ?? undefined;
      let result = await this.managedPlans.saveManagedCombatPlan(
        name,
        content,
        false,
        currentFile,
      );
      if (result.exists) {
        const conflictDetails = result.conflicts?.length
          ? `\n\n${result.conflicts.join('\n')}`
          : '';
        const overwrite = await showConfirm(
          '覆盖配置',
          `存在同名配置，是否覆盖？${conflictDetails}`,
        );
        if (!overwrite) return false;
        result = await this.managedPlans.saveManagedCombatPlan(
          name,
          content,
          true,
          currentFile,
        );
      }
      if (!result.success) {
        throw new Error(result.error || '保存失败');
      }

      this.currentPlan.fileName = result.path ?? this.currentPlan.fileName;
      this.currentManagedPlanFile = result.file ?? `bettle-${name}.yaml`;
      this.currentPlanSource = result.source ?? 'user';
      this.planPresetName = name;
      this.savedPlanSnapshot = this.planDraftSnapshot();
      this.renderPlanPreview();
      Logger.info(`出征规划已保存: ${this.currentManagedPlanFile}`);
      showSaveSuccess(
        copiedFromSystem
          ? `出征规划「${name}」已保存为用户配置`
          : `出征规划「${name}」保存成功`,
      );
      return true;
    } catch (error) {
      await showAlert(
        '保存失败',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  importTaskPreset(
    preset: TaskPreset,
    filePath: string,
    source: PlanPresetSource = 'user',
  ): void {
    this.mapLoadVersion++;
    importTaskPresetFlow(
      preset,
      filePath,
      this.planView,
      this.host,
      this.presetState,
      source,
    );
  }

  closePresetDetail(): void {
    closePresetDetailFlow(this.planView, this.presetState);
  }

  async executePreset(): Promise<void> {
    let ships: Pick<ShipLibraryShip, 'name' | 'search_name'>[] = [];
    if (
      this.currentPreset?.task_type === 'decisive'
      && this.currentPresetSource !== 'system'
    ) {
      if (!this.managedPlans?.getShipLibraryManifest) {
        await showAlert('加入队列失败', '舰船资料库读取接口不可用');
        return;
      }
      try {
        ships = (await this.managedPlans.getShipLibraryManifest()).ships;
      } catch (error) {
        await showAlert(
          '加入队列失败',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }
    executePresetFlow(
      this.planView,
      this.host,
      this.presetState,
      ships,
    );
  }

  renderPlanPreview(): void {
    if (!this.currentPlan) { this.planView.render(null); return; }
    const vo = buildPlanPreviewVO(
      this.currentPlan,
      this.currentMapData,
      this.eventMapCatalog,
      this.fleetPresetController.toViewObject(
        this.currentPlan.data.fleet_presets ?? [],
      ),
    );
    this.planView.render(vo);
    this.planView.setPresetName(this.planPresetName);
    this.planView.showPlanView();
  }

  async ensureDefaultPlan(): Promise<void> {
    this.refreshFleetPresetCatalog();
    if (this.currentPreset) return;
    if (this.currentPlan) {
      this.renderPlanPreview();
      return;
    }
    await this.changeMap('1', 1);
    this.savedPlanSnapshot = this.planDraftSnapshot();
  }

  private async changeMap(
    chapterValue: string,
    map: number | string,
  ): Promise<void> {
    await this.ensureEventMapCatalog();
    const version = ++this.mapLoadVersion;
    const eventMatch = chapterValue.match(/^event:([^:]+):(E|H)$/);
    const eventName = eventMatch?.[1];
    const eventChapter = eventMatch?.[2];
    let chapter: number | string;
    let mapValue: number | string;
    let mapData: MapData | null;

    if (eventName && eventChapter) {
      chapter = eventChapter;
      mapValue = String(map).trim().toLowerCase();
      mapData = await loadEventMapData(eventName, chapter, mapValue);
    } else {
      chapter = Number(chapterValue);
      mapValue = Number(map);
      mapData = await loadMapData(Number(chapter), mapValue);
    }
    if (version !== this.mapLoadVersion) return;
    if (!mapData) {
      Logger.error(`地图 ${chapterValue}-${mapValue} 数据不存在`);
      this.renderPlanPreview();
      return;
    }

    this.planView.resetNodeEditorDrafts();
    const selectedNodes = initialSelectedNodesForNewPlan();
    if (!this.currentPlan) {
      this.currentPlan = PlanModel.create(
        chapter,
        mapValue,
        selectedNodes,
        eventName,
      );
    } else {
      this.currentPlan.data.chapter = chapter;
      this.currentPlan.data.map = mapValue;
      this.currentPlan.data.mode = undefined;
      this.currentPlan.data.event = eventName;
      this.currentPlan.data.selected_nodes = selectedNodes;
      this.currentPlan.data.endpoint_nodes = undefined;
      this.currentPlan.data.result = undefined;
      this.currentPlan.data.node_args = {};
    }

    this.currentMapData = mapData;
    this.editingNodeId = null;
    this.planView.hideNodeEditor();
    this.renderPlanPreview();
    Logger.info(`已切换地图 ${this.currentPlan.mapName}`);
  }
}
