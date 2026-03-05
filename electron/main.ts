/**
 * Electron 主进程。
 * 负责创建窗口、注册 IPC handler。
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn, ChildProcess } from 'child_process';

let mainWindow: BrowserWindow | null = null;

/** 项目根目录 (__dirname = dist/electron/) → 向上两级 */
function appRoot(): string {
  return path.join(__dirname, '..', '..');
}

/** 将相对路径解析为相对于项目根目录的绝对路径 */
function resolveAppPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(appRoot(), filePath);
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
  });

  // __dirname = dist/electron/, HTML原文件在项目根目录 src/view/
  win.loadFile(path.join(appRoot(), 'src', 'view', 'index.html'));
  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });
  return win;
}

// ════════════════════════════════════════
// IPC Handlers
// ════════════════════════════════════════

ipcMain.handle('open-file-dialog', async (_event, filters: Electron.FileFilter[]) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
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
  fs.writeFileSync(resolved, content, 'utf-8');
});

ipcMain.handle('read-file', async (_event, filePath: string) => {
  const resolved = resolveAppPath(filePath);
  return fs.readFileSync(resolved, 'utf-8');
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
  const mumuKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
  ];
  // 也搜索 HKLM Uninstall 下所有含 MuMu 的键 (MuMu 定制版用不同键名)
  const uninstallBase = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  for (const subKey of readRegistrySubKeys(uninstallBase)) {
    const dispName = readRegistryValue(subKey, 'DisplayName');
    if (dispName && /MuMu/i.test(dispName) && !mumuKeys.includes(subKey)) {
      mumuKeys.push(subKey);
    }
  }
  for (const regKey of mumuKeys) {
    const uninstall = readRegistryValue(regKey, 'UninstallString');
    if (uninstall) {
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

ipcMain.handle('get-app-root', () => {
  return appRoot();
});

ipcMain.handle('check-environment', async () => {
  ensureSubmodule();
  return checkEnvironment();
});

ipcMain.handle('check-updates', async () => {
  return checkForUpdates();
});

ipcMain.handle('install-deps', async () => {
  const pythonCmd = findPython();
  if (!pythonCmd) return { success: false, output: '找不到 Python' };
  return installDependencies(pythonCmd);
});

ipcMain.handle('pull-updates', async () => {
  return pullUpdates();
});

ipcMain.handle('start-backend', async () => {
  if (backendProcess) return { success: true, message: '后端已在运行' };
  startBackend();
  return { success: true, message: '后端启动中' };
});

// ════════════════════════════════════════
// 后端服务管理
// ════════════════════════════════════════

let backendProcess: ChildProcess | null = null;

/** 确保后端子模块已初始化 */
function ensureSubmodule(): void {
  const submodDir = path.join(appRoot(), 'autowsgr');
  const marker = path.join(submodDir, 'pyproject.toml');
  if (fs.existsSync(marker)) return; // 子模块已就绪

  try {
    execSync('git submodule update --init', {
      cwd: appRoot(),
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // 无 git 或网络问题，后续 checkEnvironment 会报缺少 autowsgr
  }
}

/** 查找可用的 Python 可执行文件 */
function findPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      execSync(`${cmd} --version`, { encoding: 'utf-8', windowsHide: true });
      return cmd;
    } catch { /* continue */ }
  }
  return null;
}

interface EnvCheckResult {
  pythonCmd: string | null;
  pythonVersion: string | null;
  missingPackages: string[];
  allReady: boolean;
}

/** 检查 Python 环境和所需包 */
function checkEnvironment(): EnvCheckResult {
  const pythonCmd = findPython();
  if (!pythonCmd) {
    return { pythonCmd: null, pythonVersion: null, missingPackages: [], allReady: false };
  }

  let pythonVersion: string | null = null;
  try {
    pythonVersion = execSync(`${pythonCmd} --version`, { encoding: 'utf-8', windowsHide: true }).trim();
  } catch { /* ignore */ }

  const requiredPackages = ['uvicorn', 'fastapi', 'autowsgr.server.main'];
  const missingPackages: string[] = [];
  for (const pkg of requiredPackages) {
    try {
      execSync(`${pythonCmd} -c "import ${pkg}"`, { encoding: 'utf-8', windowsHide: true });
    } catch {
      // 显示顶层包名 (autowsgr.server.main → autowsgr)
      missingPackages.push(pkg.split('.')[0]);
    }
  }
  // 去重 (autowsgr 可能被多次加入)
  const unique = [...new Set(missingPackages)];

  return {
    pythonCmd,
    pythonVersion,
    missingPackages: unique,
    allReady: unique.length === 0,
  };
}

interface UpdateCheckResult {
  gitAvailable: boolean;
  hasUpdates: boolean;
  currentBranch: string;
  behindCount: number;
  remoteUrl: string;
}

/** 检查 git 仓库是否有可用更新 (检查后端 submodule) */
function checkForUpdates(): UpdateCheckResult {
  const cwd = path.join(appRoot(), 'autowsgr');
  const result: UpdateCheckResult = {
    gitAvailable: false,
    hasUpdates: false,
    currentBranch: '',
    behindCount: 0,
    remoteUrl: '',
  };

  try {
    // 检查 git 可用性
    execSync('git --version', { cwd, encoding: 'utf-8', windowsHide: true });
    result.gitAvailable = true;
  } catch {
    return result;
  }

  try {
    result.currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', windowsHide: true }).trim();
    result.remoteUrl = execSync('git remote get-url origin', { cwd, encoding: 'utf-8', windowsHide: true }).trim();

    // fetch (静默失败, 可能无网络)
    try {
      execSync('git fetch origin --quiet', { cwd, encoding: 'utf-8', windowsHide: true, timeout: 10000 });
    } catch { /* 无网络时跳过 */ }

    // 比较本地与远端
    const behindStr = execSync(
      `git rev-list --count HEAD..origin/${result.currentBranch}`,
      { cwd, encoding: 'utf-8', windowsHide: true },
    ).trim();
    result.behindCount = parseInt(behindStr, 10) || 0;
    result.hasUpdates = result.behindCount > 0;
  } catch { /* 非 git 仓库或其他错误 */ }

  return result;
}

/** 自动安装依赖 (pip install -e ./autowsgr) */
function installDependencies(pythonCmd: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const cwd = appRoot();
    const proc = spawn(pythonCmd, ['-m', 'pip', 'install', '-e', './autowsgr'], {
      cwd,
      windowsHide: true,
      stdio: 'pipe',
    });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.on('close', (code) => {
      resolve({ success: code === 0, output: output.slice(-500) });
    });
    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

/** 拉取更新 (更新后端 submodule) */
function pullUpdates(): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const cwd = path.join(appRoot(), 'autowsgr');
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', windowsHide: true }).trim();
      const output = execSync(`git pull origin ${branch}`, { cwd, encoding: 'utf-8', windowsHide: true, timeout: 30000 });
      resolve({ success: true, output: output.trim() });
    } catch (e) {
      resolve({ success: false, output: e instanceof Error ? e.message : String(e) });
    }
  });
}

function startBackend(): void {
  const pythonCmd = findPython();
  if (!pythonCmd) {
    console.error('[Backend] 找不到 Python');
    return;
  }

  const cwd = appRoot();
  backendProcess = spawn(pythonCmd, [
    '-X', 'utf8',
    '-m', 'uvicorn',
    'autowsgr.server.main:app',
    '--host', '127.0.0.1',
    '--port', '8000',
  ], {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
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

  const handleOutput = (data: Buffer) => {
    for (const line of data.toString('utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log(`${CYAN}[Backend]${RESET} ${colorLine(trimmed)}`);
      // 只转发关键日志到 GUI (INFO/WARNING/ERROR，跳过 DEBUG 和 uvicorn access log)
      if (/\bDEBUG\b/i.test(trimmed)) continue;
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
