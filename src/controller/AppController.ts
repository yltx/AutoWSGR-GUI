/**
 * AppController —— 核心控制器。
 * 协调 Model 和 View，负责：
 *   1. 从 Model 提取信息 → 拼装 ViewObject → 单向传递给 View 渲染
 *   2. 接收 View 的用户操作 → 调用 Model 或 IPC
 */
import { MainView } from '../view/MainView';
import { PlanPreviewView } from '../view/PlanPreviewView';
import { ConfigView } from '../view/ConfigView';
import { TaskGroupView, type TaskGroupItemMeta } from '../view/TaskGroupView';
import type {
  MainViewObject,
  PlanPreviewViewObject,
  NodeViewObject,
  MapEdgeVO,
  ConfigViewObject,
  TaskQueueItemVO,
  LogEntryVO,
} from '../view/viewObjects';
import { PlanModel } from '../model/PlanModel';
import { ConfigModel } from '../model/ConfigModel';
import { ApiClient, type ApiResponse } from '../model/ApiClient';
import {
  Scheduler,
  TaskPriority,
  type SchedulerTask,
  type SchedulerStatus,
} from '../model/Scheduler';
import { CronScheduler } from '../model/CronScheduler';
import { TaskGroupModel } from '../model/TaskGroupModel';
import { TemplateModel } from '../model/TemplateModel';
import type { NormalFightReq, TaskRequest } from '../model/ApiClient';
import {
  FORMATION_NAMES,
  FIGHT_CONDITION_NAMES,
  REPAIR_MODE_NAMES,
  type TaskPreset,
  type EnemyRule,
  type TaskTemplate,
} from '../model/types';
import { loadMapData, loadExMapData, getNodeType, isDetourNode, isNightNode } from '../model/MapDataLoader';
import { ALL_SHIPS, shipTypeLabel, toBackendName } from '../data/shipData';
import { Logger } from '../utils/Logger';

/** 将 repair_mode（数字或数组）转换为显示文本 */
function resolveRepairModeLabel(mode: number | number[]): string {
  if (Array.isArray(mode)) {
    const unique = [...new Set(mode)];
    if (unique.length === 1) return REPAIR_MODE_NAMES[unique[0]] ?? '中破就修';
    // 混合策略：按舰位显示，如 "①大破 ②大破 ③大破 ④中破 ⑤大破 ⑥大破"
    const circled = ['①','②','③','④','⑤','⑥'];
    const short: Record<number, string> = { 1: '中破', 2: '大破' };
    return mode.map((v, i) => `${circled[i] ?? (i+1)}${short[v] ?? v}`).join(' ');
  }
  return REPAIR_MODE_NAMES[mode] ?? '中破就修';
}
import type { MapData } from '../model/MapDataLoader';

/** 通过 preload 注入的 IPC 桥 */
interface ElectronBridge {
  openDirectoryDialog: (title?: string) => Promise<string | null>;
  openFileDialog: (filters: { name: string; extensions: string[] }[], defaultDir?: string) => Promise<{ path: string; content: string } | null>;
  saveFile: (path: string, content: string) => Promise<void>;
  saveFileDialog: (defaultName: string, content: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  readFile: (path: string) => Promise<string>;
  appendFile: (path: string, content: string) => Promise<void>;
  detectEmulator: () => Promise<{ type: string; path: string; serial: string; adbPath: string } | null>;
  checkAdbDevices: () => Promise<{ serial: string; status: string }[]>;
  getAppRoot: () => Promise<string>;
  getPlansDir: () => Promise<string>;
  getConfigDir: () => Promise<string>;
  listPlanFiles: () => Promise<{ name: string; file: string }[]>;
  openFolder: (folderPath: string) => Promise<void>;
  checkEnvironment: () => Promise<{
    pythonCmd: string | null;
    pythonVersion: string | null;
    missingPackages: string[];
    allReady: boolean;
  }>;
  checkUpdates: () => Promise<{
    gitAvailable: boolean;
    hasUpdates: boolean;
    currentBranch: string;
    behindCount: number;
    remoteUrl: string;
  }>;
  installDeps: () => Promise<{ success: boolean; output: string }>;
  pullUpdates: () => Promise<{ success: boolean; output: string }>;
  startBackend: () => Promise<{ success: boolean; message: string }>;
  runSetup: () => Promise<{ success: boolean; output: string }>;
  installPortablePython: () => Promise<{ success: boolean }>;
  checkGuiUpdates: () => Promise<{ version: string } | null>;
  downloadGuiUpdate: () => Promise<{ success: boolean; message?: string }>;
  installGuiUpdate: () => void;
  onUpdateStatus: (callback: (status: any) => void) => void;
  onBackendLog: (callback: (line: string) => void) => void;
  onSetupLog: (callback: (text: string) => void) => void;
  getAppVersion: () => string;
}

declare global {
  interface Window {
    electronBridge?: ElectronBridge;
  }
}

// 优先级 → 中文标签
const PRIORITY_LABELS: Record<number, string> = {
  [TaskPriority.EXPEDITION]: '远征',
  [TaskPriority.USER_TASK]: '用户',
  [TaskPriority.DAILY]: '日常',
};

// 调度器状态 → 中文文案
const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  stopping: '正在停止…',
  not_connected: '未连接',
};

export class AppController {
  private mainView: MainView;
  private planView: PlanPreviewView;
  private configView: ConfigView;
  private taskGroupView: TaskGroupView;

  private configModel: ConfigModel;
  private taskGroupModel: TaskGroupModel;
  private templateModel: TemplateModel;
  private currentPlan: PlanModel | null = null;
  private currentMapData: MapData | null = null;

  // ── 调度相关 ──
  private api: ApiClient;
  private scheduler: Scheduler;
  private cronScheduler: CronScheduler;
  private pendingExerciseTaskId: string | null = null;
  private pendingBattleTaskId: string | null = null;
  private wsConnected = false;
  private expeditionTimerText = '--:--';
  private currentProgress = '';
  /** 后端出征面板 OCR 识别的实时资源计数 (v2.1.3+) */
  private trackedLoot = '';   // e.g. "3/200"
  private trackedShip = '';   // e.g. "253/500"
  private appRoot = '';
  private plansDir = '';
  private configDir = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private editingNodeId: string | null = null;
  private wizardStep = 1;
  /** 向导中多方案路径列表 */
  private wizardPlanPaths: string[] = [];
  /** 正在编辑的模板 ID（非空时向导为编辑模式） */
  private editingTemplateId: string | null = null;
  private currentPreset: TaskPreset | null = null;
  private currentPresetFilePath = '';

  constructor() {
    this.mainView = new MainView();
    this.planView = new PlanPreviewView();
    this.configView = new ConfigView();
    this.taskGroupView = new TaskGroupView();
    this.configModel = new ConfigModel();
    this.taskGroupModel = new TaskGroupModel();
    this.templateModel = new TemplateModel();

    this.api = new ApiClient();
    this.scheduler = new Scheduler(this.api);

    const cfg = this.configModel.current.daily_automation;
    this.cronScheduler = new CronScheduler({
      autoExercise: cfg.auto_exercise,
      exerciseFleetId: cfg.exercise_fleet_id,
      autoBattle: cfg.auto_battle,
      battleType: cfg.battle_type,
      battleTimes: cfg.battle_times,
      autoNormalFight: cfg.auto_normal_fight,
    });
  }

