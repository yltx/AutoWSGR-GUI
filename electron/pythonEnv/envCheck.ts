/**
 * 环境校验主流程。
 * 包括 VC++ 检查、env marker 管理、依赖包验证。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCtx, setCachedPythonCmd } from './context';
import { findPython } from './finder';
import { type EnvCheckResult, ensurePthFile, localSitePackages, pipEnv, ensurePip } from './utils';
import { autoUpdateAutowsgr, type AutoUpdateDeps } from './updater';

const execAsync = promisify(exec);

// ════════════════════════════════════════
// VC++ Redistributable
// ════════════════════════════════════════

/** 检查并安装 VC++ Redistributable（c10.dll 等依赖需要） */
async function ensureVCRedist(): Promise<void> {
  const ctx = getCtx();
  // vcruntime140.dll 存在于 system32 说明已安装
  const dllPath = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'vcruntime140.dll');
  if (fs.existsSync(dllPath)) return;

  ctx.sendProgress('Microsoft Visual C++ Redistributable is not installed, this may lead to the DLL load failure.');
  const redistExe = path.join(ctx.appRoot(), 'redist', 'vc_redist.x64.exe');
  if (!fs.existsSync(redistExe)) {
    ctx.sendProgress(`It can be downloaded at https://aka.ms/vs/17/release/vc_redist.x64.exe`);
    return;
  }

  ctx.sendProgress('正在安装 Visual C++ Redistributable…');
  try {
    await execAsync(`"${redistExe}" /install /quiet /norestart`, { windowsHide: true, timeout: 120000 });
    ctx.sendProgress('Visual C++ Redistributable 安装完成 ✓');
  } catch {
    ctx.sendProgress('WARNING VC++ Redistributable 安装失败，请手动运行 redist\\vc_redist.x64.exe');
  }
}

// ════════════════════════════════════════
// 环境就绪标记 (.env_ready)
// ════════════════════════════════════════

/** 环境就绪标记文件路径 */
export const ENV_READY_MARKER = () => path.join(getCtx().appRoot(), '.env_ready');

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
  const ctx = getCtx();
  try {
    const data = JSON.parse(fs.readFileSync(ENV_READY_MARKER(), 'utf-8'));
    if (data && data.pythonCmd && data.autowsgrVersion && isVersionOk(data.autowsgrVersion)) {
      // 确保记录的 python 路径仍然存在
      if (!fs.existsSync(data.pythonCmd)) return null;
      // 若用户切换了 Python 路径，旧标记自动失效
      const configured = ctx.getConfiguredPythonPath();
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

// ════════════════════════════════════════
// autowsgr 更新桥接
// ════════════════════════════════════════

/** 构建 autoUpdateAutowsgr 所需的依赖对象 */
function buildAutoUpdateDeps(): AutoUpdateDeps {
  const ctx = getCtx();
  return {
    sendProgress: ctx.sendProgress,
    getTempDir: ctx.getTempDir,
    appRoot: ctx.appRoot,
    localSitePackages,
    pipEnv,
    ensurePip,
  };
}

// ════════════════════════════════════════
// 环境检查主流程
// ════════════════════════════════════════

/** 检查 Python 环境和所需包 */
export async function checkEnvironment(): Promise<EnvCheckResult> {
  const ctx = getCtx();
  ctx.sendProgress('正在检查运行环境…');
  await ensureVCRedist();

  // ── 快速路径: 如果标记文件存在且有效，跳过重量级依赖检查 ──
  const marker = readEnvMarker();
  if (marker) {
    setCachedPythonCmd(marker.pythonCmd);
    // 每次启动检查并自动更新 autowsgr
    const updatedVer = await autoUpdateAutowsgr(marker.pythonCmd, buildAutoUpdateDeps());
    const finalVer = updatedVer ?? marker.autowsgrVersion;
    if (updatedVer && updatedVer !== marker.autowsgrVersion) {
      writeEnvMarker(marker.pythonCmd, marker.pythonVersion, finalVer);
    }
    ctx.sendProgress(`环境就绪 (${marker.pythonVersion}, autowsgr ${finalVer}) ✓`);
    return {
      pythonCmd: marker.pythonCmd,
      pythonVersion: marker.pythonVersion,
      missingPackages: [],
      allReady: true,
    };
  }

  // ── 完整检查路径 ──
  ctx.sendProgress('正在检查 Python 环境…');
  ensurePthFile();
  const pythonCmd = await findPython();
  if (!pythonCmd) {
    ctx.sendProgress('WARNING 未找到兼容的 Python（需要 3.12 或 3.13）');
    return { pythonCmd: null, pythonVersion: null, missingPackages: [], allReady: false };
  }

  let pythonVersion: string | null = null;
  try {
    const { stdout } = await execAsync(`"${pythonCmd}" --version`, { windowsHide: true });
    pythonVersion = stdout.trim();
    ctx.sendProgress(`${pythonVersion} ✓`);
  } catch { /* ignore */ }

  ctx.sendProgress('正在检查依赖包…');
  const missingPackages: string[] = [];

  // 批量检查所有依赖（单次 Python 调用，避免多次子进程启动开销）
  const spFwd = localSitePackages().replace(/\\/g, '/');
  const checkScript = path.join(ctx.getTempDir(), 'autowsgr_depcheck.py');
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
        ctx.sendProgress(`  ${pkg} \u2713`);
      } else {
        missingPackages.push(pkg);
        ctx.sendProgress(`  ${pkg} \u2717`);
      }
    }

    if (depResult.autowsgr != null) {
      const ver = String(depResult.autowsgr);
      if (isVersionOk(ver)) {
        ctx.sendProgress(`  autowsgr ${ver} \u2713`);
        autowsgrVersion = ver;
      } else {
        ctx.sendProgress(`  autowsgr ${ver} < ${MIN_AUTOWSGR_VERSION.join('.')} \u2717`);
        missingPackages.push('autowsgr');
      }
    } else {
      missingPackages.push('autowsgr');
      ctx.sendProgress(`  autowsgr \u2717`);
    }
  } catch {
    try { fs.unlinkSync(checkScript); } catch { /* ignore */ }
    missingPackages.push('uvicorn', 'fastapi', 'autowsgr');
    ctx.sendProgress('  依赖检查失败');
  }

  const allReady = missingPackages.length === 0;
  if (allReady) {
    ctx.sendProgress('依赖检查通过 ✓');

    // 检查 ADB 可用性
    const adbDir = path.join(ctx.appRoot(), 'adb');
    const builtinAdb = path.join(adbDir, 'adb.exe');
    if (fs.existsSync(builtinAdb)) {
      ctx.sendProgress('ADB (内置) ✓');
    } else {
      ctx.sendProgress('ADB (内置) ✗  将使用模拟器自带 ADB');
    }

    // 检查并自动更新 autowsgr
    const updatedVer = await autoUpdateAutowsgr(pythonCmd, buildAutoUpdateDeps());
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
