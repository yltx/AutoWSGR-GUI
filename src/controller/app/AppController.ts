/** 作为 Renderer 组合根，初始化并协调页面、模型和功能控制器。 */
/**
 * AppController —— 核心控制器（瘦身版）。
 * 协调 Model 和 View，委托子控制器与独立函数处理细分逻辑。
 */
import { MainView } from '../../view/main/MainView';
import { PlanPreviewView } from '../../view/plan/PlanPreviewView';
import { ConfigView } from '../../view/config/ConfigView';
import { TaskGroupView } from '../../view/taskGroup/TaskGroupView';
import { SetupWizardView } from '../../view/setup/SetupWizardView';
import { initAnimatedSelects } from '../../view/shared/AnimatedSelect';
import {
  applyTheme,
  watchSystemTheme,
} from '../../view/theme';
import { ConfigModel } from '../../model/ConfigModel';
import { ApiClient } from '../../model/ApiClient';
import {
  CampaignDailyQuota,
  CronScheduler,
  NormalFightDailyQuota,
  Scheduler,
} from '../../model/scheduler';
import { TaskGroupModel } from '../../model/TaskGroupModel';
import { TemplateModel } from '../../model/TemplateModel';
import { Logger } from '../../utils/Logger';
import { showAlert } from '../../view/shared/DialogHelper';
import {
  getAppRuntimeGateway,
  type AppRuntimeGateway,
} from '../../adapter/IpcAdapter';
import { browserStorageStore } from '../../adapter/StorageAdapter';
import { TemplateController } from '../template/TemplateController';
import { TaskGroupController } from '../taskGroup/TaskGroupController';
import { loadManagedPlanToQueue } from '../taskGroup/queueLoader';
import { PlanController } from '../plan/PlanController';
import { DecisivePlanController } from '../plan/DecisivePlanController';
import { FleetPlannerController } from '../plan/FleetPlannerController';
import { StartupController } from '../startup/StartupController';
import {
  MigrationConflictController,
} from '../migration/MigrationConflictController';

import { SchedulerBinder } from './SchedulerBinder';
import { ConfigController } from './ConfigController';
import { CurrentFleetController } from './CurrentFleetController';
import { NavigationController } from './NavigationController';
import { OperationsController } from './OperationsController';
import { SettingsController } from './SettingsController';
import { buildMainViewObject, type RenderingState } from './rendering';

export class AppController {
  private mainView: MainView;
  private planView: PlanPreviewView;
  private fleetPlannerCtrl: FleetPlannerController;
  private currentFleetCtrl: CurrentFleetController;
  private configView: ConfigView;
  private taskGroupView: TaskGroupView;
  private setupView: SetupWizardView;

  private configModel: ConfigModel;
  private taskGroupModel: TaskGroupModel;
  private templateModel: TemplateModel;

  private api: ApiClient;
  private scheduler: Scheduler;
  private cronScheduler: CronScheduler;
  private campaignDailyQuota: CampaignDailyQuota;
  private normalFightDailyQuota: NormalFightDailyQuota;
  private schedulerBinder: SchedulerBinder;
  private configCtrl!: ConfigController;
  private navigationCtrl: NavigationController;
  private operationsCtrl: OperationsController;
  private settingsCtrl!: SettingsController;

  private appRoot = '';
  private plansDir = '';
  private configDir = '';

  private templateCtrl!: TemplateController;
  private taskGroupCtrl!: TaskGroupController;
  private planCtrl!: PlanController;
  private decisivePlanCtrl: DecisivePlanController;
  private migrationConflictCtrl: MigrationConflictController;
  private startupCtrl!: StartupController;

