/** 编排设置加载、环境检测、表单保存和配置持久化。 */
/**
 * ConfigController —— 配置管理子控制器。
 * 负责 loadConfig / saveConfig / renderConfig / detectAndApplyEmulator / showSetupWizard
 */
import { ConfigModel } from '../../model/ConfigModel';
import type { ConfigView } from '../../view/config/ConfigView';
import type { SetupWizardView } from '../../view/setup/SetupWizardView';
import type { MainView } from '../../view/main/MainView';
import type { Scheduler, CronScheduler } from '../../model/scheduler';
import type { StartupController } from '../startup/StartupController';
import type {
  EmulatorConfig,
  GuiAutomationSettings,
} from '../../types/model.js';
import type { ConfigViewObject } from '../../types/view.js';
import type {
  LegacyDecisiveAutomationSettings,
} from '../../shared/legacyDecisiveAutomation.js';
import {
  normalizeDecisiveAutomationSource,
} from '../../shared/decisiveAutomation.js';
import {
  formatStringMap,
  parseStringMap,
} from '../../adapter/YamlAdapter';
import {
  getConfigurationGateway,
  type ConfigurationGateway,
} from '../../adapter/IpcAdapter';
import { Logger } from '../../utils/Logger';
import {
  applyTheme,
  getAccentColor,
  getThemeMode,
} from '../../view/theme';
import { showAlert, showSaveSuccess } from '../../view/shared/DialogHelper';

const GUI_AUTOMATION_FIELDS = [
  'expeditionInterval',
  'battleTimes',
  'autoDecisive',
  'decisiveTemplateId',
  'autoLoot',
  'lootPlanSource',
  'lootPlanId',
  'lootPlans',
  'lootStopCount',
] as const satisfies readonly (keyof GuiAutomationSettings)[];

function guiAutomationFieldMatches(
  left: GuiAutomationSettings,
  right: GuiAutomationSettings,
  field: typeof GUI_AUTOMATION_FIELDS[number],
): boolean {
  if (field === 'lootPlans') {
    return JSON.stringify(left.lootPlans) === JSON.stringify(right.lootPlans);
  }
  return left[field] === right[field];
}

export interface ConfigControllerHost {
  readonly configModel: ConfigModel;
  readonly configView: ConfigView;
  readonly setupView: SetupWizardView;
  readonly mainView: MainView;
  readonly scheduler: Scheduler;
  readonly cronScheduler: CronScheduler;
  startupCtrl: StartupController | null;
  configDir: string;
}

export class ConfigController {
  constructor(
    private readonly host: ConfigControllerHost,
    private readonly gateway: ConfigurationGateway | undefined =
      getConfigurationGateway(),
  ) {}

  setConfigDir(configDir: string): void {
    this.host.configDir = configDir;
  }

  setStartupController(startupCtrl: StartupController): void {
    this.host.startupCtrl = startupCtrl;
  }

