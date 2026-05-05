/**
 * Electron 主进程。
 * 负责创建窗口、注册 IPC handler。
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import {
  initPythonEnv, clearPythonCache,
  isAllowedPythonVersion, findPython, checkEnvironment,
  checkForUpdates, installDependencies, installPortablePython,
  pullUpdates,
} from './pythonEnv';
import { detectEmulator } from './emulatorDetect';
import { initBackend, getBackendProcess, startBackend, stopBackend, runSetupScript } from './backend';

const execAsync = promisify(exec);

/** GUI 设置文件路径（延迟到 app ready 后才有效，先用函数） */
function guiSettingsPath(): string {
  return path.join(appRoot(), 'gui_settings.json');
}

/** 读取 GUI 设置 */
function readGuiSettings(): Record<string, unknown> {
  try {
    const p = guiSettingsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

/** 写入 GUI 设置（合并） */
function writeGuiSettings(patch: Record<string, unknown>): void {
  const cur = readGuiSettings();
  Object.assign(cur, patch);
  fs.writeFileSync(guiSettingsPath(), JSON.stringify(cur, null, 2), 'utf-8');
}

/** 后端端口：环境变量 > gui_settings.json > 默认 8438 */
function getBackendPort(): number {
  if (process.env.AUTOWSGR_PORT) {
    return parseInt(process.env.AUTOWSGR_PORT, 10);
  }
  const settings = readGuiSettings();
  if (typeof settings.backend_port === 'number' && settings.backend_port > 0 && settings.backend_port < 65536) {
    return settings.backend_port;
  }
  return 8438;
}

const BACKEND_PORT = getBackendPort();

/** 用户配置的 Python 路径：gui_settings.json > null (自动检测) */
function getConfiguredPythonPath(): string | null {
  const settings = readGuiSettings();
  if (typeof settings.python_path === 'string' && settings.python_path.length > 0) {
    return settings.python_path;
  }
  return null;
}

function getUpdateMode(): 'auto' | 'manual' {
  const settings = readGuiSettings();
  return settings.update_mode === 'manual' ? 'manual' : 'auto';
}

type BackendStartupMode = 'managed' | 'external';
type OcrGpuMode = 'auto' | 'cpu' | 'cuda';

function getBackendStartupMode(): BackendStartupMode {
  const settings = readGuiSettings();
  return settings.backend_startup_mode === 'external' ? 'external' : 'managed';
}

function getBackendRepoPath(): string {
  const settings = readGuiSettings();
  if (typeof settings.backend_repo_path !== 'string') return '';
  return settings.backend_repo_path.trim();
}

function getOcrGpuMode(): OcrGpuMode {
  const settings = readGuiSettings();
  const value = typeof settings.ocr_gpu_mode === 'string' ? settings.ocr_gpu_mode : '';
  if (value === 'cpu' || value === 'cuda') return value;
  return 'auto';
}

function getSaveBackendScreenshots(): boolean {
  const settings = readGuiSettings();
  return settings.save_backend_screenshots === true;
}

let mainWindow: BrowserWindow | null = null;

/** 是否处于打包后的生产模式 */
function isPackaged(): boolean {
  return app.isPackaged;
}

/**
 * 应用工作目录（外部可写文件：autowsgr/、usersettings.yaml 等）：
 * - 开发模式: 项目根目录
 * - 打包模式: exe 所在目录
 */
function appRoot(): string {
  if (isPackaged()) {
    return path.dirname(app.getPath('exe'));
  }
  return path.join(__dirname, '..', '..');
}

/** extraResources 目录 (resource/, plans/, setup.bat) */
function resourceRoot(): string {
  if (isPackaged()) {
    return process.resourcesPath;
  }
  return path.join(__dirname, '..', '..');
}

/** 将相对路径解析为绝对路径 */
function resolveAppPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  // resource/ 在打包后位于 extraResources（只读）
  if (filePath.startsWith('resource')) {
    return path.join(resourceRoot(), filePath);
  }
  // plans/ 及其他文件在 appRoot（可写，用户数据不会被覆盖安装覆盖）
  return path.join(appRoot(), filePath);
}

/**
 * 初始化用户方案目录：将 extraResources 中的默认方案
 * 复制到 appRoot/plans（不覆盖已有文件，保留用户自定义方案）。
 */
function initUserPlansDir(): void {
  const bundledDir = path.join(resourceRoot(), 'plans');
  const userDir = path.join(appRoot(), 'plans');
  if (!fs.existsSync(bundledDir)) return;
  copyDirNoOverwrite(bundledDir, userDir);
}

/** 递归复制目录，跳过已存在的文件 */
function copyDirNoOverwrite(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirNoOverwrite(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    icon: path.join(isPackaged() ? process.resourcesPath : path.join(__dirname, '..', '..'), 'resource', 'images', 'logo.png'),
  });

  const appDir = app.getAppPath();
  const htmlPath = path.join(appDir, 'src', 'view', 'index.html');

  // 根据 BACKEND_PORT 动态注入 CSP
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://localhost:${BACKEND_PORT} ws://localhost:${BACKEND_PORT}`
        ],
      },
    });
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const msg = `Page load failed!\nCode: ${errorCode}\nDesc: ${errorDescription}\nURL: ${validatedURL}\nPath: ${htmlPath}`;
    console.error('[Main]', msg);
    if (isPackaged()) {
      dialog.showMessageBox({ type: 'error', title: 'Load Error', message: msg });
    }
  });

  win.loadFile(htmlPath).catch(err => {
    console.error('[Main] loadFile failed:', err);
    if (isPackaged()) {
      dialog.showMessageBox({ type: 'error', title: 'loadFile Error', message: `${err.message}\nPath: ${htmlPath}` });
    }
  });

  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });
  return win;
}

