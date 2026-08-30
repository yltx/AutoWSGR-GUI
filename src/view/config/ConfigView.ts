/** 渲染设置页面、收集表单输入并发出保存和检测意图。 */
/**
 * ConfigView —— 设置页纯渲染组件。
 * 接收 ConfigViewObject 填充表单，用户修改后由 Controller 收集。
 */
import type { GuiUpdateStatus } from '../../types/ipc.js';
import type { NormalFightTaskConfig } from '../../types/model.js';
import type { ConfigViewObject } from '../../types/view.js';
import type {
  IntensifyCandidatePreviewViewObject,
  IntensifyInventoryViewObject,
} from '../../types/view.js';
import {
  DEFAULT_LOOT_PLAN_ID,
  type LootAutomationPlan,
} from '../../shared/lootPlans.js';
import {
  normalizeDecisiveAutomationSource,
} from '../../shared/decisiveAutomation.js';
import { DAILY_CAMPAIGN_TIMES } from '../../shared/campaign.js';
import {
  ConfigAutomationView,
} from './ConfigAutomationView';
import {
  ConfigRuntimeView,
  type ConfigStatusKind,
} from './ConfigRuntimeView';
import { updateSettingSelectWidth } from './settingSelectWidth';
import { ShipAutocomplete } from '../shared/ShipAutocomplete';

export interface ConfigViewActions {
  onSave(): void;
  onScanIntensify(): void;
  onPreviewIntensify(): void;
  onSelectIntensifyTarget(ref: string): void;
  onToggleIntensifyMaterial(ref: string): void;
  onIntensifyMaxMaterialsChange(): void;
  onOpenConfigDir(): void;
  onBrowseEmulator(): void;
  onBrowsePython(): void;
  onBrowseBackendRepo(): void;
  onBrowseCuda(): void;
  onBrowseLogRoot(): void;
  onBrowsePlanRoot(): void;
  onAddNormalFightTask(): void;
  onLoadLootPlans(): void;
  onCheckBackend(): void;
  onValidateCuda(): void;
  onValidatePython(): void;
  onCheckUpdates(): void;
  onUpdateShipLibrary(): void;
  onConnectAdb(): void;
  onDisconnectAdb(): void;
  onCheckAdb(): void;
  onResetAccent(): void;
  onThemeModeChange(mode: string): void;
  onAccentColorInput(color: string): void;
}

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`设置控件不存在: ${id}`);
  return target as T;
}

