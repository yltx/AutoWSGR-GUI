/**
 * Electron 主进程。
 * 负责创建窗口、注册 IPC handler。
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { exec, execSync, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';

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

// ════════════════════════════════════════
// 模拟器自动检测 (Windows 注册表)
// ════════════════════════════════════════

interface EmulatorDetectResult {
  type: string;
  path: string;
  serial: string;
  adbPath: string;
}

function readRegistryValue(keyPath: string, valueName: string): string | null {
  try {
    const output = execSync(
      `reg query "${keyPath}" /v "${valueName}"`,
      { encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // 输出格式: "    ValueName    REG_SZ    Value"
    const match = output.match(new RegExp(`${valueName}\\s+REG_\\w+\\s+(.+)`));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function readRegistrySubKeys(keyPath: string): string[] {
  try {
    const output = execSync(
      `reg query "${keyPath}"`,
      { encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('HKEY'));
  } catch {
    return [];
  }
}

function detectEmulator(): EmulatorDetectResult | null {
  if (process.platform !== 'win32') return null;

  // ── MuMu 12 ──
  // 用单次 reg query /s 递归搜索 Uninstall 下的 UninstallString，
  // 再从输出中筛选含 MuMu 的条目，避免逐键启动子进程。
  const uninstallBase = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  try {
    const output = execSync(
      `reg query "${uninstallBase}" /s /v UninstallString`,
      { encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    );
    // 输出格式: 键路径行 + 空行 + "    UninstallString    REG_SZ    value" + 空行 ...
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('HKEY')) {
        // 键路径行: 当前实现不需要使用具体键名, 仅保留以便未来扩展或调试
        continue;
      }
      if (/UninstallString/i.test(trimmed) && /MuMu/i.test(trimmed)) {
        const valMatch = trimmed.match(/UninstallString\s+REG_\w+\s+(.+)/i);
        if (valMatch) {
          const uninstall = valMatch[1].trim();
          const root = path.dirname(uninstall.replace(/"/g, ''));
          const shellDir = path.join(root, 'shell');
          const playerExe = path.join(shellDir, 'MuMuPlayer.exe');
          const adbExe = path.join(shellDir, 'adb.exe');
          if (fs.existsSync(playerExe)) {
            return {
              type: 'MuMu',
              path: playerExe,
              serial: '127.0.0.1:16384',
              adbPath: fs.existsSync(adbExe) ? adbExe : '',
            };
          }
        }
      }
    }
  } catch { /* Uninstall 注册表扫描失败, 继续检测其他模拟器 */ }

  // ── 雷电模拟器 ──
  try {
    const leidianSubs = readRegistrySubKeys('HKLM\\SOFTWARE\\leidian');
    for (const subKey of leidianSubs) {
      const installDir = readRegistryValue(subKey, 'InstallDir');
      if (installDir) {
        const exePath = path.join(installDir, 'dnplayer.exe');
        const adbExe = path.join(installDir, 'adb.exe');
        if (fs.existsSync(exePath)) {
          return {
            type: '雷电',
            path: exePath,
            serial: 'emulator-5554',
            adbPath: fs.existsSync(adbExe) ? adbExe : '',
          };
        }
      }
    }
  } catch { /* 未安装 */ }

  // ── 蓝叠 ──
  for (const regKey of ['HKLM\\SOFTWARE\\BlueStacks_nxt_cn', 'HKLM\\SOFTWARE\\BlueStacks_nxt']) {
    const installDir = readRegistryValue(regKey, 'InstallDir');
    if (installDir) {
      const exePath = path.join(installDir, 'HD-Player.exe');
      const adbExe = path.join(installDir, 'HD-Adb.exe');
      if (fs.existsSync(exePath)) {
        return {
          type: '蓝叠',
          path: exePath,
          serial: '127.0.0.1:5555',
          adbPath: fs.existsSync(adbExe) ? adbExe : '',
        };
      }
    }
  }

  return null;
}

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

ipcMain.handle('set-backend-port', (_event, port: number) => {
  writeGuiSettings({ backend_port: port });
});

ipcMain.on('get-python-path-sync', (event) => {
  event.returnValue = getConfiguredPythonPath();
});

