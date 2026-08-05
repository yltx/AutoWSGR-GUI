/** 渲染设置页面、收集表单输入并发出保存和检测意图。 */
/**
 * ConfigView —— 设置页纯渲染组件。
 * 接收 ConfigViewObject 填充表单，用户修改后由 Controller 收集。
 */
import type { NormalFightTaskConfig } from '../../types/model.js';
import type { ConfigViewObject } from '../../types/view.js';
import {
  DEFAULT_LOOT_PLAN_ID,
  findLootAutomationPlan,
  lootAutomationPlanKey,
  normalizeLootAutomationPlans,
  type LootAutomationPlan,
  type LootPlanSource,
} from '../../shared/lootPlans.js';
import {
  normalizeDecisiveAutomationSource,
} from '../../shared/decisiveAutomation.js';

type StatusKind = 'ok' | 'error' | 'unknown';

export interface ConfigViewActions {
  onSave(): void;
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
  private normalFightTasks: NormalFightTaskConfig[] = [];
  private normalFightFleetNames = new Map<string, string>();
  private lootPlans: LootAutomationPlan[] = [];

  private emuType = element<HTMLSelectElement>('cfg-emu-type');
  private emuPath = element<HTMLInputElement>('cfg-emu-path');
  private emuSerial = element<HTMLInputElement>('cfg-emu-serial');
  private gameApp = element<HTMLSelectElement>('cfg-game-app');
  private updateMode = element<HTMLSelectElement>('cfg-update-mode');
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
  private lootPlan = element<HTMLSelectElement>('cfg-loot-plan');
  private lootStopCount = element<HTMLInputElement>('cfg-loot-stop-count');
  private normalFightTaskList = element<HTMLElement>('cfg-normal-fight-tasks');

  private logLevel = element<HTMLSelectElement>('cfg-log-level');
  private logRoot = element<HTMLInputElement>('cfg-log-root');
  private themeMode = element<HTMLSelectElement>('cfg-theme-mode');
  private accentColor = element<HTMLInputElement>('cfg-accent-color');
  private accentLabel = element<HTMLElement>('cfg-accent-label');
  private debugMode = element<HTMLInputElement>('cfg-debug-mode');
  private backendPort = element<HTMLInputElement>('cfg-backend-port');
  private backendStatus = document.getElementById('cfg-backend-status');
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
  private cudaStatus = document.getElementById('cfg-cuda-status');
  private validateCudaBtn = document.getElementById('btn-validate-cuda') as HTMLButtonElement | null;
  private saveBackendScreenshots = element<HTMLInputElement>('cfg-save-backend-screenshots');
  private debugAdvancedWrap = document.getElementById('cfg-debug-advanced');
  private backendRepoWrap = document.getElementById('cfg-backend-repo-wrap');
  private pythonPath = element<HTMLInputElement>('cfg-python-path');
  private pythonStatus = document.getElementById('cfg-python-status');
  private adbStatus = document.getElementById('cfg-adb-status');
  private validatePythonBtn = document.getElementById('btn-validate-python') as HTMLButtonElement | null;
  private shipLibraryStatus = document.getElementById('ship-library-status');
  private updateShipLibraryBtn = document.getElementById('btn-update-ship-library') as HTMLButtonElement | null;
  private defaultWindowWidth = element<HTMLInputElement>('cfg-window-width');
  private defaultWindowHeight = element<HTMLInputElement>('cfg-window-height');
  private rememberWindowBounds = element<HTMLInputElement>('cfg-remember-window-bounds');

  private delayMin = element<HTMLInputElement>('cfg-delay-min');
  private delayMinRange = element<HTMLInputElement>('cfg-delay-min-range');
  private delayMax = element<HTMLInputElement>('cfg-delay-max');
  private delayMaxRange = element<HTMLInputElement>('cfg-delay-max-range');
  private dockFullDestroy = element<HTMLInputElement>('cfg-dock-full-destroy');
  private repairManually = element<HTMLSelectElement>('cfg-repair-manually');
  private bathroomCount = element<HTMLInputElement>('cfg-bathroom-count');
  private destroyShipWorkMode = element<HTMLSelectElement>('cfg-destroy-ship-mode');
  private destroyShipTypes = element<HTMLElement>('cfg-destroy-ship-types');
  private removeEquipmentMode = element<HTMLInputElement>('cfg-remove-equipment-mode');
  private planRoot = element<HTMLInputElement>('cfg-plan-root');

