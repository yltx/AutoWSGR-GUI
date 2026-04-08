/**
 * AppController —— 核心控制器（瘦身版）。
 * 协调 Model 和 View，委托子控制器与独立函数处理细分逻辑。
 */
import { MainView } from '../../view/main/MainView';
import { PlanPreviewView } from '../../view/plan/PlanPreviewView';
import { ConfigView } from '../../view/config/ConfigView';
import { TaskGroupView } from '../../view/taskGroup/TaskGroupView';
import { SetupWizardView } from '../../view/setup/SetupWizardView';
import type { MainViewObject, TaskQueueItemVO } from '../../types/view';
import { ConfigModel } from '../../model/ConfigModel';
import { ApiClient } from '../../model/ApiClient';
import type { ApiResponse } from '../../types/api';
import { Scheduler, CronScheduler } from '../../model/scheduler';
import { TaskGroupModel } from '../../model/TaskGroupModel';
import { TemplateModel } from '../../model/TemplateModel';
import { Logger } from '../../utils/Logger';
import { showPrompt, showConfirm, showAlert } from '../shared/DialogHelper';
import { TemplateController } from '../template/TemplateController';
import { TaskGroupController } from '../taskGroup/TaskGroupController';
import { PlanController } from '../plan/PlanController';
import { StartupController } from '../startup/StartupController';

import { SchedulerBinder } from './SchedulerBinder';
import { ConfigController } from './ConfigController';
import { applyTheme, getThemeMode } from './theme';
import { buildMainViewObject, type RenderingState } from './rendering';
import { PRIORITY_LABELS, STATUS_TEXT } from './constants';

export class AppController {
  private mainView: MainView;
  private planView: PlanPreviewView;
  private configView: ConfigView;
  private taskGroupView: TaskGroupView;
  private setupView: SetupWizardView;

  private configModel: ConfigModel;
  private taskGroupModel: TaskGroupModel;
  private templateModel: TemplateModel;

  private api: ApiClient;
  private scheduler: Scheduler;
  private cronScheduler: CronScheduler;
  private schedulerBinder: SchedulerBinder;
  private configCtrl: ConfigController;

  private appRoot = '';
  private plansDir = '';
  private configDir = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private templateCtrl!: TemplateController;
  private taskGroupCtrl!: TaskGroupController;
  private planCtrl!: PlanController;
  private startupCtrl!: StartupController;

  /** 待安装的 GUI 版本号 */
  pendingGuiVersion: string | null = null;

  constructor() {
    this.mainView = new MainView();
    this.planView = new PlanPreviewView();
    this.configView = new ConfigView();
    this.taskGroupView = new TaskGroupView();
    this.setupView = new SetupWizardView();
    this.configModel = new ConfigModel();
    this.taskGroupModel = new TaskGroupModel();
    this.templateModel = new TemplateModel();

    const rawPort = window.electronBridge?.getBackendPort?.();
    let port = Number(rawPort);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      port = 8438;
    }
    this.api = new ApiClient(`http://localhost:${port}`);
    this.scheduler = new Scheduler(this.api);

    const cfg = this.configModel.current.daily_automation;
    this.cronScheduler = new CronScheduler({
      autoExercise: cfg.auto_exercise,
      exerciseFleetId: cfg.exercise_fleet_id,
      autoBattle: cfg.auto_battle,
      battleType: cfg.battle_type,
      battleTimes: cfg.battle_times,
      autoNormalFight: cfg.auto_normal_fight,
      autoLoot: cfg.auto_loot,
      lootPlanIndex: cfg.loot_plan_index,
      lootStopCount: cfg.loot_stop_count,
    });

    this.schedulerBinder = new SchedulerBinder({
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      api: this.api,
      templateModel: this.templateModel,
      renderMain: () => this.renderMain(),
      updateOpsAvailability: (c) => this.updateOpsAvailability(c),
    });