ipcMain.handle('set-python-path', (_event, pythonPath: string | null) => {
  writeGuiSettings({ python_path: pythonPath ?? '' });
  cachedPythonCmd = undefined; // 清除缓存，下次查找时使用新路径
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

ipcMain.handle('check-updates', async () => {
  return await checkForUpdates();
});

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

ipcMain.handle('pull-updates', async () => {
  return pullUpdates();
});

ipcMain.handle('start-backend', async () => {
  if (backendProcess) return { success: true, message: '后端已在运行' };
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

// ════════════════════════════════════════
// 后端服务管理
// ════════════════════════════════════════

let backendProcess: ChildProcess | null = null;

/** 缓存的 Python 路径 (undefined = 尚未查找) */
let cachedPythonCmd: string | null | undefined;

/** 向渲染进程发送环境检查进度 */
function sendProgress(msg: string): void {
  mainWindow?.webContents.send('backend-log', msg);
}



/** 检查 Python 版本是否为 3.12.x 或 3.13.x */
function isAllowedPythonVersion(versionOutput: string): boolean {
  const m = versionOutput.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major === 3 && (minor === 12 || minor === 13);
}

/** 查找可用的 Python 可执行文件 (用户配置 > 本地便携版 > 系统, 仅接受 3.12/3.13, 结果会缓存) */
async function findPython(): Promise<string | null> {
  if (cachedPythonCmd !== undefined) return cachedPythonCmd;

  let found: string | null = null;

  // 最高优先级：用户在配置页指定的 Python 路径
  const configured = getConfiguredPythonPath();
  if (configured && fs.existsSync(configured)) {
    try {
      const { stdout } = await execAsync(`"${configured}" --version`, { windowsHide: true });
      if (isAllowedPythonVersion(stdout)) found = configured;
      else sendProgress(`WARNING 用户配置的 Python 版本不兼容: ${stdout.trim()}（需要 3.12 或 3.13），回退自动检测`);
    } catch {
      sendProgress('WARNING 用户配置的 Python 路径无法执行，回退自动检测');
    }
  } else if (configured) {
    sendProgress('WARNING 用户配置的 Python 路径不存在，回退自动检测');
  }

  // 优先使用本地便携版 Python
  const localPython = path.join(appRoot(), 'python', 'python.exe');
  if (fs.existsSync(localPython)) {
    try {
      const { stdout } = await execAsync(`"${localPython}" --version`, { windowsHide: true });
      if (isAllowedPythonVersion(stdout)) found = localPython;
      else sendProgress(`WARNING 本地 Python 版本不兼容: ${stdout.trim()}（需要 3.12 或 3.13）`);
    } catch { /* local Python broken */ }
  }

  if (!found && !configured) {  // 仅在本地 Python 不可用且无用户配置时回退系统 Python
    // 回退到系统全局 Python
    // 注意: 必须解析出真实的 .exe 绝对路径，因为 pyenv 等工具使用 .bat shim，
    // 而 Node.js spawn() 不经过 shell，无法执行 .bat 文件。
    for (const cmd of ['python', 'python3']) {
      try {
        const { stdout: verOut } = await execAsync(`${cmd} --version`, { windowsHide: true });
        if (!isAllowedPythonVersion(verOut)) continue;
        // 通过 Python 自身获取真实可执行文件路径 (解决 pyenv/.bat shim 问题)
        const { stdout } = await execAsync(
          `${cmd} -c "import sys; print(sys.executable)"`,
          { windowsHide: true },
        );
        const resolved = stdout.trim();
        found = (resolved && fs.existsSync(resolved)) ? resolved : cmd;
        break;
      } catch { /* continue */ }
    }
  }

  cachedPythonCmd = found;
  return found;
}

/** 安装/初始化便携版 Python（已随应用打包，仅需确保 pip 就绪） */
async function installPortablePython(): Promise<{ success: boolean }> {
  cachedPythonCmd = undefined; // 安装后需重新检测
  const pythonDir = path.join(appRoot(), 'python');
  const pythonExe = path.join(pythonDir, 'python.exe');

  if (!fs.existsSync(pythonExe)) {
    // 兜底: 如果打包产物缺失 python，尝试在线下载
    sendProgress('WARNING 未找到内置 Python，尝试在线下载…');
    return downloadPortablePython();
  }

  // 确保 ._pth 配置正确
  ensurePthFile();

  // 检查 pip 是否可用
  try {
    await execAsync(`"${pythonExe}" -m pip --version`, { windowsHide: true, timeout: 15000 });
    sendProgress('内置 Python + pip 就绪 ✓');
    return { success: true };
  } catch { /* pip not available, install it */ }

  // pip 缺失则安装
  sendProgress('正在安装 pip…');
  const getPipPath = path.join(app.getPath('temp'), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonExe}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
    try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }
    sendProgress('pip 安装完成 ✓');
    return { success: true };
  } catch {
    sendProgress('ERROR pip 安装失败');
    return { success: false };
  }
}

/** 兜底: 在线下载便携版 Python（仅在内置 Python 缺失时使用） */
async function downloadPortablePython(): Promise<{ success: boolean }> {
  const pythonDir = path.join(appRoot(), 'python');
  const pythonExe = path.join(pythonDir, 'python.exe');

  const version = '3.12.8';
  const zipUrl = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
  const zipPath = path.join(app.getPath('temp'), 'python-embed.zip');

  sendProgress(`正在下载 Python ${version} 便携版…`);
  try {
    await execAsync(`curl -L -o "${zipPath}" "${zipUrl}"`, { windowsHide: true, timeout: 180000 });
  } catch {
    sendProgress('ERROR Python 下载失败，请检查网络');
    return { success: false };
  }

  sendProgress('正在解压 Python…');
  try {
    if (!fs.existsSync(pythonDir)) fs.mkdirSync(pythonDir, { recursive: true });
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${pythonDir}' -Force"`,
      { windowsHide: true, timeout: 30000 },
    );
  } catch {
    sendProgress('ERROR Python 解压失败');
    return { success: false };
  }

  ensurePthFile();

  // 安装 pip
  sendProgress('正在安装 pip…');
  const getPipPath = path.join(app.getPath('temp'), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonExe}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
  } catch {
    sendProgress('ERROR pip 安装失败');
    return { success: false };
  }

  try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
  try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }

  sendProgress(`Python ${version} 便携版安装完成 ✓`);
  return { success: true };
}

