/**
 * 创建主窗口并管理窗口状态和偏好。
 */
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  MessageBoxOptions,
} from 'electron';
import * as path from 'path';
import { GuiSettingsStore } from './GuiSettingsStore';

/** renderer 可读取和修改的窗口设置。 */
export interface WindowPreferences {
  defaultWidth: number;
  defaultHeight: number;
  rememberBounds: boolean;
}

export interface PreparedWindowPreferences {
  preferences: WindowPreferences;
  settingsPatch: Record<string, unknown>;
}

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowDisplay {
  workArea: WindowBounds;
}

/** 由 main.ts 注入的 Electron 生命周期能力。 */
export interface WindowServiceDependencies {
  readonly backendPort: number;
  readonly moduleDirectory: string;
  createBrowserWindow(
    options: BrowserWindowConstructorOptions,
  ): BrowserWindow;
  getDisplays(): WindowDisplay[];
  getAppPath(): string;
  isPackaged(): boolean;
  resourceRoot(): string;
  showMessageBox(options: MessageBoxOptions): void;
}

const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;
const MIN_WINDOW_WIDTH = 854;
const MIN_WINDOW_HEIGHT = 480;

/** 创建窗口并管理窗口偏好、引用和边界持久化。 */
export class WindowService {
  private mainWindow: BrowserWindow | null = null;
  private lastWindowBounds: WindowBounds | null = null;

  constructor(
    private readonly settings: GuiSettingsStore,
    private readonly dependencies: WindowServiceDependencies,
  ) {}

  /** 返回当前主窗口；窗口销毁后返回 null。 */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /** 仅在主窗口及其页面仍可用时向 Renderer 发送消息。 */
  sendToRenderer(channel: string, ...args: unknown[]): boolean {
    const win = this.mainWindow;
    if (
      !win
      || win.isDestroyed()
      || win.webContents.isDestroyed()
    ) {
      return false;
    }
    try {
      win.webContents.send(channel, ...args);
      return true;
    } catch (error) {
      if (
        win.isDestroyed()
        || win.webContents.isDestroyed()
        || (
          error instanceof Error
          && error.message === 'Object has been destroyed'
        )
      ) {
        return false;
      }
      throw error;
    }
  }

  /** 读取并归一化默认窗口大小和边界记忆开关。 */
  getPreferences(): WindowPreferences {
    const settings = this.settings.read();
    return {
      defaultWidth: this.normalizeWindowSize(
        settings.default_window_width,
        MIN_WINDOW_WIDTH,
        DEFAULT_WINDOW_WIDTH,
      ),
      defaultHeight: this.normalizeWindowSize(
        settings.default_window_height,
        MIN_WINDOW_HEIGHT,
        DEFAULT_WINDOW_HEIGHT,
      ),
      rememberBounds: settings.remember_window_bounds === true,
    };
  }

  /** 写入归一化后的窗口偏好，并返回实际持久化结果。 */
  setPreferences(
    preferences: Partial<WindowPreferences>,
  ): WindowPreferences {
    const prepared = this.preparePreferences(preferences);
    this.settings.write(prepared.settingsPatch);
    return prepared.preferences;
  }

  /** 归一化窗口偏好并生成可参与批量配置提交的存储 patch。 */
  preparePreferences(
    preferences: Partial<WindowPreferences>,
  ): PreparedWindowPreferences {
    const current = this.getPreferences();
    const normalized: WindowPreferences = {
      defaultWidth: this.normalizeWindowSize(
        preferences?.defaultWidth,
        MIN_WINDOW_WIDTH,
        current.defaultWidth,
      ),
      defaultHeight: this.normalizeWindowSize(
        preferences?.defaultHeight,
        MIN_WINDOW_HEIGHT,
        current.defaultHeight,
      ),
      rememberBounds: preferences?.rememberBounds === true,
    };
    return {
      preferences: normalized,
      settingsPatch: {
        default_window_width: normalized.defaultWidth,
        default_window_height: normalized.defaultHeight,
        remember_window_bounds: normalized.rememberBounds,
      },
    };
  }

  /** 缓存最后一次正常窗口边界，供窗口销毁后的退出阶段使用。 */
  captureWindowBounds(
    win: BrowserWindow | null = this.mainWindow,
  ): void {
    if (!win || win.isDestroyed()) return;
    this.lastWindowBounds = win.getNormalBounds();
  }