  /** 从磁盘加载 usersettings.yaml */
  async loadConfig(): Promise<void> {
    const bridge = this.gateway;
    if (!bridge) return;

    let yamlStr = '';
    try {
      yamlStr = await bridge.readFile('usersettings.yaml');
    } catch {
      // 读取异常（文件缺失/损坏）与内容为空同等处理：创建默认配置
      yamlStr = '';
    }
    if (yamlStr.trim()) {
      this.host.configModel.loadFromYaml(yamlStr);
      Logger.debug('usersettings.yaml 已加载');
    } else {
      Logger.debug('usersettings.yaml 未找到，自动创建默认配置');
      const defaultYaml = this.host.configModel.toYaml();
      await bridge.saveFile('usersettings.yaml', defaultYaml);
      Logger.info(`已创建默认配置文件: ${this.host.configDir}\\usersettings.yaml`);
    }

    const stored = await bridge.getGuiAutomationSettings?.();
    const migrated = this.host.configModel.migratedGuiAutomation;
    const migratedDecisive =
      this.host.configModel.migratedLegacyDecisiveAutomation;
    const decisiveAutomation: Partial<GuiAutomationSettings> = {};
    if (typeof migratedDecisive.autoDecisive === 'boolean') {
      decisiveAutomation.autoDecisive =
        migratedDecisive.autoDecisive;
    }
    if (migratedDecisive.templateId) {
      decisiveAutomation.decisiveTemplateId =
        normalizeDecisiveAutomationSource(
          migratedDecisive.templateId,
        );
    }
    const storedSettings = stored?.exists ? stored.settings : {};
    const merged = {
      ...migrated,
      ...decisiveAutomation,
      ...storedSettings,
    };
    if (
      storedSettings.autoLoot === true
      && !Object.prototype.hasOwnProperty.call(
        storedSettings,
        'lootPlanId',
      )
      && !Object.prototype.hasOwnProperty.call(migrated, 'lootPlanId')
    ) {
      merged.autoLoot = false;
    }
    this.host.configModel.replaceGuiAutomation(merged);

    const hasLegacyGuiAutomation = Object.keys(migrated).length > 0;
    const hasLegacyDecisiveAutomation =
      Object.keys(decisiveAutomation).length > 0;
    const storedIsPartial = stored?.exists === true
      && GUI_AUTOMATION_FIELDS.some(field => (
        !Object.prototype.hasOwnProperty.call(storedSettings, field)
      ));
    let guiAutomationMigrated = false;
    if (
      hasLegacyGuiAutomation
      || hasLegacyDecisiveAutomation
      || storedIsPartial
    ) {
      if (typeof bridge.setGuiAutomationSettings !== 'function') {
        Logger.warn(
          'GUI 自动化配置迁移接口不可用，旧 YAML 字段已保留',
        );
      } else {
        const expected = structuredClone(
          this.host.configModel.currentGuiAutomation,
        );
        const saved = await bridge.setGuiAutomationSettings(expected);
        for (const field of GUI_AUTOMATION_FIELDS) {
          if (!guiAutomationFieldMatches(saved, expected, field)) {
            throw new Error(`GUI 自动化配置回读字段不一致: ${field}`);
          }
        }
        this.host.configModel.replaceGuiAutomation(saved);
        if (hasLegacyGuiAutomation) {
          this.host.configModel.markLegacyGuiAutomationMigrated();
          guiAutomationMigrated = true;
        }
      }
    }
    const decisiveMigrated =
      await this.migrateLegacyDecisiveAutomation();
    if (
      guiAutomationMigrated
      || decisiveMigrated
    ) {
      await bridge.saveFile('usersettings.yaml', this.host.configModel.toYaml());
      Logger.info('已将旧版配置迁移到 gui_settings.json');
    }
  }

