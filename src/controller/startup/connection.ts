/** 检测后端可用性并管理启动阶段的连接等待。 */
/**
 * connection —— 后端连接与系统启动逻辑。
 */
import type { StartupHost } from '../contracts.js';
import { Logger } from '../../utils/Logger';

/** 等待后端 HTTP 服务就绪, 然后启动系统 */
export function waitForBackendAndConnect(host: StartupHost, retries = 30): void {
  host.scheduler.ping().then((alive) => {
    if (alive) {
      Logger.info('后端服务就绪，正在连接模拟器…');
      void startSystem(host);
    } else if (retries > 0) {
      setTimeout(() => waitForBackendAndConnect(host, retries - 1), 1000);
    } else {
      Logger.error('后端服务启动超时，请检查 Python 环境');
      host.renderMain();
    }
  }).catch(() => {
    if (retries > 0) {
      setTimeout(() => waitForBackendAndConnect(host, retries - 1), 1000);
    } else {
      Logger.error('后端连接失败');
      host.renderMain();
    }
  });
}

/** 向后端发送 system/start (连接模拟器+启动游戏) */
export async function startSystem(host: StartupHost): Promise<boolean> {
  const configPath = host.configDir
    ? `${host.configDir.replace(/\\/g, '/')}/usersettings.yaml`
    : undefined;

  const automation = host.configModel.current.daily_automation;
  const guiAutomation = host.configModel.currentGuiAutomation;
  host.scheduler.setAutoExpedition(automation.auto_expedition);
  host.scheduler.setExpeditionInterval(guiAutomation.expeditionInterval);

  try {
    const ok = await host.scheduler.start(configPath);
    if (ok) {
      Logger.info('系统启动成功 ✓');
      host.cronScheduler.start();
      Logger.info('定时调度器已启动');
      host.startHeartbeat();
    } else {
      Logger.error('系统启动失败 (模拟器连接/游戏启动异常)');
    }
    host.renderMain();
    return ok;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('abort')) {
      Logger.warn('系统启动 HTTP 请求超时，正在检测后端状态…');
      const ready = await host.scheduler.isSystemReady();
      if (ready) {
        Logger.info('后端已就绪，正在恢复连接…');
        host.scheduler.recoverAfterTimeout();
        host.cronScheduler.start();
        Logger.info('定时调度器已启动');
        host.startHeartbeat();
      } else {
        Logger.error('系统启动超时且模拟器仍未连接');
      }
      host.renderMain();
      return ready;
    } else {
      Logger.error(`系统启动异常: ${msg}`);
    }
    host.renderMain();
    return false;
  }
}
