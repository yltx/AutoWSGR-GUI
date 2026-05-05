/**
 * ConfigController —— 配置管理子控制器。
 * 负责 loadConfig / saveConfig / renderConfig / detectAndApplyEmulator / showSetupWizard
 */
import type { ConfigModel } from '../../model/ConfigModel';
import type { ConfigView } from '../../view/config/ConfigView';
import type { SetupWizardView } from '../../view/setup/SetupWizardView';
import type { MainView } from '../../view/main/MainView';
import type { Scheduler, CronScheduler } from '../../model/scheduler';
import type { TemplateController } from '../template/TemplateController';
import type { StartupController } from '../startup/StartupController';
import type { ConfigViewObject } from '../../types/view';
import { Logger } from '../../utils/Logger';
import { getThemeMode, getAccentColor, applyTheme } from './theme';
import { showAlert } from '../shared/DialogHelper';

export interface ConfigControllerHost {
  readonly configModel: ConfigModel;
  readonly configView: ConfigView;
  readonly setupView: SetupWizardView;
  readonly mainView: MainView;
  readonly scheduler: Scheduler;
  readonly cronScheduler: CronScheduler;
  templateCtrl: TemplateController;
  startupCtrl: StartupController;
  configDir: string;
}

export class ConfigController {
  constructor(private readonly host: ConfigControllerHost) {}