interface EnvCheckResult {
  pythonCmd: string | null;
  pythonVersion: string | null;
  missingPackages: string[];
  allReady: boolean;
}

/** 生成在 Python 命令前插入 site-packages 路径的前缀代码 */
function sysPathInsert(): string {
  // 使用 sys.path.insert 而非 PYTHONPATH 环境变量，因为：
  // 1. 嵌入式 Python 的 ._pth 会完全忽略 PYTHONPATH
  // 2. 避免 Windows 环境变量传递的各种边界问题
  const sp = localSitePackages().replace(/\\/g, '\\\\');
  return `import sys; sys.path.insert(0, r'${sp}'); `;
}

/** 确保嵌入式 Python 的 ._pth 包含 site-packages（每次检查前都执行） */
function ensurePthFile(): void {
  const pythonDir = path.join(appRoot(), 'python');
  for (const pthName of ['python312._pth', 'python313._pth']) {
    const pthFile = path.join(pythonDir, pthName);
    if (!fs.existsSync(pthFile)) continue;
    let content = fs.readFileSync(pthFile, 'utf-8');
    let changed = false;
    // 去除可能的 BOM
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
      changed = true;
    }
    if (/^#\s*import site/m.test(content)) {
      content = content.replace(/^#\s*import site/m, 'import site');
      changed = true;
    }
    if (!content.includes('site-packages')) {
      content = content.trimEnd() + '\nsite-packages\n';
      changed = true;
    }
    if (changed) fs.writeFileSync(pthFile, content, 'utf-8');
  }
}

/** 检查并安装 VC++ Redistributable（c10.dll 等依赖需要） */
async function ensureVCRedist(): Promise<void> {
  // vcruntime140.dll 存在于 system32 说明已安装
  const dllPath = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'vcruntime140.dll');
  if (fs.existsSync(dllPath)) return;

  sendProgress('Microsoft Visual C++ Redistributable is not installed, this may lead to the DLL load failure.');
  const redistExe = path.join(appRoot(), 'redist', 'vc_redist.x64.exe');
  if (!fs.existsSync(redistExe)) {
    sendProgress(`It can be downloaded at https://aka.ms/vs/17/release/vc_redist.x64.exe`);
    return;
  }

  sendProgress('正在安装 Visual C++ Redistributable…');
  try {
    await execAsync(`"${redistExe}" /install /quiet /norestart`, { windowsHide: true, timeout: 120000 });
    sendProgress('Visual C++ Redistributable 安装完成 ✓');
  } catch {
    sendProgress('WARNING VC++ Redistributable 安装失败，请手动运行 redist\\vc_redist.x64.exe');
  }
}

/** 环境就绪标记文件路径 */
const ENV_READY_MARKER = () => path.join(appRoot(), '.env_ready');

/** 最低 autowsgr 版本要求 */
const MIN_AUTOWSGR_VERSION = [2, 1, 0];

/** 检查 autowsgr 版本是否满足最低要求 */
function isVersionOk(ver: string): boolean {
  const parts = ver.replace(/[^0-9.]/g, '.').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) > (MIN_AUTOWSGR_VERSION[i] || 0)) return true;
    if ((parts[i] || 0) < (MIN_AUTOWSGR_VERSION[i] || 0)) return false;
  }
  return true;
}

