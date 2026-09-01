/**
 * 复核已下载安装包，并以静默模式启动 NSIS 更新。
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from 'electron-updater';
import {
  GuiUpdateStateStore,
  type GuiUpdateState,
} from './GuiUpdateStateStore';

interface GuiUpdateInstallerDependencies {
  fileExists(filePath: string): boolean;
  hashSha512(filePath: string): Promise<string>;
  launch(command: string, args: string[]): Promise<number>;
  updaterCacheRoot: string;
}

function defaultUpdaterCacheRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
    ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'wsgrgui-updater');
}

function hashSha512(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    hash.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => {
      resolve(hash.digest('base64'));
    });
  });
}

function launchDetached(
  command: string,
  args: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      if (!pid) {
        reject(new Error('安装器进程没有返回 PID'));
        return;
      }
      resolve(pid);
    });
  });
}

/** 只负责 updater 缓存中的安装包，不处理应用或用户数据目录。 */
export class GuiUpdateInstaller {
  constructor(
    private readonly states: GuiUpdateStateStore,
    private readonly logger: Logger,
    private readonly resourcesPath: string,
    private readonly dependencies: GuiUpdateInstallerDependencies = {
      fileExists: filePath => fs.existsSync(filePath),
      hashSha512,
      launch: launchDetached,
      updaterCacheRoot: defaultUpdaterCacheRoot(),
    },
  ) {}

  /** 校验并启动安装器；安装完成后由 NSIS 启动新版本。 */
  async launchPendingUpdate(): Promise<GuiUpdateState> {
    const state = this.states.read();
    if (!state) {
      throw new Error('没有可安装的 GUI 更新');
    }
    try {
      await this.verifyInstaller(state);
    } catch (error) {
      this.states.clear();
      this.cleanupPendingFiles(state);
      throw error;
    }

    this.states.markInstalling();
    try {
      const args = ['--updated', '/S', '--force-run'];
      const pid = await this.launchInstaller(state, args);
      const installing = this.states.saveInstallerPid(pid);
      this.logger.info(
        `GUI update installer started: pid=${pid}, `
        + `version=${state.targetVersion}`,
      );
      return installing;
    } catch (error) {
      this.states.restoreDownloaded();
      throw error;
    }
  }

  /** 新版本确认启动后，只删除 updater 的 pending 临时目录。 */
  cleanupAppliedUpdate(state: GuiUpdateState): boolean {
    return this.cleanupPendingFiles(state);
  }

  private async verifyInstaller(
    state: GuiUpdateState,
  ): Promise<void> {
    if (!this.dependencies.fileExists(state.downloadedFile)) {
      throw new Error('已下载的 GUI 安装包不存在，需要重新下载');
    }
    const actual = await this.dependencies.hashSha512(
      state.downloadedFile,
    );
    if (actual !== state.sha512) {
      throw new Error('GUI 安装包校验失败，需要重新下载');
    }
  }

  private async launchInstaller(
    state: GuiUpdateState,
    installerArgs: string[],
  ): Promise<number> {
    const elevate = path.join(this.resourcesPath, 'elevate.exe');
    if (
      state.isAdminRightsRequired
      && this.dependencies.fileExists(elevate)
    ) {
      return this.dependencies.launch(
        elevate,
        [state.downloadedFile, ...installerArgs],
      );
    }
    try {
      return await this.dependencies.launch(
        state.downloadedFile,
        installerArgs,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (code === 'EACCES' || code === 'UNKNOWN')
        && this.dependencies.fileExists(elevate)
      ) {
        return this.dependencies.launch(
          elevate,
          [state.downloadedFile, ...installerArgs],
        );
      }
      throw error;
    }
  }

  private cleanupPendingFiles(state: GuiUpdateState): boolean {
    const pendingDirectory = path.dirname(
      path.resolve(state.downloadedFile),
    );
    const expectedPendingDirectory = path.join(
      path.resolve(this.dependencies.updaterCacheRoot),
      'pending',
    );
    if (
      pendingDirectory.toLowerCase()
      !== expectedPendingDirectory.toLowerCase()
    ) {
      this.logger.warn(
        `Skip GUI update cleanup outside pending directory: `
        + pendingDirectory,
      );
      return false;
    }
    try {
      fs.rmSync(pendingDirectory, {
        recursive: true,
        force: true,
      });
      this.logger.info(
        `Cleaned GUI update pending directory: ${pendingDirectory}`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Cannot clean GUI update pending directory: ${String(error)}`,
      );
      return false;
    }
  }
}
