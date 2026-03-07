/**
 * Electron 主进程。
 * 负责创建窗口、注册 IPC handler。
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { exec, execSync, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
  // resource/ 和 plans/ 在打包后位于 extraResources
  if (filePath.startsWith('resource') || filePath.startsWith('plans')) {
    return path.join(resourceRoot(), filePath);
  }
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
    icon: path.join(isPackaged() ? process.resourcesPath : path.join(__dirname, '..', '..'), 'resource', 'images', 'logo.png'),
  });

  const appDir = app.getAppPath();
  const htmlPath = path.join(appDir, 'src', 'view', 'index.html');

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
// 后端服务管理
// ════════════════════════════════════════

let backendProcess: ChildProcess | null = null;

/** 向渲染进程发送环境检查进度 */
function sendProgress(msg: string): void {
  mainWindow?.webContents.send('backend-log', msg);
}



/** 查找可用的 Python 可执行文件 (优先本地便携版) */
async function findPython(): Promise<string | null> {
  // 优先使用本地便携版 Python
  const localPython = path.join(appRoot(), 'python', 'python.exe');
  if (fs.existsSync(localPython)) {
    try {
      await execAsync(`"${localPython}" --version`, { windowsHide: true });
      return localPython;
    } catch { /* local Python broken */ }
  }
  // 回退到系统全局 Python (依赖通过 PYTHONUSERBASE + --no-user 确保安装到项目目录)
  // 注意: 必须解析出真实的 .exe 绝对路径，因为 pyenv 等工具使用 .bat shim，
  // 而 Node.js spawn() 不经过 shell，无法执行 .bat 文件。
  for (const cmd of ['python', 'python3']) {
    try {
      await execAsync(`${cmd} --version`, { windowsHide: true });
      // 通过 Python 自身获取真实可执行文件路径 (解决 pyenv/.bat shim 问题)
      const { stdout } = await execAsync(
        `${cmd} -c "import sys; print(sys.executable)"`,
        { windowsHide: true },
      );
      const resolved = stdout.trim();
      if (resolved && fs.existsSync(resolved)) {
        return resolved;
      }
      return cmd;
    } catch { /* continue */ }
  }
  return null;
}

/** 安装便携版 Python 到项目目录 */
async function installPortablePython(): Promise<{ success: boolean }> {
  const pythonDir = path.join(appRoot(), 'python');
  const pythonExe = path.join(pythonDir, 'python.exe');
  if (fs.existsSync(pythonExe)) return { success: true };

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

  // 启用 site-packages (pip 所需)
  // 嵌入式 Python 的 ._pth 文件存在时会忽略 PYTHONPATH 环境变量，
  // 因此必须将 site-packages 路径直接写入 ._pth 文件
  const pthFile = path.join(pythonDir, 'python312._pth');
  if (fs.existsSync(pthFile)) {
    let content = fs.readFileSync(pthFile, 'utf-8');
    content = content.replace(/^#\s*import site/m, 'import site');
    // 添加本地 site-packages 目录 (相对于 python.exe 所在目录)
    if (!content.includes('site-packages')) {
      content = content.trimEnd() + '\nsite-packages\n';
    }
    fs.writeFileSync(pthFile, content, 'utf-8');
  }

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
  const pthFile = path.join(pythonDir, 'python312._pth');
  if (!fs.existsSync(pthFile)) return;
  let content = fs.readFileSync(pthFile, 'utf-8');
  let changed = false;
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

/** 检查 Python 环境和所需包 */
async function checkEnvironment(): Promise<EnvCheckResult> {
  sendProgress('正在检查 Python 环境…');
  ensurePthFile();
  const pythonCmd = await findPython();
  if (!pythonCmd) {
    sendProgress('WARNING 未找到 Python');
    return { pythonCmd: null, pythonVersion: null, missingPackages: [], allReady: false };
  }

  let pythonVersion: string | null = null;
  try {
    const { stdout } = await execAsync(`"${pythonCmd}" --version`, { windowsHide: true });
    pythonVersion = stdout.trim();
    sendProgress(`${pythonVersion} ✓`);
  } catch { /* ignore */ }

  sendProgress('正在检查依赖包…');
  const prefix = sysPathInsert();
  const simplePackages = ['uvicorn', 'fastapi', 'setuptools'];
  const missingPackages: string[] = [];
  for (const pkg of simplePackages) {
    try {
      await execAsync(`"${pythonCmd}" -c "${prefix}import ${pkg}"`, {
        windowsHide: true,
      });
      sendProgress(`  ${pkg} \u2713`);
    } catch {
      missingPackages.push(pkg);
      sendProgress(`  ${pkg} \u2717`);
    }
  }
  // autowsgr 需要检查版本 >= 2.0.4
  let autowsgrOk = false;
  try {
    const { stdout } = await execAsync(
      `"${pythonCmd}" -c "${prefix}import autowsgr; print(autowsgr.__version__)"`,
      { windowsHide: true },
    );
    const ver = stdout.trim();
    // 简单版本比较: 拆分数字比较
    const parts = ver.replace(/[^0-9.]/g, '.').split('.').map(Number);
    const minParts = [2, 0, 4];
    let ok = false;
    for (let i = 0; i < 3; i++) {
      if ((parts[i] || 0) > (minParts[i] || 0)) { ok = true; break; }
      if ((parts[i] || 0) < (minParts[i] || 0)) { ok = false; break; }
      if (i === 2) ok = true; // equal
    }
    autowsgrOk = ok;
    if (ok) {
      sendProgress(`  autowsgr ${ver} \u2713`);
    } else {
      sendProgress(`  autowsgr ${ver} < 2.0.4 \u2717`);
      missingPackages.push('autowsgr');
    }
  } catch {
    missingPackages.push('autowsgr');
    sendProgress(`  autowsgr \u2717`);
  }
  // 去重 (autowsgr 可能被多次加入)
  const unique = [...new Set(missingPackages)];

  if (unique.length === 0) {
    sendProgress('依赖检查通过 ✓');
  }

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

/** 自动安装依赖 (pip install autowsgr)，始终安装到项目目录，不动全局 */
function installDependencies(pythonCmd: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const cwd = appRoot();
    const targetDir = localSitePackages();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    sendProgress('正在安装后端依赖到项目目录…');
    const proc = spawn(pythonCmd, [
      '-m', 'pip', 'install',
      '--target', targetDir,
      '--upgrade',
      'setuptools',  // provides distutils (removed in Python 3.12)
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
  // PYTHONPATH 确保项目目录的包优先于全局
  const localSite = localSitePackages();
  const existingPyPath = process.env.PYTHONPATH || '';
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
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUSERBASE: path.join(cwd, 'python'),
      PYTHONPATH: existingPyPath
        ? `${localSite}${path.delimiter}${existingPyPath}`
        : localSite,
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