  /**
   * 将旧版决战开关和模板升级为正式配置，并归档票数保留原值。
   * 只有主进程写入、回读和用户提示全部完成后才允许清理 YAML。
   */
  private async migrateLegacyDecisiveAutomation():
    Promise<boolean> {
    const settings =
      this.host.configModel.migratedLegacyDecisiveAutomation;
    const invalidFields =
      this.host.configModel.unmigratedLegacyDecisiveFields;
    const suppliedFields = [
      'autoDecisive',
      'ticketReserve',
      'templateId',
    ] as const;
    const supplied = suppliedFields.filter(field => (
      Object.prototype.hasOwnProperty.call(settings, field)
    ));
    if (supplied.length === 0) {
      if (invalidFields.length > 0) {
        await showAlert(
          '旧版决战配置暂未迁移',
          `以下字段格式无法识别，已继续保留在 usersettings.yaml：\n${
            invalidFields.join('、')
          }`,
        );
      }
      return false;
    }

    const bridge = this.gateway;
    if (
      typeof bridge?.migrateLegacyDecisiveAutomation !== 'function'
    ) {
      await showAlert(
        '旧版决战配置暂未迁移',
        '当前配置迁移接口不可用，原字段仍保留在 usersettings.yaml。'
          + '请完整重启 GUI 后重试。',
      );
      return false;
    }

    try {
      const verified =
        await bridge.migrateLegacyDecisiveAutomation(settings);
      for (const field of supplied) {
        if (verified[field] !== settings[field]) {
          throw new Error(`回读字段不一致: ${field}`);
        }
      }
      const summary = this.legacyDecisiveMigrationSummary(settings);
      if (invalidFields.length > 0) {
        summary.push(
          `格式无法识别并继续保留在 usersettings.yaml：${
            invalidFields.join('、')
          }`,
        );
      }
      summary.push(
        '',
        '自动决战开关和模板已升级为正式 GUI 自动化设置；'
          + '决战票保留仅无损保存，不参与执行轮数。'
          + '迁移不会覆盖当前决战计划。',
      );
      await showAlert('旧版决战配置已升级', summary.join('\n'));
      this.host.configModel.markLegacyDecisiveAutomationMigrated(
        settings,
      );
      return true;
    } catch (error) {
      Logger.warn(
        `旧版决战配置迁移失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await showAlert(
        '旧版决战配置迁移失败',
        '原字段仍保留在 usersettings.yaml，将在下次启动时重试。',
      );
      return false;
    }
  }

  /** 生成人能直接核对的逐字段迁移结果。 */
  private legacyDecisiveMigrationSummary(
    settings: LegacyDecisiveAutomationSettings,
  ): string[] {
    const summary: string[] = [];
    if (
      Object.prototype.hasOwnProperty.call(settings, 'autoDecisive')
    ) {
      summary.push(
        `自动决战：${settings.autoDecisive ? '开启' : '关闭'}`,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(settings, 'ticketReserve')
    ) {
      summary.push(`决战票保留：${settings.ticketReserve}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(settings, 'templateId')
    ) {
      summary.push(`决战模板：${settings.templateId}`);
    }
    return summary;
  }

  /** 渲染配置视图 */
  renderConfig(): void {
    const cfg = this.host.configModel.current;
    const gui = this.host.configModel.currentGuiAutomation;
    const windowPreferences = this.gateway?.getWindowPreferences() ?? {
      defaultWidth: 1280,
      defaultHeight: 720,
      rememberBounds: false,
    };
    const vo: ConfigViewObject = {
      emulatorType: cfg.emulator.type,
      emulatorPath: cfg.emulator.path || '',
      emulatorSerial: cfg.emulator.serial || '',
      gameApp: cfg.account.game_app,
      updateMode: this.gateway?.getUpdateMode()
        ?? (localStorage.getItem('updateMode') === 'manual' ? 'manual' : 'auto'),
      autoExpedition: cfg.daily_automation.auto_expedition,
      expeditionInterval: gui.expeditionInterval,
      autoBattle: cfg.daily_automation.auto_battle,
      battleType: cfg.daily_automation.battle_type,
      autoExercise: cfg.daily_automation.auto_exercise,
      exerciseFleetId: cfg.daily_automation.exercise_fleet_id ?? 1,
      battleTimes: gui.battleTimes,
      autoNormalFight: cfg.daily_automation.auto_normal_fight,
      normalFightTasks: cfg.daily_automation.normal_fight_tasks,
      autoDecisive: gui.autoDecisive,
      decisiveTemplateId: gui.decisiveTemplateId,
      autoLoot: gui.autoLoot,
      lootPlanSource: gui.lootPlanSource,
      lootPlanId: gui.lootPlanId,
      lootPlans: structuredClone(gui.lootPlans),
      lootStopCount: gui.lootStopCount,
      logLevel: cfg.log.level,
      logRoot: cfg.log.root,
      themeMode: getThemeMode(),
      accentColor: getAccentColor(),
      debugMode: localStorage.getItem('debugMode') === 'true',
      backendPort: this.gateway?.getBackendPort() ?? 8438,
      backendStartupMode:
        this.gateway?.getBackendStartupMode() ?? 'managed',
      backendRepoPath: this.gateway?.getBackendRepoPath() ?? '',
      ocrGpuMode: this.gateway?.getOcrGpuMode() ?? 'auto',
      ocrGpu: cfg.ocr.gpu,
      ocrMirror: cfg.ocr.mirror,
      enhancedShipOcr: cfg.ocr.enhanced_ship_ocr,
      ocrConfidence: cfg.ocr.ship_name_match_confidence,
      shipNameAliasesText: formatStringMap(
        cfg.ocr.ship_name_aliases,
      ),
      shipNameCorrectionsText: formatStringMap(
        cfg.ocr.ship_name_corrections,
      ),
      cudaPath: this.gateway?.getCudaPath() ?? '',
      saveBackendScreenshots:
        this.gateway?.getSaveBackendScreenshots() ?? false,
      pythonPath: this.gateway?.getPythonPath() ?? '',
      defaultWindowWidth: windowPreferences.defaultWidth,
      defaultWindowHeight: windowPreferences.defaultHeight,
      rememberWindowBounds: windowPreferences.rememberBounds,
      operationDelayMin: cfg.operation_delay_min,
      operationDelayMax: cfg.operation_delay_max,
      dockFullDestroy: cfg.dock_full_destroy,
      repairManually: cfg.repair_manually,
      bathroomCount: cfg.bathroom_count,
      destroyShipWorkMode: cfg.destroy_ship_work_mode,
      destroyShipTypes: cfg.destroy_ship_types,
      removeEquipmentMode: cfg.remove_equipment_mode,
      planRoot: cfg.plan_root ?? '',
    };
    this.host.configView.render(vo);
  }

  /** 保存配置并同步各组件 */
  async saveConfig(): Promise<void> {
    let collected: ConfigViewObject;
    let shipNameAliases: Record<string, string>;
    let shipNameCorrections: Record<string, string>;
    try {
      collected = this.host.configView.collect();
      shipNameAliases = parseStringMap(
        collected.shipNameAliasesText,
        '自定义舰名映射',
      );
      shipNameCorrections = parseStringMap(
        collected.shipNameCorrectionsText,
        '识别纠错规则',
      );
    } catch (error) {
      await showAlert(
        '设置格式错误',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const bridge = this.gateway;
    if (!bridge || typeof bridge.commitGuiSettings !== 'function') {
      await showAlert(
        '保存失败',
        '设置保存接口不完整，请完整重启 GUI 后再操作。',
      );
      return;
    }

    if (collected.backendStartupMode === 'external' && !collected.backendRepoPath.trim()) {
      await showAlert('请配置本地后端路径', '启用“使用本地后端”时必须选择本地后端仓库路径。');
      return;
    }

    try {
      const candidateModel = new ConfigModel();
      candidateModel.loadFromYaml(this.host.configModel.toYaml());
      candidateModel.replaceGuiAutomation(
        this.host.configModel.currentGuiAutomation,
      );
      this.applyCollectedConfig(
        candidateModel,
        collected,
        shipNameAliases,
        shipNameCorrections,
      );
      candidateModel.markLegacyGuiAutomationMigrated();

      const committed = await bridge.commitGuiSettings({
        updateMode: collected.updateMode,
        backendPort: collected.backendPort,
        backendStartupMode: collected.backendStartupMode,
        backendRepoPath: collected.backendRepoPath || null,
        ocrGpuMode: collected.ocrGpuMode,
        cudaPath: collected.cudaPath || null,
        saveBackendScreenshots: collected.saveBackendScreenshots,
        pythonPath: collected.pythonPath || null,
        windowPreferences: {
          defaultWidth: collected.defaultWindowWidth,
          defaultHeight: collected.defaultWindowHeight,
          rememberBounds: collected.rememberWindowBounds,
        },
        automation: candidateModel.currentGuiAutomation,
        usersettingsYaml: candidateModel.toYaml(),
      });

      this.applyCollectedConfig(
        this.host.configModel,
        collected,
        shipNameAliases,
        shipNameCorrections,
      );
      this.host.configModel.replaceGuiAutomation(committed.automation);
      this.host.configModel.markLegacyGuiAutomationMigrated();

      localStorage.setItem('themeMode', collected.themeMode);
      localStorage.setItem('accentColor', collected.accentColor);
      localStorage.setItem('debugMode', String(collected.debugMode));
      localStorage.setItem('updateMode', collected.updateMode);
      this.host.mainView.setDebugMode(collected.debugMode);
      applyTheme();

      const da = this.host.configModel.current.daily_automation;
      const gui = this.host.configModel.currentGuiAutomation;
      this.host.cronScheduler.updateConfig({
        autoExercise: da.auto_exercise,
        exerciseFleetId: da.exercise_fleet_id ?? 1,
        autoBattle: da.auto_battle,
        battleType: da.battle_type,
        battleTimes: gui.battleTimes,
        autoNormalFight: da.auto_normal_fight,
        autoDecisive: gui.autoDecisive,
        decisiveTemplateId: gui.decisiveTemplateId,
        autoLoot: gui.autoLoot,
        lootPlanSource: gui.lootPlanSource,
        lootPlanId: gui.lootPlanId,
        lootStopCount: gui.lootStopCount,
      });
      this.host.scheduler.setAutoExpedition(da.auto_expedition);
      this.host.scheduler.setExpeditionInterval(gui.expeditionInterval);

      Logger.info('设置已保存，后端启动项将在重启后生效');
    } catch (error) {
      await showAlert(
        '保存失败',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    showSaveSuccess('设置保存成功');

    // 未连接 → 尝试重连
    if (this.host.scheduler.status === 'not_connected') {
      const alive = await this.host.scheduler.ping();
      if (alive) {
        Logger.info('配置已更新，正在重新连接模拟器…');
        this.host.startupCtrl?.startSystem();
      } else {
        Logger.warn('后端未运行，请重启应用');
      }
    }
  }

  /** 把设置页输入应用到指定模型，供候选配置和正式提交复用。 */
  private applyCollectedConfig(
    model: ConfigModel,
    collected: ConfigViewObject,
    shipNameAliases: Record<string, string>,
    shipNameCorrections: Record<string, string>,
  ): void {
    model.update({
      emulator: {
        type: collected.emulatorType,
        path: collected.emulatorPath || undefined,
        serial: collected.emulatorSerial || undefined,
      },
      account: { game_app: collected.gameApp },
      ocr: {
        ...model.current.ocr,
        gpu: collected.ocrGpu,
        mirror: collected.ocrMirror,
        enhanced_ship_ocr: collected.enhancedShipOcr,
        ship_name_match_confidence: collected.ocrConfidence,
        ship_name_aliases: shipNameAliases,
        ship_name_corrections: shipNameCorrections,
      },
      log: {
        ...model.current.log,
        level: collected.logLevel,
        root: collected.logRoot,
      },
      daily_automation: {
        ...model.current.daily_automation,
        auto_expedition: collected.autoExpedition,
        auto_battle: collected.autoBattle,
        battle_type: collected.battleType,
        auto_exercise: collected.autoExercise,
        exercise_fleet_id: collected.exerciseFleetId,
        auto_normal_fight: collected.autoNormalFight,
        normal_fight_tasks: collected.normalFightTasks,
      },
      operation_delay_min: collected.operationDelayMin,
      operation_delay_max: collected.operationDelayMax,
      dock_full_destroy: collected.dockFullDestroy,
      repair_manually: collected.repairManually,
      bathroom_count: collected.bathroomCount,
      destroy_ship_work_mode: collected.destroyShipWorkMode,
      destroy_ship_types: collected.destroyShipTypes,
      remove_equipment_mode: collected.removeEquipmentMode,
      plan_root: collected.planRoot || undefined,
    });
    model.updateGuiAutomation({
      expeditionInterval: collected.expeditionInterval,
      battleTimes: collected.battleTimes,
      autoDecisive: collected.autoDecisive,
      decisiveTemplateId: collected.decisiveTemplateId,
      autoLoot: collected.autoLoot,
      lootPlanSource: collected.lootPlanSource,
      lootPlanId: collected.lootPlanId,
      lootPlans: collected.lootPlans,
      lootStopCount: collected.lootStopCount,
    });
  }

  /** 自动检测模拟器信息，仅在配置为空时填充 */
  async detectAndApplyEmulator(): Promise<void> {
    const bridge = this.gateway;
    if (!bridge?.detectEmulator) return;

    const cfg = this.host.configModel.current;
    if (cfg.emulator.path && cfg.emulator.serial) return;

    try {
      const result = await bridge.detectEmulator();
      if (!result) return;

      const patch: Partial<EmulatorConfig> = {};
      if (!cfg.emulator.path && result.path) patch.path = result.path;
      if (!cfg.emulator.serial && result.serial) patch.serial = result.serial;
      if (result.type) patch.type = result.type;

      if (Object.keys(patch).length > 0) {
        this.host.configModel.update({
          emulator: { ...cfg.emulator, ...patch },
        });
        const yamlStr = this.host.configModel.toYaml();
        await bridge.saveFile('usersettings.yaml', yamlStr);
        Logger.debug(`自动检测到模拟器: type=${result.type} path=${result.path} serial=${result.serial}`);
      }
    } catch (e) {
      Logger.debug(`模拟器自动检测失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 首次运行引导向导 */
  showSetupWizard(): Promise<void> {
    const cfg = this.host.configModel.current;
    this.host.setupView.show({
      emuType: cfg.emulator.type || '雷电',
      serial: cfg.emulator.serial || '',
      pythonPath: '',
    });

    return new Promise<void>((resolve) => {
      this.host.setupView.onCheckAdb = async () => {
        const bridge = this.gateway;
        if (!bridge?.checkAdbDevices) return;
        this.host.setupView.setCheckAdbLoading(true);
        try {
          const devices = await bridge.checkAdbDevices();
          const online = devices.filter(d => d.status === 'device');
          if (online.length > 0) {
            this.host.setupView.setSerialValue(online[0].serial);
            this.host.setupView.setSerialHint(`已检测到设备: ${online.map(d => d.serial).join(', ')}`, 'info');
          } else {
            this.host.setupView.setSerialHint('未发现在线设备，请确认模拟器已启动。', 'error');
          }
        } catch {
          this.host.setupView.setSerialHint('检测失败，请手动填写。', 'error');
        } finally {
          this.host.setupView.setCheckAdbLoading(false);
        }
      };

      this.host.setupView.onConfirm = async () => {
        const vals = this.host.setupView.collectValues();
        if (!vals.serial) {
          this.host.setupView.setSerialHint('请填写 ADB serial（不能为空）', 'error');
          this.host.setupView.focusSerial();
          return;
        }

        this.host.configModel.update({
          emulator: {
            type: vals.emuType,
            serial: vals.serial,
          },
        });

        const pyPath = vals.pythonPath || null;
        if (this.gateway?.setPythonPath) {
          await this.gateway.setPythonPath(pyPath);
        }

        const bridge = this.gateway;
        if (bridge) {
          await bridge.saveFile('usersettings.yaml', this.host.configModel.toYaml());
        }

        localStorage.setItem('setupComplete', 'true');
        this.host.setupView.hide();
        Logger.info(`初始配置完成: 模拟器=${vals.emuType}, serial=${vals.serial}`);
        resolve();
      };
    });
  }

}