  constructor() {
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
    this.lootPlan.addEventListener(
      'change',
      () => this.updateLootPlanSelectWidth(),
    );
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
    ).forEach(select => this.updateSettingSelectWidth(select));
  }

  bindActions(actions: ConfigViewActions): void {
    const bindClick = (id: string, action: () => void) => {
      document.getElementById(id)?.addEventListener('click', action);
    };
    bindClick('btn-save-config', actions.onSave);
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
  }

  /** 用 ViewObject 填充表单。 */
  render(vo: ConfigViewObject): void {
    this.emuType.value = vo.emulatorType;
    this.emuPath.value = vo.emulatorPath;
    this.emuSerial.value = vo.emulatorSerial;
    this.gameApp.value = vo.gameApp;
    this.updateMode.value = vo.updateMode;
    this.autoExpedition.checked = vo.autoExpedition;
    this.expeditionInterval.value = String(vo.expeditionInterval);
    this.autoBattle.checked = vo.autoBattle;
    this.battleType.value = vo.battleType;
    this.autoExercise.checked = vo.autoExercise;
    this.exerciseFleetId.value = String(vo.exerciseFleetId);
    this.battleTimes.value = String(vo.battleTimes);
    this.autoNormalFight.checked = vo.autoNormalFight;
    this.normalFightTasks = structuredClone(vo.normalFightTasks);
    this.normalFightFleetNames.clear();
    this.renderNormalFightTasks();
    this.autoDecisive.checked = vo.autoDecisive;
    this.decisiveTemplate.value = vo.decisiveTemplateId;
    this.lootPlans = normalizeLootAutomationPlans(vo.lootPlans, []);
    this.renderLootPlanOptions(vo.lootPlanSource, vo.lootPlanId);
    this.autoLoot.checked = vo.autoLoot && this.lootPlans.length > 0;
    this.lootStopCount.value = String(vo.lootStopCount);
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
    this.dockFullDestroy.checked = vo.dockFullDestroy;
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
    const selectedLootPlan = this.selectedLootPlan();
    if (this.autoLoot.checked && !selectedLootPlan) {
      throw new Error('启用自动胖次前必须先加载并选择出征计划');
    }
    return {
      emulatorType: this.emuType.value,
      emulatorPath: this.emuPath.value.trim(),
      emulatorSerial: this.emuSerial.value.trim(),
      gameApp: this.gameApp.value,
      updateMode: this.updateMode.value === 'manual' ? 'manual' : 'auto',
      autoExpedition: this.autoExpedition.checked,
      expeditionInterval: this.clamp(this.expeditionInterval.value, 1, 120, 15),
      autoBattle: this.autoBattle.checked,
      battleType: this.battleType.value,
      autoExercise: this.autoExercise.checked,
      exerciseFleetId: Math.trunc(this.clamp(this.exerciseFleetId.value, 1, 4, 1)),
      battleTimes: Math.trunc(this.clamp(this.battleTimes.value, 1, 99, 3)),
      autoNormalFight: this.autoNormalFight.checked,
      normalFightTasks: this.collectNormalFightTasks(),
      autoDecisive: this.autoDecisive.checked,
      decisiveTemplateId: normalizeDecisiveAutomationSource(
        this.decisiveTemplate.value,
      ),
      autoLoot: this.autoLoot.checked,
      lootPlanSource: selectedLootPlan?.source ?? 'system',
      lootPlanId: selectedLootPlan?.file ?? DEFAULT_LOOT_PLAN_ID,
      lootPlans: structuredClone(this.lootPlans),
      lootStopCount: Math.trunc(this.clamp(this.lootStopCount.value, 1, 50, 50)),
      logLevel: this.logLevel.value as ConfigViewObject['logLevel'],
      logRoot: this.logRoot.value.trim() || 'log',
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
      dockFullDestroy: this.dockFullDestroy.checked,
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
    path: string,
    fleetPresetIndex: number,
    fleetName: string,
  ): void {
    this.normalFightTasks = [{
      name: path,
      fleet_preset_index: fleetPresetIndex,
    }];
    this.normalFightFleetNames.clear();
    this.normalFightFleetNames.set(
      this.normalFightFleetKey(path, fleetPresetIndex),
      fleetName,
    );
    this.renderNormalFightTasks();
  }

  private collectNormalFightTasks(): NormalFightTaskConfig[] {
    return structuredClone(this.normalFightTasks);
  }

  private renderNormalFightTasks(): void {
    this.normalFightTaskList.replaceChildren();
    if (this.normalFightTasks.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'config-empty-note';
      empty.textContent = '尚未加载计划';
      this.normalFightTaskList.appendChild(empty);
      return;
    }
    const primaryTask = this.normalFightTasks[0];
    if (!primaryTask) return;
    const name = document.createElement('span');
    const fileName = primaryTask.name.split(/[\\/]/).pop() ?? primaryTask.name;
    const displayName = fileName
      .replace(/\.ya?ml$/i, '')
      .replace(/^bettle-/i, '');
    name.className = 'config-task-name';
    name.title = this.normalFightTasks.map(task => task.name).join('\n');
    name.textContent = this.normalFightTasks.length > 1
      ? `${displayName} 等 ${this.normalFightTasks.length} 个任务`
      : displayName;
    this.normalFightTaskList.appendChild(name);

    if (primaryTask.fleet_preset_index != null) {
      const fleetIndex = primaryTask.fleet_preset_index;
      const fleetName = this.normalFightFleetNames.get(
        this.normalFightFleetKey(primaryTask.name, fleetIndex),
      ) ?? `队伍 ${fleetIndex + 1}`;
      const fleetTag = document.createElement('span');
      fleetTag.className = 'tg-fleet-tag';
      fleetTag.textContent = fleetName;
      fleetTag.title = `使用队伍：${fleetName}`;
      this.normalFightTaskList.appendChild(fleetTag);
    }
  }

  private normalFightFleetKey(path: string, fleetPresetIndex: number): string {
    return `${path.toLowerCase()}\u0000${fleetPresetIndex}`;
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
    return structuredClone(this.lootPlans);
  }

  setLootPlans(plans: readonly LootAutomationPlan[]): void {
    const selected = this.selectedLootPlan();
    this.lootPlans = normalizeLootAutomationPlans(plans, []);
    this.renderLootPlanOptions(selected?.source, selected?.file);
    if (this.lootPlans.length === 0) this.autoLoot.checked = false;
  }

  private renderLootPlanOptions(
    source?: LootPlanSource,
    file?: string,
  ): void {
    const selected = findLootAutomationPlan(this.lootPlans, source, file)
      ?? this.lootPlans[0]
      ?? null;
    this.lootPlan.replaceChildren();
    this.lootPlans.forEach((plan) => {
      const option = document.createElement('option');
      option.value = lootAutomationPlanKey(plan);
      option.textContent = plan.name;
      option.title = `${plan.name} (${plan.file})`;
      this.lootPlan.append(option);
    });
    this.lootPlan.disabled = this.lootPlans.length === 0;
    this.lootPlan.value = selected
      ? lootAutomationPlanKey(selected)
      : '';
    this.updateLootPlanSelectWidth();
  }

  private selectedLootPlan(): LootAutomationPlan | null {
    return this.lootPlans.find(plan => (
      lootAutomationPlanKey(plan) === this.lootPlan.value
    )) ?? null;
  }

  private updateLootPlanSelectWidth(): void {
    const option = this.lootPlan.selectedOptions[0];
    const text = option?.textContent?.trim() || '任务预设';
    this.updateSettingSelectWidth(this.lootPlan);
    this.lootPlan.title = option?.title || text;
  }

  private updateSettingSelectWidth(select: HTMLSelectElement): void {
    const fixedWidth = Number(select.dataset['configSelectWidth']);
    if (Number.isFinite(fixedWidth) && fixedWidth > 0) {
      select.style.setProperty(
        '--config-select-width',
        `${fixedWidth}px`,
      );
      return;
    }

    const style = window.getComputedStyle(select);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    context.font = style.font;
    const contentWidth = Math.max(
      0,
      ...Array.from(
        select.options,
        item => context.measureText(item.text.trim()).width,
      ),
    );
    const requiredWidth = Math.ceil(contentWidth + 38);
    const widthSteps = [96, 124, 168, 204, 240, 280, 320];
    const width = widthSteps.find(step => step >= requiredWidth)
      ?? widthSteps[widthSteps.length - 1]!;
    select.style.setProperty('--config-select-width', `${width}px`);
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

  private setStatus(target: HTMLElement | null, text: string, status: StatusKind): void {
    if (!target) return;
    target.textContent = text;
    const cls = status === 'ok'
      ? 'adb-status-online'
      : status === 'error'
        ? 'adb-status-offline'
        : 'adb-status-unknown';
    target.className = `adb-status ${cls}`;
  }

  setEmulatorPath(path: string): void { this.emuPath.value = path; }
  setEmulatorSerial(serial: string): void { this.emuSerial.value = serial; }
  setPythonPath(path: string): void { this.pythonPath.value = path; }
  setBackendRepoPath(path: string): void { this.backendRepoPath.value = path; }
  setLogRoot(path: string): void { this.logRoot.value = path; }
  setPlanRoot(path: string): void { this.planRoot.value = path; }
  setCudaPath(path: string): void { this.cudaPath.value = path; }
  getEmulatorSerial(): string { return this.emuSerial.value.trim(); }
  getCudaPath(): string { return this.cudaPath.value.trim(); }
  getPythonPath(): string { return this.pythonPath.value.trim(); }
  getBackendPort(): number { return Math.trunc(this.clamp(this.backendPort.value, 1, 65535, 8438)); }

  setCudaStatus(text: string, status: StatusKind, details = text): void {
    this.setStatus(this.cudaStatus, text, status);
    if (this.cudaStatus) this.cudaStatus.title = details;
  }
  setPythonStatus(text: string, status: StatusKind): void { this.setStatus(this.pythonStatus, text, status); }
  setBackendStatus(text: string, status: StatusKind): void { this.setStatus(this.backendStatus, text, status); }
  setShipLibraryStatus(text: string, status: StatusKind): void { this.setStatus(this.shipLibraryStatus, text, status); }
  setAdbStatus(text: string, status: 'online' | 'offline' | 'unknown'): void {
    if (!this.adbStatus) return;
    this.adbStatus.title = text;
    this.adbStatus.textContent = status === 'online'
      ? '在线'
      : status === 'offline'
        ? '离线'
        : text.includes('中')
          ? text
          : '未检测';
    this.adbStatus.className = `adb-status adb-status-${status}`;
  }

  setCudaValidateLoading(loading: boolean): void {
    if (!this.validateCudaBtn) return;
    this.validateCudaBtn.disabled = loading;
    this.validateCudaBtn.textContent = loading ? '检测中…' : '检测';
  }

  setPythonValidateLoading(loading: boolean): void {
    if (!this.validatePythonBtn) return;
    this.validatePythonBtn.disabled = loading;
    this.validatePythonBtn.textContent = loading ? '检测中…' : '检测';
  }

  setShipLibraryUpdateLoading(loading: boolean): void {
    if (!this.updateShipLibraryBtn) return;
    this.updateShipLibraryBtn.disabled = loading;
    this.updateShipLibraryBtn.textContent = loading ? '正在更新…' : '更新舰船数据库';
  }

  setBackendCheckLoading(loading: boolean): void {
    this.setButtonLoading('btn-check-backend', loading, '检测中…', '检测');
  }

  setAdbCheckLoading(loading: boolean): void {
    this.setButtonLoading(
      'btn-check-adb',
      loading,
      '检测中…',
      '自动检测',
    );
  }

  setAdbConnectionLoading(
    action: 'connect' | 'disconnect',
    loading: boolean,
  ): void {
    this.setButtonLoading(
      action === 'connect' ? 'btn-connect-adb' : 'btn-disconnect-adb',
      loading,
      action === 'connect' ? '连接中…' : '断开中…',
      action === 'connect' ? '主动连接' : '断开连接',
    );
  }

  setUpdateCheckLoading(loading: boolean): void {
    this.setButtonLoading(
      'btn-check-updates',
      loading,
      '检查中…',
      '立即检查',
    );
  }

  private setButtonLoading(
    id: string,
    loading: boolean,
    loadingText: string,
    idleText: string,
  ): void {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) return;
    button.disabled = loading;
    button.textContent = loading ? loadingText : idleText;
  }

  resetAccentColor(defaultColor: string): void {
    this.accentColor.value = defaultColor;
    this.accentLabel.textContent = defaultColor;
  }
}
