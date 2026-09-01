/** 编排设置页的环境检测、设备连接、资料库更新和主题交互。 */
import type { ConfigView } from '../../view/config/ConfigView';
import type {
  ManagedBattlePlanSelection,
  ShipLibraryUpdateTarget,
} from '../../types/ipc.js';
import type { LootAutomationPlan } from '../../shared/lootPlans.js';
import {
  normalFightDailyLimit,
} from '../../model/scheduler/NormalFightDailyQuota.js';
import type { NormalFightTaskConfig } from '../../types/model.js';
import type {
  IntensifyMaterialOccurrenceData,
  IntensifySnapshotPreviewData,
  IntensifySnapshotSessionData,
  IntensifyStatsData,
} from '../../types/api.js';
import { ApiClient } from '../../model/ApiClient';
import { Logger } from '../../utils/Logger';
import { showAlert, showConfirm } from '../../view/shared/DialogHelper';
import { applyTheme } from '../../view/theme';
import {
  getSettingsGateway,
  type SettingsGateway,
} from '../../adapter/IpcAdapter.js';
import { browserStorageStore } from '../../adapter/StorageAdapter.js';

export interface SettingsControllerHost {
  readonly configView: ConfigView;
  getConfigDir(): string;
  saveConfig(): Promise<void>;
  pickAutomationPlan(
    currentTask?: NormalFightTaskConfig,
  ): Promise<ManagedBattlePlanSelection | null>;
  pickLootAutomationPlans(
    currentPlans: readonly LootAutomationPlan[],
  ): Promise<LootAutomationPlan[] | null>;
  getNormalFightRemaining(task: NormalFightTaskConfig): number;
  reloadShipLibrary(): Promise<void>;
  ensureSystemConnected(): Promise<boolean>;
}

export class SettingsController {
  private shipLibraryUpdating = false;
  private shipLibraryUpdateTarget: ShipLibraryUpdateTarget = 'wiki';
  private intensifySession: IntensifySnapshotSessionData | null = null;
  private selectedIntensifyTargetRef: string | null = null;
  private readonly selectedIntensifyMaterialRefs = new Set<string>();
  private intensifyRequestGeneration = 0;
  private actionsBound = false;

  constructor(
    private readonly host: SettingsControllerHost,
    private readonly gateway: SettingsGateway | undefined =
      getSettingsGateway(),
    private readonly api: Pick<
      ApiClient,
      'createIntensifySnapshotSession' | 'intensifySnapshotPreview'
    > = new ApiClient(),
  ) {}

  bindActions(): void {
    if (this.actionsBound) return;
    this.actionsBound = true;
    const { configView } = this.host;
    this.gateway?.onShipLibraryUpdateProgress((progress) => {
      if (this.shipLibraryUpdating) {
        configView.setShipLibraryStatus(progress.message, 'unknown');
      }
    });
    this.gateway?.onUpdateStatus((status) => {
      configView.setGuiUpdateStatus(status);
    });

    configView.bindActions({
      onSave: () => void this.host.saveConfig(),
      onScanIntensify: () => void this.scanIntensifyInventory(),
      onPreviewIntensify: () => void this.previewIntensify(),
      onSelectIntensifyTarget: ref => this.selectIntensifyTarget(ref),
      onToggleIntensifyMaterial: ref => this.toggleIntensifyMaterial(ref),
      onIntensifyMaxMaterialsChange: () => this.handleIntensifyMaxMaterialsChange(),
      onOpenConfigDir: () => this.openFolder(this.host.getConfigDir()),
      onBrowseEmulator: () => void this.browseDirectory(
        '选择模拟器安装目录',
        path => configView.setEmulatorPath(path),
      ),
      onBrowsePython: () => void this.browsePython(),
      onBrowseBackendRepo: () => void this.browseDirectory(
        '选择本地后端仓库目录',
        path => configView.setBackendRepoPath(path),
      ),
      onBrowseCuda: () => void this.browseDirectory(
        '选择 CUDA Toolkit 根目录/bin 或 PyTorch torch\\lib 目录',
        path => configView.setCudaPath(path),
      ),
      onBrowseLogRoot: () => void this.browseDirectory(
        '选择后端日志目录',
        path => configView.setLogRoot(path),
      ),
      onBrowsePlanRoot: () => void this.browseDirectory(
        '选择后端作战方案根目录',
        path => configView.setPlanRoot(path),
      ),
      onAddNormalFightTask: () => void this.selectAutomationPlan(),
      onLoadLootPlans: () => void this.selectLootAutomationPlans(),
      onCheckBackend: () => void this.checkBackend(),
      onValidateCuda: () => void this.validateCuda(),
      onValidatePython: () => void this.validatePython(),
      onCheckUpdates: () => void this.checkUpdatesManually(),
      onUpdateShipLibrary: () => void this.updateShipLibrary(),
      onConnectAdb: () => void this.changeAdbConnection('connect'),
      onDisconnectAdb: () => void this.changeAdbConnection('disconnect'),
      onCheckAdb: () => void this.checkAdbDevices(),
      onResetAccent: () => {
        configView.resetAccentColor('#0f7dff');
        browserStorageStore.set('accentColor', '#0f7dff');
        applyTheme();
      },
      onThemeModeChange: (mode) => {
        browserStorageStore.set('themeMode', mode);
        applyTheme();
      },
      onAccentColorInput: (color) => {
        browserStorageStore.set('accentColor', color);
        applyTheme();
      },
    });
  }

