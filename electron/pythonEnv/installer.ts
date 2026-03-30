/**
 * Python 安装、依赖安装与更新操作。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { getCtx, setCachedPythonCmd } from './context';
import { findPython, findPythonSync } from './finder';
import { ensurePthFile, localSitePackages, pipEnv, ensurePip } from './utils';
import { ENV_READY_MARKER } from './envCheck';

const execAsync = promisify(exec);

// ════════════════════════════════════════
// 便携版 Python 安装
// ════════════════════════════════════════

/** 安装/初始化便携版 Python（已随应用打包，仅需确保 pip 就绪） */
export async function installPortablePython(): Promise<{ success: boolean }> {
  const ctx = getCtx();
  setCachedPythonCmd(undefined); // 安装后需重新检测
  const pythonDir = path.join(ctx.appRoot(), 'python');
  const pythonExe = path.join(pythonDir, 'python.exe');

  if (!fs.existsSync(pythonExe)) {
    // 兜底: 如果打包产物缺失 python，尝试在线下载
    ctx.sendProgress('WARNING 未找到内置 Python，尝试在线下载…');
    return downloadPortablePython();
  }

  // 确保 ._pth 配置正确
  ensurePthFile();

  // 检查 pip 是否可用
  try {
    await execAsync(`"${pythonExe}" -m pip --version`, { windowsHide: true, timeout: 15000 });
    ctx.sendProgress('内置 Python + pip 就绪 ✓');
    return { success: true };
  } catch { /* pip not available, install it */ }

  // pip 缺失则安装
  ctx.sendProgress('正在安装 pip…');
  const getPipPath = path.join(ctx.getTempDir(), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonExe}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
    try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }
    ctx.sendProgress('pip 安装完成 ✓');
    return { success: true };
  } catch {
    ctx.sendProgress('ERROR pip 安装失败');
    return { success: false };
  }
}

/** 兜底: 在线下载便携版 Python（仅在内置 Python 缺失时使用） */
async function downloadPortablePython(): Promise<{ success: boolean }> {
  const ctx = getCtx();
  const pythonDir = path.join(ctx.appRoot(), 'python');
  const pythonExe = path.join(pythonDir, 'python.exe');

  const version = '3.12.8';
  const zipUrl = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
  const zipPath = path.join(ctx.getTempDir(), 'python-embed.zip');

  ctx.sendProgress(`正在下载 Python ${version} 便携版…`);
  try {
    await execAsync(`curl -L -o "${zipPath}" "${zipUrl}"`, { windowsHide: true, timeout: 180000 });
  } catch {
    ctx.sendProgress('ERROR Python 下载失败，请检查网络');
    return { success: false };
  }

  ctx.sendProgress('正在解压 Python…');
  try {
    if (!fs.existsSync(pythonDir)) fs.mkdirSync(pythonDir, { recursive: true });
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${pythonDir}' -Force"`,
      { windowsHide: true, timeout: 30000 },
    );
  } catch {
    ctx.sendProgress('ERROR Python 解压失败');
    return { success: false };
  }

  ensurePthFile();

  // 安装 pip
  ctx.sendProgress('正在安装 pip…');
  const getPipPath = path.join(ctx.getTempDir(), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonExe}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
  } catch {
    ctx.sendProgress('ERROR pip 安装失败');
    return { success: false };
  }

  try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
  try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }

  ctx.sendProgress(`Python ${version} 便携版安装完成 ✓`);
  return { success: true };
}

// ════════════════════════════════════════
// 更新检查
// ════════════════════════════════════════

interface UpdateCheckResult {
  gitAvailable: boolean;
  hasUpdates: boolean;
  currentBranch: string;
  behindCount: number;
  remoteUrl: string;
}

/** 检查 autowsgr 包是否有可用更新 (对比本地已安装版本与 PyPI 最新版) */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
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

// ════════════════════════════════════════
// 依赖安装与更新
// ════════════════════════════════════════

/** 自动安装依赖 (pip install autowsgr)，始终安装到项目目录，不动全局 */
export async function installDependencies(pythonCmd: string): Promise<{ success: boolean; output: string }> {
  const ctx = getCtx();
  // 安装后环境变化，清除标记以便下次重新检查
  try { fs.unlinkSync(ENV_READY_MARKER()); } catch { /* ignore */ }

  // 确保 pip 可用
  if (!(await ensurePip(pythonCmd))) {
    return { success: false, output: 'pip 安装失败，无法安装依赖' };
  }

  return new Promise((resolve) => {
    const cwd = ctx.appRoot();
    const targetDir = localSitePackages();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    ctx.sendProgress('正在安装后端依赖到项目目录…');
    const proc = spawn(pythonCmd, [
      '-m', 'pip', 'install',
      '--target', targetDir,
      'setuptools',         // provides distutils (removed in Python 3.12)
      'autowsgr',
    ], {
      cwd,
      windowsHide: true,
      stdio: 'pipe',
      env: pipEnv(),
    });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      for (const l of text.split('\n')) { if (l.trim()) ctx.sendProgress(l.trim()); }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      for (const l of text.split('\n')) { if (l.trim()) ctx.sendProgress(l.trim()); }
    });
    proc.on('close', (code) => {
      if (code === 0) ctx.sendProgress('后端依赖安装完成 ✓');
      else ctx.sendProgress('ERROR 依赖安装失败');
      resolve({ success: code === 0, output: output.slice(-500) });
    });
    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

/** 更新 autowsgr 包（仅升级 autowsgr 本体，不级联重装所有依赖） */
export function pullUpdates(): Promise<{ success: boolean; output: string }> {
  const ctx = getCtx();
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

    // 先删除旧版 autowsgr，再重新安装（不带 --upgrade 避免级联更新依赖）
    try {
      for (const entry of fs.readdirSync(targetDir)) {
        if (entry === 'autowsgr' || entry.startsWith('autowsgr-')) {
          fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
        }
      }
    } catch { /* ignore cleanup errors */ }

    const proc = spawn(pythonCmd, [
      '-m', 'pip', 'install',
      '--target', targetDir,
      '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
      '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
      'autowsgr',
    ], {
      cwd: ctx.appRoot(),
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
