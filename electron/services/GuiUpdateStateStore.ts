/**
 * 持久化 GUI 更新下载和安装状态，供应用重启前后的启动门禁使用。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFileStore } from './AtomicFileStore';

const INSTALLING_STATE_TIMEOUT_MS = 30 * 60 * 1000;
const INSTALLER_EXIT_GRACE_MS = 5 * 60 * 1000;

export interface GuiUpdateState {
  status: 'downloaded' | 'installing';
  sourceVersion: string;
  targetVersion: string;
  downloadedFile: string;
  sha512: string;
  isAdminRightsRequired: boolean;
  downloadedAt: string;
  installingAt?: string;
  installerPid?: number;
}

export type GuiUpdateStartupAction =
  | { action: 'continue' }
  | { action: 'cleanup'; state: GuiUpdateState }
  | { action: 'install'; state: GuiUpdateState }
  | { action: 'wait'; state: GuiUpdateState };

interface GuiUpdateStateStoreDependencies {
  now(): number;
  isProcessRunning(pid: number): boolean;
}

function defaultProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 管理用户数据目录中的单个 GUI 更新状态文件。 */
export class GuiUpdateStateStore {
  constructor(
    private readonly filePath: () => string,
    private readonly atomicFiles: AtomicFileStore,
    private readonly dependencies: GuiUpdateStateStoreDependencies = {
      now: () => Date.now(),
      isProcessRunning: defaultProcessRunning,
    },
  ) {}

  /** 读取并校验状态；损坏或不完整的内容不会阻塞 GUI 启动。 */
  read(): GuiUpdateState | null {
    const target = this.filePath();
    if (!fs.existsSync(target)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf-8'));
      return this.normalize(value);
    } catch {
      return null;
    }
  }

  /** 记录 electron-updater 已下载并校验完成的安装包。 */
  saveDownloaded(input: {
    sourceVersion: string;
    targetVersion: string;
    downloadedFile: string;
    sha512: string;
    isAdminRightsRequired?: boolean;
  }): GuiUpdateState {
    const state: GuiUpdateState = {
      status: 'downloaded',
      sourceVersion: input.sourceVersion,
      targetVersion: input.targetVersion,
      downloadedFile: path.resolve(input.downloadedFile),
      sha512: input.sha512,
      isAdminRightsRequired:
        input.isAdminRightsRequired === true,
      downloadedAt: new Date(this.dependencies.now()).toISOString(),
    };
    this.write(state);
    return state;
  }

  /** 在启动安装器前写入安装锁，避免重复启动进入旧版 GUI。 */
  markInstalling(): GuiUpdateState {
    const current = this.requireState();
    const state: GuiUpdateState = {
      ...current,
      status: 'installing',
      installingAt: new Date(this.dependencies.now()).toISOString(),
      installerPid: undefined,
    };
    this.write(state);
    return state;
  }

  /** 安装器成功创建后保存 PID，供后续重复启动判断。 */
  saveInstallerPid(pid: number): GuiUpdateState {
    const current = this.requireState();
    const state: GuiUpdateState = {
      ...current,
      status: 'installing',
      installerPid: pid,
    };
    this.write(state);
    return state;
  }

  /** 安装器启动失败时恢复为待安装状态。 */
  restoreDownloaded(): GuiUpdateState {
    const current = this.requireState();
    const state: GuiUpdateState = {
      ...current,
      status: 'downloaded',
      installingAt: undefined,
      installerPid: undefined,
    };
    this.write(state);
    return state;
  }

  /** 根据当前应用版本和安装器进程决定启动前应执行的动作。 */
  resolveStartup(currentVersion: string): GuiUpdateStartupAction {
    const state = this.read();
    if (!state) return { action: 'continue' };

    if (currentVersion !== state.sourceVersion) {
      this.clear();
      return { action: 'cleanup', state };
    }
    if (state.status === 'downloaded') {
      return { action: 'install', state };
    }
    if (this.isInstallationActive(state)) {
      return { action: 'wait', state };
    }

    return {
      action: 'install',
      state: this.restoreDownloaded(),
    };
  }

  /** 判断旧版本对应的安装器是否仍处于有效安装时间内。 */
  isInstallationActive(state: GuiUpdateState): boolean {
    if (state.status !== 'installing') return false;
    const startedAt = Date.parse(state.installingAt ?? '');
    if (
      !Number.isFinite(startedAt)
      || this.dependencies.now() - startedAt
        > INSTALLING_STATE_TIMEOUT_MS
    ) {
      return false;
    }
    return state.installerPid === undefined
      || this.dependencies.isProcessRunning(state.installerPid)
      || this.dependencies.now() - startedAt
        <= INSTALLER_EXIT_GRACE_MS;
  }

  clear(): void {
    fs.rmSync(this.filePath(), { force: true });
  }

  private requireState(): GuiUpdateState {
    const state = this.read();
    if (!state) {
      throw new Error('没有可用的 GUI 待安装更新');
    }
    return state;
  }

  private write(state: GuiUpdateState): void {
    const target = this.filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.atomicFiles.write(
      target,
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  private normalize(value: unknown): GuiUpdateState | null {
    if (!value || typeof value !== 'object') return null;
    const state = value as Partial<GuiUpdateState>;
    if (
      (state.status !== 'downloaded'
        && state.status !== 'installing')
      || typeof state.sourceVersion !== 'string'
      || typeof state.targetVersion !== 'string'
      || typeof state.downloadedFile !== 'string'
      || typeof state.sha512 !== 'string'
      || typeof state.downloadedAt !== 'string'
    ) {
      return null;
    }
    return {
      status: state.status,
      sourceVersion: state.sourceVersion,
      targetVersion: state.targetVersion,
      downloadedFile: path.resolve(state.downloadedFile),
      sha512: state.sha512,
      isAdminRightsRequired:
        state.isAdminRightsRequired === true,
      downloadedAt: state.downloadedAt,
      installingAt: typeof state.installingAt === 'string'
        ? state.installingAt
        : undefined,
      installerPid: Number.isInteger(state.installerPid)
        && Number(state.installerPid) > 0
        ? Number(state.installerPid)
        : undefined,
    };
  }
}