  private async scanIntensifyInventory(): Promise<void> {
    const { configView } = this.host;
    const generation = ++this.intensifyRequestGeneration;
    this.clearIntensifySelection();
    configView.clearIntensifyInventory();
    configView.setIntensifyLoading('scan');
    configView.setIntensifyStatus('正在扫描完整目标与素材库存；只读扫描不会选择舰船。', 'unknown');
    try {
      const result = await this.api.createIntensifySnapshotSession();
      if (generation !== this.intensifyRequestGeneration) return;
      if (!result.success || !result.data) {
        throw new Error(result.error || result.message || '强化库存扫描失败');
      }
      this.intensifySession = result.data;
      this.selectedIntensifyTargetRef = null;
      this.renderIntensifyInventory();
      configView.setIntensifyStatus(
        `只读快照已创建，有效期至 ${new Date(result.data.expiresAt).toLocaleTimeString()}。请选择一个目标 occurrence 和素材 occurrences。`,
        'ok',
      );
    } catch (error) {
      if (generation !== this.intensifyRequestGeneration) return;
      this.intensifySession = null;
      configView.setIntensifyStatus(
        error instanceof Error ? error.message : String(error),
        'error',
      );
    } finally {
      if (generation === this.intensifyRequestGeneration) {
        configView.setIntensifyLoading(null);
      }
    }
  }

  private async previewIntensify(): Promise<void> {
    const { configView } = this.host;
    const session = this.intensifySession;
    const targetRef = this.selectedIntensifyTargetRef;
    if (!session || !targetRef || this.selectedIntensifyMaterialRefs.size === 0) {
      configView.setIntensifyStatus('请先扫描库存，并选择一个目标与至少一个素材 occurrence。', 'unknown');
      return;
    }
    const generation = ++this.intensifyRequestGeneration;
    configView.setIntensifyLoading('preview');
    try {
      const selectedMaterials = this.selectedMaterials(session);
      const previewResult = await this.api.intensifySnapshotPreview({
        session_id: session.sessionId,
        selected_target_ref: targetRef,
        allowed_material_identities: [...new Set(selectedMaterials.map(item => item.identity))],
        maximum_materials: this.host.configView.getIntensifyMaxMaterials(),
        selected_material_refs: selectedMaterials.map(item => item.ref),
      });
      if (generation !== this.intensifyRequestGeneration) return;
      if (previewResult.status === 404) {
        this.invalidateIntensifySession();
        configView.setIntensifyStatus(
          '强化快照会话已失效，请重新扫描库存。',
          'error',
        );
        return;
      }
      const result = previewResult.response;
      if (!result.success || !result.data) {
        throw new Error(result.error || result.message || '强化候选预览失败');
      }
      this.renderIntensifyCandidate(result.data, targetRef);
      configView.setIntensifyStatus('候选预览已生成；未操作设备且不可执行。', 'ok');
    } catch (error) {
      if (generation !== this.intensifyRequestGeneration) return;
      configView.setIntensifyStatus(
        error instanceof Error ? error.message : String(error),
        'error',
      );
    } finally {
      if (generation === this.intensifyRequestGeneration) {
        configView.setIntensifyLoading(null);
        this.updateIntensifyPreviewEnabled();
      }
    }
  }