  constructor(
    private readonly runtimeGateway: AppRuntimeGateway | undefined =
      getAppRuntimeGateway(),
  ) {
    this.mainView = new MainView();
    this.planView = new PlanPreviewView();
    this.fleetPlannerCtrl = new FleetPlannerController();
    this.currentFleetCtrl = new CurrentFleetController();
    this.decisivePlanCtrl = new DecisivePlanController();
    this.migrationConflictCtrl = new MigrationConflictController();
    this.configView = new ConfigView();
    this.taskGroupView = new TaskGroupView();
    this.setupView = new SetupWizardView();
    this.configModel = new ConfigModel();
    this.taskGroupModel = new TaskGroupModel();
    this.templateModel = new TemplateModel();
    this.campaignDailyQuota = new CampaignDailyQuota();
    this.normalFightDailyQuota = new NormalFightDailyQuota();
    this.fleetPlannerCtrl.setTaskGroupsProvider(
      () => this.taskGroupModel.groups,
    );

    const rawPort = this.runtimeGateway?.getBackendPort();
    let port = Number(rawPort);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      port = 8438;
    }
    this.api = new ApiClient(`http://localhost:${port}`);
    this.scheduler = new Scheduler(
      this.api,
      () => this.configModel.current.ocr.ship_name_aliases,
    );
    this.navigationCtrl = new NavigationController({
      loadFleetPlanner: () => this.fleetPlannerCtrl.load(),
      ensureDefaultPlan: () => this.planCtrl.ensureDefaultPlan(),
      loadPlanManagement: () => (
        this.fleetPlannerCtrl.loadManagement()
      ),
      refreshAdbStatus: () => this.settingsCtrl.refreshAdbStatus(),
      refreshShipLibraryStatus: () => (
        this.settingsCtrl.refreshShipLibraryStatus()
      ),
      hasUnsavedConfigChanges: () => (
        this.configCtrl?.hasUnsavedChanges() ?? false
      ),
    });
    this.operationsCtrl = new OperationsController(this.api, this.mainView, Logger);

    const cfg = this.configModel.current.daily_automation;
    const gui = this.configModel.currentGuiAutomation;
    this.cronScheduler = new CronScheduler({
      autoExercise: cfg.auto_exercise,
      exerciseFleetId: cfg.exercise_fleet_id ?? 1,
      autoBattle: cfg.auto_battle,
      battleType: cfg.battle_type,
      battleTimes: gui.battleTimes,
      autoNormalFight: cfg.auto_normal_fight,
      autoDecisive: gui.autoDecisive,
      decisiveTemplateId: gui.decisiveTemplateId,
      autoLoot: gui.autoLoot,
      lootPlanSource: gui.lootPlanSource,
      lootPlanId: gui.lootPlanId,
      lootStopCount: gui.lootStopCount,
    });