/** 读取标记文件中保存的 autowsgr 版本；标记不存在或无效时返回 null */
function readEnvMarker(): { pythonCmd: string; pythonVersion: string; autowsgrVersion: string } | null {
  try {
    const data = JSON.parse(fs.readFileSync(ENV_READY_MARKER(), 'utf-8'));
    if (data && data.pythonCmd && data.autowsgrVersion && isVersionOk(data.autowsgrVersion)) {
      // 确保记录的 python 路径仍然存在
      if (!fs.existsSync(data.pythonCmd)) return null;
      // 若用户切换了 Python 路径，旧标记自动失效
      const configured = getConfiguredPythonPath();
      if (configured && configured !== data.pythonCmd) return null;
      return data;
    }
  } catch { /* ignore */ }
  return null;
}

/** 写入环境就绪标记 */
function writeEnvMarker(pythonCmd: string, pythonVersion: string, autowsgrVersion: string): void {
  try {
    fs.writeFileSync(ENV_READY_MARKER(), JSON.stringify({ pythonCmd, pythonVersion, autowsgrVersion }), 'utf-8');
  } catch { /* ignore */ }
}

/** 检查 autowsgr 是否有 PyPI 更新，有则自动升级；返回最终的已安装版本 */
async function autoUpdateAutowsgr(pythonCmd: string): Promise<string | null> {
  try {
    sendProgress('正在检查 autowsgr 更新…');

    // 单次 Python 调用: 获取本地版本 + PyPI 最新版本
    const spFwd = localSitePackages().replace(/\\/g, '\\\\');
    const checkScript = [
      'import json, sys',
      `sys.path.insert(0, r'${spFwd}')`,
      'result = {}',
      'try:',
      '    import autowsgr; result["local"] = autowsgr.__version__',
      'except: result["local"] = None',
      'try:',
      '    import urllib.request',
      '    data = json.loads(urllib.request.urlopen("https://pypi.org/pypi/autowsgr/json", timeout=10).read())',
      '    result["latest"] = data["info"]["version"]',
      'except: result["latest"] = None',
      'print(json.dumps(result))',
    ].join('\n');

    const scriptPath = path.join(app.getPath('temp'), 'autowsgr_update_check.py');
    fs.writeFileSync(scriptPath, checkScript, 'utf-8');

    const { stdout } = await execAsync(
      `"${pythonCmd}" "${scriptPath}"`,
      { windowsHide: true, timeout: 20000, env: pipEnv() },
    );
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }

    const info = JSON.parse(stdout.trim());
    const localVer: string | null = info.local;
    const latestVer: string | null = info.latest;

    if (!latestVer) {
      sendProgress('autowsgr 更新检查跳过（无法获取最新版本信息）');
      return localVer;
    }

    if (localVer === latestVer) {
      sendProgress(`autowsgr ${localVer} 已是最新版 ✓`);
      return localVer;
    }

    // 有更新，自动升级
    sendProgress(`发现 autowsgr 更新: ${localVer ?? '未安装'} → ${latestVer}，正在自动升级…`);
    const targetDir = localSitePackages();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // 清理旧版 autowsgr 文件，避免 pip --target 的 dist-info 残留导致版本检测错误
    try {
      for (const entry of fs.readdirSync(targetDir)) {
        if (entry === 'autowsgr' || entry.startsWith('autowsgr-')) {
          fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
        }
      }
    } catch { /* ignore cleanup errors */ }

    // 确保 pip 可用
    if (!(await ensurePip(pythonCmd))) {
      sendProgress('WARNING pip 不可用，autowsgr 升级跳过');
      return localVer;
    }

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(pythonCmd, [
        '-m', 'pip', 'install',
        '--target', targetDir,
        '--upgrade',
        '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
        '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
        'autowsgr',
      ], {
        cwd: appRoot(),
        windowsHide: true,
        stdio: 'pipe',
        env: pipEnv(),
      });
      proc.stdout?.on('data', () => { /* suppress verbose pip output */ });
      proc.stderr?.on('data', () => { /* suppress */ });
      proc.on('close', (code) => resolve(code ?? 1));
      proc.on('error', () => resolve(1));
    });

    if (exitCode !== 0) {
      sendProgress('WARNING autowsgr 升级失败，使用当前版本继续');
      return localVer;
    }

    // 升级后：单次 Python 调用验证版本 + 关键依赖
    const postScript = path.join(app.getPath('temp'), 'autowsgr_post_upgrade.py');
    fs.writeFileSync(postScript, [
      'import json, sys, site',
      `sys.path.insert(0, r'${spFwd}')`,
      `site.addsitedir(r'${spFwd}')`,
      'r = {"version": "unknown", "missing": []}',
      'try:',
      '    import autowsgr; r["version"] = autowsgr.__version__',
      'except: pass',
      "for m in ['fastapi', 'uvicorn']:",
      '    try: __import__(m)',
      '    except Exception: r["missing"].append(m)',
      'print(json.dumps(r))',
    ].join('\n'), 'utf-8');

    try {
      const { stdout: postOut } = await execAsync(
        `"${pythonCmd}" "${postScript}"`,
        { windowsHide: true, timeout: 15000, env: pipEnv() },
      );
      try { fs.unlinkSync(postScript); } catch { /* ignore */ }
      const postResult = JSON.parse(postOut.trim());
      const actualVer: string = postResult.version;
      const missing: string[] = postResult.missing;

      if (missing.length > 0) {
        sendProgress(`升级后缺少依赖: ${missing.join(', ')}，正在补装…`);
        const fixCode = await new Promise<number>((resolve) => {
          const proc = spawn(pythonCmd, [
            '-m', 'pip', 'install',
            '--target', targetDir,
            '--force-reinstall', '--no-deps',
            '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
            '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
            ...missing,
          ], {
            cwd: appRoot(),
            windowsHide: true,
            stdio: 'pipe',
            env: pipEnv(),
          });
          proc.stdout?.on('data', () => {});
          proc.stderr?.on('data', () => {});
          proc.on('close', (code) => resolve(code ?? 1));
          proc.on('error', () => resolve(1));
        });

        if (fixCode !== 0) {
          await new Promise<void>((resolve) => {
            const proc = spawn(pythonCmd, [
              '-m', 'pip', 'install',
              '--target', targetDir,
              '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
              '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
              ...missing,
            ], {
              cwd: appRoot(),
              windowsHide: true,
              stdio: 'pipe',
              env: pipEnv(),
            });
            proc.stdout?.on('data', () => {});
            proc.stderr?.on('data', () => {});
            proc.on('close', () => resolve());
            proc.on('error', () => resolve());
          });
        }
        sendProgress(`依赖补装完成 ✓`);
      }

      if (actualVer !== 'unknown') {
        const msg = actualVer === latestVer
          ? `autowsgr 已升级至 ${latestVer} ✓`
          : `autowsgr 已升级至 ${actualVer}（期望 ${latestVer}）`;
        sendProgress(msg);
        return actualVer;
      }
    } catch {
      try { fs.unlinkSync(postScript); } catch { /* ignore */ }
    }

    sendProgress(`autowsgr 已升级至 ${latestVer} ✓`);
    return latestVer;
  } catch {
    sendProgress('autowsgr 更新检查跳过（网络不可用或超时）');
    return null;
  }
}