  private selectIntensifyTarget(ref: string): void {
    if (!this.intensifySession?.targets.some(item => item.ref === ref)) return;
    this.intensifyRequestGeneration += 1;
    this.host.configView.setIntensifyLoading(null);
    this.selectedIntensifyTargetRef = ref;
    this.host.configView.setIntensifyStatus('目标 occurrence 已更新，请重新生成候选预览。', 'unknown');
    this.renderIntensifyInventory();
  }

  private toggleIntensifyMaterial(ref: string): void {
    const session = this.intensifySession;
    if (!session?.materials.some(item => item.ref === ref)) return;
    const maximum = this.host.configView.getIntensifyMaxMaterials();
    if (this.selectedIntensifyMaterialRefs.has(ref)) {
      this.selectedIntensifyMaterialRefs.delete(ref);
    } else if (
      maximum === null
      || this.selectedIntensifyMaterialRefs.size < maximum
    ) {
      this.selectedIntensifyMaterialRefs.add(ref);
    } else {
      this.host.configView.setIntensifyStatus(`单次最多选择 ${maximum} 艘素材舰。`, 'unknown');
      return;
    }
    this.intensifyRequestGeneration += 1;
    this.host.configView.setIntensifyLoading(null);
    this.renderIntensifyInventory();
  }

  private handleIntensifyMaxMaterialsChange(): void {
    const session = this.intensifySession;
    if (!session) return;
    const maximum = this.host.configView.getIntensifyMaxMaterials();
    const selectedMaterials = this.selectedMaterials(session);
    const retainedRefs = (maximum === null
      ? selectedMaterials
      : selectedMaterials.slice(0, maximum)
    ).map(item => item.ref);
    this.selectedIntensifyMaterialRefs.clear();
    retainedRefs.forEach(ref => this.selectedIntensifyMaterialRefs.add(ref));
    this.intensifyRequestGeneration += 1;
    this.host.configView.setIntensifyLoading(null);
    this.host.configView.setIntensifyStatus(
      maximum === null
        ? `素材上限已设为不限制，当前保留 ${retainedRefs.length} 个 occurrence，请重新生成候选预览。`
        : `素材上限已更新，当前保留前 ${retainedRefs.length} 个 occurrence，请重新生成候选预览。`,
      'unknown',
    );
    this.renderIntensifyInventory();
  }

  private renderIntensifyInventory(): void {
    const session = this.intensifySession;
    if (!session) return;
    this.host.configView.showIntensifyInventory({
      summary: `目标 ${session.targetTotal} 艘；素材 ${session.materialTotal} 艘；当前选择 ${this.selectedIntensifyMaterialRefs.size} 艘素材。`,
      targets: session.targets.map(item => ({
        ref: item.ref,
        label: `${item.identity} #${item.occurrence + 1}`,
        stats: this.formatIntensifyStats(item.current),
        selected: item.ref === this.selectedIntensifyTargetRef,
      })),
      materials: session.materials.map(item => ({
        ref: item.ref,
        label: `${item.identity} #${item.index + 1}`,
        selected: this.selectedIntensifyMaterialRefs.has(item.ref),
      })),
    });
    this.updateIntensifyPreviewEnabled();
  }

  private renderIntensifyCandidate(
    preview: IntensifySnapshotPreviewData,
    targetRef: string,
  ): void {
    const target = preview.targets.find(item => item.ref === targetRef);
    if (!target) throw new Error('所选目标 occurrence 不属于当前候选预览');
    const materials = preview.materials.filter(item => this.selectedIntensifyMaterialRefs.has(item.ref));
    this.host.configView.showIntensifyCandidatePreview({
      summary: preview.executionPath === 'confirmation_required'
        ? '所选素材包含高星舰，若未来执行必须经过保护确认；当前仍不可执行。'
        : '当前只展示离线收益投影，不会执行强化。',
      target: `${target.identity} #${target.occurrence + 1}`,
      current: this.formatIntensifyStats(target.current),
      maximum: this.formatIntensifyStats(target.maximum),
      projectedGains: this.formatIntensifyStats(target.projectedGains),
      projected: this.formatIntensifyStats(target.projected),
      materials: materials.map(item => `${item.identity}（${item.rarity} 星）`),
    });
  }