  /** 从磁盘加载 usersettings.yaml */
  async loadConfig(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) return;
    try {
      const yamlStr = await bridge.readFile('usersettings.yaml');
      this.host.configModel.loadFromYaml(yamlStr);
      Logger.debug('usersettings.yaml 已加载');
    } catch {
      Logger.debug('usersettings.yaml 未找到，自动创建默认配置');
      const defaultYaml = this.host.configModel.toYaml();
      await bridge.saveFile('usersettings.yaml', defaultYaml);
      Logger.info(`已创建默认配置文件: ${this.host.configDir}\\usersettings.yaml`);
    }
  }

  /** 渲染配置视图 */
  renderConfig(): void {
    const cfg = this.host.configModel.current;
    const vo: ConfigViewObject = {
      emulatorType: cfg.emulator.type,
      emulatorPath: cfg.emulator.path || '',
      emulatorSerial: cfg.emulator.serial || '',
      gameApp: cfg.account.game_app,
      updateMode: window.electronBridge?.getUpdateMode?.()
        ?? (localStorage.getItem('updateMode') === 'manual' ? 'manual' : 'auto'),
      autoExpedition: cfg.daily_automation.auto_expedition,
      expeditionInterval: cfg.daily_automation.expedition_interval,
      autoBattle: cfg.daily_automation.auto_battle,
      battleType: cfg.daily_automation.battle_type,
      autoExercise: cfg.daily_automation.auto_exercise,
      exerciseFleetId: cfg.daily_automation.exercise_fleet_id,
      battleTimes: cfg.daily_automation.battle_times,
      autoNormalFight: cfg.daily_automation.auto_normal_fight,
      autoDecisive: cfg.daily_automation.auto_decisive,
      decisiveTicketReserve: cfg.daily_automation.decisive_ticket_reserve,
      decisiveTemplateId: cfg.daily_automation.decisive_template_id,
      autoLoot: cfg.daily_automation.auto_loot,
      lootPlanIndex: cfg.daily_automation.loot_plan_index,
      lootStopCount: cfg.daily_automation.loot_stop_count,
      themeMode: getThemeMode(),
      accentColor: getAccentColor(),
      debugMode: localStorage.getItem('debugMode') === 'true',
      backendPort: window.electronBridge?.getBackendPort?.() ?? 8438,
      backendStartupMode: window.electronBridge?.getBackendStartupMode?.() ?? 'managed',
      backendRepoPath: window.electronBridge?.getBackendRepoPath?.() ?? '',
      ocrGpuMode: window.electronBridge?.getOcrGpuMode?.() ?? 'auto',
      saveBackendScreenshots: window.electronBridge?.getSaveBackendScreenshots?.() ?? false,
      pythonPath: window.electronBridge?.getPythonPath?.() ?? '',
    };
    this.host.configView.render(vo);
    this.host.templateCtrl.populateDecisiveSelect(cfg.daily_automation.decisive_template_id);
  }

  /** 保存配置并同步各组件 */
  async saveConfig(): Promise<void> {
    const collected = this.host.configView.collect();
    const bridge = window.electronBridge;

    if (collected.backendStartupMode === 'external' && !collected.backendRepoPath.trim()) {
      await showAlert('请配置本地后端路径', '启用“使用本地后端”时必须选择本地后端仓库路径。');
      return;
    }

    // 界面设置 → localStorage
    localStorage.setItem('themeMode', collected.themeMode);
    localStorage.setItem('accentColor', collected.accentColor);
    localStorage.setItem('debugMode', String(collected.debugMode));
    localStorage.setItem('updateMode', collected.updateMode);
    this.host.mainView.setDebugMode(collected.debugMode);
    applyTheme();

    if (bridge?.setUpdateMode) {
      await bridge.setUpdateMode(collected.updateMode);
    }

    // 后端端口 / Python 路径（修改后需重启）
    if (bridge?.setBackendPort) {
      await bridge.setBackendPort(collected.backendPort);
    }
    if (bridge?.setBackendStartupMode) {
      await bridge.setBackendStartupMode(collected.backendStartupMode);
    }
    if (bridge?.setBackendRepoPath) {
      await bridge.setBackendRepoPath(collected.backendRepoPath || null);
    }
    if (bridge?.setOcrGpuMode) {
      await bridge.setOcrGpuMode(collected.ocrGpuMode);
    }
    if (bridge?.setSaveBackendScreenshots) {
      await bridge.setSaveBackendScreenshots(collected.saveBackendScreenshots);
    }
    if (bridge?.setPythonPath) {
      await bridge.setPythonPath(collected.pythonPath || null);
    }

    this.host.configModel.update({
      emulator: {
        type: collected.emulatorType,
        path: collected.emulatorPath || undefined,
        serial: collected.emulatorSerial || undefined,
      },
      account: { game_app: collected.gameApp },
      daily_automation: {
        auto_expedition: collected.autoExpedition,
        expedition_interval: collected.expeditionInterval,
        auto_battle: collected.autoBattle,
        battle_type: collected.battleType,
        auto_exercise: collected.autoExercise,
        exercise_fleet_id: collected.exerciseFleetId,
        battle_times: collected.battleTimes,
        auto_normal_fight: collected.autoNormalFight,
        auto_decisive: collected.autoDecisive,
        decisive_ticket_reserve: collected.decisiveTicketReserve,
        decisive_template_id: collected.decisiveTemplateId,
        auto_loot: collected.autoLoot,
        loot_plan_index: collected.lootPlanIndex,
        loot_stop_count: collected.lootStopCount,
      },
    });

    // 同步 CronScheduler
    const da = this.host.configModel.current.daily_automation;
    this.host.cronScheduler.updateConfig({
      autoExercise: da.auto_exercise,
      exerciseFleetId: da.exercise_fleet_id,
      autoBattle: da.auto_battle,
      battleType: da.battle_type,
      battleTimes: da.battle_times,
      autoNormalFight: da.auto_normal_fight,
      autoLoot: da.auto_loot,
      lootPlanIndex: da.loot_plan_index,
      lootStopCount: da.loot_stop_count,
    });

    // 远征检查间隔
    this.host.scheduler.setExpeditionInterval(da.expedition_interval);

    const yamlStr = this.host.configModel.toYaml();
    console.log('保存配置:\n', yamlStr);

    if (bridge) {
      await bridge.saveFile('usersettings.yaml', yamlStr);
    }

    Logger.info('配置已保存');

    // 未连接 → 尝试重连
    if (this.host.scheduler.status === 'not_connected') {
      const alive = await this.host.scheduler.ping();
      if (alive) {
        Logger.info('配置已更新，正在重新连接模拟器…');
        this.host.startupCtrl.startSystem();
      } else {
        Logger.warn('后端未运行，请重启应用');
      }
    }
  }

  /** 自动检测模拟器信息，仅在配置为空时填充 */
  async detectAndApplyEmulator(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge?.detectEmulator) return;

    const cfg = this.host.configModel.current;
    if (cfg.emulator.path && cfg.emulator.serial) return;

    try {
      const result = await bridge.detectEmulator();
      if (!result) return;

      const patch: { type?: string; path?: string; serial?: string } = {};
      if (!cfg.emulator.path && result.path) patch.path = result.path;
      if (!cfg.emulator.serial && result.serial) patch.serial = result.serial;
      if (result.type) patch.type = result.type;

      if (Object.keys(patch).length > 0) {
        this.host.configModel.update({ emulator: patch as any });
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
        const bridge = window.electronBridge;
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
        if (window.electronBridge?.setPythonPath) {
          await window.electronBridge.setPythonPath(pyPath);
        }

        const bridge = window.electronBridge;
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