    this.schedulerBinder = new SchedulerBinder({
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      api: this.api,
      templateModel: this.templateModel,
      configModel: this.configModel,
      campaignDailyQuota: this.campaignDailyQuota,
      normalFightDailyQuota: this.normalFightDailyQuota,
      renderMain: () => this.renderMain(),
      refreshNormalFightRemaining: () => (
        this.configCtrl?.refreshNormalFightRemaining()
      ),
      updateOpsAvailability: (c) => this.operationsCtrl.updateOpsAvailability(c),
      updateExpeditionTimer: (text) => (
        this.mainView.setExpeditionTimer(text)
      ),
    });
  }

  /** 初始化：绑定事件、渲染初始状态、自动连接后端 */
  init(): void {
    applyTheme();
    initAnimatedSelects();
    this.navigationCtrl.bindNavigation();
    this.navigationCtrl.bindPlanNavigation();
    this.bindQueueActions();
    this.schedulerBinder.bindSchedulerCallbacks();
    this.schedulerBinder.bindCronCallbacks();

    this.decisivePlanCtrl.bindActions();
    void this.decisivePlanCtrl.load();

    this.planCtrl = new PlanController(this.planView, {
      scheduler: this.scheduler,
      plansDir: '',
      renderMain: () => this.renderMain(),
      switchPage: (p) => this.navigationCtrl.switchPage(p, p === 'plan' ? 'scheme' : undefined),
    });
    this.fleetPlannerCtrl.onOpenBattlePlan = async (file, source) => {
      await this.planCtrl.openManagedPlan(file, source);
    };
    this.fleetPlannerCtrl.onTeamPlanSaved = (
      previousName,
      plan,
    ) => this.planCtrl.synchronizeTeamPlan(previousName, plan);
    this.planCtrl.bindActions();

    this.taskGroupCtrl = new TaskGroupController(
      this.taskGroupModel, this.taskGroupView, this.templateModel,
      this.mainView, this.planView, {
        scheduler: this.scheduler,
        plansDir: '',
        getShipNameAliases: () => (
          this.configModel.current.ocr.ship_name_aliases
        ),
        renderMain: () => this.renderMain(),
        switchPage: (p) => this.navigationCtrl.switchPage(p, p === 'plan' ? 'scheme' : undefined),
        importTaskPreset: (preset, fp) => this.planCtrl.importTaskPreset(preset, fp),
        getCurrentPlan: () => this.planCtrl.getCurrentPlan(),
        setCurrentPlan: (plan, mapData) => this.planCtrl.setCurrentPlan(plan, mapData),
        renderPlanPreview: () => this.planCtrl.renderPlanPreview(),
        closePresetDetail: () => this.planCtrl.closePresetDetail(),
        executePreset: () => this.planCtrl.executePreset(),
        getCurrentPresetInfo: () => this.planCtrl.getCurrentPresetInfo(),
        pickManagedBattlePlan: () => this.planCtrl.pickManagedBattlePlan(),
        openManagedPlan: (file, source) => (
          this.planCtrl.openManagedPlan(file, source)
        ),
      },
    );
    this.taskGroupCtrl.bindActions();

    this.templateCtrl = new TemplateController(
      this.templateModel, this.taskGroupModel,
      () => this.taskGroupCtrl.render(), '', '',
    );
    this.templateCtrl.bindActions();

    // 现在可以创建 configCtrl（startupCtrl 后续赋值）
    this.configCtrl = new ConfigController({
      configModel: this.configModel,
      configView: this.configView,
      setupView: this.setupView,
      mainView: this.mainView,
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      normalFightDailyQuota: this.normalFightDailyQuota,
      startupCtrl: null,
      configDir: this.configDir,
    });
    this.settingsCtrl = new SettingsController({
      configView: this.configView,
      getConfigDir: () => this.configDir,
      saveConfig: () => this.configCtrl.saveConfig(),
      pickAutomationPlan: currentTask => (
        this.planCtrl.pickManagedBattlePlanForAutomation(currentTask)
      ),
      pickLootAutomationPlans: currentPlans => (
        this.planCtrl.pickManagedLootPlans(currentPlans)
      ),
      getNormalFightRemaining: task => (
        this.normalFightDailyQuota.remaining(task)
      ),
      reloadShipLibrary: async () => {
        await Promise.all([
          this.fleetPlannerCtrl.load(true),
          this.currentFleetCtrl.load(true),
        ]);
        this.renderMain();
      },
      ensureSystemConnected: () => {
        if (this.scheduler.status !== 'not_connected') {
          return Promise.resolve(true);
        }
        return this.startupCtrl?.startSystem() ?? Promise.resolve(false);
      },
    });
    this.settingsCtrl.bindActions();

    this.operationsCtrl.bindOpsActions();
    this.renderMain();
    void this.currentFleetCtrl.load().then(() => this.renderMain());
    this.planView.render(null);

    // 显示版本号
    const version = this.runtimeGateway?.getAppVersion();
    if (version) {
      this.mainView.setVersion(`v${version}`);
    }

    watchSystemTheme();

    this.mainView.onBeforeUnload = () => {
      this.schedulerBinder.dispose();
      this.fleetPlannerCtrl.dispose();
      this.decisivePlanCtrl.dispose();
      this.taskGroupModel.save();
      Logger.flush();
    };

    // 加载配置 → 检测模拟器 → 渲染 → 连接
    this.startupCtrl = new StartupController({
      scheduler: this.scheduler,
      cronScheduler: this.cronScheduler,
      configModel: this.configModel,
      appRoot: this.appRoot,
      plansDir: this.plansDir,
      configDir: this.configDir,
      syncPaths: (appRoot, plansDir, configDir) => {
        this.appRoot = appRoot;
        this.plansDir = plansDir;
        this.configDir = configDir;
        this.templateCtrl.appRoot = appRoot;
        this.templateCtrl.plansDir = plansDir;
        this.taskGroupCtrl.host.plansDir = plansDir;
        this.planCtrl.host.plansDir = plansDir;
        // 同步 configCtrl 的 configDir
        this.configCtrl.setConfigDir(configDir);
      },
      initLogger: (b) => {
        Logger.init({
          appendGuiLog: b.appendGuiLog.bind(b),
          uiCallback: (level, channel, message) => {
            const now = new Date();
            const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
            this.mainView.appendLog({ time, level, channel, message });
          },
        });
      },
      loadConfigAndSync: async () => {
        await this.configCtrl.loadConfig();
        const da = this.configModel.current.daily_automation;
        const gui = this.configModel.currentGuiAutomation;
        this.cronScheduler.updateConfig({
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
      },
      detectAndApplyEmulator: () => this.configCtrl.detectAndApplyEmulator(),
      showSetupWizard: () => this.configCtrl.showSetupWizard(),
      loadModelsAndRender: async (b) => {
        await this.templateModel.init(b);
        this.templateCtrl.renderLibrary();
        this.configCtrl.renderConfig();
        this.mainView.setDebugMode(
          browserStorageStore.get('debugMode') === 'true',
        );
        await this.taskGroupModel.load();
        this.taskGroupCtrl.render();
      },
      reviewMigrationConflicts: () => (
        this.migrationConflictCtrl.reviewPending()
      ),
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
            this.schedulerBinder.handleBackendRuntimeLog(message);
            Logger.logLevel(level, message);
            this.scheduler.processBackendLog(message);
          });
        }
      },
      renderMain: () => this.renderMain(),
      startHeartbeat: () => this.startupCtrl.startHeartbeat(),
    });

    // 回填 startupCtrl 引用
    this.configCtrl.setStartupController(this.startupCtrl);
    this.navigationCtrl.restoreLastActivePage();

    this.startupCtrl.run().catch((e) => {
      console.error('初始化失败:', e);
      this.configCtrl.renderConfig();
    });
  }

  // ════════════════════════════════════════
  // 用户操作绑定
  // ════════════════════════════════════════

  private bindQueueActions(): void {
    this.mainView.onStopTask = () => {
      void this.stopCurrentTask();
    };
    this.mainView.onClearQueue = () => {
      this.scheduler.clearQueue();
      this.renderMain();
    };
    this.mainView.onImportPlan = () => {
      void this.importPlanToQueue();
    };
    this.mainView.onStartQueue = () => {
      this.scheduler.startConsuming();
      this.renderMain();
    };

    this.mainView.onRemoveQueueItem = (taskId) => {
      this.scheduler.removeTask(taskId);
      this.renderMain();
    };
    this.mainView.onMoveQueueItem = (from, to) => {
      this.scheduler.moveTask(from, to);
      this.renderMain();
    };
  }

  private async stopCurrentTask(): Promise<void> {
    if (this.scheduler.status === 'stopping') return;
    Logger.info('正在停止当前任务，请等待后端确认…');
    try {
      await this.scheduler.stopRunning();
      this.schedulerBinder.resetRuntimeState();
      this.renderMain();
      Logger.info('当前任务已停止（任务已保留在队列中）');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`停止任务失败：${message}`);
      this.renderMain();
    }
  }

  private async importPlanToQueue(): Promise<void> {
    const selected = await this.planCtrl.pickManagedBattlePlanForQueue();
    if (!selected) return;
    try {
      await loadManagedPlanToQueue(selected, {
        scheduler: this.scheduler,
        getShipNameAliases: () => (
          this.configModel.current.ocr.ship_name_aliases
        ),
        renderMain: () => this.renderMain(),
      });
    } catch (error) {
      await showAlert(
        '无法加载出征计划',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ════════════════════════════════════════
  // 渲染
  // ════════════════════════════════════════

  private renderMain(): void {
    const running = this.scheduler.currentRunningTask;
    const runtime = this.schedulerBinder.runtimeState;
    const state: RenderingState = {
      scheduler: this.scheduler,
      currentFleet: running
        ? this.currentFleetCtrl.resolve(running.request)
        : [],
      currentProgress: runtime.currentProgress,
      trackedLoot: runtime.trackedLoot,
      trackedShip: runtime.trackedShip,
      dailySortieStats: runtime.dailySortieStats,
      wsConnected: runtime.wsConnected,
      expeditionTimerText: runtime.expeditionTimerText,
    };
    const vo = buildMainViewObject(state);
    this.mainView.render(vo);
  }

}

// ── 入口：实例化并初始化 ──
const app = new AppController();
app.init();
