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
import { ApiClient } from '../model/ApiClient';
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
import { ALL_SHIPS, shipTypeLabel } from '../data/shipData';

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
  detectEmulator: () => Promise<{ type: string; path: string; serial: string; adbPath: string } | null>;
  checkAdbDevices: () => Promise<{ serial: string; status: string }[]>;
  getAppRoot: () => Promise<string>;
  getPlansDir: () => Promise<string>;
  getConfigDir: () => Promise<string>;
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
  onBackendLog: (callback: (line: string) => void) => void;
  onSetupLog: (callback: (text: string) => void) => void;
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
  private appRoot = '';
  private plansDir = '';
  private configDir = '';
  private editingNodeId: string | null = null;
  private wizardStep = 1;
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
    this.renderMain();
    this.planView.render(null);

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.getThemeMode() === 'system') this.applyTheme();
    });

    // 窗口关闭时保存任务组状态
    window.addEventListener('beforeunload', () => {
      this.taskGroupModel.save();
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

    // 显示关键路径，帮助用户找到配置和方案目录
    this.appendLocalLog('info', `配置文件目录: ${this.configDir}`);
    this.appendLocalLog('info', `方案文件目录: ${this.plansDir}`);

    // ── 1. 加载配置 & 渲染 (在环境检查前完成, 避免配置页长时间显示默认值) ──
    await this.loadConfig();
    const da = this.configModel.current.daily_automation;
    this.cronScheduler.updateConfig({
      autoExercise: da.auto_exercise,
      exerciseFleetId: da.exercise_fleet_id,
      autoBattle: da.auto_battle,
      battleType: da.battle_type,
      battleTimes: da.battle_times,
    });
    await this.detectAndApplyEmulator();
    this.renderConfig();
    this.mainView.setDebugMode(localStorage.getItem('debugMode') === 'true');

    // 加载模板
    await this.templateModel.init(bridge);
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
        this.appendLocalLog(level, message);
      });
    }

    // ── 2. 环境检查 ──
    const envReady = await this.checkAndPrepareEnv(bridge);
    if (!envReady) return; // 日志中已输出错误信息

    // ── 3. 检查更新 (非阻塞) ──
    this.checkForUpdates(bridge);

    // ── 4. 启动后端 & 连接 ──
    this.appendLocalLog('info', '正在启动后端服务…');
    await bridge.startBackend();
    // 等待后端就绪后再连接
    this.waitForBackendAndConnect();
  }

  /** 检查 Python 环境, 缺失时自动安装本地便携版 */
  private async checkAndPrepareEnv(bridge: ElectronBridge): Promise<boolean> {
    this.appendLocalLog('info', '正在检查运行环境…');

    let env = await bridge.checkEnvironment();

    if (!env.pythonCmd) {
      // 尝试安装本地便携版 Python
      if (bridge.installPortablePython) {
        const result = await bridge.installPortablePython();
        if (!result.success) {
          this.appendLocalLog('error', 'Python 安装失败，请手动运行 setup.bat');
          return false;
        }
      } else {
        this.appendLocalLog('error', '未找到 Python，请安装 Python 3.12+');
        return false;
      }
      env = await bridge.checkEnvironment();
      if (!env.pythonCmd) {
        this.appendLocalLog('error', '安装后仍未检测到 Python，请重启应用');
        return false;
      }
    }

    if (env.allReady) {
      return true;
    }

    // 缺少依赖，尝试自动安装
    this.appendLocalLog('info', `正在安装缺失依赖: ${env.missingPackages.join(', ')}…`);
    const installResult = await bridge.installDeps();

    if (!installResult.success) {
      this.appendLocalLog('error', '依赖安装失败');
      this.appendLocalLog('error', installResult.output.slice(-200));
      return false;
    }

    // 重新检查
    env = await bridge.checkEnvironment();
    if (!env.allReady) {
      this.appendLocalLog('error', `仍缺少依赖: ${env.missingPackages.join(', ')}`);
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
            this.appendLocalLog('info', trimmed);
          } else if (trimmed.startsWith('×')) {
            this.appendLocalLog('error', trimmed);
          } else if (trimmed.includes('下载') || trimmed.includes('安装') || trimmed.includes('检测')) {
            this.appendLocalLog('info', trimmed);
          }
        }
      });
    }

    const result = await bridge.runSetup();
    return result.success;
  }

  /** 检查 git 更新 (非阻塞, 仅日志提示) */
  private async checkForUpdates(bridge: ElectronBridge): Promise<void> {
    try {
      const updates = await bridge.checkUpdates();
      if (updates.hasUpdates) {
        this.appendLocalLog('warn', `发现 ${updates.behindCount} 个新提交可更新，可通过「配置 → 检查更新」拉取`);
      }
    } catch { /* 忽略 */ }
  }

  /** 等待后端 HTTP 服务就绪, 然后启动系统 */
  private waitForBackendAndConnect(retries = 30): void {
    this.scheduler.ping().then((alive) => {
      if (alive) {
        this.appendLocalLog('info', '后端服务就绪，正在连接模拟器…');
        this.startSystem();
      } else if (retries > 0) {
        setTimeout(() => this.waitForBackendAndConnect(retries - 1), 1000);
      } else {
        this.appendLocalLog('error', '后端服务启动超时，请检查 Python 环境');
        this.renderMain();
      }
    }).catch(() => {
      if (retries > 0) {
        setTimeout(() => this.waitForBackendAndConnect(retries - 1), 1000);
      } else {
        this.appendLocalLog('error', '后端连接失败');
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
        this.appendLocalLog('info', '系统启动成功 ✓');
        this.cronScheduler.start();
        this.appendLocalLog('info', '定时调度器已启动');
      } else {
        this.appendLocalLog('error', '系统启动失败 (模拟器连接/游戏启动异常)');
      }
      this.renderMain();
    }).catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort')) {
        // HTTP 超时但后端可能已完成 —— 尝试恢复
        this.appendLocalLog('warn', '系统启动 HTTP 请求超时，正在检测后端状态…');
        const alive = await this.scheduler.ping();
        if (alive) {
          this.appendLocalLog('info', '后端已就绪，正在恢复连接…');
          this.scheduler.recoverAfterTimeout();
          this.cronScheduler.start();
          this.appendLocalLog('info', '定时调度器已启动');
        } else {
          this.appendLocalLog('error', '系统启动超时且后端未响应 (模拟器连接耗时过长)');
        }
      } else {
        this.appendLocalLog('error', `系统启动异常: ${msg}`);
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
    } catch {
      // 文件不存在时使用默认值，并自动保存一份供用户参考
      console.log('usersettings.yaml 未找到，自动创建默认配置');
      const defaultYaml = this.configModel.toYaml();
      await bridge.saveFile('usersettings.yaml', defaultYaml);
      this.appendLocalLog('info', `已创建默认配置文件: ${this.configDir}\\usersettings.yaml`);
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
        console.log('自动检测到模拟器:', result);
      }
    } catch (e) {
      console.warn('模拟器自动检测失败:', e);
    }
  }

  private switchPage(pageId: string): void {
    // 更新 tab 高亮
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelector(`.nav-tab[data-page="${pageId}"]`)?.classList.add('active');

    // 切换页面可见性
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.getElementById(`page-${pageId}`)?.classList.add('active');
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
            this.appendLocalLog('info', `ADB 检测到在线设备: ${online[0].serial}，已自动填入`);
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
      this.appendLocalLog('info', '已停止当前任务');
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
      if (field === 'repair_mode') this.currentPlan.data.repair_mode = value;
      else if (field === 'fight_condition') this.currentPlan.data.fight_condition = value;
      else if (field === 'fleet_id') this.currentPlan.data.fleet_id = value;

      // 即时保存到文件
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
        const content = await bridge.readFile(item.path);
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
      this.appendLocalLog('warn', '当前任务列表为空，无法导出');
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
      this.appendLocalLog('info', `已导出任务列表「${group.name}」`);
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
    this.appendLocalLog('info', `已导入任务列表「${groupName}」（${data.items.length} 项）`);
  }

  /** 将当前方案页预览的方案加入活跃任务组 */
  private addCurrentPlanToGroup(): void {
    if (!this.currentPlan) {
      this.appendLocalLog('warn', '没有已加载的方案');
      return;
    }
    let group = this.taskGroupModel.getActiveGroup();
    if (!group) {
      // 自动创建默认组
      this.taskGroupModel.upsertGroup('默认');
      this.taskGroupModel.setActiveGroup('默认');
      group = this.taskGroupModel.getActiveGroup()!;
    }
    const timesInput = document.getElementById('plan-times') as HTMLInputElement;
    const times = Math.max(1, parseInt(timesInput.value, 10) || 1);
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
    this.appendLocalLog('info', `已将「${label} ×${times}」加入任务组「${group.name}」`);
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
    this.appendLocalLog('info', `已添加「${label}」到任务组「${group.name}」`);
  }

  /** 将当前任务组全部条目加入调度队列 */
  private async loadGroupToQueue(): Promise<void> {
    const group = this.taskGroupModel.getActiveGroup();
    if (!group || group.items.length === 0) {
      this.appendLocalLog('warn', '当前任务组为空');
      return;
    }
    const bridge = window.electronBridge;
    if (!bridge) return;

    let loadedCount = 0;
    for (const item of group.items) {
      try {
        const content = await bridge.readFile(item.path);
        const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') continue;

        if (item.kind === 'preset' || ('task_type' in parsed && !('chapter' in parsed))) {
          this.importTaskPreset(parsed as unknown as TaskPreset, item.path);
        } else {
          // 战斗方案
          const plan = PlanModel.fromYaml(content, item.path);
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
        this.appendLocalLog('error', `加载「${item.label}」失败: ${msg}`);
      }
    }

    if (loadedCount > 0) {
      this.appendLocalLog('info', `已从任务组「${group.name}」加载 ${loadedCount} 个任务到队列`);
      this.switchPage('main');
      this.renderMain();
    }
  }

  /** 从任务列表拖拽单个条目加入队列 */
  private async loadSingleItemToQueue(index: number): Promise<void> {
    const group = this.taskGroupModel.getActiveGroup();
    if (!group) return;
    const item = group.items[index];
    if (!item) return;

    const bridge = window.electronBridge;
    if (!bridge) return;

    try {
      const content = await bridge.readFile(item.path);
      const parsed = (await import('js-yaml')).load(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;

      if (item.kind === 'preset' || ('task_type' in parsed && !('chapter' in parsed))) {
        this.importTaskPreset(parsed as unknown as TaskPreset, item.path);
      } else {
        const plan = PlanModel.fromYaml(content, item.path);
        const req: NormalFightReq = {
          type: 'normal_fight',
          plan_id: plan.fileName,
          times: 1,
          gap: plan.data.gap ?? 0,
        };
        this.scheduler.addTask(plan.mapName, 'normal_fight', req, TaskPriority.USER_TASK, item.times, plan.data.stop_condition);
      }

      this.appendLocalLog('info', `已将「${item.label}」加入队列`);
      this.renderMain();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.appendLocalLog('error', `加载「${item.label}」失败: ${msg}`);
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
      await this.openItemForEdit(item.path, item.kind);
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
        this.appendLocalLog('warn', `「${task.name}」没有关联的方案文件`);
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
      this.appendLocalLog('error', `打开编辑失败: ${msg}`);
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
        // 演习/战役任务完成后更新时间戳 (或清除 pending 以便重试)
        if (taskId === this.pendingExerciseTaskId) {
          if (success) {
            this.cronScheduler.markExerciseCompleted();
          } else {
            this.cronScheduler.clearExercisePending();
          }
          this.pendingExerciseTaskId = null;
        }
        if (taskId === this.pendingBattleTaskId) {
          if (success) {
            this.cronScheduler.markBattleCompleted();
          } else {
            this.cronScheduler.clearBattlePending();
          }
          this.pendingBattleTaskId = null;
        }
        this.renderMain();
      },

      onLog: (msg) => {
        const entry: LogEntryVO = {
          time: msg.timestamp.slice(11, 19), // HH:MM:SS
          level: msg.level.toLowerCase(),
          channel: msg.channel,
          message: msg.message,
        };
        this.mainView.appendLog(entry);
      },

      onQueueChange: () => {
        this.renderMain();
      },

      onConnectionChange: (connected) => {
        this.wsConnected = connected;
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
        this.appendLocalLog('info', `自动演习已加入队列 (舰队 ${fleetId})`);
        this.scheduler.startConsuming();
      },

      onCampaignDue: (campaignName, times) => {
        const id = this.scheduler.addTask(
          `自动战役·${campaignName}`,
          'campaign',
          { type: 'campaign', campaign_name: campaignName, times },
          TaskPriority.DAILY,
          times,
        );
        this.pendingBattleTaskId = id;
        this.appendLocalLog('info', `自动战役已加入队列 (${campaignName} ×${times})`);
        this.scheduler.startConsuming();
      },

      onScheduledTaskDue: (taskKey) => {
        this.appendLocalLog('info', `定时任务「${taskKey}」已触发`);
        // scheduled tasks are handled via plan re-import (future extension)
      },

      onLog: (level, message) => {
        this.appendLocalLog(level, message);
      },
    });
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
      this.appendLocalLog('error', `文件导入失败: ${msg}`);
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
    if (preset.task_type === 'exercise' || preset.task_type === 'campaign') {
      // 演习：打完所有已刷新演习；战役：配置页已有自动战役设置
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

    const effectiveTimes = (preset.task_type === 'exercise' || preset.task_type === 'decisive' || preset.task_type === 'campaign') ? 1 : times;
    const stopCondition = preset.stop_condition;

    this.scheduler.addTask(name, preset.task_type, req, TaskPriority.USER_TASK, effectiveTimes, stopCondition);

    this.closePresetDetail();
    this.switchPage('main');
    this.renderMain();

    const parts: string[] = [];
    if (effectiveTimes > 1 || stopCondition) parts.push(`×${effectiveTimes}`);
    if (stopCondition?.loot_count_ge) parts.push(`战利品≥${stopCondition.loot_count_ge}时停止`);
    if (stopCondition?.ship_count_ge) parts.push(`舰船≥${stopCondition.ship_count_ge}时停止`);
    this.appendLocalLog('info', `任务「${name}」已加入队列${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
  }

  /** 将当前预设加入任务组 */
  private addPresetToGroup(): void {
    if (!this.currentPreset || !this.currentPresetFilePath) {
      this.appendLocalLog('warn', '没有已加载的任务预设');
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
    this.appendLocalLog('info', `已将「${label} ×${times}」加入任务组「${group.name}」`);
  }

  // ════════════════════════════════════════
  // 核心流程：执行 Plan → 加入调度队列
  // ════════════════════════════════════════

  private executePlan(): void {
    if (!this.currentPlan) return;

    const timesInput = document.getElementById('plan-times') as HTMLInputElement;
    const plan = this.currentPlan;

    // 优先使用 plan 内嵌的 times，否则使用 UI 输入
    const times = plan.data.times ?? Math.max(1, parseInt(timesInput.value, 10) || 1);
    const stopCondition = plan.data.stop_condition;

    const req: NormalFightReq = {
      type: 'normal_fight',
      plan_id: plan.fileName,
      times: 1, // 调度器 remainingTimes 控制重复
      gap: plan.data.gap ?? 0,
    };

    this.scheduler.addTask(
      plan.mapName,
      'normal_fight',
      req,
      TaskPriority.USER_TASK,
      times,
      stopCondition,
    );

    this.switchPage('main');
    this.renderMain();

    // 日志提示
    if (stopCondition) {
      const parts: string[] = [`×${times}`];
      if (stopCondition.loot_count_ge) parts.push(`战利品≥${stopCondition.loot_count_ge}时停止`);
      if (stopCondition.ship_count_ge) parts.push(`舰船≥${stopCondition.ship_count_ge}时停止`);
      this.appendLocalLog('info', `任务「${plan.mapName}」已加入队列 (${parts.join(', ')})`);
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
        progress: this.currentProgress || undefined,
        progressPercent,
      });
    }

    for (const t of queue) {
      taskQueueVo.push({
        id: t.id,
        name: t.name,
        priorityLabel: PRIORITY_LABELS[t.priority] ?? '用户',
        remaining: t.remainingTimes,
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
      this.appendLocalLog('info', `方案已导出: ${saved}`);
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
        this.appendLocalLog('error', `地图 ${mapLabel} 数据不存在`);
        return;
      }

      const allNodes = Object.keys(mapData).sort();
      this.currentPlan = PlanModel.create(chapter, map, allNodes);
      this.currentMapData = mapData;
      this.renderPlanPreview();
      this.switchPage('plan');
      this.appendLocalLog('info', `已新建方案 ${mapLabel}，共 ${allNodes.length} 个节点`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.appendLocalLog('error', `新建方案失败: ${msg}`);
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
    };

    this.planView.render(vo);

    // 显示方案时隐藏模板库卡片和预设面板
    const tplCard = document.getElementById('template-library-card');
    const presetEl = document.getElementById('task-preset-detail');
    if (tplCard) tplCard.style.display = 'none';
    if (presetEl) presetEl.style.display = 'none';

    // 内嵌了 times 的方案：预填次数输入框
    if (plan.data.times != null) {
      const timesInput = document.getElementById('plan-times') as HTMLInputElement;
      if (timesInput) timesInput.value = String(plan.data.times);
    }
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
      themeMode: this.getThemeMode(),
      accentColor: this.getAccentColor(),
      debugMode: localStorage.getItem('debugMode') === 'true',
    };
    this.configView.render(vo);
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

  // ════════════════════════════════════════
  // 模板系统
  // ════════════════════════════════════════

  private static readonly TEMPLATE_TYPE_LABELS: Record<string, string> = {
    normal_fight: '普通出击',
    exercise: '演习',
    campaign: '战役',
    decisive: '决战',
  };

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

    // 步骤2：浏览方案文件
    document.getElementById('btn-tpl-browse-plan')?.addEventListener('click', async () => {
      const bridge = window.electronBridge;
      if (!bridge) return;
      const result = await bridge.openFileDialog(
        [{ name: 'YAML 方案', extensions: ['yaml', 'yml'] }],
        this.plansDir || undefined,
      );
      if (result) {
        (document.getElementById('tpl-plan-path') as HTMLInputElement).value = result.path;
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
    });

    // 初始渲染模板库
    this.renderTemplateLibrary();
  }

  // ── 向导显示/隐藏 ──

  private showWizard(): void {
    this.wizardStep = 1;
    // 重置表单
    (document.querySelector('input[name="tpl-type"][value="normal_fight"]') as HTMLInputElement).checked = true;
    (document.getElementById('tpl-plan-path') as HTMLInputElement).value = '';
    (document.getElementById('tpl-name') as HTMLInputElement).value = '';
    (document.getElementById('tpl-default-times') as HTMLInputElement).value = '1';
    (document.getElementById('tpl-stop-loot') as HTMLInputElement).value = '-1';
    (document.getElementById('tpl-stop-ship') as HTMLInputElement).value = '-1';
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
        if (tpl.planPath) (document.getElementById('tpl-plan-path') as HTMLInputElement).value = tpl.planPath;
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
    const loot = parseInt((document.getElementById('tpl-stop-loot') as HTMLInputElement).value) || 0;
    const ship = parseInt((document.getElementById('tpl-stop-ship') as HTMLInputElement).value) || 0;

    const stopCondition = (loot > 0 || ship > 0) ? {
      ...(loot > 0 ? { loot_count_ge: loot } : {}),
      ...(ship > 0 ? { ship_count_ge: ship } : {}),
    } : undefined;

    const partial: Omit<TaskTemplate, 'id' | 'createdAt'> = {
      name,
      type,
      defaultTimes: times,
      defaultStopCondition: stopCondition,
    };

    // 类型专属字段
    switch (type) {
      case 'normal_fight': {
        const planPath = (document.getElementById('tpl-plan-path') as HTMLInputElement).value;
        if (!planPath) {
          this.wizardStep = 2;
          this.updateWizardUI();
          (document.getElementById('tpl-plan-path') as HTMLInputElement).focus();
          return;
        }
        partial.planPath = planPath;
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

    await this.templateModel.add(partial);
    this.hideWizard();
    this.renderTemplateLibrary();
    this.appendLocalLog('info', `模板「${name}」已创建`);
  }

  // ── 使用模板 → 加入任务队列 ──

  private async useTemplate(id: string): Promise<void> {
    const tpl = this.templateModel.get(id);
    if (!tpl) return;

    const times = tpl.defaultTimes ?? 1;

    let req: TaskRequest;
    switch (tpl.type) {
      case 'exercise':
        req = { type: 'exercise', fleet_id: tpl.fleet_id ?? 1 };
        break;
      case 'campaign':
        req = { type: 'campaign', campaign_name: tpl.campaign_name ?? '困难潜艇', times };
        break;
      case 'decisive':
        req = {
          type: 'decisive',
          chapter: tpl.chapter ?? 6,
          level1: tpl.level1 ?? [],
          level2: tpl.level2 ?? [],
          flagship_priority: tpl.flagship_priority ?? [],
        };
        break;
      case 'normal_fight':
      default:
        if (tpl.fleet?.length) {
          req = {
            type: 'normal_fight',
            plan: {
              fleet_id: tpl.fleet_id ?? 1,
              fleet: tpl.fleet,
            },
            plan_id: tpl.planPath ?? null,
            times: 1,
            gap: tpl.defaultGap ?? 0,
          };
        } else {
          req = {
            type: 'normal_fight',
            plan_id: tpl.planPath ?? null,
            times: 1,
            gap: tpl.defaultGap ?? 0,
          };
        }
        break;
    }

    const effectiveTimes = (tpl.type === 'exercise' || tpl.type === 'decisive') ? 1 : times;

    this.scheduler.addTask(
      tpl.name,
      tpl.type,
      req,
      TaskPriority.USER_TASK,
      effectiveTimes,
      tpl.defaultStopCondition,
    );

    this.renderMain();
    this.appendLocalLog('info', `模板「${tpl.name}」→ 任务已加入队列 (×${effectiveTimes})`);
  }

  private async deleteTemplate(id: string): Promise<void> {
    const tpl = this.templateModel.get(id);
    if (!tpl) return;
    const ok = await this.showConfirm('确认删除', `确定删除模板「${tpl.name}」？`);
    if (!ok) return;
    await this.templateModel.remove(id);
    this.renderTemplateLibrary();
    this.appendLocalLog('info', `模板「${tpl.name}」已删除`);
  }

  private async renameTemplate(id: string): Promise<void> {
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
      this.appendLocalLog('info', `其余 ${count} 个模板已直接导入`);
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

    container.innerHTML = templates.map(tpl => `
      <div class="tpl-item" data-tpl-id="${tpl.id}">
        <div class="tpl-item-info">
          <div class="tpl-item-name" title="${tpl.name}">${tpl.name}</div>
          <div class="tpl-item-type">${AppController.TEMPLATE_TYPE_LABELS[tpl.type] ?? tpl.type}${tpl.defaultTimes ? ` · ×${tpl.defaultTimes}` : ''}</div>
        </div>
        <div class="tpl-item-actions">
          <button class="btn btn-small btn-primary" data-tpl-action="use" data-tpl-id="${tpl.id}" title="加入队列">使用</button>
          <button class="btn btn-small" data-tpl-action="rename" data-tpl-id="${tpl.id}" title="重命名">✎</button>
          <button class="btn btn-small btn-danger" data-tpl-action="delete" data-tpl-id="${tpl.id}" title="删除">✕</button>
        </div>
      </div>
    `).join('');
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

  /** 追加一条本地日志到 UI (非后端推送) */
  private appendLocalLog(level: string, message: string): void {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    this.mainView.appendLog({ time, level, channel: 'GUI', message });
  }
}

// ── 入口：实例化并初始化 ──
const app = new AppController();
app.init();
