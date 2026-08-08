/**
 * Python 安装、依赖安装与更新操作。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { getCtx, setCachedPythonCmd } from './context';
import { findPython } from './finder';
import { ensurePthFile, pipEnv, ensurePip, ensureSslCertForPython } from './utils';
import { ENV_READY_MARKER } from './envCheck';
import {
  buildPythonProcessEnv,
  installTargetArgs,
  type PythonEnvironment,
  resolvePythonEnvironment,
} from './environment';
import {
  BACKEND_RUNTIME_REQUIREMENTS,
  SHIP_LIBRARY_REQUIREMENTS,
} from './dependencies';
import { MANAGED_AUTOWSGR_REQUIREMENT } from './backendRequirement';

const execAsync = promisify(exec);

// 便携版 Python 安装

/** 安装或初始化便携版 Python。 */
export async function installPortablePython(): Promise<{ success: boolean }> {
  const ctx = getCtx();
  setCachedPythonCmd(undefined); // 安装后需重新检测
  const pythonDir = path.join(ctx.appRoot(), 'python');
  const pythonExe = path.join(pythonDir, 'python.exe');

  if (!fs.existsSync(pythonExe)) {
    // 打包产物缺失时尝试在线下载。
    ctx.sendProgress('WARNING 未找到内置 Python，尝试在线下载…');
    return downloadPortablePython();
  }

  // 确保 ._pth 配置正确。
  ensurePthFile();

  // 检查 pip 是否可用。
  try {
    await execAsync(`"${pythonExe}" -m pip --version`, { windowsHide: true, timeout: 15000 });
    const certFile = await ensureSslCertForPython(pythonExe);
    if (certFile) ctx.sendProgress(`TLS 证书已就绪: ${certFile}`);
    ctx.sendProgress('内置 Python + pip 就绪 ✓');
    return { success: true };
  } catch { /* pip 不可用时继续安装。 */ }

  // pip 缺失时执行安装。
  ctx.sendProgress('正在安装 pip…');
  const getPipPath = path.join(ctx.getTempDir(), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonExe}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
    try { fs.unlinkSync(getPipPath); } catch { /* 忽略清理失败。 */ }
    const certFile = await ensureSslCertForPython(pythonExe);
    if (certFile) ctx.sendProgress(`TLS 证书已就绪: ${certFile}`);
    else ctx.sendProgress('WARNING 未检测到 TLS 根证书，后续联网操作可能失败');
    ctx.sendProgress('pip 安装完成 ✓');
    return { success: true };
  } catch {
    ctx.sendProgress('ERROR pip 安装失败');
    return { success: false };
  }
}

/** 在内置 Python 缺失时在线下载便携版。 */
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

  // 安装 pip。
  ctx.sendProgress('正在安装 pip…');
  const getPipPath = path.join(ctx.getTempDir(), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonExe}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
    const certFile = await ensureSslCertForPython(pythonExe);
    if (certFile) ctx.sendProgress(`TLS 证书已就绪: ${certFile}`);
    else ctx.sendProgress('WARNING 未检测到 TLS 根证书，后续联网操作可能失败');
  } catch {
    ctx.sendProgress('ERROR pip 安装失败');
    return { success: false };
  }

  try { fs.unlinkSync(zipPath); } catch { /* 忽略清理失败。 */ }
  try { fs.unlinkSync(getPipPath); } catch { /* 忽略清理失败。 */ }

  ctx.sendProgress(`Python ${version} 便携版安装完成 ✓`);
  return { success: true };
}

// 更新检查

interface UpdateCheckResult {
  gitAvailable: boolean;
  hasUpdates: boolean;
  currentBranch: string;
  behindCount: number;
  remoteUrl: string;
}

/** 比较本地与 PyPI 的 autowsgr 版本。 */
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

  result.gitAvailable = true; // 复用字段表示可检查更新。

  try {
    // 获取已安装版本。
    const { stdout: localVer } = await execAsync(
      `"${pythonCmd}" -c "import autowsgr; print(autowsgr.__version__)"`,
      { windowsHide: true, env: pipEnv() },
    );
    result.currentBranch = localVer.trim(); // 复用字段保存当前版本。

    // 获取 PyPI 最新版本。
    const { stdout: pipOut } = await execAsync(
      `"${pythonCmd}" -m pip index versions autowsgr`,
      { windowsHide: true, timeout: 15000, env: pipEnv() },
    );
    const m = pipOut.match(/LATEST:\s*(\S+)/i) || pipOut.match(/versions:\s*(\S+)/i);
    if (m) {
      const latestVer = m[1].replace(/,$/,'');
      result.hasUpdates = latestVer !== result.currentBranch;
    }
  } catch { /* 检查失败时返回默认结果。 */ }

  return result;
}

