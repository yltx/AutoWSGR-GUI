/** 编排运行环境准备、依赖安装和 GUI 更新检查。 */
/**
 * envAndUpdates —— 环境检查、依赖安装、更新检查逻辑。
 */
import type { StartupGateway } from '../../adapter/IpcAdapter.js';
import { browserStorageStore } from '../../adapter/StorageAdapter.js';
import { Logger } from '../../utils/Logger';

function getUpdateMode(bridge?: StartupGateway): 'auto' | 'manual' {
  const fromBridge = bridge?.getUpdateMode?.();
  if (fromBridge === 'manual') return 'manual';
  if (fromBridge === 'auto') return 'auto';
  try {
    return browserStorageStore.get('updateMode') === 'manual'
      ? 'manual'
      : 'auto';
  } catch {
    return 'auto';
  }
}

/** 检查 Python 环境, 缺失时自动安装本地便携版 */
export async function checkAndPrepareEnv(
  bridge: StartupGateway,
): Promise<boolean> {
  Logger.info('正在检查运行环境…');

  let env = await bridge.checkEnvironment();

  if (!env.pythonCmd) {
    if (bridge.installPortablePython) {
      const result = await bridge.installPortablePython();
      if (!result.success) {
        Logger.error('Python 安装失败，请手动运行 setup.bat');
        return false;
      }
    } else {
      Logger.error('未找到 Python，请安装 Python 3.12 或 3.13');
      return false;
    }
    env = await bridge.checkEnvironment();
    if (!env.pythonCmd) {
      Logger.error('安装后仍未检测到 Python，请重启应用');
      return false;
    }
  }

  if (env.allReady) return true;

  Logger.info(`正在安装缺失依赖: ${env.missingPackages.join(', ')}…`);
  const installResult = await bridge.installDeps();

  if (!installResult.success) {
    Logger.error('依赖安装失败，请检查日志');
    // 原始 pip 输出仅写入日志文件，不推送到 UI 面板（可能含乱码，不适合展示）
    Logger.logToFile(installResult.output.slice(-200));
    return false;
  }

  env = await bridge.checkEnvironment();
  if (!env.allReady) {
    Logger.error(`仍缺少依赖: ${env.missingPackages.join(', ')}`);
    return false;
  }

  return true;
}

/** 运行 setup.bat 安装环境 */
export async function runSetupScript(
  bridge: StartupGateway,
): Promise<boolean> {
  if (!bridge.runSetup) return false;

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

/** 检查更新 (非阻塞, 仅日志提示) */
export async function checkForUpdates(
  bridge: StartupGateway,
): Promise<void> {
  const updateMode = getUpdateMode(bridge);

  initGuiAutoUpdate(bridge);
  if (updateMode === 'manual') {
    Logger.info('当前为手动更新模式，已跳过启动自动更新检查');
    return;
  }
}

/** 初始化 GUI 自动更新监听 + 首次检查 */
function initGuiAutoUpdate(bridge: StartupGateway): void {
  if (!bridge.onUpdateStatus) return;

  bridge.onUpdateStatus((status) => {
    switch (status.status) {
      case 'available':
        Logger.info(
          `发现 GUI 新版本 v${status.version}，等待用户选择更新时间`,
        );
        break;
      case 'downloading':
        Logger.info('GUI 更新正在后台静默下载并校验');
        break;
      case 'downloaded':
        Logger.info(`GUI v${status.version} 已准备完成，等待选择重启时间`);
        break;
      case 'deferred':
        Logger.info(`GUI v${status.version} 将在下次打开前更新，当前任务继续运行`);
        break;
      case 'installing':
        Logger.info(status.message);
        break;
      case 'error':
        Logger.warn(`GUI 更新检查失败: ${status.message || '未知错误'}`);
        break;
    }
  });

  setTimeout(() => {
    if (getUpdateMode(bridge) === 'manual') return;
    bridge.checkGuiUpdates?.().catch(() => {});
  }, 5000);
}