// ════════════════════════════════════════
// IPC Handlers
// ════════════════════════════════════════

ipcMain.handle('open-directory-dialog', async (_event, title?: string) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: title || '选择文件夹',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-file-dialog', async (_event, filters: Electron.FileFilter[], defaultDir?: string) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    defaultPath: defaultDir || undefined,
    filters,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf-8');
  return { path: filePath, content };
});

ipcMain.handle('save-file', async (_event, filePath: string, content: string) => {
  const resolved = resolveAppPath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
});

ipcMain.handle('save-file-dialog', async (_event, defaultName: string, content: string, filters: Electron.FileFilter[]) => {
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,  // caller can pass full path (dir + filename)
    filters,
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return result.filePath;
});

ipcMain.handle('read-file', async (_event, filePath: string) => {
  const resolved = resolveAppPath(filePath);
  if (!fs.existsSync(resolved)) return '';
  return fs.readFileSync(resolved, 'utf-8');
});

ipcMain.handle('append-file', async (_event, filePath: string, content: string) => {
  const resolved = resolveAppPath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(resolved, content, 'utf-8');
});


ipcMain.handle('detect-emulator', async () => {
  return detectEmulator();
});

ipcMain.handle('check-adb-devices', async () => {
  const adbDir = path.join(appRoot(), 'adb');
  const adbExe = path.join(adbDir, 'adb.exe');
  const adbCmd = fs.existsSync(adbExe) ? adbExe : 'adb';
  try {
    const { stdout } = await execAsync(`"${adbCmd}" devices`, { windowsHide: true, timeout: 5000 });
    const lines = stdout.split('\n').slice(1); // skip header
    return lines
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => {
        const [serial, status] = l.split(/\s+/);
        return { serial, status: status || 'unknown' };
      });
  } catch {
    return [];
  }
});

