/**
 * 管理 Electron 单实例锁和重复启动时的窗口聚焦。
 */

/** 单实例服务依赖的最小 Electron App 契约。 */
export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  exit(exitCode?: number): void;
  on(event: 'second-instance', listener: () => void): void;
}

/** 重复启动时可恢复并聚焦的主窗口契约。 */
export interface SingleInstanceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

type MainWindowProvider = () => SingleInstanceWindow | null;
type DuplicateLaunchHandler = () => boolean;

/** 保证迁移、环境安装和窗口生命周期只由一个进程执行。 */
export class SingleInstanceService {
  private primary = false;
  private mainWindowProvider: MainWindowProvider = () => null;
  private duplicateLaunchHandler: DuplicateLaunchHandler = () => false;

  constructor(private readonly application: SingleInstanceApplication) {}

  /** 尝试获取系统单实例锁；次实例直接退出。 */
  acquire(): boolean {
    if (this.primary) return true;
    if (!this.application.requestSingleInstanceLock()) {
      this.application.exit(0);
      return false;
    }

    this.primary = true;
    this.application.on('second-instance', () => {
      if (this.duplicateLaunchHandler()) return;
      this.focusMainWindow();
    });
    return true;
  }

  setMainWindowProvider(provider: MainWindowProvider): void {
    this.mainWindowProvider = provider;
  }

  /** 安装期间可拦截重复启动，并由主实例显示更新提示。 */
  setDuplicateLaunchHandler(handler: DuplicateLaunchHandler): void {
    this.duplicateLaunchHandler = handler;
  }

  private focusMainWindow(): void {
    const window = this.mainWindowProvider();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
