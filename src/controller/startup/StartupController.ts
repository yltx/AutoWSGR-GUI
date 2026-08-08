/** 统一协调应用启动、后端连接、环境检查和资源释放。 */
/**
 * StartupController —— 应用启动流程控制器（精简版）。
 * 环境检查 → envAndUpdates.ts，后端连接 → connection.ts。
 */
import {
  getStartupGateway,
  type StartupGateway,
} from '../../adapter/IpcAdapter.js';
import { Logger } from '../../utils/Logger';
import { checkAndPrepareEnv, checkForUpdates } from './envAndUpdates';
import { waitForBackendAndConnect } from './connection';
import type { StartupHost } from '../contracts.js';

// ════════════════════════════════════════
// StartupController
// ════════════════════════════════════════

export class StartupController {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: StartupHost,
    private readonly gateway: StartupGateway | undefined =
      getStartupGateway(),
  ) {}

  /** 完整的异步启动流程 */
  async run(): Promise<void> {
    const bridge = this.gateway;
    if (!bridge) return;

    // 获取目录
    if (bridge.getAppRoot) this.host.appRoot = await bridge.getAppRoot();
    if (bridge.getPlansDir) this.host.plansDir = await bridge.getPlansDir();
    if (bridge.getConfigDir) this.host.configDir = await bridge.getConfigDir();
    this.host.syncPaths(this.host.appRoot, this.host.plansDir, this.host.configDir);

    // 初始化日志
    this.host.initLogger(bridge);
    Logger.info(`配置文件目录: ${this.host.configDir}`);
    Logger.info(`方案文件目录: ${this.host.plansDir}`);

    // 在配置和任务组读入内存前处理冲突，避免保存时恢复已删除文件的旧引用。
    await this.host.reviewMigrationConflicts();

    // 1. 加载配置 & 渲染
    await this.host.loadConfigAndSync();
    Logger.debug('配置加载完成');
    await this.host.detectAndApplyEmulator();
    Logger.debug('模拟器检测完成');

    // 首次运行引导
    if (!localStorage.getItem('setupComplete')) {
      await this.host.showSetupWizard();
    }

    // 加载模板/任务组/渲染
    await this.host.loadModelsAndRender(bridge);

    // 绑定后端日志
    this.host.bindBackendLog(bridge);

    // 2. 环境检查
    const envReady = await checkAndPrepareEnv(bridge);
    if (!envReady) return;

    // 3. 检查更新 (非阻塞)
    checkForUpdates(bridge);

    // 4. 启动后端 & 连接
    const backendStartupMode = bridge.getBackendStartupMode?.() ?? 'managed';
    if (backendStartupMode === 'external') {
      Logger.info('正在启动本地后端服务…');
    } else {
      Logger.info('正在启动后端服务…');
    }
    const backendResult = await bridge.startBackend();
    if (!backendResult.success) {
      Logger.error(`后端启动失败: ${backendResult.message}`);
      return;
    }
    waitForBackendAndConnect(this.host);
  }

  /** 代理: 等待后端并连接 */
  waitForBackendAndConnect(retries?: number): void {
    waitForBackendAndConnect(this.host, retries);
  }

  /** 代理: 启动系统 */
  startSystem(): void {
    import('./connection.js').then(m => m.startSystem(this.host));
  }

  startHeartbeat(): void {
    this.stopHeartbeat();
    let consecutiveFails = 0;
    this.heartbeatTimer = setInterval(async () => {
      try {
        const alive = await this.host.scheduler.ping();
        consecutiveFails = alive ? 0 : consecutiveFails + 1;
      } catch {
        consecutiveFails++;
      }
      if (consecutiveFails < 3) return;

      Logger.error('后端连续 3 次心跳失败，尝试自动重启…');
      this.stopHeartbeat();
      const bridge = this.gateway;
      if (bridge?.startBackend) {
        await bridge.startBackend();
        this.waitForBackendAndConnect();
      }
    }, 30_000);
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
