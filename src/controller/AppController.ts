/**
 * AppController —— 核心控制器。
 * 协调 Model 和 View，负责：
 *   1. 从 Model 提取信息 → 拼装 ViewObject → 单向传递给 View 渲染
 *   2. 接收 View 的用户操作 → 调用 Model 或 IPC
 */
import { MainView } from '../view/MainView';
import { PlanPreviewView } from '../view/PlanPreviewView';
import { ConfigView } from '../view/ConfigView';
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
import type { NormalFightReq, TaskRequest } from '../model/ApiClient';
import {
  FORMATION_NAMES,
  FIGHT_CONDITION_NAMES,
  REPAIR_MODE_NAMES,
  type TaskPreset,
  type EnemyRule,
} from '../model/types';
import { loadMapData, loadExMapData, getNodeType, isDetourNode } from '../model/MapDataLoader';

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
  openFileDialog: (filters: { name: string; extensions: string[] }[]) => Promise<{ path: string; content: string } | null>;
  saveFile: (path: string, content: string) => Promise<void>;
  saveFileDialog: (defaultName: string, content: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  readFile: (path: string) => Promise<string>;
  detectEmulator: () => Promise<{ type: string; path: string; serial: string; adbPath: string } | null>;
  getAppRoot: () => Promise<string>;
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

  private configModel: ConfigModel;
  private currentPlan: PlanModel | null = null;
  private currentMapData: MapData | null = null;

  // ── 调度相关 ──
  private api: ApiClient;
  private scheduler: Scheduler;
  private cronScheduler: CronScheduler;
  private wsConnected = false;
  private expeditionTimerText = '--:--';
  private currentProgress = '';
  private appRoot = '';
  private editingNodeId: string | null = null;

  constructor() {
    this.mainView = new MainView();
    this.planView = new PlanPreviewView();
    this.configView = new ConfigView();
    this.configModel = new ConfigModel();

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
    this.renderMain();
    this.planView.render(null);

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.getThemeMode() === 'system') this.applyTheme();
    });

    // 窗口关闭时保存定时调度器状态 (用于下次启动时检测错过的刷新)
    window.addEventListener('beforeunload', () => {
      this.cronScheduler.saveState();
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

    // ── 1. 环境检查 ──
    const envReady = await this.checkAndPrepareEnv(bridge);
    if (!envReady) return; // 日志中已输出错误信息

    // ── 2. 检查更新 (非阻塞) ──
    this.checkForUpdates(bridge);

    // ── 3. 加载配置 & 检测模拟器 ──
    await this.loadConfig();
    await this.detectAndApplyEmulator();
    this.renderConfig();

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

    this.scheduler.start(configPath).then((ok) => {
      if (ok) {
        this.appendLocalLog('info', '系统启动成功 ✓');
        this.cronScheduler.start();
        this.appendLocalLog('info', '定时调度器已启动');
      } else {
        this.appendLocalLog('error', '系统启动失败 (模拟器连接/游戏启动异常)');
      }
      this.renderMain();
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort')) {
        this.appendLocalLog('error', '系统启动超时 (模拟器连接耗时过长)');
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
      // 文件不存在时使用默认值
      console.log('usersettings.yaml 未找到，使用默认配置');
    }
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

    // 停止当前任务
    document.getElementById('btn-stop-task')?.addEventListener('click', () => this.scheduler.stopCurrentTask());

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
      this.planView.showNodeEditor(nodeId, {
        formation: args.formation ?? 2,
        night: args.night ?? false,
        proceed: args.proceed ?? true,
        enemyRules: rulesText,
      });
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

    // 方案：plan-level 字段修改回调
    this.planView.onPlanFieldChange = (field, value) => {
      if (!this.currentPlan) return;
      if (field === 'repair_mode') this.currentPlan.data.repair_mode = value;
      else if (field === 'fight_condition') this.currentPlan.data.fight_condition = value;
      else if (field === 'fleet_id') this.currentPlan.data.fleet_id = value;
    };
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

      onTaskCompleted: (_taskId, _success, _result, _error) => {
        this.currentProgress = '';
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
        this.scheduler.addTask(
          '自动演习',
          'exercise',
          { type: 'exercise', fleet_id: fleetId },
          TaskPriority.DAILY,
          1,
        );
        this.appendLocalLog('info', `自动演习已加入队列 (舰队 ${fleetId})`);
        this.scheduler.startConsuming();
      },

      onCampaignDue: (campaignName, times) => {
        this.scheduler.addTask(
          `自动战役·${campaignName}`,
          'campaign',
          { type: 'campaign', campaign_name: campaignName, times },
          TaskPriority.DAILY,
          times,
        );
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
    ]);
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

  /** 导入任务预设 YAML 并直接加入调度队列 */
  private importTaskPreset(preset: TaskPreset, filePath: string): void {
    const name = filePath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? preset.task_type;
    let req: TaskRequest;
    const times = preset.times ?? 1;

    // 将相对 plan_id 解析为绝对路径 (相对于预设文件所在目录)
    let resolvedPlanId = preset.plan_id ?? null;
    if (resolvedPlanId && !/^[A-Za-z]:[/\\]/.test(resolvedPlanId) && !resolvedPlanId.startsWith('/')) {
      const dir = filePath.replace(/[\\/][^\\/]+$/, '');
      resolvedPlanId = dir + '\\' + resolvedPlanId.replace(/\//g, '\\');
    }

    switch (preset.task_type) {
      case 'exercise':
        req = { type: 'exercise', fleet_id: preset.fleet_id ?? 1 };
        break;
      case 'campaign':
        req = { type: 'campaign', campaign_name: preset.campaign_name ?? '困难潜艇', times };
        break;
      case 'decisive':
        req = {
          type: 'decisive',
          chapter: preset.chapter ?? 6,
          level1: preset.level1 ?? [],
          level2: preset.level2 ?? [],
          flagship_priority: preset.flagship_priority ?? [],
        };
        break;
      case 'event_fight':
        req = {
          type: 'event_fight',
          plan_id: resolvedPlanId,
          times: 1,
          gap: preset.gap ?? 0,
          fleet_id: preset.fleet_id ?? null,
        };
        break;
      case 'normal_fight':
      default:
        req = {
          type: 'normal_fight',
          plan_id: resolvedPlanId,
          times: 1,
          gap: preset.gap ?? 0,
        };
        break;
    }

    const effectiveTimes = preset.task_type === 'exercise' || preset.task_type === 'decisive' ? 1 : times;
    const stopCondition = preset.stop_condition;

    this.scheduler.addTask(
      name,
      preset.task_type,
      req,
      TaskPriority.USER_TASK,
      effectiveTimes,
      stopCondition,
    );

    this.switchPage('main');
    this.renderMain();

    const parts: string[] = [];
    if (effectiveTimes > 1 || stopCondition) parts.push(`×${effectiveTimes}`);
    if (stopCondition?.loot_count_ge) parts.push(`战利品≥${stopCondition.loot_count_ge}时停止`);
    if (stopCondition?.ship_count_ge) parts.push(`舰船≥${stopCondition.ship_count_ge}时停止`);
    this.appendLocalLog('info', `任务「${name}」已加入队列${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
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

    const taskQueueVo: TaskQueueItemVO[] = queue.map((t: SchedulerTask) => ({
      id: t.id,
      name: t.name,
      priorityLabel: PRIORITY_LABELS[t.priority] ?? '用户',
      remaining: t.remainingTimes,
    }));

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
    };
    this.mainView.render(vo);
  }

  private closePlan(): void {
    this.currentPlan = null;
    this.currentMapData = null;
    this.editingNodeId = null;
    this.planView.render(null);
    this.planView.hideNodeEditor();
  }

  /** 导出当前方案为 YAML 文件 */
  private async exportPlan(): Promise<void> {
    if (!this.currentPlan) return;
    const bridge = window.electronBridge;
    if (!bridge) return;

    const yamlStr = this.currentPlan.toYaml();
    const defaultName = this.currentPlan.fileName
      ? this.currentPlan.fileName.split(/[\\/]/).pop() || `${this.currentPlan.mapName}.yaml`
      : `${this.currentPlan.mapName}.yaml`;

    const saved = await bridge.saveFileDialog(defaultName, yamlStr, [
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
      autoBattle: cfg.daily_automation.auto_battle,
      battleType: cfg.daily_automation.battle_type,
      autoExercise: cfg.daily_automation.auto_exercise,
      exerciseFleetId: cfg.daily_automation.exercise_fleet_id,
      battleTimes: cfg.daily_automation.battle_times,
      themeMode: this.getThemeMode(),
      accentColor: this.getAccentColor(),
    };
    this.configView.render(vo);
  }

  private async saveConfig(): Promise<void> {
    const collected = this.configView.collect();

    // 保存界面设置到 localStorage
    localStorage.setItem('themeMode', collected.themeMode);
    localStorage.setItem('accentColor', collected.accentColor);
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
        auto_battle: collected.autoBattle,
        battle_type: collected.battleType,
        auto_exercise: collected.autoExercise,
        exercise_fleet_id: collected.exerciseFleetId,
        battle_times: collected.battleTimes,
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

    const yamlStr = this.configModel.toYaml();
    console.log('保存配置:\n', yamlStr);

    const bridge = window.electronBridge;
    if (bridge) {
      await bridge.saveFile('usersettings.yaml', yamlStr);
    }
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