/** 检查 Python 环境和所需包 */
async function checkEnvironment(): Promise<EnvCheckResult> {
  sendProgress('正在检查运行环境…');
  await ensureVCRedist();

  // ── 快速路径: 如果标记文件存在且有效，跳过重量级依赖检查 ──
  const marker = readEnvMarker();
  if (marker) {
    cachedPythonCmd = marker.pythonCmd;
    // 每次启动检查并自动更新 autowsgr
    const updatedVer = await autoUpdateAutowsgr(marker.pythonCmd);
    const finalVer = updatedVer ?? marker.autowsgrVersion;
    if (updatedVer && updatedVer !== marker.autowsgrVersion) {
      writeEnvMarker(marker.pythonCmd, marker.pythonVersion, finalVer);
    }
    sendProgress(`环境就绪 (${marker.pythonVersion}, autowsgr ${finalVer}) ✓`);
    return {
      pythonCmd: marker.pythonCmd,
      pythonVersion: marker.pythonVersion,
      missingPackages: [],
      allReady: true,
    };
  }

  // ── 完整检查路径 ──
  sendProgress('正在检查 Python 环境…');
  ensurePthFile();
  const pythonCmd = await findPython();
  if (!pythonCmd) {
    sendProgress('WARNING 未找到兼容的 Python（需要 3.12 或 3.13）');
    return { pythonCmd: null, pythonVersion: null, missingPackages: [], allReady: false };
  }

  let pythonVersion: string | null = null;
  try {
    const { stdout } = await execAsync(`"${pythonCmd}" --version`, { windowsHide: true });
    pythonVersion = stdout.trim();
    sendProgress(`${pythonVersion} ✓`);
  } catch { /* ignore */ }

  sendProgress('正在检查依赖包…');
  const missingPackages: string[] = [];

  // 批量检查所有依赖（单次 Python 调用，避免多次子进程启动开销）
  const spFwd = localSitePackages().replace(/\\/g, '/');
  const checkScript = path.join(app.getPath('temp'), 'autowsgr_depcheck.py');
  fs.writeFileSync(checkScript, [
    'import json, sys, site',
    `sp = '${spFwd}'`,
    'sys.path.insert(0, sp)',
    'site.addsitedir(sp)',   // 处理 .pth 文件，与后端启动保持一致
    'r = {}',
    "for p in ['uvicorn', 'fastapi']:",
    '    try:',
    '        __import__(p); r[p] = True',
    '    except Exception:',
    '        r[p] = False',
    'try:',
    '    import autowsgr; r["autowsgr"] = autowsgr.__version__',
    'except Exception:',
    '    r["autowsgr"] = None',
    'print(json.dumps(r))',
  ].join('\n'), 'utf-8');

  let autowsgrVersion = '';
  try {
    const { stdout: depOut } = await execAsync(
      `"${pythonCmd}" "${checkScript}"`,
      { windowsHide: true, timeout: 30000 },
    );
    try { fs.unlinkSync(checkScript); } catch { /* ignore */ }
    const depResult = JSON.parse(depOut.trim());

    for (const pkg of ['uvicorn', 'fastapi']) {
      if (depResult[pkg]) {
        sendProgress(`  ${pkg} \u2713`);
      } else {
        missingPackages.push(pkg);
        sendProgress(`  ${pkg} \u2717`);
      }
    }

    if (depResult.autowsgr != null) {
      const ver = String(depResult.autowsgr);
      if (isVersionOk(ver)) {
        sendProgress(`  autowsgr ${ver} \u2713`);
        autowsgrVersion = ver;
      } else {
        sendProgress(`  autowsgr ${ver} < ${MIN_AUTOWSGR_VERSION.join('.')} \u2717`);
        missingPackages.push('autowsgr');
      }
    } else {
      missingPackages.push('autowsgr');
      sendProgress(`  autowsgr \u2717`);
    }
  } catch {
    try { fs.unlinkSync(checkScript); } catch { /* ignore */ }
    missingPackages.push('uvicorn', 'fastapi', 'autowsgr');
    sendProgress('  依赖检查失败');
  }

  const allReady = missingPackages.length === 0;
  if (allReady) {
    sendProgress('依赖检查通过 ✓');

    // 检查 ADB 可用性
    const adbDir = path.join(appRoot(), 'adb');
    const builtinAdb = path.join(adbDir, 'adb.exe');
    if (fs.existsSync(builtinAdb)) {
      sendProgress('ADB (内置) ✓');
    } else {
      sendProgress('ADB (内置) ✗  将使用模拟器自带 ADB');
    }

    // 检查并自动更新 autowsgr
    const updatedVer = await autoUpdateAutowsgr(pythonCmd);
    const finalVer = updatedVer || autowsgrVersion;
    writeEnvMarker(pythonCmd, pythonVersion || '', finalVer);
  }

  return {
    pythonCmd,
    pythonVersion,
    missingPackages,
    allReady,
  };
}