  /** 初始化：绑定事件、渲染初始状态、自动连接后端 */
  init(): void {
    this.applyTheme();
    this.bindNavigation();
    this.bindActions();
    this.bindSchedulerCallbacks();
    this.bindCronCallbacks();
    this.bindTaskGroupActions();
    this.bindTemplateActions();
    this.bindOpsActions();
    this.renderMain();
    this.planView.render(null);

    // 显示版本号
    const versionEl = document.getElementById('app-version');
    const bridge = window.electronBridge;
    if (versionEl && bridge) {
      const v = bridge.getAppVersion();
      if (v) versionEl.textContent = `v${v}`;
    }

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.getThemeMode() === 'system') this.applyTheme();
    });

    // 窗口关闭时保存任务组状态并刷新日志
    window.addEventListener('beforeunload', () => {
      this.taskGroupModel.save();
      Logger.flush();
    });

    // 加载配置 → 自动检测模拟器 → 渲染 → 连接
    this.initAsync().catch((e) => {
      console.error('初始化失败:', e);
      this.renderConfig();
    });
  }

  /** 异步初始化: 环境检查 → 加载配置 → 检测模拟器 → 启动后端 → 连接 */
  private async initAsync(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) return;

    if (bridge.getAppRoot) {
      this.appRoot = await bridge.getAppRoot();
    }
    if (bridge.getPlansDir) {
      this.plansDir = await bridge.getPlansDir();
    }
    if (bridge.getConfigDir) {
      this.configDir = await bridge.getConfigDir();
    }

    // 初始化日志系统
    Logger.init({
      appendFile: bridge.appendFile.bind(bridge),
      uiCallback: (level, channel, message) => {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        this.mainView.appendLog({ time, level, channel, message });
      },
      logDir: `${this.configDir}/log`,
    });

    // 显示关键路径，帮助用户找到配置和方案目录
    Logger.info(`配置文件目录: ${this.configDir}`);
    Logger.info(`方案文件目录: ${this.plansDir}`);

    // ── 1. 加载配置 & 渲染 (在环境检查前完成, 避免配置页长时间显示默认值) ──
    await this.loadConfig();
    Logger.debug('配置加载完成');
    const da = this.configModel.current.daily_automation;
    this.cronScheduler.updateConfig({
      autoExercise: da.auto_exercise,
      exerciseFleetId: da.exercise_fleet_id,
      autoBattle: da.auto_battle,
      battleType: da.battle_type,
      battleTimes: da.battle_times,
      autoNormalFight: da.auto_normal_fight,
    });
    await this.detectAndApplyEmulator();
    Logger.debug('模拟器检测完成');

    // 加载模板（需在 renderConfig 之前，以便决战模板下拉列表能检索到已有模板）
    await this.templateModel.init(bridge);
    this.renderConfig();
    this.mainView.setDebugMode(localStorage.getItem('debugMode') === 'true');
    this.renderTemplateLibrary();

    // 加载任务组
    await this.taskGroupModel.load();
    this.renderTaskGroup();

    // 更新方案空状态页的路径提示
    this.updatePlanEmptyHint();

    // 接收后端关键日志并显示到日志面板
    if (bridge.onBackendLog) {
      bridge.onBackendLog((line) => {
        // 去掉 ANSI 转义码
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
        if (!clean) return;
        let level = 'info';
        if (/\bERROR\b/i.test(clean)) level = 'error';
        else if (/\bWARNING\b/i.test(clean)) level = 'warn';
        // 提取日志正文：去掉 "HH:MM:SS.mmm | LEVEL | module/file:line | " 前缀
        const msgMatch = clean.match(/\|\s*(?:INFO|WARNING|ERROR)\s*\|\s*\S+\s*\|\s*(.+)/);
        const message = msgMatch ? msgMatch[1].trim() : clean;
        Logger.logLevel(level, message);

        // 将提取的消息传给调度器，用于 OCR 停止条件检测
        this.scheduler.processBackendLog(message);
      });
    }

    // ── 2. 环境检查 ──
    const envReady = await this.checkAndPrepareEnv(bridge);
    if (!envReady) return; // 日志中已输出错误信息

    // ── 3. 检查更新 (非阻塞) ──
    this.checkForUpdates(bridge);

    // ── 4. 启动后端 & 连接 ──
    Logger.info('正在启动后端服务…');
    await bridge.startBackend();
    // 等待后端就绪后再连接
    this.waitForBackendAndConnect();
  }

  /** 检查 Python 环境, 缺失时自动安装本地便携版 */
  private async checkAndPrepareEnv(bridge: ElectronBridge): Promise<boolean> {
    Logger.info('正在检查运行环境…');

    let env = await bridge.checkEnvironment();

    if (!env.pythonCmd) {
      // 尝试安装本地便携版 Python
      if (bridge.installPortablePython) {
        const result = await bridge.installPortablePython();
        if (!result.success) {
          Logger.error('Python 安装失败，请手动运行 setup.bat');
          return false;
        }
      } else {
        Logger.error('未找到 Python，请安装 Python 3.12+');
        return false;
      }
      env = await bridge.checkEnvironment();
      if (!env.pythonCmd) {
        Logger.error('安装后仍未检测到 Python，请重启应用');
        return false;
      }
    }

    if (env.allReady) {
      return true;
    }

    // 缺少依赖，尝试自动安装
    Logger.info(`正在安装缺失依赖: ${env.missingPackages.join(', ')}…`);
    const installResult = await bridge.installDeps();

    if (!installResult.success) {
      Logger.error('依赖安装失败');
      Logger.error(installResult.output.slice(-200));
      return false;
    }

    // 重新检查
    env = await bridge.checkEnvironment();
    if (!env.allReady) {
      Logger.error(`仍缺少依赖: ${env.missingPackages.join(', ')}`);
      return false;
    }

    return true;
  }

  /** 运行 setup.bat 安装环境 */
  private async runSetupScript(bridge: ElectronBridge): Promise<boolean> {
    if (!bridge.runSetup) return false;

    // 监听安装日志
    if (bridge.onSetupLog) {
      bridge.onSetupLog((text) => {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('√')) {
            Logger.info(trimmed);
          } else if (trimmed.startsWith('×')) {
            Logger.error(trimmed);
          } else if (trimmed.includes('下载') || trimmed.includes('安装') || trimmed.includes('检测')) {
            Logger.info(trimmed);
          }
        }
      });
    }

    const result = await bridge.runSetup();
    return result.success;
  }

  /** 检查 git 更新 (非阻塞, 仅日志提示) */
  private async checkForUpdates(bridge: ElectronBridge): Promise<void> {
    // 后端 (autowsgr PyPI) 更新检查
    try {
      const updates = await bridge.checkUpdates();
      if (updates.hasUpdates) {
        Logger.warn(`发现 ${updates.behindCount} 个新提交可更新，可通过「配置 → 检查更新」拉取`);
      }
    } catch { /* 忽略 */ }

    // GUI 增量更新检查
    this.initGuiAutoUpdate(bridge);
  }

  /** 初始化 GUI 自动更新监听 + 首次检查 */
  private initGuiAutoUpdate(bridge: ElectronBridge): void {
    if (!bridge.onUpdateStatus) return;

    bridge.onUpdateStatus((status) => {
      switch (status.status) {
        case 'available':
          Logger.info(`发现 GUI 新版本 v${status.version}，正在自动下载增量更新…`);
          bridge.downloadGuiUpdate?.();
          break;
        case 'downloading':
          if (status.percent != null && status.percent % 25 === 0) {
            Logger.info(`GUI 更新下载中… ${status.percent}%`);
          }
          break;
        case 'downloaded':
          Logger.info(`GUI v${status.version} 下载完成，将在退出时自动安装`);
          this.pendingGuiVersion = status.version;
          break;
        case 'error':
          Logger.warn(`GUI 更新检查失败: ${status.message || '未知错误'}`);
          break;
      }
    });

    // 延迟 5 秒后静默检查
    setTimeout(() => {
      bridge.checkGuiUpdates?.().catch(() => {});
    }, 5000);
  }

  /** 待安装的 GUI 版本号 */
  private pendingGuiVersion: string | null = null;

  /** 等待后端 HTTP 服务就绪, 然后启动系统 */
  private waitForBackendAndConnect(retries = 30): void {
    this.scheduler.ping().then((alive) => {
      if (alive) {
        Logger.info('后端服务就绪，正在连接模拟器…');
        this.startSystem();
      } else if (retries > 0) {
        setTimeout(() => this.waitForBackendAndConnect(retries - 1), 1000);
      } else {
        Logger.error('后端服务启动超时，请检查 Python 环境');
        this.renderMain();
      }
    }).catch(() => {
      if (retries > 0) {
        setTimeout(() => this.waitForBackendAndConnect(retries - 1), 1000);
      } else {
        Logger.error('后端连接失败');
        this.renderMain();
      }
    });
  }

  /** 向后端发送 system/start (连接模拟器+启动游戏, 可能耗时较长) */
  private startSystem(): void {
    const configPath = this.appRoot
      ? `${this.appRoot.replace(/\\/g, '/')}/usersettings.yaml`
      : undefined;

    // 从配置加载远征检查间隔
    this.scheduler.setExpeditionInterval(this.configModel.current.daily_automation.expedition_interval);

    this.scheduler.start(configPath).then((ok) => {
      if (ok) {
        Logger.info('系统启动成功 ✓');
        this.cronScheduler.start();
        Logger.info('定时调度器已启动');
        this.startHeartbeat();
      } else {
        Logger.error('系统启动失败 (模拟器连接/游戏启动异常)');
      }
      this.renderMain();
    }).catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort')) {
        // HTTP 超时但后端可能已完成 —— 尝试恢复
        Logger.warn('系统启动 HTTP 请求超时，正在检测后端状态…');
        const alive = await this.scheduler.ping();
        if (alive) {
          Logger.info('后端已就绪，正在恢复连接…');
          this.scheduler.recoverAfterTimeout();
          this.cronScheduler.start();
          Logger.info('定时调度器已启动');
          this.startHeartbeat();
        } else {
          Logger.error('系统启动超时且后端未响应 (模拟器连接耗时过长)');
        }
      } else {
        Logger.error(`系统启动异常: ${msg}`);
      }
      this.renderMain();
    });
  }

  /** 从磁盘加载 usersettings.yaml */
  private async loadConfig(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) return;
    try {
      const yamlStr = await bridge.readFile('usersettings.yaml');
      this.configModel.loadFromYaml(yamlStr);
      Logger.debug('usersettings.yaml 已加载');
    } catch {
      // 文件不存在时使用默认值，并自动保存一份供用户参考
      Logger.debug('usersettings.yaml 未找到，自动创建默认配置');
      const defaultYaml = this.configModel.toYaml();
      await bridge.saveFile('usersettings.yaml', defaultYaml);
      Logger.info(`已创建默认配置文件: ${this.configDir}\\usersettings.yaml`);
    }
  }

  /** 更新方案空状态页的路径提示 */
  private updatePlanEmptyHint(): void {
    const hintEl = document.getElementById('plans-dir-hint');
    if (hintEl && this.plansDir) {
      hintEl.textContent = this.plansDir;
      hintEl.title = this.plansDir;
    }
  }

  /** 在资源管理器中打开指定文件夹 */
  private openFolder(folderPath: string): void {
    if (!folderPath) return;
    const bridge = window.electronBridge;
    if (bridge?.openFolder) bridge.openFolder(folderPath);
  }

  // ════════════════════════════════════════
  // 页面导航 (View 上报 → Controller 处理)
  // ════════════════════════════════════════

  private bindNavigation(): void {
    const tabs = document.querySelectorAll<HTMLElement>('.nav-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const pageId = tab.dataset['page'];
        if (!pageId) return;
        this.switchPage(pageId);
      });
    });
  }

  /** 自动检测模拟器信息，仅在配置为空时填充 */
  private async detectAndApplyEmulator(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge?.detectEmulator) return;

    const cfg = this.configModel.current;
    // 如果模拟器路径和 serial 都已经配置，跳过检测
    if (cfg.emulator.path && cfg.emulator.serial) return;

    try {
      const result = await bridge.detectEmulator();
      if (!result) return;

      const patch: { type?: string; path?: string; serial?: string } = {};
      if (!cfg.emulator.path && result.path) patch.path = result.path;
      if (!cfg.emulator.serial && result.serial) patch.serial = result.serial;
      if (result.type) patch.type = result.type;

      if (Object.keys(patch).length > 0) {
        this.configModel.update({ emulator: patch as any });
        // 自动保存检测结果
        const yamlStr = this.configModel.toYaml();
        await bridge.saveFile('usersettings.yaml', yamlStr);
        Logger.debug(`自动检测到模拟器: type=${result.type} path=${result.path} serial=${result.serial}`);
      }
    } catch (e) {
      Logger.debug(`模拟器自动检测失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private switchPage(pageId: string): void {
    // 更新 tab 高亮
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelector(`.nav-tab[data-page="${pageId}"]`)?.classList.add('active');

    // 切换页面可见性
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.getElementById(`page-${pageId}`)?.classList.add('active');

    // 切到配置页时自动刷新 ADB 状态
    if (pageId === 'config') this.refreshAdbStatus();
  }

  /** 刷新配置页的 ADB 状态指示器 */
  private async refreshAdbStatus(): Promise<void> {
    const el = document.getElementById('cfg-adb-status');
    if (!el) return;
    const bridge = window.electronBridge;
    if (!bridge?.checkAdbDevices) return;
    el.textContent = '检测中…';
    el.className = 'adb-status adb-status-unknown';
    try {
      const devices = await bridge.checkAdbDevices();
      const online = devices.filter(d => d.status === 'device');
      if (online.length > 0) {
        el.textContent = `在线 (${online.map(d => d.serial).join(', ')})`;
        el.className = 'adb-status adb-status-online';
      } else {
        el.textContent = '未发现在线设备';
        el.className = 'adb-status adb-status-offline';
      }
    } catch {
      el.textContent = '检测失败';
      el.className = 'adb-status adb-status-offline';
    }
  }

  /** 启动后端心跳检测 (30 秒一次) */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    let consecutiveFails = 0;
    this.heartbeatTimer = setInterval(async () => {
      try {
        const alive = await this.scheduler.ping();
        if (alive) {
          consecutiveFails = 0;
        } else {
          consecutiveFails++;
        }
      } catch {
        consecutiveFails++;
      }

      if (consecutiveFails >= 3) {
        Logger.error('后端连续 3 次心跳失败，尝试自动重启…');
        this.stopHeartbeat();
        const bridge = window.electronBridge;
        if (bridge?.startBackend) {
          await bridge.startBackend();
          this.waitForBackendAndConnect();
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ════════════════════════════════════════
  // 用户操作绑定
  // ════════════════════════════════════════

  private bindActions(): void {
    // 导入 Plan 按钮 (主页 + 预览页各一个)
    document.getElementById('btn-import-plan')?.addEventListener('click', () => this.importPlan());
    document.getElementById('btn-import-plan-2')?.addEventListener('click', () => this.importPlan());
    document.getElementById('btn-close-plan')?.addEventListener('click', () => this.closePlan());

    // 执行 Plan
    document.getElementById('btn-execute-plan')?.addEventListener('click', () => this.executePlan());

    // 保存配置
    document.getElementById('btn-save-config')?.addEventListener('click', () => this.saveConfig());

    // 打开文件夹快捷按钮
    document.getElementById('btn-open-plans-dir')?.addEventListener('click', () => this.openFolder(this.plansDir));
    document.getElementById('btn-open-config-dir')?.addEventListener('click', () => this.openFolder(this.configDir));

    // 模拟器路径浏览按钮
    document.getElementById('btn-browse-emu')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge) return;
      const dir = await bridge.openDirectoryDialog('选择模拟器安装目录');
      if (dir) {
        (document.getElementById('cfg-emu-path') as HTMLInputElement).value = dir;
      }
    });

    // ADB 设备检测按钮
    document.getElementById('btn-check-adb')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge?.checkAdbDevices) return;
      const btn = document.getElementById('btn-check-adb') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = '检测中…';
      try {
        const devices = await bridge.checkAdbDevices();
        const online = devices.filter(d => d.status === 'device');
        if (online.length === 0) {
          await this.showAlert('ADB 检测', '未发现在线设备。\n请确认模拟器已启动。');
        } else {
          const list = online.map(d => d.serial).join('\n');
          const msg = `发现 ${online.length} 个在线设备：\n\n${list}\n\n是否将第一个设备填入 serial？`;
          if (online.length === 1) {
            // 只有一个设备，直接填入
            (document.getElementById('cfg-emu-serial') as HTMLInputElement).value = online[0].serial;
            Logger.info(`ADB 检测到在线设备: ${online[0].serial}，已自动填入`);
          } else {
            // 多个设备，让用户确认
            const ok = await this.showConfirm('ADB 检测', msg);
            if (ok) {
              (document.getElementById('cfg-emu-serial') as HTMLInputElement).value = online[0].serial;
            }
          }
        }
      } catch (e: any) {
        await this.showAlert('ADB 检测失败', e.message || String(e));
      } finally {
        btn.disabled = false;
        btn.textContent = '检测 ADB';
      }
    });

    // 停止当前任务（立即清除运行状态，不删除队列项）
    document.getElementById('btn-stop-task')?.addEventListener('click', async () => {
      await this.scheduler.stopRunning();
      this.renderMain();
      Logger.info('已停止当前任务');
    });

    // 清空队列
    document.getElementById('btn-clear-queue')?.addEventListener('click', () => {
      this.scheduler.clearQueue();
      this.renderMain();
    });

    // 开始执行队列
    document.getElementById('btn-start-queue')?.addEventListener('click', () => {
      this.scheduler.startConsuming();
      this.renderMain();
    });

    // View 的队列项移除回调
    this.mainView.onRemoveQueueItem = (taskId) => {
      this.scheduler.removeTask(taskId);
      this.renderMain();
    };

    // View 的队列拖拽排序回调
    this.mainView.onMoveQueueItem = (from, to) => {
      this.scheduler.moveTask(from, to);
      this.renderMain();
    };

    // 节点编辑：点击节点 chip → 打开编辑或信息面板
    this.planView.onNodeClick = (nodeId) => {
      if (!this.currentPlan) return;

      // 检查节点类型，非战斗节点显示信息面板
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
      const rulesText = (args.enemy_rules ?? [])
        .map(r => `${r[0]}, ${r[1]}`)
        .join('\n');
      const mapNight = this.currentMapData ? isNightNode(this.currentMapData, nodeId) : false;
      this.planView.showNodeEditor(nodeId, nodeType as any, {
        formation: args.formation ?? 2,
        night: args.night ?? false,
        proceed: args.proceed ?? true,
        enemyRules: rulesText,
      }, mapNight);
    };

    // 节点编辑：关闭
    document.getElementById('btn-node-editor-close')?.addEventListener('click', () => {
      this.editingNodeId = null;
      this.planView.hideNodeEditor();
    });

    // 节点编辑：应用
    document.getElementById('btn-node-edit-save')?.addEventListener('click', () => {
      this.saveNodeEditorValues();
    });

    // 主题：重置主色调
    document.getElementById('btn-reset-accent')?.addEventListener('click', () => {
      const picker = document.getElementById('cfg-accent-color') as HTMLInputElement;
      const label = document.getElementById('cfg-accent-label')!;
      picker.value = '#0f7dff';
      label.textContent = '#0f7dff';
      localStorage.setItem('accentColor', '#0f7dff');
      this.applyTheme();
    });

    // 主题：切换模式实时预览
    document.getElementById('cfg-theme-mode')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'dark' | 'light' | 'system';
      localStorage.setItem('themeMode', mode);
      this.applyTheme();
    });

    // 主题：调色盘实时预览
    document.getElementById('cfg-accent-color')?.addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      localStorage.setItem('accentColor', color);
      this.applyTheme();
    });

    // 方案：导出 YAML
    document.getElementById('btn-export-plan')?.addEventListener('click', () => this.exportPlan());

    // 方案：新建
    document.getElementById('btn-new-plan')?.addEventListener('click', () => this.showNewPlanDialog());
    document.getElementById('btn-new-plan-confirm')?.addEventListener('click', () => this.confirmNewPlan());
    document.getElementById('btn-new-plan-cancel')?.addEventListener('click', () => this.hideNewPlanDialog());

    // 新建方案：切换海域时更新地图下拉选项（Ex 系列 1-12，普通章节 1-6）
    document.getElementById('new-plan-chapter')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      const mapSelect = document.getElementById('new-plan-map') as HTMLSelectElement;
      const count = val === 'Ex' ? 12 : 6;
      mapSelect.innerHTML = Array.from({length: count}, (_, i) =>
        `<option value="${i + 1}">${i + 1}</option>`).join('');
    });

    // 方案：plan-level 字段修改回调（即时保存）
    this.planView.onPlanFieldChange = (field, value) => {
      if (!this.currentPlan) return;
      if (field === 'repair_mode') this.currentPlan.data.repair_mode = value as number;
      else if (field === 'fight_condition') this.currentPlan.data.fight_condition = value as number;
      else if (field === 'fleet_id') this.currentPlan.data.fleet_id = value as number;
      else if (field === 'times') this.currentPlan.data.times = value as number;
      else if (field === 'gap') this.currentPlan.data.gap = value as number;
      else if (field === 'loot_count_ge' || field === 'ship_count_ge') {
        if (!this.currentPlan.data.stop_condition) {
          this.currentPlan.data.stop_condition = {};
        }
        this.currentPlan.data.stop_condition[field] = value as number | undefined;
        // 清理空的 stop_condition 对象
        const sc = this.currentPlan.data.stop_condition;
        if (sc.loot_count_ge == null && sc.ship_count_ge == null) {
          this.currentPlan.data.stop_condition = undefined;
        }
      }

      // 即时保存到文件
      if (this.currentPlan.fileName) {
        const bridge = window.electronBridge;
        bridge?.saveFile(this.currentPlan.fileName, this.currentPlan.toYaml());
      }
    };

    // 编队预设 CRUD 回调（add / edit / delete → 即时保存）
    this.planView.onFleetPresetChange = (action, index, preset) => {
      if (!this.currentPlan) return;
      if (!this.currentPlan.data.fleet_presets) {
        this.currentPlan.data.fleet_presets = [];
      }
      const presets = this.currentPlan.data.fleet_presets;

      if (action === 'add' && preset) {
        presets.push({ name: preset.name, ships: preset.ships });
      } else if (action === 'edit' && preset && index >= 0 && index < presets.length) {
        presets[index] = { name: preset.name, ships: preset.ships };
      } else if (action === 'delete' && index >= 0 && index < presets.length) {
        presets.splice(index, 1);
      }

      // 即时保存到文件
      if (this.currentPlan.fileName) {
        const bridge = window.electronBridge;
        bridge?.saveFile(this.currentPlan.fileName, this.currentPlan.toYaml());
      }

      // 重新渲染预设列表
      this.planView.renderFleetPresets(
        presets.map(p => ({ name: p.name, ships: p.ships }))
      );
    };

    // 注释/说明修改回调（即时保存）
    this.planView.onCommentChange = (comment) => {
      if (!this.currentPlan) return;
      this.currentPlan.comment = comment;
      if (this.currentPlan.fileName) {
        const bridge = window.electronBridge;
        bridge?.saveFile(this.currentPlan.fileName, this.currentPlan.toYaml());
      }
    };
  }

  // ════════════════════════════════════════
  // 任务组
  // ════════════════════════════════════════

  private bindTaskGroupActions(): void {
    this.taskGroupView.onSelectGroup = (name) => {
      this.taskGroupModel.setActiveGroup(name);
      this.renderTaskGroup();
    };

    this.taskGroupView.onNewGroup = async () => {
      const name = await this.showPrompt('新建任务列表', '请输入名称：');
      if (!name?.trim()) return;
      const trimmed = name.trim();
      const existing = this.taskGroupModel.getGroup(trimmed);
      if (existing) {
        await this.showAlert('提示', `任务列表「${trimmed}」已存在，请换一个名称或直接选择它。`);
        return;
      }
      this.taskGroupModel.upsertGroup(trimmed);
      this.taskGroupModel.setActiveGroup(trimmed);
      this.taskGroupModel.save();
      this.renderTaskGroup();
    };

    this.taskGroupView.onDeleteGroup = async () => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      const yes = await this.showConfirm('删除确认', `确认删除任务列表「${active.name}」？`);
      if (!yes) return;
      this.taskGroupModel.deleteGroup(active.name);
      this.taskGroupModel.save();
      this.renderTaskGroup();
    };

    this.taskGroupView.onRenameGroup = async () => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      const newName = await this.showPrompt('重命名', '新名称：', active.name);
      if (!newName?.trim() || newName.trim() === active.name) return;
      const trimmed = newName.trim();
      if (!this.taskGroupModel.renameGroup(active.name, trimmed)) {
        await this.showAlert('提示', `名称「${trimmed}」已被占用。`);
        return;
      }
      this.taskGroupModel.save();
      this.renderTaskGroup();
    };

    this.taskGroupView.onRemoveItem = (index) => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      this.taskGroupModel.removeItem(active.name, index);
      this.taskGroupModel.save();
      this.renderTaskGroup();
    };

    this.taskGroupView.onTimesChange = (index, times) => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      this.taskGroupModel.updateItemTimes(active.name, index, times);
      this.taskGroupModel.save();
    };

    this.taskGroupView.onMoveItem = (from, to) => {
      const active = this.taskGroupModel.getActiveGroup();
      if (!active) return;
      this.taskGroupModel.moveItem(active.name, from, to);
      this.taskGroupModel.save();
      this.renderTaskGroup();
    };

    this.taskGroupView.onLoadAll = () => this.loadGroupToQueue();

    this.taskGroupView.onAddFile = () => this.addFileToGroup();

    this.taskGroupView.onExportGroup = () => this.exportTaskGroup();

    this.taskGroupView.onImportGroup = () => this.importTaskGroup();

    // 从任务列表拖拽单个条目到队列
    this.taskGroupView.onDropToQueue = () => {};  // 由 MainView drop zone 触发
    this.mainView.onDropFromTaskGroup = (index) => this.loadSingleItemToQueue(index);

    // 右键编辑：任务列表条目
    this.taskGroupView.onEditItem = (index, x, y) => this.showContextMenuForItem('taskgroup', index, x, y);

    // 右键编辑：队列条目
    this.mainView.onEditQueueItem = (taskId, x, y) => this.showContextMenuForItem('queue', taskId, x, y);

    // 点击其他区域关闭上下文菜单
    document.addEventListener('click', () => this.hideContextMenu());

    // 上下文菜单「编辑」
    document.getElementById('ctx-edit')?.addEventListener('click', () => this.handleContextMenuEdit());

    // 方案预览页「加入任务组」按钮
    document.getElementById('btn-add-to-group')?.addEventListener('click', () => this.addCurrentPlanToGroup());

    // 任务预设详情面板
    document.getElementById('btn-close-preset')?.addEventListener('click', () => this.closePresetDetail());
    document.getElementById('btn-tp-add-queue')?.addEventListener('click', () => this.executePreset());
    document.getElementById('btn-tp-add-group')?.addEventListener('click', () => this.addPresetToGroup());
    document.getElementById('tp-fleet-enable-ex')?.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      document.getElementById('tp-fleet-grid-ex')!.style.display = checked ? '' : 'none';
    });
  }

  private renderTaskGroup(): void {
    const groups = this.taskGroupModel.groups;
    const active = this.taskGroupModel.getActiveGroup();
    const items = active?.items ?? [];

    // 先用无元数据快速渲染
    this.taskGroupView.render({
      groups: groups.map(g => ({ name: g.name, itemCount: g.items.length })),
      activeGroupName: this.taskGroupModel.activeGroupName,
      items,
    });

    // 异步加载元数据后重新渲染
    if (items.length > 0) {
      this.loadItemMetas(items).then(metas => {
        // 确保活跃组未切换
        if (this.taskGroupModel.getActiveGroup()?.name !== active?.name) return;
        this.taskGroupView.render({
          groups: groups.map(g => ({ name: g.name, itemCount: g.items.length })),
          activeGroupName: this.taskGroupModel.activeGroupName,
          items,
          itemMetas: metas,
        });
      });
    }
  }

  /** 从 YAML 文件中异步加载任务条目元数据 */
  private async loadItemMetas(items: ReadonlyArray<import('../model/TaskGroupModel').TaskGroupItem>): Promise<(TaskGroupItemMeta | null)[]> {
    const bridge = window.electronBridge;
    if (!bridge) return items.map(() => null);

    const REPAIR: Record<number, string> = { 1: '中破就修', 2: '大破才修' };
    const TYPE_LABELS: Record<string, string> = {
      normal_fight: '普通出击', event_fight: '活动出击',
      exercise: '演习', campaign: '战役', decisive: '决战',
    };

    return Promise.all(items.map(async (item): Promise<TaskGroupItemMeta | null> => {
      try {
        // 模板引用 — 从模板库读取元数据
        if (item.kind === 'template') {
          const tpl = this.templateModel.get(item.templateId ?? '');
          if (!tpl) return { typeLabel: '模板已删除' };
          const meta: TaskGroupItemMeta = {
            typeLabel: TYPE_LABELS[tpl.type] ?? tpl.type,
          };
          if (tpl.fleet_id) meta.fleetId = tpl.fleet_id;
          if (item.fleet_id) meta.fleetId = item.fleet_id;
          if (tpl.fleet?.length) meta.fleet = tpl.fleet.filter(Boolean);
          if (item.campaignName) meta.mapName = item.campaignName;
          else if (tpl.campaign_name) meta.mapName = tpl.campaign_name;
          if (item.chapter) meta.mapName = `决战第${item.chapter}章`;
          else if (tpl.chapter) meta.mapName = `决战第${tpl.chapter}章`;
          return meta;
        }

        const content = await bridge.readFile(item.path!);
        const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') return null;

        const meta: TaskGroupItemMeta = {};

        if ('chapter' in parsed && 'map' in parsed) {
          const ch = Number(parsed.chapter);
          const mp = Number(parsed.map);
          meta.mapName = ch === 99 ? `Ex-${mp}` : `${ch}-${mp}`;
        }

        if ('fleet_id' in parsed) {
          meta.fleetId = Number(parsed.fleet_id) || undefined;
        }

        if ('repair_mode' in parsed) {
          const rm = parsed.repair_mode;
          if (typeof rm === 'number') meta.repairMode = REPAIR[rm] ?? `修理${rm}`;
          else if (Array.isArray(rm)) meta.repairMode = REPAIR[rm[0]] ?? `修理${rm[0]}`;
        }

        if ('task_type' in parsed && !('chapter' in parsed)) {
          meta.typeLabel = TYPE_LABELS[String(parsed.task_type)] ?? String(parsed.task_type);
        }

        if ('fleet' in parsed && Array.isArray(parsed.fleet)) {
          meta.fleet = (parsed.fleet as unknown[]).map(s => String(s || '')).filter(Boolean);
        }

        return meta;
      } catch {
        return null;
      }
    }));
  }

  /** 导出当前任务列表为 JSON 文件 */
  private async exportTaskGroup(): Promise<void> {
    const group = this.taskGroupModel.getActiveGroup();
    if (!group || group.items.length === 0) {
      Logger.warn('当前任务列表为空，无法导出');
      return;
    }
    const bridge = window.electronBridge;
    if (!bridge) return;

    const data = { name: group.name, items: group.items };
    const json = JSON.stringify(data, null, 2);
    const saved = await bridge.saveFileDialog(
      `${group.name}.taskgroup.json`,
      json,
      [{ name: '任务列表模板', extensions: ['taskgroup.json', 'json'] }],
    );
    if (saved) {
      Logger.info(`已导出任务列表「${group.name}」`);
    }
  }

  /** 从 JSON 文件导入任务列表 */
  private async importTaskGroup(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) return;

    const result = await bridge.openFileDialog([
      { name: '任务列表模板', extensions: ['taskgroup.json', 'json'] },
    ]);
    if (!result) return;

    let data: { name?: string; items?: unknown[] };
    try {
      data = JSON.parse(result.content);
    } catch {
      await this.showAlert('导入失败', '文件格式不正确，无法解析 JSON。');
      return;
    }

    if (!Array.isArray(data.items) || data.items.length === 0) {
      await this.showAlert('导入失败', '模板中没有有效的任务条目。');
      return;
    }

    // 确定列表名称
    let groupName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '导入的列表';
    // 如果已有同名列表，加后缀
    if (this.taskGroupModel.getGroup(groupName)) {
      let suffix = 2;
      while (this.taskGroupModel.getGroup(`${groupName} (${suffix})`)) suffix++;
      groupName = `${groupName} (${suffix})`;
    }

    this.taskGroupModel.upsertGroup(groupName);
    this.taskGroupModel.setActiveGroup(groupName);

    for (const raw of data.items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.path !== 'string' || typeof item.kind !== 'string') continue;
      this.taskGroupModel.addItem(groupName, {
        path: item.path,
        kind: item.kind === 'preset' ? 'preset' : 'plan',
        times: typeof item.times === 'number' && item.times > 0 ? item.times : 1,
        label: typeof item.label === 'string' ? item.label : item.path.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? String(item.path),
      });
    }

    this.taskGroupModel.save();
    this.renderTaskGroup();
    Logger.info(`已导入任务列表「${groupName}」（${data.items.length} 项）`);
  }

  /** 将当前方案页预览的方案加入活跃任务组 */
  private addCurrentPlanToGroup(): void {
    if (!this.currentPlan) {
      Logger.warn('没有已加载的方案');
      return;
    }
    let group = this.taskGroupModel.getActiveGroup();
    if (!group) {
      // 自动创建默认组
      this.taskGroupModel.upsertGroup('默认');
      this.taskGroupModel.setActiveGroup('默认');
      group = this.taskGroupModel.getActiveGroup()!;
    }
    const times = this.currentPlan.data.times ?? 1;
    const fileName = this.currentPlan.fileName;
    const label = fileName.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? fileName;

    this.taskGroupModel.addItem(group.name, {
      path: fileName,
      kind: 'plan',
      times,
      label,
    });
    this.taskGroupModel.save();
    this.renderTaskGroup();
    Logger.info(`已将「${label} ×${times}」加入任务组「${group.name}」`);
  }

  /** 从文件对话框添加条目到当前组 */
  private async addFileToGroup(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) return;
    let group = this.taskGroupModel.getActiveGroup();
    if (!group) {
      this.taskGroupModel.upsertGroup('默认');
      this.taskGroupModel.setActiveGroup('默认');
      group = this.taskGroupModel.getActiveGroup()!;
    }

    const result = await bridge.openFileDialog([
      { name: 'YAML 方案/预设', extensions: ['yaml', 'yml'] },
    ], this.plansDir || undefined);
    if (!result) return;

    // 判断类型
    const parsed = (await import('js-yaml')).load(result.content) as Record<string, unknown>;
    let itemKind: 'plan' | 'preset' = 'plan';
    if (parsed && typeof parsed === 'object') {
      if ('task_type' in parsed && !('chapter' in parsed)) itemKind = 'preset';
    }

    const label = result.path.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? result.path;
    this.taskGroupModel.addItem(group.name, {
      path: result.path,
      kind: itemKind,
      times: (parsed as any)?.times ?? 1,
      label,
    });
    this.taskGroupModel.save();
    this.renderTaskGroup();
    Logger.info(`已添加「${label}」到任务组「${group.name}」`);
  }

  /** 将当前任务组全部条目加入调度队列 */
  private async loadGroupToQueue(): Promise<void> {
    const group = this.taskGroupModel.getActiveGroup();
    if (!group || group.items.length === 0) {
      Logger.warn('当前任务组为空');
      return;
    }
    const bridge = window.electronBridge;
    if (!bridge) return;

    let loadedCount = 0;
    for (const item of group.items) {
      try {
        if (item.kind === 'template') {
          // 模板引用 — 直接从模板库构建任务请求
          loadedCount += this.loadTemplateToQueue(item) ? 1 : 0;
          continue;
        }

        const content = await bridge.readFile(item.path!);
        const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') continue;

        if (item.kind === 'preset' || ('task_type' in parsed && !('chapter' in parsed))) {
          this.importTaskPreset(parsed as unknown as TaskPreset, item.path!);
        } else {
          // 战斗方案
          const plan = PlanModel.fromYaml(content, item.path!);
          const times = item.times;
          const req: NormalFightReq = {
            type: 'normal_fight',
            plan_id: plan.fileName,
            times: 1,
            gap: plan.data.gap ?? 0,
          };
          this.scheduler.addTask(plan.mapName, 'normal_fight', req, TaskPriority.USER_TASK, times, plan.data.stop_condition);
        }
        loadedCount++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        Logger.error(`加载「${item.label}」失败: ${msg}`);
      }
    }

    if (loadedCount > 0) {
      Logger.info(`已从任务组「${group.name}」加载 ${loadedCount} 个任务到队列`);
      this.switchPage('main');
      this.renderMain();
    }
  }

  /** 从模板 ID 构建任务请求并加入调度队列 */
  private loadTemplateToQueue(item: import('../model/TaskGroupModel').TaskGroupItem): boolean {
    const tpl = this.templateModel.get(item.templateId ?? '');
    if (!tpl) {
      Logger.error(`模板「${item.label}」不存在，可能已被删除`);
      return false;
    }

    let req: TaskRequest;
    const times = item.times;

    switch (tpl.type) {
      case 'exercise':
        req = { type: 'exercise', fleet_id: item.fleet_id ?? tpl.fleet_id ?? 1 };
        this.scheduler.addTask(item.label || tpl.name, 'exercise', req, TaskPriority.USER_TASK, 1);
        break;
      case 'campaign': {
        const cName = item.campaignName ?? tpl.campaign_name ?? '困难潜艇';
        req = { type: 'campaign', campaign_name: cName, times: 1 };
        this.scheduler.addTask(item.label || tpl.name, 'campaign', req, TaskPriority.USER_TASK, times);
        break;
      }
      case 'decisive':
        req = {
          type: 'decisive',
          chapter: item.chapter ?? tpl.chapter ?? 6,
          level1: tpl.level1 ?? [],
          level2: tpl.level2 ?? [],
          flagship_priority: tpl.flagship_priority ?? [],
        };
        this.scheduler.addTask(item.label || tpl.name, 'decisive', req, TaskPriority.USER_TASK, 1);
        break;
      default:
        return false;
    }
    return true;
  }

  /** 从任务列表拖拽单个条目加入队列 */
  private async loadSingleItemToQueue(index: number): Promise<void> {
    const group = this.taskGroupModel.getActiveGroup();
    if (!group) return;
    const item = group.items[index];
    if (!item) return;

    if (item.kind === 'template') {
      this.loadTemplateToQueue(item);
      Logger.info(`已将「${item.label}」加入队列`);
      this.renderMain();
      return;
    }

    const bridge = window.electronBridge;
    if (!bridge) return;

    try {
      const content = await bridge.readFile(item.path!);
      const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;

      if (item.kind === 'preset' || ('task_type' in parsed && !('chapter' in parsed))) {
        this.importTaskPreset(parsed as unknown as TaskPreset, item.path!);
      } else {
        const plan = PlanModel.fromYaml(content, item.path!);
        const req: NormalFightReq = {
          type: 'normal_fight',
          plan_id: plan.fileName,
          times: 1,
          gap: plan.data.gap ?? 0,
        };
        this.scheduler.addTask(plan.mapName, 'normal_fight', req, TaskPriority.USER_TASK, item.times, plan.data.stop_condition);
      }

      Logger.info(`已将「${item.label}」加入队列`);
      this.renderMain();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error(`加载「${item.label}」失败: ${msg}`);
    }
  }

  // ── 右键上下文菜单 ──

  private contextMenuTarget: { source: 'taskgroup' | 'queue'; id: number | string } | null = null;

  private showContextMenuForItem(source: 'taskgroup' | 'queue', id: number | string, x: number, y: number): void {
    this.contextMenuTarget = { source, id };
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = '';
  }

  private hideContextMenu(): void {
    const menu = document.getElementById('context-menu');
    if (menu) menu.style.display = 'none';
  }

  private async handleContextMenuEdit(): Promise<void> {
    this.hideContextMenu();
    const target = this.contextMenuTarget;
    if (!target) return;
    this.contextMenuTarget = null;

    if (target.source === 'taskgroup') {
      // 打开任务列表中的条目进行编辑
      const group = this.taskGroupModel.getActiveGroup();
      if (!group) return;
      const item = group.items[target.id as number];
      if (!item) return;
      if (item.kind === 'template') {
        Logger.info(`模板「${item.label}」请在模板库中查看和编辑`);
        return;
      }
      await this.openItemForEdit(item.path!, item.kind);
    } else {
      // 从队列中查找任务
      const taskId = target.id as string;
      const running = this.scheduler.currentRunningTask;
      const task = (running?.id === taskId) ? running : this.scheduler.taskQueue.find(t => t.id === taskId);
      if (!task) return;

      // normal_fight / event_fight 有 plan_id 可以打开文件编辑
      const req = task.request;
      let planId: string | undefined;
      if (req.type === 'normal_fight' || req.type === 'event_fight') {
        planId = req.plan_id ?? undefined;
      }
      if (planId) {
        await this.openItemForEdit(planId, 'plan');
      } else {
        Logger.warn(`「${task.name}」没有关联的方案文件`);
      }
    }
  }

  /** 打开指定文件到预览/编辑页面 */
  private async openItemForEdit(filePath: string, kind: 'plan' | 'preset'): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) return;

    try {
      const content = await bridge.readFile(filePath);
      const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;

      if (kind === 'preset' || ('task_type' in parsed && !('chapter' in parsed))) {
        this.importTaskPreset(parsed as unknown as TaskPreset, filePath);
      } else {
        this.currentPlan = PlanModel.fromYaml(content, filePath);
        const { chapter, map } = this.currentPlan.data;
        this.currentMapData = chapter === 99
          ? await loadExMapData(map)
          : await loadMapData(chapter, map);
        this.renderPlanPreview();
      }
      this.switchPage('plan');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error(`打开编辑失败: ${msg}`);
    }
  }

  // ════════════════════════════════════════
  // 调度器回调绑定
  // ════════════════════════════════════════

  private bindSchedulerCallbacks(): void {
    this.scheduler.setCallbacks({
      onStatusChange: (_status: SchedulerStatus) => {
        this.renderMain();
      },

      onProgressUpdate: (_taskId, progress) => {
        this.currentProgress = `${progress.current}/${progress.total}`;
        this.renderMain();
      },

      onTaskCompleted: (taskId, success, _result, _error) => {
        this.currentProgress = '';
        this.trackedLoot = '';
        this.trackedShip = '';
        // 演习/战役任务完成后的调度处理
        if (taskId === this.pendingExerciseTaskId) {
          if (success) {
            this.cronScheduler.markExerciseCompleted();
          } else {
            this.cronScheduler.clearExercisePending();
          }
          this.pendingExerciseTaskId = null;
        }
        if (taskId === this.pendingBattleTaskId) {
          // 战役次数按“每日 0 点刷新”处理：无论成功/失败，今日均视为已处理，
          // 避免同一天内像演习时段一样反复重触发。
          this.cronScheduler.markBattleHandled();
          this.pendingBattleTaskId = null;
        }
        this.renderMain();
      },

      onLog: (msg) => {
        // 解析后端出征面板 OCR 日志 (v2.1.3 sortie panel mixin)
        const lootMatch = msg.message.match(/\[UI\] 战利品数量: (\d+\/\d+)/);
        const shipMatch = msg.message.match(/\[UI\] 舰船数量: (\d+\/\d+)/);
        if (lootMatch) { this.trackedLoot = lootMatch[1]; this.renderMain(); }
        if (shipMatch) { this.trackedShip = shipMatch[1]; this.renderMain(); }
        Logger.logLevel(msg.level.toLowerCase(), msg.message, msg.channel);
      },

      onQueueChange: () => {
        this.renderMain();
      },

      onConnectionChange: (connected) => {
        this.wsConnected = connected;
        this.updateOpsAvailability(connected);
        if (connected) {
          this.api.health().then(res => {
            if (res.success && res.data) {
              const uptime = Math.floor(res.data.uptime_seconds);
              Logger.debug(`后端健康检查: 运行 ${uptime}s, 模拟器${res.data.emulator_connected ? '已连接' : '未连接'}`);
            }
          }).catch(() => {});
        }
        this.renderMain();
      },

      onExpeditionTimerTick: (seconds) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        this.expeditionTimerText = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        // 仅更新倒计时元素，无需全量 render
        const el = document.getElementById('expedition-timer');
        if (el) el.textContent = this.expeditionTimerText;
      },
    });
  }

  /** 绑定定时调度器回调 */
  private bindCronCallbacks(): void {
    this.cronScheduler.setCallbacks({
      onExerciseDue: (fleetId) => {
        const id = this.scheduler.addTask(
          '自动演习',
          'exercise',
          { type: 'exercise', fleet_id: fleetId },
          TaskPriority.DAILY,
          1,
        );
        this.pendingExerciseTaskId = id;
        Logger.info(`自动演习已加入队列 (舰队 ${fleetId})`);
        this.scheduler.startConsuming();
      },

      onCampaignDue: (campaignName, times) => {
        const id = this.scheduler.addTask(
          `自动战役·${campaignName}`,
          'campaign',
          { type: 'campaign', campaign_name: campaignName, times: 1 },
          TaskPriority.DAILY,
          times,
        );
        this.pendingBattleTaskId = id;
        Logger.info(`自动战役已加入队列 (${campaignName} ×${times})`);
        this.scheduler.startConsuming();
      },

      onScheduledTaskDue: (taskKey) => {
        Logger.info(`定时任务「${taskKey}」已触发`);
        // scheduled tasks are handled via plan re-import (future extension)
      },

      onLog: (level, message) => {
        Logger.logLevel(level, message);
      },
    });
  }

  // ════════════════════════════════════════
  // 日常操作按钮绑定
  // ════════════════════════════════════════

  private bindOpsActions(): void {
    const wrap = (btnId: string, label: string, action: () => Promise<ApiResponse>) => {
      document.getElementById(btnId)?.addEventListener('click', async () => {
        const btn = document.getElementById(btnId) as HTMLButtonElement;
        btn.disabled = true;
        const statusEl = document.getElementById('ops-status');
        if (statusEl) statusEl.textContent = `${label}中…`;
        try {
          const res = await action();
          if (res.success) {
            Logger.info(`${label}完成`);
            if (statusEl) statusEl.textContent = `${label}完成`;
          } else {
            Logger.warn(`${label}失败: ${res.message ?? '未知错误'}`);
            if (statusEl) statusEl.textContent = `${label}失败`;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          Logger.error(`${label}异常: ${msg}`);
          if (statusEl) statusEl.textContent = `${label}异常`;
        } finally {
          btn.disabled = false;
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
        }
      });
    };

    wrap('btn-ops-expedition', '收取远征', () => this.api.expeditionCheck());
    wrap('btn-ops-reward', '收取奖励', () => this.api.rewardCollect());
    wrap('btn-ops-build-collect', '收取建造', () => this.api.buildCollect());
    wrap('btn-ops-cook', '食堂烹饪', () => this.api.cook());
    wrap('btn-ops-repair', '浴室修理', () => this.api.repairBath());
  }

  /** 根据连接状态启用/禁用日常操作按钮 */
  private updateOpsAvailability(connected: boolean): void {
    const ids = ['btn-ops-expedition', 'btn-ops-reward', 'btn-ops-build-collect', 'btn-ops-cook', 'btn-ops-repair'];
    for (const id of ids) {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = !connected;
    }
    const statusEl = document.getElementById('ops-status');
    if (statusEl) statusEl.textContent = connected ? '' : '未连接';
  }

  // ════════════════════════════════════════
  // 核心流程：导入 Plan
  // ════════════════════════════════════════

  private async importPlan(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) {
      console.error('electronBridge 未注入，无法打开文件对话框');
      return;
    }

    const result = await bridge.openFileDialog([
      { name: 'YAML 方案/任务预设', extensions: ['yaml', 'yml'] },
    ], this.plansDir || undefined);
    if (!result) return;

    try {
      const parsed = (await import('js-yaml')).load(result.content) as Record<string, unknown>;

      // 含 chapter + map 的文件视为战斗方案 (可能同时含 times/stop_condition 等任务字段)
      if (parsed && typeof parsed === 'object' && 'chapter' in parsed && 'map' in parsed) {
        this.currentPlan = PlanModel.fromYaml(result.content, result.path);
        Logger.debug(`方案已导入: ${result.path}`);
        const { chapter, map } = this.currentPlan.data;
        this.currentMapData = chapter === 99
          ? await loadExMapData(map)
          : await loadMapData(chapter, map);
        this.renderPlanPreview();
        this.switchPage('plan');
        return;
      }

      // 仅含 task_type 的文件视为纯任务预设 (引用外部 plan)
      if (parsed && typeof parsed === 'object' && 'task_type' in parsed) {
        this.importTaskPreset(parsed as unknown as TaskPreset, result.path);
        return;
      }

      throw new Error('文件缺少 chapter/map 或 task_type 字段');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('YAML 解析失败:', msg);
      Logger.error(`文件导入失败: ${msg}`);
    }
  }

  /** 导入任务预设 YAML → 打开详情面板，用户手动加入队列 */
  private importTaskPreset(preset: TaskPreset, filePath: string): void {
    // 将相对 plan_id 解析为绝对路径 (相对于预设文件所在目录)
    if (preset.plan_id && !/^[A-Za-z]:[/\\]/.test(preset.plan_id) && !preset.plan_id.startsWith('/')) {
      const dir = filePath.replace(/[\\/][^\\/]+$/, '');
      preset.plan_id = dir + '\\' + preset.plan_id.replace(/\//g, '\\');
    }
    this.showPresetDetail(preset, filePath);
    this.switchPage('plan');
  }

  /** 显示任务预设详情面板，隐藏模板库 */
  private showPresetDetail(preset: TaskPreset, filePath: string): void {
    this.currentPreset = preset;
    this.currentPresetFilePath = filePath;

    const name = filePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? preset.task_type;
    const typeLabel = AppController.TEMPLATE_TYPE_LABELS[preset.task_type] ?? preset.task_type;

    // 隐藏空状态 / 方案预览 / 模板库，显示预设面板
    const emptyEl = document.getElementById('plan-empty');
    const detailEl = document.getElementById('plan-detail');
    const tplCard = document.getElementById('template-library-card');
    const presetEl = document.getElementById('task-preset-detail');
    if (emptyEl) emptyEl.style.display = 'none';
    if (detailEl) detailEl.style.display = 'none';
    if (tplCard) tplCard.style.display = 'none';
    if (presetEl) presetEl.style.display = '';

    document.getElementById('tp-name')!.textContent = name;
    document.getElementById('tp-type-badge')!.textContent = typeLabel;

    // 隐藏所有类型配置区
    for (const id of ['tp-cfg-exercise', 'tp-cfg-campaign', 'tp-cfg-decisive', 'tp-cfg-fight']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }

    // 根据类型显示 & 预填
    switch (preset.task_type) {
      case 'exercise': {
        document.getElementById('tp-cfg-exercise')!.style.display = '';
        (document.getElementById('tp-exercise-fleet') as HTMLSelectElement).value = String(preset.fleet_id ?? 1);
        // 重置编队
        const cb = document.getElementById('tp-fleet-enable-ex') as HTMLInputElement;
        cb.checked = false;
        document.getElementById('tp-fleet-grid-ex')!.style.display = 'none';
        document.querySelectorAll<HTMLInputElement>('.tp-ship-ex').forEach(inp => { inp.value = ''; });
        break;
      }
      case 'campaign':
        document.getElementById('tp-cfg-campaign')!.style.display = '';
        (document.getElementById('tp-campaign-name') as HTMLSelectElement).value = preset.campaign_name ?? '困难潜艇';
        break;
      case 'decisive': {
        document.getElementById('tp-cfg-decisive')!.style.display = '';
        (document.getElementById('tp-decisive-chapter') as HTMLSelectElement).value = String(preset.chapter ?? 6);
        (document.getElementById('tp-decisive-level1') as HTMLTextAreaElement).value = (preset.level1 ?? []).join('\n');
        (document.getElementById('tp-decisive-level2') as HTMLTextAreaElement).value = (preset.level2 ?? []).join('\n');
        (document.getElementById('tp-decisive-flagship') as HTMLTextAreaElement).value = (preset.flagship_priority ?? []).join('\n');
        break;
      }
      case 'normal_fight':
      case 'event_fight':
        document.getElementById('tp-cfg-fight')!.style.display = '';
        (document.getElementById('tp-fight-plan') as HTMLInputElement).value = preset.plan_id ?? '';
        (document.getElementById('tp-fight-fleet') as HTMLSelectElement).value = String(preset.fleet_id ?? 1);
        break;
    }

    // 公共字段
    const timesGroup = document.getElementById('tp-times-group')!;
    const timesEl = document.getElementById('tp-times') as HTMLInputElement;
    if (preset.task_type === 'exercise') {
      // 演习：打完所有已刷新演习
      timesGroup.style.display = 'none';
    } else {
      timesGroup.style.display = '';
      timesEl.value = String(preset.times ?? 1);
      timesEl.disabled = preset.task_type === 'decisive';
    }
  }

  /** 关闭预设详情面板，恢复模板库显示 */
  private closePresetDetail(): void {
    this.currentPreset = null;
    this.currentPresetFilePath = '';

    const presetEl = document.getElementById('task-preset-detail');
    const emptyEl = document.getElementById('plan-empty');
    const tplCard = document.getElementById('template-library-card');
    if (presetEl) presetEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '';
    if (tplCard) tplCard.style.display = '';
  }

  /** 从预设详情面板收集表单值，构建任务加入队列 */
  private executePreset(): void {
    const preset = this.currentPreset;
    if (!preset) return;

    const name = this.currentPresetFilePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? preset.task_type;
    let req: TaskRequest;
    const times = Math.max(1, parseInt((document.getElementById('tp-times') as HTMLInputElement).value, 10) || 1);

    switch (preset.task_type) {
      case 'exercise':
        req = {
          type: 'exercise',
          fleet_id: parseInt((document.getElementById('tp-exercise-fleet') as HTMLSelectElement).value),
        };
        break;
      case 'campaign':
        req = {
          type: 'campaign',
          campaign_name: (document.getElementById('tp-campaign-name') as HTMLSelectElement).value,
          times: 1,
        };
        break;
      case 'decisive': {
        const parseLines = (id: string) =>
          (document.getElementById(id) as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean);
        req = {
          type: 'decisive',
          chapter: parseInt((document.getElementById('tp-decisive-chapter') as HTMLSelectElement).value),
          level1: parseLines('tp-decisive-level1'),
          level2: parseLines('tp-decisive-level2'),
          flagship_priority: parseLines('tp-decisive-flagship'),
        };
        break;
      }
      case 'event_fight':
        req = {
          type: 'event_fight',
          plan_id: (document.getElementById('tp-fight-plan') as HTMLInputElement).value || null,
          times: 1,
          gap: preset.gap ?? 0,
          fleet_id: parseInt((document.getElementById('tp-fight-fleet') as HTMLSelectElement).value) || null,
        };
        break;
      case 'normal_fight':
      default:
        req = {
          type: 'normal_fight',
          plan_id: (document.getElementById('tp-fight-plan') as HTMLInputElement).value || null,
          times: 1,
          gap: preset.gap ?? 0,
        };
        break;
    }

    const effectiveTimes = (preset.task_type === 'exercise' || preset.task_type === 'decisive') ? 1 : times;
    const stopCondition = preset.stop_condition;

    this.scheduler.addTask(name, preset.task_type, req, TaskPriority.USER_TASK, effectiveTimes, stopCondition);

    this.closePresetDetail();
    this.switchPage('main');
    this.renderMain();

    const parts: string[] = [];
    if (effectiveTimes > 1 || stopCondition) parts.push(`×${effectiveTimes}`);
    if (stopCondition?.loot_count_ge) parts.push(`战利品≥${stopCondition.loot_count_ge}时停止`);
    if (stopCondition?.ship_count_ge) parts.push(`舰船≥${stopCondition.ship_count_ge}时停止`);
    Logger.info(`任务「${name}」已加入队列${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
  }

  /** 将当前预设加入任务组 */
  private addPresetToGroup(): void {
    if (!this.currentPreset || !this.currentPresetFilePath) {
      Logger.warn('没有已加载的任务预设');
      return;
    }
    let group = this.taskGroupModel.getActiveGroup();
    if (!group) {
      this.taskGroupModel.upsertGroup('默认');
      this.taskGroupModel.setActiveGroup('默认');
      group = this.taskGroupModel.getActiveGroup()!;
    }
    const times = Math.max(1, parseInt((document.getElementById('tp-times') as HTMLInputElement).value, 10) || 1);
    const label = this.currentPresetFilePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? this.currentPreset.task_type;

    this.taskGroupModel.addItem(group.name, {
      path: this.currentPresetFilePath,
      kind: 'preset',
      times,
      label,
    });
    this.taskGroupModel.save();
    this.renderTaskGroup();
    Logger.info(`已将「${label} ×${times}」加入任务组「${group.name}」`);
  }

  // ════════════════════════════════════════
  // 核心流程：执行 Plan → 加入调度队列
  // ════════════════════════════════════════

  private executePlan(): void {
    if (!this.currentPlan) return;

    const plan = this.currentPlan;

    const times = plan.data.times ?? 1;
    const stopCondition = plan.data.stop_condition;

    // 检查选中的编队预设（多选）
    const selectedPresets = this.planView.getSelectedPresets();
    const firstPreset = selectedPresets.length > 0 ? selectedPresets[0] : undefined;

    const req: NormalFightReq = {
      type: 'normal_fight',
      plan_id: plan.fileName,
      times: 1, // 调度器 remainingTimes 控制重复
      gap: plan.data.gap ?? 0,
    };

    // 如果选中了编队预设，使用第一个预设的舰船列表
    if (firstPreset && firstPreset.ships.length > 0) {
      req.plan = {
        fleet: firstPreset.ships.map(toBackendName),
        fleet_id: plan.data.fleet_id,
      };
    }

    // 读取泡澡修理配置
    const bathRepairConfig = this.planView.getBathRepairConfig();
    const fleetId = plan.data.fleet_id ?? 1;
    // 编队预设轮换: 选中多个预设时传递所有选中的预设
    const fleetPresets = selectedPresets.length > 1 ? selectedPresets : undefined;
    const currentPresetIndex = fleetPresets ? 0 : undefined;

    this.scheduler.addTask(
      plan.mapName,
      'normal_fight',
      req,
      TaskPriority.USER_TASK,
      times,
      stopCondition,
      bathRepairConfig,
      fleetId,
      fleetPresets,
      currentPresetIndex,
    );
    Logger.debug(`executePlan: map=${plan.mapName} plan_id=${plan.fileName} times=${times} gap=${req.gap}${firstPreset ? ' fleet=' + firstPreset.ships.join(',') : ''}${fleetPresets ? ' rotation=' + fleetPresets.length + '套' : ''}`);

    // 重置编队选择
    this.planView.selectedFleetPresetIndices.clear();

    this.switchPage('main');
    this.renderMain();

    // 日志提示
    if (stopCondition) {
      const parts: string[] = [`×${times}`];
      if (stopCondition.loot_count_ge) parts.push(`战利品≥${stopCondition.loot_count_ge}时停止`);
      if (stopCondition.ship_count_ge) parts.push(`舰船≥${stopCondition.ship_count_ge}时停止`);
      Logger.info(`任务「${plan.mapName}」已加入队列 (${parts.join(', ')})`);
    }
  }

  /** 将节点编辑面板的值保存回 PlanModel */
  private saveNodeEditorValues(): void {
    if (!this.currentPlan || !this.editingNodeId) return;

    const vals = this.planView.collectNodeEditorValues();
    const nodeId = this.editingNodeId;

    // 解析索敌规则文本
    const rules: EnemyRule[] = [];
    for (const line of vals.rulesText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const commaIdx = trimmed.lastIndexOf(',');
      if (commaIdx < 0) continue;
      const expr = trimmed.slice(0, commaIdx).trim();
      const actionStr = trimmed.slice(commaIdx + 1).trim();
      const actionNum = Number(actionStr);
      rules.push([expr, isNaN(actionNum) ? actionStr : actionNum]);
    }

    // 确保 node_args 对象存在
    if (!this.currentPlan.data.node_args) {
      this.currentPlan.data.node_args = {};
    }

    this.currentPlan.data.node_args[nodeId] = {
      ...this.currentPlan.data.node_args[nodeId],
      formation: vals.formation,
      night: vals.night,
      proceed: vals.proceed,
      enemy_rules: rules.length > 0 ? rules : undefined,
    };

    // 即时保存到文件
    if (this.currentPlan.fileName) {
      const bridge = window.electronBridge;
      bridge?.saveFile(this.currentPlan.fileName, this.currentPlan.toYaml());
    }

    this.planView.hideNodeEditor();
    this.editingNodeId = null;
    this.renderPlanPreview();
  }

  // ════════════════════════════════════════
  // ViewObject 拼装 + 渲染
  // ════════════════════════════════════════

  private renderMain(): void {
    const running = this.scheduler.currentRunningTask;
    const queue = this.scheduler.taskQueue;

    // 构建统一的任务队列 VO：运行中的任务在最前
    const taskQueueVo: TaskQueueItemVO[] = [];

    if (running) {
      // 解析进度
      let progressPercent = 0;
      if (this.currentProgress) {
        const parts = this.currentProgress.split('/');
        if (parts.length === 2) {
          const cur = parseInt(parts[0], 10);
          const total = parseInt(parts[1], 10);
          if (total > 0) progressPercent = cur / total;
        }
      }
      taskQueueVo.push({
        id: running.id,
        name: running.name,
        priorityLabel: PRIORITY_LABELS[running.priority] ?? '用户',
        remaining: running.remainingTimes,
        totalTimes: running.totalTimes,
        progress: this.currentProgress || undefined,
        progressPercent,
        acquisitionText: this.buildAcquisitionText(),
      });
    }

    for (const t of queue) {
      taskQueueVo.push({
        id: t.id,
        name: t.name,
        priorityLabel: PRIORITY_LABELS[t.priority] ?? '用户',
        remaining: t.remainingTimes,
        totalTimes: t.totalTimes,
      });
    }

    const vo: MainViewObject = {
      status: this.scheduler.status === 'not_connected' ? 'not_connected' : this.scheduler.status,
      statusText: STATUS_TEXT[this.scheduler.status] ?? '未知',
      currentTask: running
        ? {
            name: running.name,
            type: running.type as MainViewObject['currentTask'] extends null ? never : NonNullable<MainViewObject['currentTask']>['type'],
            progress: this.currentProgress || '0/0',
            startedAt: '',
          }
        : null,
      expeditionTimer: this.expeditionTimerText,
      taskQueue: taskQueueVo,
      wsConnected: this.wsConnected,
      runningTaskId: running?.id ?? null,
    };
    this.mainView.render(vo);
  }

  /** 根据日志中解析到的后端 OCR 数据构建资源文本 */
  private buildAcquisitionText(): string | undefined {
    const parts: string[] = [];
    if (this.trackedLoot) parts.push(`装备 ${this.trackedLoot}`);
    if (this.trackedShip) parts.push(`舰船 ${this.trackedShip}`);
    return parts.length > 0 ? parts.join(' | ') : undefined;
  }

  private closePlan(): void {
    this.currentPlan = null;
    this.currentMapData = null;
    this.editingNodeId = null;
    this.planView.render(null);
    this.planView.hideNodeEditor();

    // 恢复模板库卡片显示
    const tplCard = document.getElementById('template-library-card');
    const presetEl = document.getElementById('task-preset-detail');
    if (tplCard) tplCard.style.display = '';
    if (presetEl) presetEl.style.display = 'none';
  }

  /** 导出当前方案为 YAML 文件 */
  private async exportPlan(): Promise<void> {
    if (!this.currentPlan) return;
    const bridge = window.electronBridge;
    if (!bridge) return;

    const yamlStr = this.currentPlan.toYaml();
    const fileName = this.currentPlan.fileName
      ? this.currentPlan.fileName.split(/[\\/]/).pop() || `${this.currentPlan.mapName}.yaml`
      : `${this.currentPlan.mapName}.yaml`;
    // 默认保存到方案目录
    const defaultPath = this.plansDir ? `${this.plansDir}\\${fileName}` : fileName;

    const saved = await bridge.saveFileDialog(defaultPath, yamlStr, [
      { name: 'YAML 方案', extensions: ['yaml', 'yml'] },
    ]);
    if (saved) {
      this.currentPlan.fileName = saved;
      Logger.info(`方案已导出: ${saved}`);
      this.renderPlanPreview();
    }
  }

  /** 显示新建方案对话框 */
  private showNewPlanDialog(): void {
    document.getElementById('new-plan-dialog')!.style.display = '';
  }

  /** 隐藏新建方案对话框 */
  private hideNewPlanDialog(): void {
    document.getElementById('new-plan-dialog')!.style.display = 'none';
  }

  // ══════════════════════════════════════
  // 通用对话框（替代 prompt / confirm / alert）
  // ══════════════════════════════════════

  /** 弹出输入框，返回用户输入的字符串，取消返回 null */
  private showPrompt(title: string, message = '', defaultValue = ''): Promise<string | null> {
    const overlay = document.getElementById('generic-prompt')!;
    const titleEl = document.getElementById('generic-prompt-title')!;
    const msgEl = document.getElementById('generic-prompt-message')!;
    const inputEl = document.getElementById('generic-prompt-input') as HTMLInputElement;
    const okBtn = document.getElementById('generic-prompt-ok')!;
    const cancelBtn = document.getElementById('generic-prompt-cancel')!;

    titleEl.textContent = title;
    msgEl.textContent = message;
    msgEl.style.display = message ? '' : 'none';
    inputEl.style.display = '';
    inputEl.value = defaultValue;
    cancelBtn.style.display = '';
    overlay.style.display = '';
    inputEl.focus();
    inputEl.select();

    return new Promise<string | null>((resolve) => {
      const cleanup = () => {
        overlay.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        inputEl.removeEventListener('keydown', onKey);
      };
      const onOk = () => { cleanup(); resolve(inputEl.value); };
      const onCancel = () => { cleanup(); resolve(null); };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') onOk();
        if (e.key === 'Escape') onCancel();
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      inputEl.addEventListener('keydown', onKey);
    });
  }

  /** 弹出确认框，返回 true/false */
  private showConfirm(title: string, message = ''): Promise<boolean> {
    const overlay = document.getElementById('generic-prompt')!;
    const titleEl = document.getElementById('generic-prompt-title')!;
    const msgEl = document.getElementById('generic-prompt-message')!;
    const inputEl = document.getElementById('generic-prompt-input') as HTMLInputElement;
    const okBtn = document.getElementById('generic-prompt-ok')!;
    const cancelBtn = document.getElementById('generic-prompt-cancel')!;

    titleEl.textContent = title;
    msgEl.textContent = message;
    msgEl.style.display = message ? '' : 'none';
    inputEl.style.display = 'none';
    cancelBtn.style.display = '';
    overlay.style.display = '';
    okBtn.focus();

    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        overlay.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  /** 弹出提示框（只有确定按钮） */
  private showAlert(title: string, message = ''): Promise<void> {
    const overlay = document.getElementById('generic-prompt')!;
    const titleEl = document.getElementById('generic-prompt-title')!;
    const msgEl = document.getElementById('generic-prompt-message')!;
    const inputEl = document.getElementById('generic-prompt-input') as HTMLInputElement;
    const okBtn = document.getElementById('generic-prompt-ok')!;
    const cancelBtn = document.getElementById('generic-prompt-cancel')!;

    titleEl.textContent = title;
    msgEl.textContent = message;
    msgEl.style.display = message ? '' : 'none';
    inputEl.style.display = 'none';
    cancelBtn.style.display = 'none';
    overlay.style.display = '';
    okBtn.focus();

    return new Promise<void>((resolve) => {
      const cleanup = () => {
        overlay.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
      };
      const onOk = () => { cleanup(); resolve(); };
      okBtn.addEventListener('click', onOk);
    });
  }

  /** 确认新建方案 */
  private async confirmNewPlan(): Promise<void> {
    const chapterVal = (document.getElementById('new-plan-chapter') as HTMLSelectElement).value;
    this.hideNewPlanDialog();

    try {
      let mapData: MapData | null;
      let chapter: number;
      let map: number;
      let mapLabel: string;

      map = parseInt((document.getElementById('new-plan-map') as HTMLSelectElement).value, 10);

      if (chapterVal === 'Ex') {
        mapData = await loadExMapData(map);
        chapter = 99;
        mapLabel = `Ex-${map}`;
      } else {
        chapter = parseInt(chapterVal, 10);
        mapData = await loadMapData(chapter, map);
        mapLabel = `${chapter}-${map}`;
      }

      if (!mapData) {
        Logger.error(`地图 ${mapLabel} 数据不存在`);
        return;
      }

      const allNodes = Object.keys(mapData).sort();
      this.currentPlan = PlanModel.create(chapter, map, allNodes);
      this.currentMapData = mapData;
      this.renderPlanPreview();
      this.switchPage('plan');
      Logger.info(`已新建方案 ${mapLabel}，共 ${allNodes.length} 个节点`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error(`新建方案失败: ${msg}`);
    }
  }

  private renderPlanPreview(): void {
    if (!this.currentPlan) {
      this.planView.render(null);
      return;
    }

    const plan = this.currentPlan;
    const mapData = this.currentMapData;
    const selectedSet = new Set(plan.data.selected_nodes);

    // 已选节点 VO
    const nodes: NodeViewObject[] = plan.data.selected_nodes.map((nodeId) => {
      const args = plan.getNodeArgs(nodeId);
      return {
        id: nodeId,
        formation: FORMATION_NAMES[args.formation ?? 2] ?? '复纵阵',
        night: args.night ?? false,
        proceed: args.proceed ?? true,
        hasCustomRules: plan.hasCustomArgs(nodeId),
        note: '',
        nodeType: mapData ? getNodeType(mapData, nodeId) : 'Normal',
        detour: mapData ? isDetourNode(mapData, nodeId) : false,
        mapNight: mapData ? isNightNode(mapData, nodeId) : false,
      };
    });

    // 构建地图可视化数据
    let allNodes: NodeViewObject[] | undefined;
    let edges: MapEdgeVO[] | undefined;
    if (mapData) {
      // 收集所有位置坐标以计算边界
      const positions = new Map<string, [number, number]>();
      for (const [id, pt] of Object.entries(mapData)) {
        if (pt.position) positions.set(id, pt.position);
      }

      if (positions.size > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of positions.values()) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }

        // 归一化到 0-100 百分比坐标，保持比例
        const rangeX = maxX - minX || 1;
        const rangeY = maxY - minY || 1;
        const PAD = 6;
        const innerW = 100 - PAD * 2;
        const innerH = 100 - PAD * 2;
        const scale = Math.min(innerW / rangeX, innerH / rangeY);
        const offsetX = PAD + (innerW - rangeX * scale) / 2;
        const offsetY = PAD + (innerH - rangeY * scale) / 2;

        const scaledPos = new Map<string, [number, number]>();
        for (const [id, [x, y]] of positions) {
          scaledPos.set(id, [(x - minX) * scale + offsetX, (y - minY) * scale + offsetY]);
        }

        // 全部节点 VO (含未选中的)
        allNodes = Object.entries(mapData).map(([id, pt]) => {
          const args = plan.getNodeArgs(id);
          const isSelected = selectedSet.has(id);
          return {
            id,
            formation: isSelected ? (FORMATION_NAMES[args.formation ?? 2] ?? '复纵阵') : '',
            night: isSelected ? (args.night ?? false) : false,
            proceed: isSelected ? (args.proceed ?? true) : true,
            hasCustomRules: isSelected ? plan.hasCustomArgs(id) : false,
            note: '',
            nodeType: pt.type,
            detour: pt.detour,
            mapNight: pt.night,
            position: scaledPos.get(id),
          };
        });

        // 连线
        edges = [];
        for (const [id, pt] of Object.entries(mapData)) {
          const fromPos = scaledPos.get(id);
          if (!fromPos) continue;
          for (const nxt of pt.next) {
            const toPos = scaledPos.get(nxt);
            if (toPos) edges.push({ from: fromPos, to: toPos, fromId: id, toId: nxt });
          }
        }

      }
    }

    const vo: PlanPreviewViewObject = {
      fileName: plan.fileName.split(/[\\/]/).pop() || plan.fileName,
      chapter: plan.data.chapter,
      map: plan.data.map,
      mapName: plan.mapName,
      repairModeValue: Array.isArray(plan.repairMode) ? plan.repairMode[0] ?? 1 : plan.repairMode,
      fightConditionValue: plan.fightCondition,
      fleetId: plan.data.fleet_id ?? 1,
      selectedNodes: nodes,
      comment: plan.comment,
      allNodes,
      edges,
      fleetPresets: plan.data.fleet_presets?.map(p => ({ name: p.name, ships: p.ships })),
      times: plan.data.times,
      gap: plan.data.gap,
      lootCountGe: plan.data.stop_condition?.loot_count_ge,
      shipCountGe: plan.data.stop_condition?.ship_count_ge,
    };

    this.planView.render(vo);

    // 显示方案时隐藏模板库卡片和预设面板
    const tplCard = document.getElementById('template-library-card');
    const presetEl = document.getElementById('task-preset-detail');
    if (tplCard) tplCard.style.display = 'none';
    if (presetEl) presetEl.style.display = 'none';
  }

  private renderConfig(): void {
    const cfg = this.configModel.current;
    const vo: ConfigViewObject = {
      emulatorType: cfg.emulator.type,
      emulatorPath: cfg.emulator.path || '',
      emulatorSerial: cfg.emulator.serial || '',
      gameApp: cfg.account.game_app,
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
      themeMode: this.getThemeMode(),
      accentColor: this.getAccentColor(),
      debugMode: localStorage.getItem('debugMode') === 'true',
    };
    this.configView.render(vo);

    // 填充决战模板下拉列表（传入配置值，因为 render 时 option 尚不存在，浏览器会静默丢弃）
    this.populateDecisiveTemplateSelect(cfg.daily_automation.decisive_template_id);
  }

  private async saveConfig(): Promise<void> {
    const collected = this.configView.collect();

    // 保存界面设置到 localStorage
    localStorage.setItem('themeMode', collected.themeMode);
    localStorage.setItem('accentColor', collected.accentColor);
    localStorage.setItem('debugMode', String(collected.debugMode));
    this.mainView.setDebugMode(collected.debugMode);
    this.applyTheme();

    this.configModel.update({
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
      },
    });

    // 同步定时调度器
    const da = this.configModel.current.daily_automation;
    this.cronScheduler.updateConfig({
      autoExercise: da.auto_exercise,
      exerciseFleetId: da.exercise_fleet_id,
      autoBattle: da.auto_battle,
      battleType: da.battle_type,
      battleTimes: da.battle_times,
      autoNormalFight: da.auto_normal_fight,
    });

    // 同步远征检查间隔
    this.scheduler.setExpeditionInterval(da.expedition_interval);

    const yamlStr = this.configModel.toYaml();
    console.log('保存配置:\n', yamlStr);

    const bridge = window.electronBridge;
    if (bridge) {
      await bridge.saveFile('usersettings.yaml', yamlStr);
    }
  }

  /** 填充配置页的决战模板下拉列表 */
  private populateDecisiveTemplateSelect(selectedId?: string): void {
    const sel = document.getElementById('cfg-decisive-template') as HTMLSelectElement | null;
    if (!sel) return;
    const desiredVal = selectedId ?? sel.value;
    const decisiveTemplates = this.templateModel.getAll().filter(t => t.type === 'decisive');
    sel.innerHTML = '<option value="">未选择</option>' +
      decisiveTemplates.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    sel.value = desiredVal;
  }

  // ════════════════════════════════════════
  // 模板系统
  // ════════════════════════════════════════

  private static readonly TEMPLATE_TYPE_LABELS: Record<string, string> = {
    normal_fight: '普通出击',
    exercise: '演习',
    campaign: '战役',
    decisive: '决战',
  };

  private static readonly CAMPAIGN_OPTIONS: string[] = [
    '困难潜艇', '困难航母', '困难驱逐', '困难巡洋', '困难战列',
    '简单航母', '简单潜艇', '简单驱逐', '简单巡洋', '简单战列',
  ];

  private bindTemplateActions(): void {
    // 创建模板按钮
    document.getElementById('btn-create-template')?.addEventListener('click', () => this.showWizard());

    // 导入模板按钮
    document.getElementById('btn-import-template')?.addEventListener('click', () => this.importTemplates());

    // 向导：上一步 / 下一步 / 取消
    document.getElementById('btn-wizard-prev')?.addEventListener('click', () => this.wizardNav(-1));
    document.getElementById('btn-wizard-next')?.addEventListener('click', () => this.wizardNav(1));
    document.getElementById('btn-wizard-cancel')?.addEventListener('click', () => this.hideWizard());

    // 步骤1：切换类型 → 切换步骤2配置面板
    document.querySelectorAll<HTMLInputElement>('input[name="tpl-type"]').forEach(radio => {
      radio.addEventListener('change', () => this.updateWizardConfigPanel());
    });

    // 步骤2：浏览添加方案文件
    document.getElementById('btn-tpl-browse-plan')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge) return;
      const result = await bridge.openFileDialog(
        [{ name: 'YAML 方案', extensions: ['yaml', 'yml'] }],
        this.plansDir || undefined,
      );
      if (!result) return;
      const filePath = result.path;
      if (!this.wizardPlanPaths.includes(filePath)) {
        this.wizardPlanPaths.push(filePath);
        this.renderWizardPlanList();
      }
      (document.getElementById('tpl-plan-path') as HTMLInputElement).value = filePath;
      if (this.wizardPlanPaths.length === 1) {
        try {
          const parsed = (await import('js-yaml')).load(result.content) as Record<string, any>;
          if (!parsed || typeof parsed !== 'object') return;
          if (parsed.fleet_id) {
            (document.getElementById('tpl-fleet') as HTMLSelectElement).value = String(parsed.fleet_id);
          }
          const presets = parsed.fleet_presets as any[] | undefined;
          if (presets?.length && presets[0].ships?.length) {
            this.fillFleetGrid('nf', presets[0].ships);
          }
          const sc = parsed.stop_condition as any;
          if (sc) {
            if (sc.loot_count_ge != null && sc.loot_count_ge >= 0) {
              (document.getElementById('tpl-stop-loot') as HTMLInputElement).value = String(sc.loot_count_ge);
            }
            if (sc.ship_count_ge != null && sc.ship_count_ge >= 0) {
              (document.getElementById('tpl-stop-ship') as HTMLInputElement).value = String(sc.ship_count_ge);
            }
          }
          const fileName = filePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? '';
          if (fileName) {
            (document.getElementById('tpl-name') as HTMLInputElement).value = fileName;
          }
          if (parsed.times) {
            (document.getElementById('tpl-default-times') as HTMLInputElement).value = String(parsed.times);
          }
        } catch { /* YAML 解析失败不影响流程 */ }
      }
    });

    // 步骤2：从方案目录扫描添加
    document.getElementById('btn-tpl-scan-plans')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge?.listPlanFiles) return;
      const files = await bridge.listPlanFiles();
      let added = 0;
      for (const f of files) {
        const fullPath = `${this.plansDir}\\${f.file}`;
        if (!this.wizardPlanPaths.includes(fullPath)) {
          this.wizardPlanPaths.push(fullPath);
          added++;
        }
      }
      if (added > 0) this.renderWizardPlanList();
      Logger.info(`扫描到 ${files.length} 个方案文件，新增 ${added} 个`);
    });

    // 步骤2：方案列表删除按钮
    document.getElementById('tpl-plan-list')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.btn-remove-plan') as HTMLElement | null;
      if (!btn) return;
      const idx = parseInt(btn.dataset.idx ?? '-1');
      if (idx >= 0 && idx < this.wizardPlanPaths.length) {
        this.wizardPlanPaths.splice(idx, 1);
        this.renderWizardPlanList();
      }
    });

    // 步骤2：编队设置开关
    for (const suffix of ['nf', 'ex', 'cp']) {
      const cb = document.getElementById(`tpl-fleet-enable-${suffix}`) as HTMLInputElement | null;
      const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
      cb?.addEventListener('change', () => {
        if (grid) grid.style.display = cb.checked ? '' : 'none';
      });
    }

    // 舰船名称自动补全
    this.initShipAutocomplete();

    // 模板库：委托点击
    document.getElementById('template-library-items')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('[data-tpl-action]') as HTMLElement | null;
      if (!btn) return;
      const id = btn.dataset.tplId!;
      const action = btn.dataset.tplAction;
      if (action === 'use') this.useTemplate(id);
      else if (action === 'delete') this.deleteTemplate(id);
      else if (action === 'rename') this.renameTemplate(id);
      else if (action === 'edit') this.editTemplate(id);
    });

    // 初始渲染模板库
    this.renderTemplateLibrary();
  }

  // ── 向导显示/隐藏 ──

  private showWizard(): void {
    this.wizardStep = 1;
    this.wizardPlanPaths = [];
    this.editingTemplateId = null;
    // 重置表单
    (document.querySelector('input[name="tpl-type"][value="normal_fight"]') as HTMLInputElement).checked = true;
    (document.getElementById('tpl-plan-path') as HTMLInputElement).value = '';
    (document.getElementById('tpl-name') as HTMLInputElement).value = '';
    (document.getElementById('tpl-default-times') as HTMLInputElement).value = '1';
    (document.getElementById('tpl-stop-loot') as HTMLInputElement).value = '-1';
    (document.getElementById('tpl-stop-ship') as HTMLInputElement).value = '-1';
    this.renderWizardPlanList();
    // 重置编队设置
    for (const suffix of ['nf', 'ex', 'cp']) {
      const cb = document.getElementById(`tpl-fleet-enable-${suffix}`) as HTMLInputElement | null;
      const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
      if (cb) cb.checked = false;
      if (grid) {
        grid.style.display = 'none';
        grid.querySelectorAll<HTMLInputElement>('.fleet-ship').forEach(inp => inp.value = '');
      }
    }
    document.getElementById('wizard-title')!.textContent = '创建模板';
    this.updateWizardConfigPanel();
    this.updateWizardUI();
    document.getElementById('template-wizard')!.style.display = 'flex';
  }

  /** 打开向导并预填模板数据，供用户查看/编辑后保存 */
  private showWizardWithTemplate(tpl: Record<string, any>): void {
    // 先走一遍正常的重置
    this.showWizard();
    document.getElementById('wizard-title')!.textContent = '导入模板';

    const type = tpl.type as string;
    // 选中对应类型
    const radio = document.querySelector(`input[name="tpl-type"][value="${type}"]`) as HTMLInputElement | null;
    if (radio) radio.checked = true;
    this.updateWizardConfigPanel();

    // 预填类型专属字段
    switch (type) {
      case 'normal_fight': {
        if (tpl.planPaths?.length) {
          this.wizardPlanPaths = [...tpl.planPaths];
        } else if (tpl.planPath) {
          this.wizardPlanPaths = [tpl.planPath];
        }
        this.renderWizardPlanList();
        if (tpl.fleet_id) (document.getElementById('tpl-fleet') as HTMLSelectElement).value = String(tpl.fleet_id);
        if (tpl.fleet?.length) this.fillFleetGrid('nf', tpl.fleet);
        break;
      }
      case 'exercise': {
        if (tpl.fleet_id) (document.getElementById('tpl-exercise-fleet') as HTMLSelectElement).value = String(tpl.fleet_id);
        if (tpl.fleet?.length) this.fillFleetGrid('ex', tpl.fleet);
        break;
      }
      case 'campaign': {
        if (tpl.campaign_name) (document.getElementById('tpl-campaign-type') as HTMLSelectElement).value = tpl.campaign_name;
        if (tpl.fleet?.length) this.fillFleetGrid('cp', tpl.fleet);
        break;
      }
      case 'decisive': {
        if (tpl.chapter) (document.getElementById('tpl-decisive-chapter') as HTMLSelectElement).value = String(tpl.chapter);
        if (tpl.level1?.length) (document.getElementById('tpl-decisive-level1') as HTMLTextAreaElement).value = tpl.level1.join('\n');
        if (tpl.level2?.length) (document.getElementById('tpl-decisive-level2') as HTMLTextAreaElement).value = tpl.level2.join('\n');
        if (tpl.flagship_priority?.length) (document.getElementById('tpl-decisive-flagship') as HTMLTextAreaElement).value = tpl.flagship_priority.join('\n');
        break;
      }
    }

    // 预填命名与默认参数
    if (tpl.name) (document.getElementById('tpl-name') as HTMLInputElement).value = tpl.name;
    if (tpl.defaultTimes) (document.getElementById('tpl-default-times') as HTMLInputElement).value = String(tpl.defaultTimes);
    if (tpl.defaultStopCondition?.loot_count_ge > 0) {
      (document.getElementById('tpl-stop-loot') as HTMLInputElement).value = String(tpl.defaultStopCondition.loot_count_ge);
    }
    if (tpl.defaultStopCondition?.ship_count_ge > 0) {
      (document.getElementById('tpl-stop-ship') as HTMLInputElement).value = String(tpl.defaultStopCondition.ship_count_ge);
    }

    // 直接跳到步骤2（配置页），让用户审阅
    this.wizardStep = 2;
    this.updateWizardUI();
  }

  /** 预填编队舰船网格 */
  private fillFleetGrid(suffix: string, ships: string[]): void {
    const cb = document.getElementById(`tpl-fleet-enable-${suffix}`) as HTMLInputElement | null;
    const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
    if (!cb || !grid) return;
    // 只有至少一个非空舰船时才勾选
    if (ships.some(s => s)) {
      cb.checked = true;
      grid.style.display = '';
      const inputs = grid.querySelectorAll<HTMLInputElement>('.fleet-ship');
      ships.forEach((name, i) => { if (inputs[i]) inputs[i].value = name; });
    }
  }

  private hideWizard(): void {
    document.getElementById('template-wizard')!.style.display = 'none';
  }

  /** 渲染向导中的多方案列表 */
  private renderWizardPlanList(): void {
    const container = document.getElementById('tpl-plan-list');
    if (!container) return;
    if (this.wizardPlanPaths.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;margin:0">尚未添加方案文件</p>';
      return;
    }
    container.innerHTML = this.wizardPlanPaths.map((p, i) => {
      const name = p.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? p;
      return `<div class="tpl-plan-entry">
        <span class="plan-name" title="${p}">${name}</span>
        <span class="btn-remove-plan" data-idx="${i}" title="移除">✕</span>
      </div>`;
    }).join('');
  }

  // ── 向导导航 ──

  private wizardNav(dir: number): void {
    // 最后一步点击完成
    if (this.wizardStep === 3 && dir === 1) {
      this.finishWizard();
      return;
    }

    const next = this.wizardStep + dir;
    if (next < 1 || next > 3) return;

    this.wizardStep = next;
    this.updateWizardUI();
  }

  private updateWizardUI(): void {
    const step = this.wizardStep;

    // 显示/隐藏步骤页
    for (let i = 1; i <= 3; i++) {
      const page = document.getElementById(`wizard-step-${i}`);
      if (page) page.style.display = i === step ? '' : 'none';
    }

    // 步骤指示器
    document.querySelectorAll('.wizard-step').forEach(el => {
      const s = parseInt(el.getAttribute('data-step') ?? '0');
      el.classList.toggle('active', s === step);
      el.classList.toggle('done', s < step);
    });

    // 按钮
    document.getElementById('btn-wizard-prev')!.style.display = step > 1 ? '' : 'none';
    const nextBtn = document.getElementById('btn-wizard-next')!;
    nextBtn.textContent = step === 3 ? '保存' : '下一步';
  }

  private updateWizardConfigPanel(): void {
    const type = (document.querySelector('input[name="tpl-type"]:checked') as HTMLInputElement)?.value ?? 'normal_fight';
    const panels = ['normal_fight', 'exercise', 'campaign', 'decisive'];
    for (const p of panels) {
      const el = document.getElementById(`wizard-cfg-${p}`);
      if (el) el.style.display = p === type ? '' : 'none';
    }
  }

  // ── 完成向导 → 创建模板 ──

  private readFleetGrid(suffix: string): string[] | undefined {
    const cb = document.getElementById(`tpl-fleet-enable-${suffix}`) as HTMLInputElement | null;
    if (!cb?.checked) return undefined;
    const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
    if (!grid) return undefined;
    const ships = Array.from(grid.querySelectorAll<HTMLInputElement>('.fleet-ship'))
      .map(inp => inp.value.trim());
    return ships.some(s => s) ? ships : undefined;
  }

  // ── 舰船名称自动补全 ──

  private activeDropdown: HTMLElement | null = null;

  private initShipAutocomplete(): void {
    // 事件委托：所有 fleet-ship 输入框
    document.addEventListener('input', (e) => {
      const inp = e.target as HTMLInputElement;
      if (!inp.classList.contains('fleet-ship')) return;
      this.showShipDropdown(inp);
    });

    document.addEventListener('focusin', (e) => {
      const inp = e.target as HTMLInputElement;
      if (!inp.classList.contains('fleet-ship') || !inp.value.trim()) return;
      this.showShipDropdown(inp);
    });

    document.addEventListener('focusout', (e) => {
      const inp = e.target as HTMLInputElement;
      if (!inp.classList.contains('fleet-ship')) return;
      setTimeout(() => this.hideShipDropdown(), 150);
    });

    document.addEventListener('keydown', (e) => {
      const inp = e.target as HTMLInputElement;
      if (!inp.classList.contains('fleet-ship') || !this.activeDropdown) return;
      const items = this.activeDropdown.querySelectorAll<HTMLElement>('.ship-ac-item');
      if (!items.length) return;

      const active = this.activeDropdown.querySelector<HTMLElement>('.ship-ac-item.active');
      let idx = active ? Array.from(items).indexOf(active) : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active?.classList.remove('active');
        idx = (idx + 1) % items.length;
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active?.classList.remove('active');
        idx = idx <= 0 ? items.length - 1 : idx - 1;
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (active) {
          inp.value = active.dataset.shipName!;
          this.hideShipDropdown();
        }
      } else if (e.key === 'Escape') {
        this.hideShipDropdown();
      }
    });
  }

  private showShipDropdown(inp: HTMLInputElement): void {
    const query = inp.value.trim().toLowerCase();
    if (!query) { this.hideShipDropdown(); return; }

    const matches = ALL_SHIPS
      .filter(s => s.name.toLowerCase().includes(query))
      .slice(0, 20);

    if (!matches.length) { this.hideShipDropdown(); return; }

    this.hideShipDropdown();
    const dd = document.createElement('div');
    dd.className = 'ship-autocomplete';
    for (const ship of matches) {
      const item = document.createElement('div');
      item.className = 'ship-ac-item';
      item.dataset.shipName = ship.name;
      item.innerHTML = `<span class="ship-ac-name">${this.highlightMatch(ship.name, query)}</span>`
        + `<span class="ship-ac-meta">${ship.nation} · ${shipTypeLabel(ship.ship_type)}</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = ship.name;
        this.hideShipDropdown();
      });
      dd.appendChild(item);
    }

    const row = inp.closest('.fleet-row') as HTMLElement;
    if (row) row.style.position = 'relative';
    inp.parentElement!.appendChild(dd);
    this.activeDropdown = dd;
  }

  private hideShipDropdown(): void {
    this.activeDropdown?.remove();
    this.activeDropdown = null;
  }

  private highlightMatch(name: string, query: string): string {
    const lower = name.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) return name;
    const before = name.slice(0, idx);
    const match = name.slice(idx, idx + query.length);
    const after = name.slice(idx + query.length);
    return `${before}<b>${match}</b>${after}`;
  }

  private async finishWizard(): Promise<void> {
    const type = (document.querySelector('input[name="tpl-type"]:checked') as HTMLInputElement)?.value as TaskTemplate['type'];
    const name = (document.getElementById('tpl-name') as HTMLInputElement).value.trim();
    if (!name) {
      (document.getElementById('tpl-name') as HTMLInputElement).focus();
      return;
    }

    const times = parseInt((document.getElementById('tpl-default-times') as HTMLInputElement).value) || 1;

    let stopCondition: TaskTemplate['defaultStopCondition'];
    if (type !== 'decisive') {
      const loot = parseInt((document.getElementById('tpl-stop-loot') as HTMLInputElement).value) || 0;
      const ship = parseInt((document.getElementById('tpl-stop-ship') as HTMLInputElement).value) || 0;
      stopCondition = (loot > 0 || ship > 0) ? {
        ...(loot > 0 ? { loot_count_ge: loot } : {}),
        ...(ship > 0 ? { ship_count_ge: ship } : {}),
      } : undefined;
    }

    const partial: Omit<TaskTemplate, 'id' | 'createdAt'> = {
      name,
      type,
      defaultTimes: times,
      defaultStopCondition: stopCondition,
    };

    // 类型专属字段
    switch (type) {
      case 'normal_fight': {
        if (this.wizardPlanPaths.length === 0) {
          const planPath = (document.getElementById('tpl-plan-path') as HTMLInputElement).value;
          if (!planPath) {
            this.wizardStep = 2;
            this.updateWizardUI();
            return;
          }
          this.wizardPlanPaths = [planPath];
        }
        partial.planPaths = [...this.wizardPlanPaths];
        partial.planPath = this.wizardPlanPaths[0];
        partial.fleet_id = parseInt((document.getElementById('tpl-fleet') as HTMLSelectElement).value);
        partial.fleet = this.readFleetGrid('nf');
        break;
      }
      case 'exercise':
        partial.fleet_id = parseInt((document.getElementById('tpl-exercise-fleet') as HTMLSelectElement).value);
        partial.fleet = this.readFleetGrid('ex');
        break;
      case 'campaign':
        partial.campaign_name = (document.getElementById('tpl-campaign-type') as HTMLSelectElement).value;
        partial.fleet = this.readFleetGrid('cp');
        break;
      case 'decisive': {
        partial.chapter = parseInt((document.getElementById('tpl-decisive-chapter') as HTMLSelectElement).value);
        const parseLines = (id: string) => (document.getElementById(id) as HTMLTextAreaElement).value
          .split('\n').map(s => s.trim()).filter(Boolean);
        partial.level1 = parseLines('tpl-decisive-level1');
        partial.level2 = parseLines('tpl-decisive-level2');
        partial.flagship_priority = parseLines('tpl-decisive-flagship');
        break;
      }
    }

    if (this.editingTemplateId) {
      await this.templateModel.update(this.editingTemplateId, partial);
      Logger.info(`模板「${name}」已更新`);
      this.editingTemplateId = null;
    } else {
      await this.templateModel.add(partial);
      Logger.info(`模板「${name}」已创建`);
    }
    this.hideWizard();
    this.renderTemplateLibrary();
  }

  // ── 使用模板 → 加入任务列表 ──

  private async useTemplate(id: string): Promise<void> {
    const tpl = this.templateModel.get(id);
    if (!tpl) return;

    let group = this.taskGroupModel.getActiveGroup();
    if (!group) {
      this.taskGroupModel.upsertGroup('默认');
      this.taskGroupModel.setActiveGroup('默认');
      group = this.taskGroupModel.getActiveGroup()!;
    }

    if (tpl.type === 'normal_fight') {
      const paths = tpl.planPaths ?? (tpl.planPath ? [tpl.planPath] : []);
      if (paths.length === 0) {
        Logger.warn(`模板「${tpl.name}」缺少方案文件路径`);
        return;
      }
      if (paths.length === 1) {
        this.addPlanToTaskList(tpl, paths[0], group.name);
      } else {
        this.showPlanSelector(tpl, paths, group.name);
        return;
      }
    } else if (tpl.type === 'campaign') {
      this.showCampaignSelector(tpl, group.name);
      return;
    } else if (tpl.type === 'exercise') {
      this.showExerciseFleetSelector(tpl, group.name);
      return;
    } else if (tpl.type === 'decisive') {
      this.showDecisiveChapterSelector(tpl, group.name);
      return;
    } else {
      this.taskGroupModel.addItem(group.name, {
        templateId: tpl.id,
        kind: 'template',
        times: tpl.defaultTimes ?? 1,
        label: tpl.name,
      });
    }

    this.taskGroupModel.save();
    this.renderTaskGroup();
    Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${group.name}」`);
  }

  /** 将指定方案添加到任务列表 */
  private addPlanToTaskList(tpl: TaskTemplate, planPath: string, groupName: string): void {
    const planName = planPath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? tpl.name;
    this.taskGroupModel.addItem(groupName, {
      path: planPath,
      kind: 'plan',
      times: tpl.defaultTimes ?? 1,
      label: `${tpl.name} (${planName})`,
    });
  }

  /** 显示方案选择弹窗 */
  private showPlanSelector(tpl: TaskTemplate, paths: string[], groupName: string): void {
    const overlay = document.getElementById('plan-selector-dialog')!;
    const title = document.getElementById('plan-selector-title')!;
    const list = document.getElementById('plan-selector-list')!;
    const timesRow = document.getElementById('plan-selector-times-row')!;
    timesRow.style.display = 'none';

    title.textContent = `「${tpl.name}」— 选择执行方案`;
    list.innerHTML = paths.map((p, i) => {
      const name = p.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? p;
      return `<div class="plan-selector-item" data-plan-idx="${i}">
        <span class="plan-icon">📄</span>
        <span>${name}</span>
      </div>`;
    }).join('');

    const onSelect = (e: Event) => {
      const item = (e.target as HTMLElement).closest('.plan-selector-item') as HTMLElement | null;
      if (!item) return;
      const idx = parseInt(item.dataset.planIdx ?? '-1');
      if (idx < 0 || idx >= paths.length) return;
      this.addPlanToTaskList(tpl, paths[idx], groupName);
      this.taskGroupModel.save();
      this.renderTaskGroup();
      Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（方案: ${paths[idx].split(/[\\/]/).pop()}）`);
      cleanup();
    };
    const onCancel = () => cleanup();
    const cleanup = () => {
      overlay.style.display = 'none';
      list.removeEventListener('click', onSelect);
      document.getElementById('btn-plan-selector-cancel')?.removeEventListener('click', onCancel);
    };

    list.addEventListener('click', onSelect);
    document.getElementById('btn-plan-selector-cancel')?.addEventListener('click', onCancel);
    overlay.style.display = 'flex';
  }

  private showCampaignSelector(tpl: TaskTemplate, groupName: string): void {
    const overlay = document.getElementById('plan-selector-dialog')!;
    const title = document.getElementById('plan-selector-title')!;
    const list = document.getElementById('plan-selector-list')!;
    const timesRow = document.getElementById('plan-selector-times-row')!;
    const timesInput = document.getElementById('plan-selector-times') as HTMLInputElement;
    timesRow.style.display = '';
    timesInput.value = String(tpl.defaultTimes ?? 1);

    title.textContent = `「${tpl.name}」— 选择战役类型`;
    list.innerHTML = AppController.CAMPAIGN_OPTIONS.map((name, i) => {
      return `<div class="plan-selector-item" data-plan-idx="${i}">
        <span class="plan-icon">⚔</span>
        <span>${name}</span>
      </div>`;
    }).join('');

    const onSelect = (e: Event) => {
      const item = (e.target as HTMLElement).closest('.plan-selector-item') as HTMLElement | null;
      if (!item) return;
      const idx = parseInt(item.dataset.planIdx ?? '-1');
      const chosen = AppController.CAMPAIGN_OPTIONS[idx];
      if (!chosen) return;
      const times = parseInt(timesInput.value) || 1;
      this.taskGroupModel.addItem(groupName, {
        templateId: tpl.id,
        kind: 'template',
        times,
        label: `${tpl.name} (${chosen})`,
        campaignName: chosen,
      });
      this.taskGroupModel.save();
      this.renderTaskGroup();
      Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（${chosen}）`);
      cleanup();
    };
    const onCancel = () => cleanup();
    const cleanup = () => {
      overlay.style.display = 'none';
      list.removeEventListener('click', onSelect);
      document.getElementById('btn-plan-selector-cancel')?.removeEventListener('click', onCancel);
    };

    list.addEventListener('click', onSelect);
    document.getElementById('btn-plan-selector-cancel')?.addEventListener('click', onCancel);
    overlay.style.display = 'flex';
  }

  private showExerciseFleetSelector(tpl: TaskTemplate, groupName: string): void {
    const overlay = document.getElementById('plan-selector-dialog')!;
    const title = document.getElementById('plan-selector-title')!;
    const list = document.getElementById('plan-selector-list')!;
    const timesRow = document.getElementById('plan-selector-times-row')!;
    timesRow.style.display = 'none';

    title.textContent = `「${tpl.name}」— 选择舰队`;
    const fleetOptions = ['第 1 舰队', '第 2 舰队', '第 3 舰队', '第 4 舰队'];
    list.innerHTML = fleetOptions.map((name, i) => {
      return `<div class="plan-selector-item" data-plan-idx="${i}">
        <span class="plan-icon">⚓</span>
        <span>${name}</span>
      </div>`;
    }).join('');

    const onSelect = (e: Event) => {
      const item = (e.target as HTMLElement).closest('.plan-selector-item') as HTMLElement | null;
      if (!item) return;
      const idx = parseInt(item.dataset.planIdx ?? '-1');
      if (idx < 0 || idx >= fleetOptions.length) return;
      const fleetId = idx + 1;
      this.taskGroupModel.addItem(groupName, {
        templateId: tpl.id,
        kind: 'template',
        times: tpl.defaultTimes ?? 1,
        label: `${tpl.name} (${fleetOptions[idx]})`,
        fleet_id: fleetId,
      });
      this.taskGroupModel.save();
      this.renderTaskGroup();
      Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（${fleetOptions[idx]}）`);
      cleanup();
    };
    const onCancel = () => cleanup();
    const cleanup = () => {
      overlay.style.display = 'none';
      list.removeEventListener('click', onSelect);
      document.getElementById('btn-plan-selector-cancel')?.removeEventListener('click', onCancel);
    };

    list.addEventListener('click', onSelect);
    document.getElementById('btn-plan-selector-cancel')?.addEventListener('click', onCancel);
    overlay.style.display = 'flex';
  }

  private static readonly DECISIVE_CHAPTERS = [
    { value: 1, label: '第 1 章' },
    { value: 2, label: '第 2 章' },
    { value: 3, label: '第 3 章' },
    { value: 4, label: '第 4 章' },
    { value: 5, label: '第 5 章' },
    { value: 6, label: '第 6 章' },
  ];

  private showDecisiveChapterSelector(tpl: TaskTemplate, groupName: string): void {
    const overlay = document.getElementById('plan-selector-dialog')!;
    const title = document.getElementById('plan-selector-title')!;
    const list = document.getElementById('plan-selector-list')!;
    const timesRow = document.getElementById('plan-selector-times-row')!;
    const timesInput = document.getElementById('plan-selector-times') as HTMLInputElement;
    timesRow.style.display = '';
    timesInput.value = String(tpl.defaultTimes ?? 1);

    title.textContent = `「${tpl.name}」— 选择章节`;
    list.innerHTML = AppController.DECISIVE_CHAPTERS.map((ch, i) => {
      return `<div class="plan-selector-item" data-plan-idx="${i}">
        <span class="plan-icon">🏆</span>
        <span>${ch.label}</span>
      </div>`;
    }).join('');

    const onSelect = (e: Event) => {
      const item = (e.target as HTMLElement).closest('.plan-selector-item') as HTMLElement | null;
      if (!item) return;
      const idx = parseInt(item.dataset.planIdx ?? '-1');
      const chosen = AppController.DECISIVE_CHAPTERS[idx];
      if (!chosen) return;
      const times = parseInt(timesInput.value) || 1;
      this.taskGroupModel.addItem(groupName, {
        templateId: tpl.id,
        kind: 'template',
        times,
        label: `${tpl.name} (${chosen.label})`,
        chapter: chosen.value,
      });
      this.taskGroupModel.save();
      this.renderTaskGroup();
      Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（${chosen.label}）`);
      cleanup();
    };
    const onCancel = () => cleanup();
    const cleanup = () => {
      overlay.style.display = 'none';
      list.removeEventListener('click', onSelect);
      document.getElementById('btn-plan-selector-cancel')?.removeEventListener('click', onCancel);
    };

    list.addEventListener('click', onSelect);
    document.getElementById('btn-plan-selector-cancel')?.addEventListener('click', onCancel);
    overlay.style.display = 'flex';
  }

  /** 编辑已有模板：打开向导预填数据，保存时更新而非新建 */
  private editTemplate(id: string): void {
    if (this.templateModel.isBuiltin(id)) return;
    const tpl = this.templateModel.get(id);
    if (!tpl) return;
    this.editingTemplateId = id;
    this.showWizardWithTemplate(tpl as any);
    document.getElementById('wizard-title')!.textContent = '编辑模板';
  }

  private async deleteTemplate(id: string): Promise<void> {
    if (this.templateModel.isBuiltin(id)) return;
    const tpl = this.templateModel.get(id);
    if (!tpl) return;
    const ok = await this.showConfirm('确认删除', `确定删除模板「${tpl.name}」？`);
    if (!ok) return;
    await this.templateModel.remove(id);
    this.renderTemplateLibrary();
    Logger.info(`模板「${tpl.name}」已删除`);
  }

  private async renameTemplate(id: string): Promise<void> {
    if (this.templateModel.isBuiltin(id)) return;
    const tpl = this.templateModel.get(id);
    if (!tpl) return;
    const newName = await this.showPrompt('重命名模板', '请输入新名称：', tpl.name);
    if (!newName?.trim()) return;
    await this.templateModel.rename(id, newName.trim());
    this.renderTemplateLibrary();
  }

  private async importTemplates(): Promise<void> {
    const bridge = window.electronBridge;
    if (!bridge) return;
    const defaultDir = this.appRoot ? `${this.appRoot}\\templates` : undefined;
    const result = await bridge.openFileDialog(
      [{ name: '模板文件', extensions: ['json'] }],
      defaultDir,
    );
    if (!result) return;
    let arr: unknown[];
    try {
      const parsed = JSON.parse(result.content);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      this.showAlert('导入失败', '文件格式错误，请选择有效的 JSON 模板文件。');
      return;
    }
    // 过滤出有效条目
    const valid = arr.filter(item => item && typeof item === 'object' && (item as any).name && (item as any).type);
    if (valid.length === 0) {
      this.showAlert('导入失败', '未找到有效的模板数据（需包含 name 和 type 字段）。');
      return;
    }
    // 第一个模板打开向导供用户查看/编辑
    this.showWizardWithTemplate(valid[0] as Record<string, any>);
    // 其余模板直接加入模板库
    if (valid.length > 1) {
      const rest = valid.slice(1);
      const count = await this.templateModel.importFromJson(rest);
      this.renderTemplateLibrary();
      Logger.info(`其余 ${count} 个模板已直接导入`);
    }
  }

  // ── 渲染模板库 ──

  private renderTemplateLibrary(): void {
    const container = document.getElementById('template-library-items');
    if (!container) return;

    const templates = this.templateModel.getAll();
    if (templates.length === 0) {
      container.innerHTML = '<p class="tpl-empty">暂无模板，点击「创建模板」添加</p>';
      return;
    }

    container.innerHTML = templates.map(tpl => {
      const isBuiltin = !!tpl.builtin;
      const builtinBadge = isBuiltin ? '<span class="tpl-builtin-badge">内置</span>' : '';
      const planCount = tpl.planPaths?.length ?? (tpl.planPath ? 1 : 0);
      const planInfo = tpl.type === 'normal_fight' && planCount > 1 ? ` · ${planCount}个方案` : '';
      const descTitle = tpl.description ? ` title="${tpl.description}"` : ` title="${tpl.name}"`;
      const editBtns = isBuiltin ? '' : `<button class="btn btn-small" data-tpl-action="edit" data-tpl-id="${tpl.id}" title="编辑">✎</button>
         <button class="btn btn-small btn-danger" data-tpl-action="delete" data-tpl-id="${tpl.id}" title="删除">✕</button>`;
      return `<div class="tpl-item" data-tpl-id="${tpl.id}">
        <div class="tpl-item-info"${descTitle}>
          <div class="tpl-item-name">${tpl.name}${builtinBadge}</div>
          <div class="tpl-item-type">${AppController.TEMPLATE_TYPE_LABELS[tpl.type] ?? tpl.type}${planInfo}${tpl.defaultTimes ? ` · ×${tpl.defaultTimes}` : ''}</div>
        </div>
        <div class="tpl-item-actions">
          <button class="btn btn-small btn-primary" data-tpl-action="use" data-tpl-id="${tpl.id}" title="加入任务列表">加入列表</button>
          ${editBtns}
        </div>
      </div>`;
    }).join('');

    this.populateDecisiveTemplateSelect();
  }

  // ════════════════════════════════════════
  // 主题管理
  // ════════════════════════════════════════

  private getThemeMode(): 'dark' | 'light' | 'system' {
    return (localStorage.getItem('themeMode') as 'dark' | 'light' | 'system') || 'dark';
  }

  private getAccentColor(): string {
    return localStorage.getItem('accentColor') || '#0f7dff';
  }

  private applyTheme(): void {
    const mode = this.getThemeMode();
    let resolved: 'dark' | 'light';
    if (mode === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } else {
      resolved = mode;
    }
    document.documentElement.setAttribute('data-theme', resolved);

    const accent = this.getAccentColor();
    document.documentElement.style.setProperty('--accent', accent);
    // 生成略浅的 hover 色
    document.documentElement.style.setProperty('--accent-hover', this.lightenColor(accent, 20));
  }

  private lightenColor(hex: string, percent: number): string {
    const num = parseInt(hex.slice(1), 16);
    const r = Math.min(255, (num >> 16) + Math.round(2.55 * percent));
    const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(2.55 * percent));
    const b = Math.min(255, (num & 0xff) + Math.round(2.55 * percent));
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }

}

// ── 入口：实例化并初始化 ──
const app = new AppController();
app.init();