// 依赖安装与更新

export interface DependencyInstallPlan {
  buildArgs: string[];
  toolArgs: string[];
  backendArgs: string[];
}

/** 生成与运行环境一致的 pip 参数，供回归测试直接验证。 */
export function buildDependencyInstallPlan(
  environment: PythonEnvironment,
  backendRequirement: string,
): DependencyInstallPlan {
  const targetArgs = installTargetArgs(environment);
  return {
    buildArgs: [
      '-m', 'pip', 'install',
      '--upgrade',
      ...targetArgs,
      'setuptools',
      'hatchling',
      'hatch-vcs',
    ],
    toolArgs: [
      '-m', 'pip', 'install',
      '--upgrade',
      ...targetArgs,
      ...SHIP_LIBRARY_REQUIREMENTS,
      ...BACKEND_RUNTIME_REQUIREMENTS,
    ],
    backendArgs: [
      '-m', 'pip', 'install',
      '--upgrade',
      '--no-build-isolation',
      ...targetArgs,
      backendRequirement,
    ],
  };
}

/** 自动安装依赖；安装目标由统一 Python 环境描述决定。 */
export async function installDependencies(pythonCmd: string): Promise<{ success: boolean; output: string }> {
  const ctx = getCtx();
  let environment: PythonEnvironment;
  try {
    environment = resolvePythonEnvironment(pythonCmd);
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
  const backendRequirement = environment.backendRoot
    ?? MANAGED_AUTOWSGR_REQUIREMENT;
  const installPlan = buildDependencyInstallPlan(
    environment,
    backendRequirement,
  );

  // 安装后清除环境标记，触发下次完整检查。
  try { fs.unlinkSync(ENV_READY_MARKER()); } catch { /* 忽略清理失败。 */ }

  const certFile = await ensureSslCertForPython(pythonCmd);
  if (certFile) ctx.sendProgress(`TLS 证书已就绪: ${certFile}`);
  else ctx.sendProgress('WARNING 未检测到 TLS 根证书，后续联网操作可能失败');

  // 确保 pip 可用。
  if (!(await ensurePip(pythonCmd))) {
    return { success: false, output: 'pip 安装失败，无法安装依赖' };
  }

  const cwd = ctx.appRoot();
  if (
    environment.installTarget
    && !fs.existsSync(environment.installTarget)
  ) {
    fs.mkdirSync(environment.installTarget, { recursive: true });
  }

  const runPip = (args: string[]): Promise<{ code: number; output: string }> => new Promise((resolve) => {
    const proc = spawn(pythonCmd, args, {
      cwd,
      windowsHide: true,
      stdio: 'pipe',
      env: buildPythonProcessEnv(environment),
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
    proc.on('close', (code) => resolve({ code: code ?? 1, output }));
    proc.on('error', (err) => resolve({ code: 1, output: err.message }));
  });

  ctx.sendProgress('正在安装后端构建依赖…');
  const buildDeps = await runPip(installPlan.buildArgs);
  if (buildDeps.code !== 0) {
    ctx.sendProgress('ERROR 后端构建依赖安装失败');
    return { success: false, output: buildDeps.output.slice(-500) };
  }

  ctx.sendProgress('正在安装工具与后端运行依赖…');
  const toolDeps = await runPip(installPlan.toolArgs);
  if (toolDeps.code !== 0) {
    ctx.sendProgress('ERROR 舰船资料库更新依赖安装失败');
    return { success: false, output: toolDeps.output.slice(-500) };
  }

  const installLocation = environment.installTarget
    ? 'GUI 项目目录'
    : '当前 Python 环境';
  ctx.sendProgress(`正在安装后端依赖到${installLocation}…`);
  const install = await runPip(installPlan.backendArgs);
  if (install.code === 0) ctx.sendProgress('后端依赖安装完成 ✓');
  else ctx.sendProgress('ERROR 依赖安装失败');
  return { success: install.code === 0, output: install.output.slice(-500) };
}