interface UpdateCheckResult {
  gitAvailable: boolean;
  hasUpdates: boolean;
  currentBranch: string;
  behindCount: number;
  remoteUrl: string;
}

/** 检查 autowsgr 包是否有可用更新 (对比本地已安装版本与 PyPI 最新版) */
async function checkForUpdates(): Promise<UpdateCheckResult> {
  const result: UpdateCheckResult = {
    gitAvailable: false,
    hasUpdates: false,
    currentBranch: '',
    behindCount: 0,
    remoteUrl: 'https://pypi.org/project/autowsgr/',
  };

  const pythonCmd = await findPython();
  if (!pythonCmd) return result;

  result.gitAvailable = true; // reuse field: means "can check updates"

  try {
    // 获取已安装版本
    const { stdout: localVer } = await execAsync(
      `"${pythonCmd}" -c "import autowsgr; print(autowsgr.__version__)"`,
      { windowsHide: true, env: pipEnv() },
    );
    result.currentBranch = localVer.trim(); // reuse field: current version

    // 获取 PyPI 最新版本
    const { stdout: pipOut } = await execAsync(
      `"${pythonCmd}" -m pip index versions autowsgr`,
      { windowsHide: true, timeout: 15000, env: pipEnv() },
    );
    const m = pipOut.match(/LATEST:\s*(\S+)/i) || pipOut.match(/versions:\s*(\S+)/i);
    if (m) {
      const latestVer = m[1].replace(/,$/,'');
      result.hasUpdates = latestVer !== result.currentBranch;
    }
  } catch { /* ignore */ }

  return result;
}

/** 判断是否使用本地便携版 Python */
function isLocalPython(pythonCmd: string): boolean {
  return path.isAbsolute(pythonCmd) && pythonCmd.startsWith(appRoot());
}

/** pip 命令的公共环境变量：确保项目目录的包优先于全局 */
function pipEnv(): NodeJS.ProcessEnv {
  const localSite = localSitePackages();
  const existing = process.env.PYTHONPATH || '';
  return {
    ...process.env,
    PYTHONUSERBASE: path.join(appRoot(), 'python'),
    PYTHONPATH: existing
      ? `${localSite}${path.delimiter}${existing}`
      : localSite,
  };
}

