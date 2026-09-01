/**
 * 连接 GUI 自动更新 IPC 与 electron-updater。
 */
import * as path from 'path';
import {
  autoUpdater,
  type Logger,
  type UpdateDownloadedEvent,
  type UpdateFileInfo,
  type UpdateInfo,
} from 'electron-updater';
import type { IpcRegistrar } from './IpcRegistrar';
import type {
  GuiUpdateStateStore,
} from '../services/GuiUpdateStateStore';
import {
  classifyGuiUpdateCheck,
  resolveGuiUpdateSelectionPolicy,
  validateGuiUpdateCandidate,
} from '../services/GuiUpdatePolicy';

type GuiUpdateCheckResult =
  | { status: 'available'; version: string }
  | { status: 'up-to-date' }
  | { status: 'error'; message: string };

export interface UpdaterContext {
  sendToRenderer(channel: string, ...args: unknown[]): boolean;
  getAppVersion(): string;
  allowTestUpdates(): boolean;
  logger: Logger;
  updateStates: GuiUpdateStateStore;
  chooseDownload(
    version: string,
  ): Promise<'now' | 'later'>;
  chooseRestartTiming(
    version: string,
  ): Promise<'restart' | 'next-launch'>;
  installDownloadedUpdate(): Promise<void>;
}

function updateFileName(file: UpdateFileInfo): string {
  try {
    const url = new URL(file.url, 'https://update.invalid');
    return path.basename(decodeURIComponent(url.pathname));
  } catch {
    return path.basename(file.url);
  }
}

function downloadedFileMetadata(
  info: UpdateDownloadedEvent,
): {
  sha512: string;
  isAdminRightsRequired: boolean;
} {
  const downloadedName = path.basename(info.downloadedFile);
  const file = info.files.find(
    candidate => updateFileName(candidate) === downloadedName,
  ) ?? info.files[0];
  return {
    sha512: file?.sha512 ?? info.sha512,
    isAdminRightsRequired:
      file?.isAdminRightsRequired === true,
  };
}

/** 注册 GUI 更新检查；下载和安装决定均由主进程系统弹窗控制。 */
export function registerUpdaterIpc(
  ipc: IpcRegistrar,
  context: UpdaterContext,
): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = context.logger;

  let updatePolicy = resolveGuiUpdateSelectionPolicy(
    context.getAppVersion(),
    context.allowTestUpdates(),
  );
  const applyUpdatePolicy = (): void => {
    updatePolicy = resolveGuiUpdateSelectionPolicy(
      context.getAppVersion(),
      context.allowTestUpdates(),
    );
    autoUpdater.channel = updatePolicy.channel;
    autoUpdater.allowPrerelease = updatePolicy.allowPrerelease;
  };
  applyUpdatePolicy();

  let approvedUpdateVersion: string | null = null;
  let declinedUpdateVersion: string | null = null;
  let downloadPromise: Promise<void> | null = null;
  let checkPromise: Promise<GuiUpdateCheckResult> | null = null;
  let choosingRestartTiming = false;

  const reportError = (message: string): void => {
    context.logger.error(message);
    context.sendToRenderer('update-status', {
      status: 'error',
      message,
    });
  };

  const beginDownload = (version: string): Promise<void> => {
    if (downloadPromise) return downloadPromise;
    context.logger.info(
      `User approved background download for GUI v${version}`,
    );
    context.sendToRenderer('update-status', {
      status: 'downloading',
    });
    downloadPromise = autoUpdater.downloadUpdate()
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = error instanceof Error
          ? error.message
          : String(error);
        reportError(message);
      })
      .finally(() => {
        downloadPromise = null;
      });
    return downloadPromise;
  };

  const offerDownload = async (version: string): Promise<void> => {
    const pending = context.updateStates.read();
    if (pending?.targetVersion === version) {
      context.sendToRenderer('update-status', {
        status: 'deferred',
        version,
      });
      return;
    }
    if (declinedUpdateVersion === version || downloadPromise) return;

    const choice = await context.chooseDownload(version);
    if (choice === 'later') {
      declinedUpdateVersion = version;
      context.logger.info(
        `User deferred GUI v${version} download until next launch`,
      );
      return;
    }
    void beginDownload(version);
  };

  const offerRestart = async (version: string): Promise<void> => {
    if (choosingRestartTiming) return;
    choosingRestartTiming = true;
    try {
      const timing = await context.chooseRestartTiming(version);
      if (timing === 'restart') {
        context.sendToRenderer('update-status', {
          status: 'installing',
          message: '正在安全停止任务并准备后台更新',
        });
        await context.installDownloadedUpdate();
        return;
      }
      context.logger.info(
        `GUI v${version} will install before next window opens`,
      );
      context.sendToRenderer('update-status', {
        status: 'deferred',
        version,
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);
      reportError(`GUI 更新安装准备失败：${message}`);
    } finally {
      choosingRestartTiming = false;
    }
  };

  autoUpdater.on('checking-for-update', () => {
    context.sendToRenderer('update-status', {
      status: 'checking',
    });
  });
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const mismatch = validateGuiUpdateCandidate(
      updatePolicy,
      info.version,
    );
    if (mismatch) {
      approvedUpdateVersion = null;
      reportError(mismatch);
      return;
    }
    approvedUpdateVersion = info.version;
    context.sendToRenderer('update-status', {
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : '',
    });
  });
  autoUpdater.on('update-not-available', () => {
    approvedUpdateVersion = null;
    context.sendToRenderer('update-status', {
      status: 'up-to-date',
    });
  });
  autoUpdater.on(
    'update-downloaded',
    (info: UpdateDownloadedEvent) => {
      const mismatch = validateGuiUpdateCandidate(
        updatePolicy,
        info.version,
      );
      if (mismatch) {
        reportError(mismatch);
        return;
      }
      try {
        const metadata = downloadedFileMetadata(info);
        if (!metadata.sha512) {
          throw new Error('更新元数据缺少 SHA-512 校验值');
        }
        context.updateStates.saveDownloaded({
          sourceVersion: context.getAppVersion(),
          targetVersion: info.version,
          downloadedFile: info.downloadedFile,
          sha512: metadata.sha512,
          isAdminRightsRequired:
            metadata.isAdminRightsRequired,
        });
        context.logger.info(
          `GUI v${info.version} downloaded and persisted: `
          + info.downloadedFile,
        );
        context.sendToRenderer('update-status', {
          status: 'downloaded',
          version: info.version,
        });
        void offerRestart(info.version);
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        reportError(message);
      }
    },
  );
  autoUpdater.on('error', (error: Error) => {
    approvedUpdateVersion = null;
    reportError(error.message);
  });

  ipc.handle('check-gui-updates', async () => {
    if (checkPromise) return checkPromise;
    checkPromise = (async (): Promise<GuiUpdateCheckResult> => {
      try {
        applyUpdatePolicy();
        const result = await autoUpdater.checkForUpdates();
        const classified = classifyGuiUpdateCheck(
          updatePolicy,
          result,
        );
        approvedUpdateVersion = classified.status === 'available'
          ? classified.version
          : null;
        if (
          classified.status === 'available'
          && approvedUpdateVersion
        ) {
          await offerDownload(approvedUpdateVersion);
        }
        return classified;
      } catch (error) {
        approvedUpdateVersion = null;
        const message = error instanceof Error
          ? error.message
          : String(error);
        reportError(message);
        return {
          status: 'error',
          message,
        };
      }
    })();
    try {
      return await checkPromise;
    } finally {
      checkPromise = null;
    }
  });
}