  /** 仅在用户启用窗口记忆时写入最后一次正常窗口边界。 */
  persistWindowBounds(): void {
    if (this.getPreferences().rememberBounds && this.lastWindowBounds) {
      this.settings.write({ window_bounds: this.lastWindowBounds });
    }
  }

  /** 使用当前偏好创建并持有 Electron 主窗口。 */
  createWindow(): BrowserWindow {
    const preferences = this.getPreferences();
    const rememberedBounds = preferences.rememberBounds
      ? this.readRememberedWindowBounds()
      : null;
    const initialBounds = rememberedBounds
      && this.isWindowBoundsVisible(rememberedBounds)
      ? rememberedBounds
      : null;
    const win = this.dependencies.createBrowserWindow({
      width: initialBounds?.width ?? preferences.defaultWidth,
      height: initialBounds?.height ?? preferences.defaultHeight,
      x: initialBounds?.x,
      y: initialBounds?.y,
      center: initialBounds === null,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(
          this.dependencies.moduleDirectory,
          'preload.js',
        ),
        contextIsolation: true,
        nodeIntegration: false,
      },
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#1a1a2e',
      icon: path.join(
        this.dependencies.resourceRoot(),
        'resource',
        'images',
        'logo.png',
      ),
    });
    if (typeof win.setMenuBarVisibility === 'function') {
      win.setMenuBarVisibility(false);
    }

    const htmlPath = path.join(
      this.dependencies.getAppPath(),
      'src',
      'view',
      'index.html',
    );

    // 根据后端端口动态注入现有 CSP。
    win.webContents.session.webRequest.onHeadersReceived(
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file: data:; connect-src 'self' http://localhost:${this.dependencies.backendPort} ws://localhost:${this.dependencies.backendPort}`,
            ],
          },
        });
      },
    );

    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL) => {
        const message = `Page load failed!\nCode: ${errorCode}\nDesc: ${errorDescription}\nURL: ${validatedURL}\nPath: ${htmlPath}`;
        console.error('[Main]', message);
        if (this.dependencies.isPackaged()) {
          this.dependencies.showMessageBox({
            type: 'error',
            title: 'Load Error',
            message,
          });
        }
      },
    );

    win.loadFile(htmlPath).catch((error: Error) => {
      console.error('[Main] loadFile failed:', error);
      if (this.dependencies.isPackaged()) {
        this.dependencies.showMessageBox({
          type: 'error',
          title: 'loadFile Error',
          message: `${error.message}\nPath: ${htmlPath}`,
        });
      }
    });

    this.mainWindow = win;
    this.captureWindowBounds(win);
    win.on('move', () => this.captureWindowBounds(win));
    win.on('resize', () => this.captureWindowBounds(win));
    win.on('close', () => {
      this.captureWindowBounds(win);
      this.persistWindowBounds();
    });
    win.on('closed', () => {
      this.mainWindow = null;
    });
    return win;
  }

  private normalizeWindowSize(
    value: unknown,
    minimum: number,
    fallback: number,
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(minimum, Math.trunc(value));
  }

  private readRememberedWindowBounds(): WindowBounds | null {
    const raw = this.settings.read().window_bounds;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const bounds = raw as Record<string, unknown>;
    if (
      typeof bounds.x !== 'number'
      || typeof bounds.y !== 'number'
      || !Number.isFinite(bounds.x)
      || !Number.isFinite(bounds.y)
    ) {
      return null;
    }
    return {
      x: Math.trunc(bounds.x),
      y: Math.trunc(bounds.y),
      width: this.normalizeWindowSize(
        bounds.width,
        MIN_WINDOW_WIDTH,
        DEFAULT_WINDOW_WIDTH,
      ),
      height: this.normalizeWindowSize(
        bounds.height,
        MIN_WINDOW_HEIGHT,
        DEFAULT_WINDOW_HEIGHT,
      ),
    };
  }

  /** 至少保留一块可拖动区域，避免窗口完全落在屏幕外。 */
  private isWindowBoundsVisible(bounds: WindowBounds): boolean {
    return this.dependencies.getDisplays().some(({ workArea }) => {
      const visibleWidth = Math.min(
        bounds.x + bounds.width,
        workArea.x + workArea.width,
      ) - Math.max(bounds.x, workArea.x);
      const visibleHeight = Math.min(
        bounds.y + bounds.height,
        workArea.y + workArea.height,
      ) - Math.max(bounds.y, workArea.y);
      return visibleWidth >= 160 && visibleHeight >= 80;
    });
  }
}