/** 项目本地包目录 */
function localSitePackages(): string {
  return path.join(appRoot(), 'python', 'site-packages');
}

/** 同步查找 Python (用于非 async 上下文) */
function findPythonSync(): string | null {
  if (cachedPythonCmd !== undefined) return cachedPythonCmd;
  // 最高优先级：用户配置的 Python 路径
  const configured = getConfiguredPythonPath();
  if (configured && fs.existsSync(configured)) return configured;
  const localPython = path.join(appRoot(), 'python', 'python.exe');
  if (fs.existsSync(localPython)) return localPython;
  for (const cmd of ['python', 'python3']) {
    try {
      execSync(`${cmd} --version`, { windowsHide: true });
      // 解析真实路径 (pyenv/.bat shim 兼容)
      const resolved = execSync(
        `${cmd} -c "import sys; print(sys.executable)"`,
        { windowsHide: true, encoding: 'utf-8' },
      ).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
      return cmd;
    } catch { /* continue */ }
  }
  return null;
}

/** 确保 pip 可用，缺失时自动安装 */
async function ensurePip(pythonCmd: string): Promise<boolean> {
  try {
    await execAsync(`"${pythonCmd}" -m pip --version`, { windowsHide: true, timeout: 15000 });
    return true;
  } catch { /* pip not available */ }

  if (isLocalPython(pythonCmd)) ensurePthFile();

  sendProgress('pip 未就绪，正在安装…');
  const getPipPath = path.join(app.getPath('temp'), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonCmd}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
    try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }
    sendProgress('pip 安装完成 ✓');
    return true;
  } catch {
    sendProgress('ERROR pip 安装失败');
    try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }
    return false;
  }
}

/** 自动安装依赖 (pip install autowsgr)，始终安装到项目目录，不动全局 */
async function installDependencies(pythonCmd: string): Promise<{ success: boolean; output: string }> {
  // 安装后环境变化，清除标记以便下次重新检查
  try { fs.unlinkSync(ENV_READY_MARKER()); } catch { /* ignore */ }

  // 确保 pip 可用
  if (!(await ensurePip(pythonCmd))) {
    return { success: false, output: 'pip 安装失败，无法安装依赖' };
  }

  return new Promise((resolve) => {
    const cwd = appRoot();
    const targetDir = localSitePackages();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    sendProgress('正在安装后端依赖到项目目录…');
    const proc = spawn(pythonCmd, [
      '-m', 'pip', 'install',
      '--target', targetDir,
      '--upgrade',
      'setuptools',         // provides distutils (removed in Python 3.12)
      'autowsgr',
    ], {
      cwd,
      windowsHide: true,
      stdio: 'pipe',
      env: pipEnv(),
    });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) sendProgress('后端依赖安装完成 ✓');
      else sendProgress('ERROR 依赖安装失败');
      resolve({ success: code === 0, output: output.slice(-500) });
    });
    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

/** 更新 autowsgr 包 (pip install --upgrade --target) */
function pullUpdates(): Promise<{ success: boolean; output: string }> {
  // 更新后清除环境标记
  try { fs.unlinkSync(ENV_READY_MARKER()); } catch { /* ignore */ }
  return new Promise((resolve) => {
    const pythonCmd = findPythonSync();
    if (!pythonCmd) {
      resolve({ success: false, output: '找不到 Python' });
      return;
    }
    const targetDir = localSitePackages();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const proc = spawn(pythonCmd, [
      '-m', 'pip', 'install',
      '--target', targetDir,
      '--upgrade',
      'setuptools',
      'autowsgr',
    ], {
      cwd: appRoot(),
      windowsHide: true,
      stdio: 'pipe',
      env: pipEnv(),
    });
    let output = '';
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', (code) => {
      resolve({ success: code === 0, output: output.slice(-500) });
    });
    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

/** 运行 setup.bat 安装环境 */
function runSetupScript(): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    // 打包模式下 setup.bat 在 extraResources 里
    let setupPath = path.join(resourceRoot(), 'setup.bat');
    if (!fs.existsSync(setupPath)) {
      setupPath = path.join(appRoot(), 'setup.bat');
    }
    if (!fs.existsSync(setupPath)) {
      resolve({ success: false, output: '找不到 setup.bat' });
      return;
    }

    const proc = spawn('cmd.exe', ['/c', setupPath], {
      cwd: appRoot(),
      windowsHide: false,
      stdio: 'pipe',
    });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      mainWindow?.webContents.send('setup-log', text);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      mainWindow?.webContents.send('setup-log', text);
    });
    proc.on('close', (code) => {
      resolve({ success: code === 0, output: output.slice(-1000) });
    });
    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