ipcMain.on('get-app-version-sync', (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on('get-backend-port-sync', (event) => {
  event.returnValue = BACKEND_PORT;
});

ipcMain.on('get-backend-startup-mode-sync', (event) => {
  event.returnValue = getBackendStartupMode();
});

ipcMain.on('get-backend-repo-path-sync', (event) => {
  event.returnValue = getBackendRepoPath();
});

ipcMain.on('get-ocr-gpu-mode-sync', (event) => {
  event.returnValue = getOcrGpuMode();
});

ipcMain.on('get-save-backend-screenshots-sync', (event) => {
  event.returnValue = getSaveBackendScreenshots();
});

ipcMain.handle('set-backend-port', (_event, port: number) => {
  // 防御性校验：仅在端口为有限数值且位于合法范围时才写入设置
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    return;
  }
  const normalizedPort = Math.trunc(port);
  if (normalizedPort < 1 || normalizedPort > 65535) {
    return;
  }
  writeGuiSettings({ backend_port: normalizedPort });
});

ipcMain.handle('set-backend-startup-mode', (_event, mode: BackendStartupMode) => {
  const normalized = mode === 'external' ? 'external' : 'managed';
  writeGuiSettings({ backend_startup_mode: normalized });
});

ipcMain.handle('set-backend-repo-path', (_event, repoPath: string | null) => {
  const normalized = typeof repoPath === 'string' ? repoPath.trim() : '';
  writeGuiSettings({ backend_repo_path: normalized });
});

ipcMain.handle('set-ocr-gpu-mode', (_event, mode: OcrGpuMode) => {
  const normalized: OcrGpuMode = mode === 'cpu' || mode === 'cuda' ? mode : 'auto';
  writeGuiSettings({ ocr_gpu_mode: normalized });
});

ipcMain.handle('set-save-backend-screenshots', (_event, enabled: boolean) => {
  writeGuiSettings({ save_backend_screenshots: enabled === true });
});

ipcMain.on('get-python-path-sync', (event) => {
  event.returnValue = getConfiguredPythonPath();
});

ipcMain.on('get-update-mode-sync', (event) => {
  event.returnValue = getUpdateMode();
});

ipcMain.handle('set-update-mode', (_event, mode: 'auto' | 'manual') => {
  const normalized = mode === 'manual' ? 'manual' : 'auto';
  writeGuiSettings({ update_mode: normalized });
});

ipcMain.handle('set-python-path', (_event, pythonPath: string | null) => {
  writeGuiSettings({ python_path: pythonPath ?? '' });
  clearPythonCache(); // 清除缓存，下次查找时使用新路径
});

ipcMain.handle('validate-python', async (_event, pythonPath: string) => {
  if (!pythonPath) return { valid: false, version: null, error: '路径为空' };
  if (!fs.existsSync(pythonPath)) return { valid: false, version: null, error: '文件不存在' };
  try {
    const { stdout } = await execAsync(`"${pythonPath}" --version`, { windowsHide: true, timeout: 10000 });
    const version = stdout.trim();
    if (!isAllowedPythonVersion(version)) {
      return { valid: false, version, error: `版本不兼容: ${version}（需要 3.12 或 3.13）` };
    }
    return { valid: true, version };
  } catch (e) {
    return { valid: false, version: null, error: `执行失败: ${e instanceof Error ? e.message : String(e)}` };
  }
});

ipcMain.handle('get-app-root', () => {
  return appRoot();
});

ipcMain.handle('resolve-app-path', (_event, filePath: string) => {
  return resolveAppPath(filePath);
});

ipcMain.handle('get-plans-dir', () => {
  return resolveAppPath('plans');
});

ipcMain.handle('list-plan-files', () => {
  const dir = resolveAppPath('plans');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.ya?ml$/i.test(f))
    .map(f => ({ name: f.replace(/\.ya?ml$/i, ''), file: f }));
});

ipcMain.handle('get-config-dir', () => {
  return appRoot();
});

ipcMain.handle('open-folder', async (_event, folderPath: string) => {
  if (fs.existsSync(folderPath)) {
    await shell.openPath(folderPath);
  }
});

ipcMain.handle('check-environment', async () => {
  return await checkEnvironment();
});

/*
 * 测试期接口（后端源码更新）已停用，逻辑保留便于回滚恢复。
ipcMain.handle('check-updates', async () => {
  return await checkForUpdates();
});
*/

ipcMain.handle('install-deps', async () => {
  const pythonCmd = await findPython();
  if (!pythonCmd) return { success: false, output: '找不到 Python' };
  return installDependencies(pythonCmd);
});

ipcMain.handle('run-setup', async () => {
  return runSetupScript();
});

ipcMain.handle('install-portable-python', async () => {
  return installPortablePython();
});

/*
 * 测试期接口（后端源码更新）已停用，逻辑保留便于回滚恢复。
ipcMain.handle('pull-updates', async () => {
  return pullUpdates();
});
*/

ipcMain.handle('start-backend', async () => {
  if (getBackendProcess()) return { success: true, message: '后端已在运行' };
  await startBackend();
  return { success: true, message: '后端启动中' };
});

// ════════════════════════════════════════
// GUI 自动更新 (electron-updater)
// ════════════════════════════════════════

/** 初始化自动更新 */
function initAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    mainWindow?.webContents.send('update-status', {
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    mainWindow?.webContents.send('update-status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    mainWindow?.webContents.send('update-status', {
      status: 'downloaded',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err: Error) => {
    mainWindow?.webContents.send('update-status', {
      status: 'error',
      message: err.message,
    });
  });
}

ipcMain.handle('check-gui-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return result?.updateInfo ? { version: result.updateInfo.version } : null;
  } catch {
    return null;
  }
});

ipcMain.handle('download-gui-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('install-gui-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

/** 向渲染进程发送环境检查进度 */
function sendProgress(msg: string): void {
  mainWindow?.webContents.send('backend-log', msg);
}

// ════════════════════════════════════════
// App Lifecycle
// ════════════════════════════════════════

app.whenReady().then(() => {
  initPythonEnv({
    appRoot,
    sendProgress,
    getConfiguredPythonPath,
    getUpdateMode,
    getTempDir: () => app.getPath('temp'),
  });
  initBackend({
    appRoot,
    resourceRoot,
    BACKEND_PORT,
    getMainWindow: () => mainWindow,
  });
  initUserPlansDir();
  initAutoUpdater();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