  private selectedMaterials(
    session: IntensifySnapshotSessionData,
  ): IntensifyMaterialOccurrenceData[] {
    return session.materials.filter(item => this.selectedIntensifyMaterialRefs.has(item.ref));
  }

  private updateIntensifyPreviewEnabled(): void {
    this.host.configView.setIntensifyPreviewEnabled(Boolean(
      this.intensifySession
      && this.selectedIntensifyTargetRef
      && this.selectedIntensifyMaterialRefs.size > 0
    ));
  }

  private clearIntensifySelection(): void {
    this.intensifySession = null;
    this.selectedIntensifyTargetRef = null;
    this.selectedIntensifyMaterialRefs.clear();
  }

  invalidateIntensifySession(): void {
    this.intensifyRequestGeneration += 1;
    this.clearIntensifySelection();
    this.host.configView.setIntensifyLoading(null);
    this.host.configView.clearIntensifyInventory();
    this.host.configView.setIntensifyStatus(
      '尚未扫描库存，不会选择、操作或消耗舰船。',
      'unknown',
    );
  }

  private formatIntensifyStats(stats: IntensifyStatsData): string {
    return `火力 ${stats.firepower} / 鱼雷 ${stats.torpedo} / 装甲 ${stats.armor} / 防空 ${stats.antiAir}`;
  }

  async refreshAdbStatus(): Promise<void> {
    const { configView } = this.host;
    configView.setAdbStatus('检测中…', 'unknown');
    if (!this.gateway) {
      configView.setAdbStatus('ADB 功能不可用', 'offline');
      return;
    }
    try {
      const devices = await this.gateway.checkAdbDevices();
      const online = devices.filter(device => device.status === 'device');
      const configuredSerial = configView.getEmulatorSerial();
      if (
        configuredSerial
        && online.some(device => device.serial === configuredSerial)
      ) {
        configView.setAdbStatus(
          `在线 (${configuredSerial})`,
          'online',
        );
      } else if (online.length > 0) {
        configView.setAdbStatus(
          `当前地址未连接（发现 ${online.map(device => device.serial).join(', ')}）`,
          'offline',
        );
      } else {
        configView.setAdbStatus('未发现在线设备', 'offline');
      }
    } catch {
      configView.setAdbStatus('ADB 检测失败', 'offline');
    }
  }