async function startBackend(): Promise<void> {
  ensurePthFile();
  const pythonCmd = await findPython();
  if (!pythonCmd) {
    console.error('[Backend] 找不到 Python');
    return;
  }

  const cwd = appRoot();
  const localSite = localSitePackages();

  // 使用 -c 启动而非 -m uvicorn，以便：
  // 1. 显式注入 site-packages 到 sys.path
  // 2. 激活 setuptools 的 distutils 兼容层 (Python 3.12+ 需要)
  // 3. 绕过嵌入式 Python 的 ._pth/PYTHONPATH 限制
  const bootstrap = [
    `import sys, os, site`,
    `sp = r'${localSite.replace(/'/g, "\\'")}'`,
    `sys.path.insert(0, sp)`,
    `site.addsitedir(sp)`,  // 处理 .pth 文件，激活 _distutils_hack
    `import uvicorn`,
    `uvicorn.run('autowsgr.server.main:app', host='127.0.0.1', port=${BACKEND_PORT})`,

  ].join('; ');

  // 将内置 ADB 目录加入 PATH，使后端 shutil.which('adb') 能找到
  const adbDir = path.join(appRoot(), 'adb');
  const envPath = process.env.PATH || '';
  const pathWithAdb = fs.existsSync(adbDir) ? `${adbDir};${envPath}` : envPath;

  // 预连接 ADB 设备（MuMu 多开实例不会自动被 ADB 发现，需要主动 connect）
  try {
    const cfgPath = path.join(appRoot(), 'usersettings.yaml');
    if (fs.existsSync(cfgPath)) {
      const cfgText = fs.readFileSync(cfgPath, 'utf-8');
      const serialMatch = cfgText.match(/serial:\s*(\S+)/);
      if (serialMatch) {
        const serial = serialMatch[1];
        const adbExe = path.join(adbDir, 'adb.exe');
        const adbCmd = fs.existsSync(adbExe) ? adbExe : 'adb';
        execSync(`"${adbCmd}" connect ${serial}`, { windowsHide: true, timeout: 5000, stdio: 'pipe' });
        console.log(`[Backend] ADB connect ${serial} 完成`);
      }
    }
  } catch (e: any) {
    console.warn(`[Backend] ADB connect 失败 (非致命): ${e.message}`);
  }

  backendProcess = spawn(pythonCmd, [
    '-X', 'utf8',
    '-c', bootstrap,
  ], {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PATH: pathWithAdb,
    },
  });

  // ANSI 颜色码
  const CYAN = '\x1b[36m';
  const RED = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const GREEN = '\x1b[32m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';

  const colorLine = (line: string): string => {
    if (/\bERROR\b/i.test(line)) return `${RED}${line}${RESET}`;
    if (/\bWARNING\b/i.test(line)) return `${YELLOW}${line}${RESET}`;
    if (/\bINFO\b/i.test(line)) return `${GREEN}${line}${RESET}`;
    if (/\bDEBUG\b/i.test(line)) return `${DIM}${line}${RESET}`;
    return `${CYAN}${line}${RESET}`;
  };

  // loguru 新日志行以 "HH:mm:ss.SSS |" 开头
  const LOGURU_LINE_RE = /^\d{2}:\d{2}:\d{2}\.\d{3}\s*\|/;
  let skipMultiline = false;

  const handleOutput = (data: Buffer) => {
    for (const line of data.toString('utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log(`${CYAN}[Backend]${RESET} ${colorLine(trimmed)}`);

      const isNewEntry = LOGURU_LINE_RE.test(trimmed);
      if (isNewEntry) {
        // 新日志条目：判断级别，决定是否跳过后续续行
        skipMultiline = /\bDEBUG\b/i.test(trimmed);
      }
      // 跳过 DEBUG 级别的日志（包括其多行续行）
      if (skipMultiline) continue;
      // 跳过 uvicorn access log
      if (/"(?:GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+\//.test(trimmed)) continue;
      mainWindow?.webContents.send('backend-log', trimmed);
    }
  };
  backendProcess.stdout?.on('data', handleOutput);
  backendProcess.stderr?.on('data', handleOutput);
  backendProcess.on('error', (err) => {
    console.error('[Backend] 启动失败:', err.message);
    backendProcess = null;
  });
  backendProcess.on('close', (code) => {
    console.log(`[Backend] 进程退出, code=${code}`);
    backendProcess = null;
  });
}

function stopBackend(): void {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

// ════════════════════════════════════════
// App Lifecycle
// ════════════════════════════════════════

app.whenReady().then(() => {
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