    // configCtrl 创建延迟到 init()（需要子控制器引用）
    this.configCtrl = null!;
  }

  /** 初始化：绑定事件、渲染初始状态、自动连接后端 */
  init(): void {
    applyTheme();
    this.bindNavigation();
    this.bindActions();
    this.schedulerBinder.bindSchedulerCallbacks();
    this.schedulerBinder.bindCronCallbacks();

    this.planCtrl = new PlanController(this.planView, {
      scheduler: this.scheduler,
      plansDir: '',
      renderMain: () => this.renderMain(),
      switchPage: (p) => this.switchPage(p),
    });
    this.planCtrl.bindActions();

    this.taskGroupCtrl = new TaskGroupController(
      this.taskGroupModel, this.taskGroupView, this.templateModel,
      this.mainView, {
        scheduler: this.scheduler,
        plansDir: '',
        renderMain: () => this.renderMain(),
        switchPage: (p) => this.switchPage(p),
        importTaskPreset: (preset, fp) => this.planCtrl.importTaskPreset(preset, fp),
        getCurrentPlan: () => this.planCtrl.getCurrentPlan(),
        setCurrentPlan: (plan, mapData) => this.planCtrl.setCurrentPlan(plan, mapData),
        renderPlanPreview: () => this.planCtrl.renderPlanPreview(),
        closePresetDetail: () => this.planCtrl.closePresetDetail(),
        executePreset: () => this.planCtrl.executePreset(),
        getCurrentPresetInfo: () => this.planCtrl.getCurrentPresetInfo(),
      },
    );
    this.taskGroupCtrl.bindActions();

    this.templateCtrl = new TemplateController(
      this.templateModel, this.taskGroupModel,
      () => this.taskGroupCtrl.render(), '', '',
    );
    this.templateCtrl.bindActions();

    // 现在可以创建 configCtrl（依赖 templateCtrl / startupCtrl 后续会赋值）
    this.configCtrl = new ConfigController({
      configModel: this.configModel,
      configView: this.configView,
      setupView: this.setupView,
      mainView: this.mainView,
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      templateCtrl: this.templateCtrl,
      startupCtrl: null!, // 在 startupCtrl 创建后回填
      configDir: this.configDir,
    });

    this.bindOpsActions();
    this.renderMain();
    this.planView.render(null);

    // 显示版本号
    const bridge = window.electronBridge;
    if (bridge) {
      const v = bridge.getAppVersion();
      if (v) this.mainView.setVersion(`v${v}`);
    }

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getThemeMode() === 'system') applyTheme();
    });

    // 窗口关闭时保存任务组状态并刷新日志
    window.addEventListener('beforeunload', () => {
      this.taskGroupModel.save();
      Logger.flush();
    });

    // 加载配置 → 检测模拟器 → 渲染 → 连接
    this.startupCtrl = new StartupController({
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      configModel: this.configModel,
      appRoot: this.appRoot,
      plansDir: this.plansDir,
      configDir: this.configDir,
      pendingGuiVersion: this.pendingGuiVersion,
      syncPaths: (appRoot, plansDir, configDir) => {
        this.appRoot = appRoot;
        this.plansDir = plansDir;
        this.configDir = configDir;
        this.templateCtrl.appRoot = appRoot;
        this.templateCtrl.plansDir = plansDir;
        this.taskGroupCtrl.host.plansDir = plansDir;
        this.planCtrl.host.plansDir = plansDir;
        // 同步 configCtrl 的 configDir
        (this.configCtrl as any).host.configDir = configDir;
      },
      initLogger: (b) => {
        Logger.init({
          appendFile: b.appendFile.bind(b),
          uiCallback: (level, channel, message) => {
            const now = new Date();
            const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
            this.mainView.appendLog({ time, level, channel, message });
          },
          logDir: `${this.configDir}/log`,
        });
      },
      loadConfigAndSync: async () => {
        await this.configCtrl.loadConfig();
        const da = this.configModel.current.daily_automation;
        this.cronScheduler.updateConfig({
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
      },
      detectAndApplyEmulator: () => this.configCtrl.detectAndApplyEmulator(),
      showSetupWizard: () => this.configCtrl.showSetupWizard(),
      loadModelsAndRender: async (b) => {
        await this.templateModel.init(b);
        this.configCtrl.renderConfig();
        this.mainView.setDebugMode(localStorage.getItem('debugMode') === 'true');
        this.templateCtrl.renderLibrary();
        await this.taskGroupModel.load();
        this.taskGroupCtrl.render();
        this.updatePlanEmptyHint();
      },
      bindBackendLog: (b) => {
        if (b.onBackendLog) {
          b.onBackendLog((line) => {
            const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
            if (!clean) return;
            let level = 'info';
            if (/\bERROR\b/i.test(clean)) level = 'error';
            else if (/\bWARNING\b/i.test(clean)) level = 'warn';
            const msgMatch = clean.match(/\|\s*(?:INFO|WARNING|ERROR)\s*\|\s*\S+\s*\|\s*(.+)/);
            const message = msgMatch ? msgMatch[1].trim() : clean;
            Logger.logLevel(level, message);
            this.scheduler.processBackendLog(message);
          });
        }
      },
      renderMain: () => this.renderMain(),
      startHeartbeat: () => this.startHeartbeat(),
    });

    // 回填 startupCtrl 引用
    (this.configCtrl as any).host.startupCtrl = this.startupCtrl;

    this.startupCtrl.run().catch((e) => {
      console.error('初始化失败:', e);
      this.configCtrl.renderConfig();
    });
  }

  // ════════════════════════════════════════
  // 页面导航
  // ════════════════════════════════════════

  private bindNavigation(): void {
    document.querySelectorAll<HTMLElement>('.nav-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const pageId = tab.dataset['page'];
        if (pageId) this.switchPage(pageId);
      });
    });
  }

  private switchPage(pageId: string): void {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelector(`.nav-tab[data-page="${pageId}"]`)?.classList.add('active');
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.getElementById(`page-${pageId}`)?.classList.add('active');
    if (pageId === 'config') this.refreshAdbStatus();
  }

  // ════════════════════════════════════════
  // 用户操作绑定
  // ════════════════════════════════════════

  private bindActions(): void {
    document.getElementById('btn-save-config')?.addEventListener('click', () => this.configCtrl.saveConfig());
    document.getElementById('btn-open-plans-dir')?.addEventListener('click', () => this.openFolder(this.plansDir));
    document.getElementById('btn-open-config-dir')?.addEventListener('click', () => this.openFolder(this.configDir));

    document.getElementById('btn-browse-emu')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge) return;
      const dir = await bridge.openDirectoryDialog('选择模拟器安装目录');
      if (dir) this.configView.setEmulatorPath(dir);
    });

    document.getElementById('btn-browse-python')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge) return;
      const result = await bridge.openFileDialog([{ name: 'Python', extensions: ['exe'] }]);
      if (result) this.configView.setPythonPath(result.path);
    });

    document.getElementById('btn-validate-python')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge?.validatePython) return;
      const pythonPath = this.configView.getPythonPath();
      if (!pythonPath) { this.configView.setPythonStatus('"留空"将自动检测', 'unknown'); return; }
      this.configView.setPythonValidateLoading(true);
      try {
        const result = await bridge.validatePython(pythonPath);
        this.configView.setPythonStatus(result.valid ? '✓ ' + result.version : (result.error ?? '不兼容'), result.valid ? 'ok' : 'error');
      } catch { this.configView.setPythonStatus('检测失败', 'error'); }
      finally { this.configView.setPythonValidateLoading(false); }
    });

    document.getElementById('btn-check-adb')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge?.checkAdbDevices) return;
      const btn = document.getElementById('btn-check-adb') as HTMLButtonElement;
      btn.disabled = true; btn.textContent = '检测中…';
      try {
        const devices = await bridge.checkAdbDevices();
        const online = devices.filter(d => d.status === 'device');
        if (online.length === 0) {
          await showAlert('ADB 检测', '未发现在线设备。\n请确认模拟器已启动。');
        } else if (online.length === 1) {
          this.configView.setEmulatorSerial(online[0].serial);
          Logger.info(`ADB 检测到在线设备: ${online[0].serial}，已自动填入`);
        } else {
          const list = online.map(d => d.serial).join('\n');
          const ok = await showConfirm('ADB 检测', `发现 ${online.length} 个在线设备：\n\n${list}\n\n是否将第一个设备填入 serial？`);
          if (ok) this.configView.setEmulatorSerial(online[0].serial);
        }
      } catch (e: any) { await showAlert('ADB 检测失败', e.message || String(e)); }
      finally { btn.disabled = false; btn.textContent = '检测 ADB'; }
    });

    document.getElementById('btn-stop-task')?.addEventListener('click', async () => {
      await this.scheduler.stopRunning();
      this.schedulerBinder.currentProgress = '';
      this.schedulerBinder.trackedLoot = '';
      this.schedulerBinder.trackedShip = '';
      this.renderMain();
      Logger.info('已停止当前任务（任务已保留在队列中）');
    });
    document.getElementById('btn-clear-queue')?.addEventListener('click', () => {
      this.scheduler.clearQueue(); this.renderMain();
    });
    document.getElementById('btn-start-queue')?.addEventListener('click', () => {
      this.scheduler.startConsuming(); this.renderMain();
    });

    this.mainView.onRemoveQueueItem = (taskId) => { this.scheduler.removeTask(taskId); this.renderMain(); };
    this.mainView.onMoveQueueItem = (from, to) => { this.scheduler.moveTask(from, to); this.renderMain(); };

    document.getElementById('btn-reset-accent')?.addEventListener('click', () => {
      this.configView.resetAccentColor('#0f7dff');
      localStorage.setItem('accentColor', '#0f7dff');
      applyTheme();
    });
    document.getElementById('cfg-theme-mode')?.addEventListener('change', (e) => {
      localStorage.setItem('themeMode', (e.target as HTMLSelectElement).value);
      applyTheme();
    });
    document.getElementById('cfg-accent-color')?.addEventListener('input', (e) => {
      localStorage.setItem('accentColor', (e.target as HTMLInputElement).value);
      applyTheme();
    });
  }

  // ════════════════════════════════════════
  // 日常操作按钮
  // ════════════════════════════════════════

  private bindOpsActions(): void {
    const wrap = (btnId: string, label: string, action: () => Promise<ApiResponse>) => {
      document.getElementById(btnId)?.addEventListener('click', async () => {
        const btn = document.getElementById(btnId) as HTMLButtonElement;
        btn.disabled = true;
        this.mainView.setOpsStatus(`${label}中…`);
        try {
          const res = await action();
          if (res.success) { Logger.info(`${label}完成`); this.mainView.setOpsStatus(`${label}完成`); }
          else { Logger.warn(`${label}失败: ${res.message ?? '未知错误'}`); this.mainView.setOpsStatus(`${label}失败`); }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          Logger.error(`${label}异常: ${msg}`); this.mainView.setOpsStatus(`${label}异常`);
        } finally {
          btn.disabled = false;
          setTimeout(() => { this.mainView.setOpsStatus(''); }, 3000);
        }
      });
    };
    wrap('btn-ops-expedition', '收取远征', () => this.api.expeditionCheck());
    wrap('btn-ops-reward', '收取奖励', () => this.api.rewardCollect());
    wrap('btn-ops-build-collect', '收取建造', () => this.api.buildCollect());
    wrap('btn-ops-cook', '食堂烹饪', () => this.api.cook());
    wrap('btn-ops-repair', '浴室修理', () => this.api.repairBath());
  }

  private updateOpsAvailability(connected: boolean): void {
    this.mainView.setOpsAvailability(connected);
  }

  // ════════════════════════════════════════
  // 渲染
  // ════════════════════════════════════════

  private renderMain(): void {
    const state: RenderingState = {
      scheduler: this.scheduler,
      currentProgress: this.schedulerBinder.currentProgress,
      trackedLoot: this.schedulerBinder.trackedLoot,
      trackedShip: this.schedulerBinder.trackedShip,
      wsConnected: this.schedulerBinder.wsConnected,
      expeditionTimerText: this.schedulerBinder.expeditionTimerText,
    };
    const vo = buildMainViewObject(state);
    this.mainView.render(vo);
  }

  // ════════════════════════════════════════
  // ADB / 心跳 / 辅助
  // ════════════════════════════════════════

  private async refreshAdbStatus(): Promise<void> {
    this.configView.setAdbStatus('检测中…', 'unknown');
    try {
      const res = await this.api.emulatorDevices();
      if (res.success && Array.isArray(res.data)) {
        const online = res.data.filter(d => d.status === 'device');
        if (online.length > 0) {
          this.configView.setAdbStatus(`在线 (${online.map(d => d.serial).join(', ')})`, 'online');
        } else {
          this.configView.setAdbStatus('未发现在线设备', 'offline');
        }
      } else {
        this.configView.setAdbStatus(res.error || '检测失败', 'offline');
      }
    } catch {
      this.configView.setAdbStatus('检测失败（后端未启动？）', 'offline');
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    let consecutiveFails = 0;
    this.heartbeatTimer = setInterval(async () => {
      try {
        const alive = await this.scheduler.ping();
        if (alive) { consecutiveFails = 0; } else { consecutiveFails++; }
      } catch { consecutiveFails++; }
      if (consecutiveFails >= 3) {
        Logger.error('后端连续 3 次心跳失败，尝试自动重启…');
        this.stopHeartbeat();
        const bridge = window.electronBridge;
        if (bridge?.startBackend) {
          await bridge.startBackend();
          this.startupCtrl.waitForBackendAndConnect();
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private updatePlanEmptyHint(): void {
    if (this.plansDir) this.planView.setPlansDir(this.plansDir);
  }

  private openFolder(folderPath: string): void {
    if (!folderPath) return;
    const bridge = window.electronBridge;
    if (bridge?.openFolder) bridge.openFolder(folderPath);
  }
}

// ── 入口：实例化并初始化 ──
const app = new AppController();
app.init();