  async refreshShipLibraryStatus(ignoreUpdating = false): Promise<void> {
    if (this.shipLibraryUpdating && !ignoreUpdating) return;
    if (!this.gateway) return;
    try {
      const status = await this.gateway.getShipLibraryStatus();
      if (status.error) {
        this.setShipLibraryUpdateAction('wiki', '更新舰船数据库');
        this.host.configView.setShipLibraryStatus(
          '舰船数据库状态异常',
          'error',
          status.error,
        );
        Logger.error(`舰船数据库状态异常：${status.error}`);
      } else if (!status.exists || status.shipCount <= 0) {
        this.setShipLibraryUpdateAction('wiki', '更新舰船数据库');
        this.host.configView.setShipLibraryStatus(
          'Wiki 船库尚未同步',
          'error',
        );
      } else if (status.missingAssets > 0) {
        this.setShipLibraryUpdateAction('wiki', '更新舰船数据库');
        this.host.configView.setShipLibraryStatus(
          `Wiki 船库未同步完整，缺少 ${status.missingAssets} 个资源`,
          'error',
        );
      } else if (status.backendSynchronized !== true) {
        this.setShipLibraryUpdateAction('backend', '同步后端');
        const missingRecords = status.backendMissingRecords ?? 0;
        const missingAliases = status.backendMissingAliases ?? 0;
        const missing = missingRecords + missingAliases;
        const detail = status.backendError
          ? `后端核对失败：${status.backendError}`
          : `后端缺少 ${missing} 条舰名`;
        this.host.configView.setShipLibraryStatus(
          status.backendError
            ? '后端舰名库核对失败'
            : '前后端舰名库不一致',
          'error',
          `Wiki 与 GUI 已同步，${detail}`,
        );
        if (status.backendError) {
          Logger.error(`后端舰名库核对失败：${status.backendError}`);
        }
      } else {
        this.setShipLibraryUpdateAction('wiki', '检查更新');
        const updatedAt = status.generatedAt
          ? new Date(status.generatedAt).toLocaleString(
            'zh-CN',
            { hour12: false },
          )
          : '时间未知';
        this.host.configView.setShipLibraryStatus(
          `Wiki、GUI、后端已同步 · ${status.shipCount} 艘 · ${updatedAt}`,
          'ok',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.configView.setShipLibraryStatus(
        '舰船数据库状态读取失败',
        'error',
        message,
      );
      Logger.error(`舰船数据库状态读取失败：${message}`);
    }
  }

  private setShipLibraryUpdateAction(
    target: ShipLibraryUpdateTarget,
    label: string,
  ): void {
    this.shipLibraryUpdateTarget = target;
    this.host.configView.setShipLibraryUpdateLabel(label);
  }

  private async browseDirectory(
    title: string,
    applyPath: (path: string) => void,
  ): Promise<void> {
    const path = await this.gateway?.openDirectoryDialog(title);
    if (path) applyPath(path);
  }

  private async browsePython(): Promise<void> {
    if (!this.gateway) return;
    const result = await this.gateway.openFileDialog([
      { name: 'Python', extensions: ['exe'] },
    ]);
    if (result) this.host.configView.setPythonPath(result.path);
  }

  private async selectAutomationPlan(): Promise<void> {
    const currentTask = this.host.configView.getNormalFightTasks()[0];
    const selected = await this.host.pickAutomationPlan(currentTask);
    if (!selected) return;
    try {
      const result = await this.gateway?.readManagedCombatPlan(
        selected.plan.source,
        selected.plan.file,
      );
      if (!result?.success || !result.path) {
        throw new Error(result?.error || '无法读取所选出征计划');
      }
      const fleetPresetIndex = selected.fleetPresetIndex;
      const fleetName = fleetPresetIndex === undefined
        ? ''
        : selected.plan.fleets[fleetPresetIndex]?.name;
      if (fleetPresetIndex !== undefined && !fleetName) {
        throw new Error('所选使用舰队不存在');
      }
      const task: NormalFightTaskConfig = {
        name: selected.plan.file,
        source: selected.plan.source,
        ...(fleetPresetIndex === undefined
          ? {}
          : { fleet_preset_index: fleetPresetIndex }),
        times: normalFightDailyLimit(selected.dailyMaxExecutions),
      };
      this.host.configView.setNormalFightPlan(
        task,
        fleetName ?? '',
        this.host.getNormalFightRemaining(task),
      );
    } catch (error) {
      await showAlert(
        '无法加载出征计划',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async selectLootAutomationPlans(): Promise<void> {
    const plans = await this.host.pickLootAutomationPlans(
      this.host.configView.getLootPlans(),
    );
    if (plans) this.host.configView.setLootPlans(plans);
  }

  private async checkBackend(): Promise<void> {
    const port = this.host.configView.getBackendPort();
    this.host.configView.setBackendCheckLoading(true);
    this.host.configView.setBackendStatus('正在连接', 'unknown');
    try {
      const result = await new ApiClient(
        `http://localhost:${port}`,
      ).health();
      this.host.configView.setBackendStatus(
        result.success
          ? '接口正常'
          : (result.error || result.message || '接口异常'),
        result.success ? 'ok' : 'error',
      );
    } catch {
      this.host.configView.setBackendStatus('无法连接', 'error');
    } finally {
      this.host.configView.setBackendCheckLoading(false);
    }
  }

  private async validateCuda(): Promise<void> {
    if (!this.gateway) return;
    const { configView } = this.host;
    const cudaPath = configView.getCudaPath();
    configView.setCudaValidateLoading(true);
    configView.setCudaStatus(
      '检测中',
      'unknown',
      '正在检测 PyTorch、CUDA 和显卡',
    );
    try {
      const result = await this.gateway.validateCudaPath(cudaPath);
      if (result.valid) {
        if (result.path) configView.setCudaPath(result.path);
        const details = [
          result.device ?? 'CUDA 可用',
          result.version ? `CUDA ${result.version}` : null,
          result.torchVersion ? `PyTorch ${result.torchVersion}` : null,
        ].filter(Boolean);
        configView.setCudaStatus(
          result.version ? `CUDA ${result.version}` : 'GPU 可用',
          'ok',
          details.join('；'),
        );
      } else {
        const error = result.error ?? '未检测到可用 CUDA';
        const shortStatus = (
          result.torchVersion?.includes('+cpu')
          || error.includes('未检测到可用 CUDA')
        )
          ? '仅 CPU'
          : error.includes('路径')
            || error.includes('目录')
            || error.includes('Runtime DLL')
            ? '路径无效'
            : '检测失败';
        configView.setCudaStatus(shortStatus, 'error', error);
      }
    } catch {
      configView.setCudaStatus('检测失败', 'error', '硬件检测失败');
    } finally {
      configView.setCudaValidateLoading(false);
    }
  }

  private async validatePython(): Promise<void> {
    if (!this.gateway) return;
    const { configView } = this.host;
    const pythonPath = configView.getPythonPath();
    if (!pythonPath) {
      configView.setPythonStatus('"留空"将自动检测', 'unknown');
      return;
    }
    configView.setPythonValidateLoading(true);
    try {
      const result = await this.gateway.validatePython(pythonPath);
      configView.setPythonStatus(
        result.valid ? `✓ ${result.version}` : (result.error ?? '不兼容'),
        result.valid ? 'ok' : 'error',
      );
    } catch {
      configView.setPythonStatus('检测失败', 'error');
    } finally {
      configView.setPythonValidateLoading(false);
    }
  }

  private async checkAdbDevices(): Promise<void> {
    if (!this.gateway) return;
    this.host.configView.setAdbCheckLoading(true);
    try {
      const devices = await this.gateway.checkAdbDevices();
      const online = devices.filter(device => device.status === 'device');
      if (online.length === 0) {
        await showAlert(
          'ADB 检测',
          '未发现在线设备。\n请确认模拟器已启动。',
        );
      } else if (online.length === 1) {
        this.host.configView.setEmulatorSerial(online[0].serial);
        this.host.configView.setAdbStatus(
          `在线 (${online[0].serial})`,
          'online',
        );
        Logger.info(`ADB 检测到在线设备: ${online[0].serial}，已自动填入`);
      } else {
        const list = online.map(device => device.serial).join('\n');
        const confirmed = await showConfirm(
          'ADB 检测',
          `发现 ${online.length} 个在线设备：\n\n${list}\n\n是否将第一个设备填入 serial？`,
        );
        if (confirmed) {
          this.host.configView.setEmulatorSerial(online[0].serial);
          this.host.configView.setAdbStatus(
            `在线 (${online[0].serial})`,
            'online',
          );
        }
      }
    } catch (error) {
      await showAlert(
        'ADB 检测失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.host.configView.setAdbCheckLoading(false);
    }
  }

  private async changeAdbConnection(
    action: 'connect' | 'disconnect',
  ): Promise<void> {
    if (!this.gateway) return;

    const serial = this.host.configView.getEmulatorSerial();
    if (!serial) {
      await showAlert(
        'ADB 地址为空',
        '请先填写 ADB 地址，例如 127.0.0.1:16384。',
      );
      return;
    }

    this.host.configView.setAdbConnectionLoading(action, true);
    this.host.configView.setAdbStatus(
      action === 'connect' ? '正在连接' : '正在断开',
      'unknown',
    );

    try {
      const result = action === 'connect'
        ? await this.gateway.connectAdbDevice(serial)
        : await this.gateway.disconnectAdbDevice(serial);
      if (result.success) {
        const connected = action === 'connect';
        if (connected) {
          this.host.configView.setAdbStatus(
            'ADB 在线，正在连接后端',
            'unknown',
          );
          const systemConnected = await this.host.ensureSystemConnected();
          if (!systemConnected) {
            this.host.configView.setAdbStatus(
              'ADB 在线，后端连接失败',
              'offline',
            );
            Logger.warn(`ADB 已连接但后端系统启动失败: ${serial}`);
            await showAlert(
              '后端连接失败',
              'ADB 设备已经在线，但后端仍未连接模拟器。请检查 ADB 地址和后端日志后重试。',
            );
            return;
          }
        }
        this.host.configView.setAdbStatus(
          connected ? `在线 (${serial})` : '已断开',
          connected ? 'online' : 'offline',
        );
        Logger.info(`ADB ${connected ? '连接' : '断开'}成功: ${serial}`);
      } else {
        this.host.configView.setAdbStatus(
          `${action === 'connect' ? '连接' : '断开'}失败`,
          'offline',
        );
        await showAlert(
          `ADB ${action === 'connect' ? '连接' : '断开'}失败`,
          result.message,
        );
      }
    } catch (error) {
      this.host.configView.setAdbStatus('ADB 命令执行失败', 'offline');
      await showAlert(
        'ADB 操作失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.host.configView.setAdbConnectionLoading(action, false);
    }
  }

  private async updateShipLibrary(): Promise<void> {
    if (!this.gateway || this.shipLibraryUpdating) return;
    const updateTarget = this.shipLibraryUpdateTarget;
    this.shipLibraryUpdating = true;
    this.host.configView.setShipLibraryUpdateLoading(true);
    this.host.configView.setShipLibraryStatus(
      updateTarget === 'backend'
        ? '正在同步后端舰名库…'
        : '正在检查 Wiki 更新…',
      'unknown',
    );
    try {
      const result = await this.gateway.updateShipLibrary(updateTarget);
      if (!result.success) {
        const message = result.error || result.failures?.[0] || '未知错误';
        this.host.configView.setShipLibraryStatus(
          updateTarget === 'backend'
            ? '后端舰名库同步失败'
            : '舰船数据库更新失败',
          'error',
          message,
        );
        Logger.error(`舰船资料库更新失败: ${message}`);
        return;
      }
      if (updateTarget === 'wiki') await this.host.reloadShipLibrary();
      if (result.shipnames_sync_error) {
        Logger.error(
          `舰船资料库已更新，但后端舰名同步失败: ${result.shipnames_sync_error}`,
        );
      }
      Logger.info(
        updateTarget === 'backend'
          ? '后端舰名库同步完成'
          : 'Wiki 舰船资料库检查完成',
      );
      await this.refreshShipLibraryStatus(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.configView.setShipLibraryStatus(
        updateTarget === 'backend'
          ? '后端舰名库同步失败'
          : '舰船数据库更新失败',
        'error',
        message,
      );
      Logger.error(`舰船资料库更新失败: ${message}`);
    } finally {
      this.shipLibraryUpdating = false;
      this.host.configView.setShipLibraryUpdateLoading(false);
    }
  }

  private async checkUpdatesManually(): Promise<void> {
    if (!this.gateway) return;
    this.host.configView.setUpdateCheckLoading(true);

    try {
      Logger.info('已跳过后端源码更新检查（测试接口已停用）');
      try {
        const guiUpdate = await this.gateway.checkGuiUpdates();
        if (guiUpdate.status === 'error') {
          Logger.warn(`GUI 更新检查失败: ${guiUpdate.message}`);
          return;
        }
        // 无新版本：auto 与 manual 模式统一提示
        if (guiUpdate.status !== 'available') {
          Logger.info('GUI 已是最新版本');
          return;
        }
        Logger.info(
          `检测到 GUI 新版本 v${guiUpdate.version}，`
          + '更新选择已由系统窗口处理',
        );
      } catch {
        Logger.warn('GUI 更新检查失败');
      }
    } finally {
      this.host.configView.setUpdateCheckLoading(false);
    }
  }

  private openFolder(folderPath: string): void {
    if (!folderPath || !this.gateway) return;
    void this.gateway.openFolder(folderPath);
  }
}