export class ConfigView {
  private configTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-config-tab]'));
  private configPanels = Array.from(document.querySelectorAll<HTMLElement>('[data-config-panel]'));
  private configTabDescription = document.getElementById('config-tab-description');
  private readonly automationView = new ConfigAutomationView();
  private readonly runtimeView = new ConfigRuntimeView();

  private emuType = element<HTMLSelectElement>('cfg-emu-type');
  private emuPath = element<HTMLInputElement>('cfg-emu-path');
  private emuSerial = element<HTMLInputElement>('cfg-emu-serial');
  private gameApp = element<HTMLSelectElement>('cfg-game-app');
  private updateMode = element<HTMLSelectElement>('cfg-update-mode');
  private allowTestUpdates = element<HTMLInputElement>('cfg-allow-test-updates');
  private autoExpedition = element<HTMLInputElement>('cfg-auto-expedition');
  private expeditionInterval = element<HTMLInputElement>('cfg-expedition-interval');
  private autoBattle = element<HTMLInputElement>('cfg-auto-battle');
  private battleType = element<HTMLSelectElement>('cfg-battle-type');
  private autoExercise = element<HTMLInputElement>('cfg-auto-exercise');
  private exerciseFleetId = element<HTMLSelectElement>('cfg-exercise-fleet');
  private battleTimes = element<HTMLInputElement>('cfg-battle-times');
  private autoNormalFight = element<HTMLInputElement>('cfg-auto-normal-fight');
  private autoDecisive = element<HTMLInputElement>('cfg-auto-decisive');
  private decisiveTemplate = element<HTMLSelectElement>('cfg-decisive-template');
  private autoLoot = element<HTMLInputElement>('cfg-auto-loot');
  private lootStopCount = element<HTMLInputElement>('cfg-loot-stop-count');
  private intensifyTargetShip = element<HTMLInputElement>('cfg-intensify-target');
  private intensifyMaterialTypes = element<HTMLSelectElement>('cfg-intensify-material-types');
  private intensifyMaxMaterials = element<HTMLInputElement>('cfg-intensify-max-materials');
  private intensifyProtectedShips = element<HTMLTextAreaElement>('cfg-intensify-protected-ships');
  private intensifyStatus = element<HTMLElement>('cfg-intensify-status');
  private intensifyScanBtn = element<HTMLButtonElement>('btn-intensify-scan');
  private intensifyPreviewBtn = element<HTMLButtonElement>('btn-intensify-preview');
  private intensifyOccurrences = element<HTMLElement>('cfg-intensify-occurrences');
  private intensifyOccurrenceSummary = element<HTMLElement>('cfg-intensify-occurrence-summary');
  private intensifyTargetOccurrences = element<HTMLElement>('cfg-intensify-target-occurrences');
  private intensifyMaterialOccurrences = element<HTMLElement>('cfg-intensify-material-occurrences');
  private intensifyCandidatePreview = element<HTMLElement>('cfg-intensify-candidate-preview');
  private intensifyActions: ConfigViewActions | null = null;
  private readonly intensifyShipAutocomplete: ShipAutocomplete;

  private logLevel = element<HTMLSelectElement>('cfg-log-level');
  private logRoot = element<HTMLInputElement>('cfg-log-root');
  private themeMode = element<HTMLSelectElement>('cfg-theme-mode');
  private accentColor = element<HTMLInputElement>('cfg-accent-color');
  private accentLabel = element<HTMLElement>('cfg-accent-label');
  private debugMode = element<HTMLInputElement>('cfg-debug-mode');
  private backendPort = element<HTMLInputElement>('cfg-backend-port');
  private backendStartupMode = element<HTMLInputElement>('cfg-use-external-backend');
  private backendRepoPath = element<HTMLInputElement>('cfg-backend-repo-path');
  private ocrGpuMode = element<HTMLSelectElement>('cfg-ocr-gpu-mode');
  private ocrGpu = element<HTMLInputElement>('cfg-ocr-gpu');
  private ocrMirror = element<HTMLSelectElement>('cfg-ocr-mirror');
  private enhancedShipOcr = element<HTMLInputElement>('cfg-enhanced-ship-ocr');
  private ocrConfidence = element<HTMLInputElement>('cfg-ocr-confidence');
  private ocrConfidenceRange = element<HTMLInputElement>('cfg-ocr-confidence-range');
  private shipNameAliases = element<HTMLTextAreaElement>('cfg-ship-name-aliases');
  private shipNameCorrections = element<HTMLTextAreaElement>('cfg-ship-name-corrections');
  private cudaPath = element<HTMLInputElement>('cfg-cuda-path');
  private saveBackendScreenshots = element<HTMLInputElement>('cfg-save-backend-screenshots');
  private debugAdvancedWrap = document.getElementById('cfg-debug-advanced');
  private backendRepoWrap = document.getElementById('cfg-backend-repo-wrap');
  private pythonPath = element<HTMLInputElement>('cfg-python-path');
  private defaultWindowWidth = element<HTMLInputElement>('cfg-window-width');
  private defaultWindowHeight = element<HTMLInputElement>('cfg-window-height');
  private rememberWindowBounds = element<HTMLInputElement>('cfg-remember-window-bounds');

  private delayMin = element<HTMLInputElement>('cfg-delay-min');
  private delayMinRange = element<HTMLInputElement>('cfg-delay-min-range');
  private delayMax = element<HTMLInputElement>('cfg-delay-max');
  private delayMaxRange = element<HTMLInputElement>('cfg-delay-max-range');
  private dockFullMode = element<HTMLSelectElement>('cfg-dock-full-mode');
  private repairManually = element<HTMLSelectElement>('cfg-repair-manually');
  private bathroomCount = element<HTMLInputElement>('cfg-bathroom-count');
  private destroyShipWorkMode = element<HTMLSelectElement>('cfg-destroy-ship-mode');
  private destroyShipTypes = element<HTMLElement>('cfg-destroy-ship-types');
  private removeEquipmentMode = element<HTMLInputElement>('cfg-remove-equipment-mode');
  private planRoot = element<HTMLInputElement>('cfg-plan-root');

  constructor() {
    this.intensifyShipAutocomplete = new ShipAutocomplete(
      document,
      '#cfg-intensify-target',
      { maxResults: 10 },
    );
    for (const tab of this.configTabs) {
      tab.addEventListener('click', () => this.showConfigTab(tab.dataset['configTab'] ?? 'system'));
    }
    this.showConfigTab('system');

    this.accentColor.addEventListener('input', () => {
      this.accentLabel.textContent = this.accentColor.value;
    });
    this.debugMode.addEventListener('change', () => {
      this.updateDebugAdvancedVisibility();
      this.updateBackendRepoVisibility();
    });
    this.backendStartupMode.addEventListener('change', () => this.updateBackendRepoVisibility());
    this.cudaPath.addEventListener('input', () => {
      const hasPath = this.cudaPath.value.trim().length > 0;
      this.setCudaStatus(
        hasPath ? '待检测' : '系统环境',
        'unknown',
        hasPath ? 'CUDA 路径已修改，请点击检测' : 'CUDA 路径留空，将检测当前系统环境',
      );
    });
    this.bindNumberRange(this.delayMinRange, this.delayMin);
    this.bindNumberRange(this.delayMaxRange, this.delayMax);
    this.bindNumberRange(this.ocrConfidenceRange, this.ocrConfidence);

    this.ocrGpuMode.addEventListener('change', () => {
      if (this.ocrGpuMode.value === 'cpu') this.ocrGpu.checked = false;
      if (this.ocrGpuMode.value === 'cuda') this.ocrGpu.checked = true;
    });
    this.ocrGpu.addEventListener('change', () => {
      this.ocrGpuMode.value = this.ocrGpu.checked ? 'cuda' : 'cpu';
    });

    document.querySelectorAll<HTMLSelectElement>(
      '#page-config select.input',
    ).forEach(select => updateSettingSelectWidth(select));
  }

  dispose(): void {
    this.intensifyShipAutocomplete.dispose();
  }

  bindActions(actions: ConfigViewActions): void {
    if (this.intensifyActions) return;
    this.intensifyActions = actions;
    const bindClick = (id: string, action: () => void) => {
      document.getElementById(id)?.addEventListener('click', action);
    };
    bindClick('btn-save-config', actions.onSave);
    bindClick('btn-intensify-scan', actions.onScanIntensify);
    bindClick('btn-intensify-preview', actions.onPreviewIntensify);
    bindClick('btn-open-config-dir', actions.onOpenConfigDir);
    bindClick('btn-browse-emu', actions.onBrowseEmulator);
    bindClick('btn-browse-python', actions.onBrowsePython);
    bindClick('btn-browse-backend-repo', actions.onBrowseBackendRepo);
    bindClick('btn-browse-cuda', actions.onBrowseCuda);
    bindClick('btn-browse-log-root', actions.onBrowseLogRoot);
    bindClick('btn-browse-plan-root', actions.onBrowsePlanRoot);
    bindClick('btn-add-normal-fight-task', actions.onAddNormalFightTask);
    bindClick('btn-load-loot-plans', actions.onLoadLootPlans);
    bindClick('btn-check-backend', actions.onCheckBackend);
    bindClick('btn-validate-cuda', actions.onValidateCuda);
    bindClick('btn-validate-python', actions.onValidatePython);
    bindClick('btn-check-updates', actions.onCheckUpdates);
    bindClick('btn-update-ship-library', actions.onUpdateShipLibrary);
    bindClick('btn-connect-adb', actions.onConnectAdb);
    bindClick('btn-disconnect-adb', actions.onDisconnectAdb);
    bindClick('btn-check-adb', actions.onCheckAdb);
    bindClick('btn-reset-accent', actions.onResetAccent);
    this.themeMode.addEventListener(
      'change',
      () => actions.onThemeModeChange(this.themeMode.value),
    );
    this.accentColor.addEventListener(
      'input',
      () => actions.onAccentColorInput(this.accentColor.value),
    );
    this.intensifyMaxMaterials.addEventListener(
      'change',
      actions.onIntensifyMaxMaterialsChange,
    );
  }

  /** 用 ViewObject 填充表单。 */
  render(vo: ConfigViewObject): void {
    this.emuType.value = vo.emulatorType;
    this.emuPath.value = vo.emulatorPath;
    this.emuSerial.value = vo.emulatorSerial;
    this.gameApp.value = vo.gameApp;
    this.updateMode.value = vo.updateMode;
    this.allowTestUpdates.checked = vo.allowTestUpdates;
    this.autoExpedition.checked = vo.autoExpedition;
    this.expeditionInterval.value = String(vo.expeditionInterval);
    this.autoBattle.checked = vo.autoBattle;
    this.battleType.value = vo.battleType;
    this.autoExercise.checked = vo.autoExercise;
    this.exerciseFleetId.value = String(vo.exerciseFleetId);
    this.battleTimes.value = String(vo.battleTimes);
    this.autoNormalFight.checked = vo.autoNormalFight;
    this.automationView.showNormalFightTasks(
      vo.normalFightTasks,
      vo.normalFightRemaining,
    );
    this.autoDecisive.checked = vo.autoDecisive;
    this.decisiveTemplate.value = vo.decisiveTemplateId;
    this.automationView.showLootPlans(
      vo.lootPlans,
      vo.lootPlanSource,
      vo.lootPlanId,
    );
    this.autoLoot.checked = vo.autoLoot
      && this.automationView.hasLootPlans();
    this.lootStopCount.value = String(vo.lootStopCount);
    this.intensifyTargetShip.value = vo.intensifyTargetShip ?? '';
    for (const option of Array.from(this.intensifyMaterialTypes.options)) {
      option.selected = (vo.intensifyMaterialShipTypes ?? ['DD']).includes(
        option.value,
      );
    }
    this.intensifyMaxMaterials.value = String(vo.intensifyMaxMaterials ?? 4);
    this.intensifyProtectedShips.value = (
      vo.intensifyProtectedShips ?? []
    ).join('\n');
    this.logLevel.value = vo.logLevel;
    this.logRoot.value = vo.logRoot;
    this.themeMode.value = vo.themeMode;
    this.accentColor.value = vo.accentColor;
    this.accentLabel.textContent = vo.accentColor;
    this.debugMode.checked = vo.debugMode;
    this.backendPort.value = String(vo.backendPort);
    this.backendStartupMode.checked = vo.backendStartupMode === 'external';
    this.backendRepoPath.value = vo.backendRepoPath;
    this.ocrGpuMode.value = vo.ocrGpuMode;
    this.ocrGpu.checked = vo.ocrGpu;
    this.ocrMirror.value = vo.ocrMirror;
    this.enhancedShipOcr.checked = vo.enhancedShipOcr;
    this.setRangeValue(this.ocrConfidenceRange, this.ocrConfidence, vo.ocrConfidence);
    this.shipNameAliases.value = vo.shipNameAliasesText;
    this.shipNameCorrections.value = vo.shipNameCorrectionsText;
    this.cudaPath.value = vo.cudaPath;
    this.setCudaStatus(
      vo.cudaPath ? '待检测' : '系统环境',
      'unknown',
      vo.cudaPath ? '已配置 CUDA 路径，请点击检测' : 'CUDA 路径留空，将检测当前系统环境',
    );
    this.saveBackendScreenshots.checked = vo.saveBackendScreenshots;
    this.pythonPath.value = vo.pythonPath;
    this.defaultWindowWidth.value = String(vo.defaultWindowWidth);
    this.defaultWindowHeight.value = String(vo.defaultWindowHeight);
    this.rememberWindowBounds.checked = vo.rememberWindowBounds;
    this.setRangeValue(this.delayMinRange, this.delayMin, vo.operationDelayMin);
    this.setRangeValue(this.delayMaxRange, this.delayMax, vo.operationDelayMax);
    this.dockFullMode.value = String(vo.dockFullMode ?? (vo.dockFullDestroy ? 1 : 0));
    this.repairManually.value = String(vo.repairManually);
    this.bathroomCount.value = String(vo.bathroomCount);
    this.destroyShipWorkMode.value = String(vo.destroyShipWorkMode);
    this.removeEquipmentMode.checked = vo.removeEquipmentMode;
    this.planRoot.value = vo.planRoot;
    for (const checkbox of Array.from(
      this.destroyShipTypes.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    )) {
      checkbox.checked = vo.destroyShipTypes.includes(checkbox.value);
    }

    this.updateDebugAdvancedVisibility();
    this.updateBackendRepoVisibility();
  }

  /** 收集并校验当前表单。 */
  collect(): ConfigViewObject {
    const operationDelayMin = this.clamp(this.delayMin.value, 0, 10, 0);
    const operationDelayMax = this.clamp(this.delayMax.value, 0, 10, 0);
    if (operationDelayMin > operationDelayMax) {
      throw new Error('全局延迟的最小值不能大于最大值');
    }
    const selectedLootPlan = this.automationView.selectedLootPlan();
    if (this.autoLoot.checked && !selectedLootPlan) {
      throw new Error('启用自动胖次前必须先加载并选择出征计划');
    }
    return {
      emulatorType: this.emuType.value,
      emulatorPath: this.emuPath.value.trim(),
      emulatorSerial: this.emuSerial.value.trim(),
      gameApp: this.gameApp.value,
      updateMode: this.updateMode.value === 'manual' ? 'manual' : 'auto',
      allowTestUpdates: this.allowTestUpdates.checked,
      autoExpedition: this.autoExpedition.checked,
      expeditionInterval: this.clamp(this.expeditionInterval.value, 1, 120, 15),
      autoBattle: this.autoBattle.checked,
      battleType: this.battleType.value,
      autoExercise: this.autoExercise.checked,
      exerciseFleetId: Math.trunc(this.clamp(this.exerciseFleetId.value, 1, 4, 1)),
      battleTimes: DAILY_CAMPAIGN_TIMES,
      autoNormalFight: this.autoNormalFight.checked,
      normalFightTasks: this.automationView.getNormalFightTasks(),
      normalFightRemaining: this.automationView.getNormalFightRemaining(),
      autoDecisive: this.autoDecisive.checked,
      decisiveTemplateId: normalizeDecisiveAutomationSource(
        this.decisiveTemplate.value,
      ),
      autoLoot: this.autoLoot.checked,
      lootPlanSource: selectedLootPlan?.source ?? 'system',
      lootPlanId: selectedLootPlan?.file ?? DEFAULT_LOOT_PLAN_ID,
      lootPlans: this.automationView.getLootPlans(),
      lootStopCount: Math.trunc(this.clamp(this.lootStopCount.value, 1, 50, 50)),
      intensifyTargetShip: this.intensifyTargetShip.value.trim(),
      intensifyMaterialShipTypes: Array.from(
        this.intensifyMaterialTypes.selectedOptions,
        option => option.value,
      ),
      intensifyMaxMaterials: Math.trunc(
        this.clamp(this.intensifyMaxMaterials.value, 1, 12, 4),
      ),
      intensifyProtectedShips: this.parseShipNames(
        this.intensifyProtectedShips.value,
      ),
      logLevel: this.logLevel.value as ConfigViewObject['logLevel'],
      logRoot: this.logRoot.value.trim() || 'logs',
      themeMode: this.themeMode.value as ConfigViewObject['themeMode'],
      accentColor: this.accentColor.value,
      debugMode: this.debugMode.checked,
      backendPort: Math.trunc(this.clamp(this.backendPort.value, 1, 65535, 8438)),
      backendStartupMode: this.backendStartupMode.checked ? 'external' : 'managed',
      backendRepoPath: this.backendRepoPath.value.trim(),
      ocrGpuMode: this.ocrGpuMode.value as ConfigViewObject['ocrGpuMode'],
      ocrGpu: this.ocrGpu.checked,
      ocrMirror: this.ocrMirror.value as ConfigViewObject['ocrMirror'],
      enhancedShipOcr: this.enhancedShipOcr.checked,
      ocrConfidence: this.clamp(this.ocrConfidence.value, 0, 1, 0.65),
      shipNameAliasesText: this.shipNameAliases.value,
      shipNameCorrectionsText: this.shipNameCorrections.value,
      cudaPath: this.cudaPath.value.trim(),
      saveBackendScreenshots: this.saveBackendScreenshots.checked,
      pythonPath: this.pythonPath.value.trim(),
      defaultWindowWidth: Math.trunc(this.clamp(this.defaultWindowWidth.value, 854, 10000, 1280)),
      defaultWindowHeight: Math.trunc(this.clamp(this.defaultWindowHeight.value, 480, 10000, 720)),
      rememberWindowBounds: this.rememberWindowBounds.checked,
      operationDelayMin,
      operationDelayMax,
      dockFullMode: Math.trunc(this.clamp(this.dockFullMode.value, 0, 3, 0)),
      dockFullDestroy: (Math.trunc(this.clamp(this.dockFullMode.value, 0, 3, 0))) > 0,
      repairManually: this.repairManually.value === 'true',
      bathroomCount: Math.trunc(this.clamp(this.bathroomCount.value, 1, 12, 2)),
      destroyShipWorkMode: Math.trunc(this.clamp(this.destroyShipWorkMode.value, 0, 2, 0)),
      destroyShipTypes: Array.from(
        this.destroyShipTypes.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
        checkbox => checkbox.value,
      ),
      removeEquipmentMode: this.removeEquipmentMode.checked,
      planRoot: this.planRoot.value.trim(),
    };
  }

  setNormalFightPlan(
    task: NormalFightTaskConfig,
    fleetName: string,
    remaining: number,
  ): void {
    this.automationView.setNormalFightPlan(task, fleetName, remaining);
  }

  getNormalFightTasks(): NormalFightTaskConfig[] {
    return this.automationView.getNormalFightTasks();
  }

  setNormalFightRemaining(
    tasks: readonly NormalFightTaskConfig[],
    remaining: number,
  ): void {
    this.automationView.setNormalFightRemaining(tasks, remaining);
  }

  private showConfigTab(tag: string): void {
    const descriptions: Record<string, string> = {
      system: '管理运行环境、自动任务、日志和界面设置。',
      behavior: '管理操作延迟、OCR 识别和舰队相关行为。',
    };
    for (const tab of this.configTabs) {
      const active = tab.dataset['configTab'] === tag;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of this.configPanels) panel.hidden = panel.dataset['configPanel'] !== tag;
    if (this.configTabDescription) this.configTabDescription.textContent = descriptions[tag] ?? '';
  }

  private updateDebugAdvancedVisibility(): void {
    if (!this.debugAdvancedWrap) return;
    this.debugAdvancedWrap.style.display = this.debugMode.checked ? '' : 'none';
    if (!this.debugMode.checked && this.backendRepoWrap) this.backendRepoWrap.style.display = 'none';
  }

  private updateBackendRepoVisibility(): void {
    if (!this.backendRepoWrap) return;
    const show = this.debugMode.checked && this.backendStartupMode.checked;
    this.backendRepoWrap.style.display = show ? '' : 'none';
    this.backendRepoPath.required = show;
  }

  getLootPlans(): LootAutomationPlan[] {
    return this.automationView.getLootPlans();
  }

  setLootPlans(plans: readonly LootAutomationPlan[]): void {
    this.automationView.setLootPlans(plans);
    if (!this.automationView.hasLootPlans()) this.autoLoot.checked = false;
  }

  setIntensifyLoading(action: 'scan' | 'preview' | null): void {
    this.intensifyScanBtn.disabled = action !== null;
    this.intensifyScanBtn.textContent = action === 'scan'
      ? '扫描中…'
      : '扫描只读库存';
    if (action !== null) this.intensifyPreviewBtn.disabled = true;
    this.intensifyPreviewBtn.textContent = action === 'preview'
      ? '生成中…'
      : '生成候选预览';
  }

  setIntensifyPreviewEnabled(enabled: boolean): void {
    this.intensifyPreviewBtn.disabled = !enabled;
  }

  setIntensifyStatus(
    text: string,
    status: 'ok' | 'error' | 'unknown',
  ): void {
    this.intensifyStatus.textContent = text;
    this.intensifyStatus.className = `intensify-status intensify-status-${status}`;
  }

  clearIntensifyInventory(): void {
    this.intensifyOccurrences.hidden = true;
    this.intensifyTargetOccurrences.replaceChildren();
    this.intensifyMaterialOccurrences.replaceChildren();
    this.intensifyCandidatePreview.hidden = true;
    this.intensifyCandidatePreview.replaceChildren();
    this.setIntensifyPreviewEnabled(false);
  }

  showIntensifyInventory(vo: IntensifyInventoryViewObject): void {
    this.intensifyCandidatePreview.hidden = true;
    this.intensifyCandidatePreview.replaceChildren();
    this.intensifyOccurrenceSummary.textContent = vo.summary;
    this.intensifyTargetOccurrences.replaceChildren(...vo.targets.map(item => (
      this.intensifyOccurrenceButton(
        `${item.label} · ${item.stats}`,
        item.selected,
        () => this.intensifyActions?.onSelectIntensifyTarget(item.ref),
      )
    )));
    this.intensifyMaterialOccurrences.replaceChildren(...vo.materials.map(item => (
      this.intensifyOccurrenceButton(
        item.label,
        item.selected,
        () => this.intensifyActions?.onToggleIntensifyMaterial(item.ref),
      )
    )));
    this.intensifyOccurrences.hidden = false;
  }

  showIntensifyCandidatePreview(vo: IntensifyCandidatePreviewViewObject): void {
    const rows = [
      vo.summary,
      `目标：${vo.target}`,
      `当前：${vo.current}`,
      `上限：${vo.maximum}`,
      `预计收益：${vo.projectedGains}`,
      `预计结果：${vo.projected}`,
      `素材：${vo.materials.join('、')}`,
    ].map(text => {
      const row = document.createElement('p');
      row.textContent = text;
      return row;
    });
    this.intensifyCandidatePreview.replaceChildren(...rows);
    this.intensifyCandidatePreview.hidden = false;
  }

  private intensifyOccurrenceButton(
    label: string,
    selected: boolean,
    action: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'intensify-occurrence-item';
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('role', 'listitem');
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  private parseShipNames(value: string): string[] {
    return [...new Set(
      value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean),
    )];
  }

  private bindNumberRange(range: HTMLInputElement, number: HTMLInputElement): void {
    range.addEventListener('input', () => { number.value = range.value; });
    number.addEventListener('input', () => { range.value = number.value; });
  }

  private setRangeValue(range: HTMLInputElement, number: HTMLInputElement, value: number): void {
    range.value = String(value);
    number.value = String(value);
  }

  private clamp(value: string, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  }

  setEmulatorPath(path: string): void { this.emuPath.value = path; }
  setEmulatorSerial(serial: string): void { this.emuSerial.value = serial; }
  setPythonPath(path: string): void { this.pythonPath.value = path; }
  setBackendRepoPath(path: string): void { this.backendRepoPath.value = path; }
  setLogRoot(path: string): void { this.logRoot.value = path; }
  setPlanRoot(path: string): void { this.planRoot.value = path; }
  setCudaPath(path: string): void { this.cudaPath.value = path; }
  getEmulatorSerial(): string { return this.emuSerial.value.trim(); }
  getIntensifyMaxMaterials(): number {
    return Math.trunc(this.clamp(this.intensifyMaxMaterials.value, 1, 12, 4));
  }
  getCudaPath(): string { return this.cudaPath.value.trim(); }
  getPythonPath(): string { return this.pythonPath.value.trim(); }
  getBackendPort(): number { return Math.trunc(this.clamp(this.backendPort.value, 1, 65535, 8438)); }

  setCudaStatus(
    text: string,
    status: ConfigStatusKind,
    details = text,
  ): void {
    this.runtimeView.setCudaStatus(text, status, details);
  }
  setPythonStatus(text: string, status: ConfigStatusKind): void {
    this.runtimeView.setPythonStatus(text, status);
  }
  setBackendStatus(text: string, status: ConfigStatusKind): void {
    this.runtimeView.setBackendStatus(text, status);
  }
  setShipLibraryStatus(
    text: string,
    status: ConfigStatusKind,
    details = text,
  ): void {
    this.runtimeView.setShipLibraryStatus(text, status, details);
  }
  setShipLibraryUpdateLabel(label: string): void {
    this.runtimeView.setShipLibraryUpdateLabel(label);
  }
  setAdbStatus(text: string, status: 'online' | 'offline' | 'unknown'): void {
    this.runtimeView.setAdbStatus(text, status);
  }

  setCudaValidateLoading(loading: boolean): void {
    this.runtimeView.setCudaValidateLoading(loading);
  }

  setPythonValidateLoading(loading: boolean): void {
    this.runtimeView.setPythonValidateLoading(loading);
  }

  setShipLibraryUpdateLoading(loading: boolean): void {
    this.runtimeView.setShipLibraryUpdateLoading(loading);
  }

  setBackendCheckLoading(loading: boolean): void {
    this.runtimeView.setBackendCheckLoading(loading);
  }

  setAdbCheckLoading(loading: boolean): void {
    this.runtimeView.setAdbCheckLoading(loading);
  }

  setAdbConnectionLoading(
    action: 'connect' | 'disconnect',
    loading: boolean,
  ): void {
    this.runtimeView.setAdbConnectionLoading(action, loading);
  }

  setUpdateCheckLoading(loading: boolean): void {
    this.runtimeView.setUpdateCheckLoading(loading);
  }

  setGuiUpdateStatus(status: GuiUpdateStatus): void {
    this.runtimeView.setGuiUpdateStatus(status);
  }

  resetAccentColor(defaultColor: string): void {
    this.accentColor.value = defaultColor;
    this.accentLabel.textContent = defaultColor;
  }
}
