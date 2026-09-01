/**
 * 检查 VC++、Python、依赖包和环境就绪标记。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCtx, setCachedPythonCmd } from './context';
import { findPython } from './finder';
import {
  type EnvCheckResult,
  ensurePthFile,
  localSitePackages,
  pipEnv,
  ensurePip,
  ensureSslCertForPython,
} from './utils';
import { autoUpdateAutowsgr, type AutoUpdateDeps } from './updater';
import {
  buildPythonProcessEnv,
  type PythonEnvironment,
  resolvePythonEnvironment,
} from './environment';
import {
  buildBackendRuntimeContractProbeLines,
} from './backendContractProbe';
import { PYTHON_DEPENDENCY_SPECS } from './dependencies';
import {
  FORCE_MANAGED_AUTOWSGR_UPDATE_ON_INSTALL,
} from './backendRequirement';

const execAsync = promisify(exec);

// VC++ Redistributable

/** 检查并安装 VC++ Redistributable。 */
async function ensureVCRedist(): Promise<void> {
  const ctx = getCtx();
  // system32 中存在 vcruntime140.dll 即视为已安装。
  const systemRoot = process.env.SystemRoot
    || process.env.SYSTEMROOT
    || process.env.WINDIR;
  if (
    systemRoot
    && fs.existsSync(path.join(systemRoot, 'System32', 'vcruntime140.dll'))
  ) {
    return;
  }

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

// 环境就绪标记 (.env_ready)

/** 返回环境就绪标记路径。 */
export const ENV_READY_MARKER = () => path.join(getCtx().appRoot(), '.env_ready');

interface EnvironmentMarker {
  pythonCmd: string;
  pythonVersion: string;
  autowsgrVersion: string;
  environmentIdentity: string;
  environment: PythonEnvironment;
}

/** 读取环境标记；当前模式、解释器或仓库变化时返回 null。 */
function readEnvMarker(): EnvironmentMarker | null {
  const ctx = getCtx();
  try {
    const data = JSON.parse(fs.readFileSync(ENV_READY_MARKER(), 'utf-8'));
    if (
      data
      && data.pythonCmd
      && data.autowsgrVersion
      && data.environmentIdentity
    ) {
      // 标记中的 Python 路径必须仍然存在。
      if (!fs.existsSync(data.pythonCmd)) return null;
      // Python 路径变化后旧标记失效。
      const configured = ctx.getConfiguredPythonPath();
      if (configured && configured !== data.pythonCmd) return null;
      const environment = resolvePythonEnvironment(data.pythonCmd);
      if (environment.identity !== data.environmentIdentity) return null;
      return { ...data, environment };
    }
  } catch { /* 标记缺失或损坏时重新检查。 */ }
  return null;
}

/** 写入环境就绪标记。 */
function writeEnvMarker(
  environment: PythonEnvironment,
  pythonVersion: string,
  autowsgrVersion: string,
): void {
  try {
    fs.writeFileSync(
      ENV_READY_MARKER(),
      JSON.stringify({
        pythonCmd: environment.pythonCmd,
        pythonVersion,
        autowsgrVersion,
        environmentIdentity: environment.identity,
      }),
      'utf-8',
    );
  } catch { /* 标记写入失败不阻断启动。 */ }
}

// autowsgr 更新桥接

/** 构造 autoUpdateAutowsgr 的依赖对象。 */
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

function shouldAutoUpdate(environment: PythonEnvironment): boolean {
  const ctx = getCtx();
  return environment.startupMode === 'managed'
    && ctx.getUpdateMode() !== 'manual';
}

/** 发行包在安装器清除环境标记后必须重新安装一次指定后端。 */
function shouldForceManagedBackendInstall(
  environment: PythonEnvironment,
): boolean {
  return (
    environment.startupMode === 'managed'
    && FORCE_MANAGED_AUTOWSGR_UPDATE_ON_INSTALL
  );
}

function autoUpdateSkipMessage(environment: PythonEnvironment): string {
  return environment.startupMode === 'external'
    ? '本地后端调试模式：跳过 autowsgr 自动更新检查'
    : '手动更新模式：跳过 autowsgr 自动更新检查';
}

type CoreDepProbeResult = {
  uvicorn: boolean;
  fastapi: boolean;
  scipy: boolean;
  requests: boolean;
  beautifulSoup: boolean;
  maafw: boolean;
  cffi: boolean;
  rendercanvas: boolean;
  wgpu: boolean;
  autowsgr: string | null;
  backendRuntimeContract: boolean;
};

/** 检查核心依赖及 scipy._lib 是否可导入。 */
async function probeCoreDependencies(
  environment: PythonEnvironment,
): Promise<CoreDepProbeResult | null> {
  const ctx = getCtx();
  const { backendRoot, pythonCmd, useLocalSite } = environment;
  const expectedRoot = backendRoot || environment.localSite;
  const pythonPath = (value: string): string => value
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'");
  const checkScript = path.join(ctx.getTempDir(), 'autowsgr_depcheck.py');
  const scriptLines = [
    'import json, sys, site',
    ...(useLocalSite
      ? [
          `sp = '${pythonPath(localSitePackages())}'`,
          'sys.path.insert(0, sp)',
          'site.addsitedir(sp)',
        ]
      : []),
    ...(backendRoot
      ? [
          `repo = '${pythonPath(backendRoot)}'`,
          'sys.path.insert(0, repo)',
        ]
      : []),
    'r = {}',
    `checks = ${JSON.stringify(
      PYTHON_DEPENDENCY_SPECS.map(
        dependency => [dependency.key, dependency.importName],
      ),
    )}`,
    'for key, mod in checks:',
    '    try:',
    '        __import__(mod); r[key] = True',
    '    except Exception:',
    '        r[key] = False',
    'try:',
    '    import autowsgr',
    '    r["autowsgr"] = getattr(autowsgr, "__version__", "source")',
    '    r["autowsgr_path"] = autowsgr.__file__',
    'except Exception:',
    '    r["autowsgr"] = None',
    '    r["autowsgr_path"] = None',
    ...buildBackendRuntimeContractProbeLines(),
    'try:',
    '    _verify_gui_runtime_contract()',
    '    r["backend_runtime_contract"] = True',
    'except Exception:',
    '    r["backend_runtime_contract"] = False',
    'print(json.dumps(r))',
  ];
  fs.writeFileSync(checkScript, scriptLines.join('\n'), 'utf-8');

  try {
    const { stdout: depOut } = await execAsync(
      `"${pythonCmd}" "${checkScript}"`,
      {
        windowsHide: true,
        timeout: 30000,
        env: buildPythonProcessEnv(environment),
      },
    );
    const depResult = JSON.parse(depOut.trim());
    const autowsgrPath = typeof depResult.autowsgr_path === 'string'
      ? path.resolve(depResult.autowsgr_path)
      : '';
    const relativePath = autowsgrPath
      ? path.relative(path.resolve(expectedRoot), autowsgrPath)
      : '';
    const usesExpectedAutowsgr = autowsgrPath !== ''
      && relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath);
    if (depResult.autowsgr != null && !usesExpectedAutowsgr) {
      ctx.sendProgress(
        `WARNING 忽略来源不正确的 autowsgr: ${autowsgrPath}`,
      );
    }
    return {
      uvicorn: Boolean(depResult.uvicorn),
      fastapi: Boolean(depResult.fastapi),
      scipy: Boolean(depResult.scipy),
      requests: Boolean(depResult.requests),
      beautifulSoup: Boolean(depResult.beautifulSoup),
      maafw: Boolean(depResult.maafw),
      cffi: Boolean(depResult.cffi),
      rendercanvas: Boolean(depResult.rendercanvas),
      wgpu: Boolean(depResult.wgpu),
      autowsgr: depResult.autowsgr == null || !usesExpectedAutowsgr
        ? null
        : String(depResult.autowsgr),
      backendRuntimeContract: (
        usesExpectedAutowsgr
        && depResult.backend_runtime_contract === true
      ),
    };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(checkScript); } catch { /* 忽略清理失败。 */ }
  }
}

// 环境检查主流程

function environmentSourceMessage(
  environment: PythonEnvironment,
): string {
  return `运行环境来源: 后端 ${environment.startupMode}, Python ${environment.pythonSource} (${environment.pythonCmd})`;
}

/** 检查 Python 环境和所需包。 */
export async function checkEnvironment(): Promise<EnvCheckResult> {
  const ctx = getCtx();
  ctx.sendProgress('正在检查运行环境…');
  await ensureVCRedist();

  // 有效标记可跳过重量级依赖检查。
  const marker = readEnvMarker();
  if (marker) {
    setCachedPythonCmd(marker.pythonCmd);
    ctx.sendProgress(environmentSourceMessage(marker.environment));
    const certFile = await ensureSslCertForPython(marker.pythonCmd);
    if (certFile) ctx.sendProgress(`TLS 证书已就绪: ${certFile}`);
    else ctx.sendProgress('WARNING 未检测到 TLS 根证书，后续联网操作可能失败');

    const markerProbe = await probeCoreDependencies(marker.environment);
    const markerBrokenDeps: string[] = [];
    if (!markerProbe) {
      markerBrokenDeps.push('dep-check');
    } else {
      for (const dependency of PYTHON_DEPENDENCY_SPECS) {
        if (!markerProbe[dependency.key]) {
          markerBrokenDeps.push(dependency.packageName);
        }
      }
      if (markerProbe.autowsgr == null) markerBrokenDeps.push('autowsgr');
      if (!markerProbe.backendRuntimeContract) {
        markerBrokenDeps.push('autowsgr-runtime-contract');
      }
    }

    if (markerBrokenDeps.length === 0) {
      // 自动模式下每次启动检查 autowsgr 更新。
      const markerAutowsgrVersion = markerProbe?.autowsgr ?? marker.autowsgrVersion;
      let finalVer = markerAutowsgrVersion;
      if (shouldAutoUpdate(marker.environment)) {
        const updatedVer = await autoUpdateAutowsgr(marker.pythonCmd, buildAutoUpdateDeps());
        finalVer = updatedVer ?? markerAutowsgrVersion;
        if (updatedVer && updatedVer !== markerAutowsgrVersion) {
          writeEnvMarker(
            marker.environment,
            marker.pythonVersion,
            finalVer,
          );
        }
      } else {
        ctx.sendProgress(autoUpdateSkipMessage(marker.environment));
      }
      ctx.sendProgress(`环境就绪 (${marker.pythonVersion}, autowsgr ${finalVer}) ✓`);
      return {
        pythonCmd: marker.pythonCmd,
        pythonVersion: marker.pythonVersion,
        missingPackages: [],
        allReady: true,
      };
    }

    ctx.sendProgress(`检测到依赖异常 (${markerBrokenDeps.join(', ')})，重新执行完整检查…`);
    try { fs.unlinkSync(ENV_READY_MARKER()); } catch { /* 忽略清理失败。 */ }
  }

  // 标记无效时执行完整检查。
  ctx.sendProgress('正在检查 Python 环境…');
  const pythonCmd = await findPython();
  if (!pythonCmd) {
    ctx.sendProgress('WARNING 未找到兼容的 Python（需要 3.12 或 3.13）');
    return { pythonCmd: null, pythonVersion: null, missingPackages: [], allReady: false };
  }

  let environment: PythonEnvironment;
  try {
    environment = resolvePythonEnvironment(pythonCmd);
  } catch (error) {
    ctx.sendProgress(
      `ERROR ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      pythonCmd,
      pythonVersion: null,
      missingPackages: ['autowsgr'],
      allReady: false,
    };
  }
  ctx.sendProgress(environmentSourceMessage(environment));
  if (environment.useLocalSite) ensurePthFile();

  const certFile = await ensureSslCertForPython(pythonCmd);
  if (certFile) ctx.sendProgress(`TLS 证书已就绪: ${certFile}`);
  else ctx.sendProgress('WARNING 未检测到 TLS 根证书，后续联网操作可能失败');

  let pythonVersion: string | null = null;
  try {
    const { stdout } = await execAsync(`"${pythonCmd}" --version`, { windowsHide: true });
    pythonVersion = stdout.trim();
    ctx.sendProgress(`${pythonVersion} ✓`);
  } catch { /* 版本读取失败时保留空值。 */ }

  ctx.sendProgress('正在检查依赖包…');
  const missingPackages: string[] = [];

  let autowsgrVersion = '';
  try {
    const depResult = await probeCoreDependencies(environment);
    if (!depResult) {
      throw new Error('依赖探测失败');
    }

    for (const dependency of PYTHON_DEPENDENCY_SPECS) {
      if (depResult[dependency.key]) {
        ctx.sendProgress(`  ${dependency.packageName} \u2713`);
      } else {
        missingPackages.push(dependency.packageName);
        ctx.sendProgress(`  ${dependency.packageName} \u2717`);
      }
    }

    if (depResult.autowsgr != null) {
      const ver = String(depResult.autowsgr);
      ctx.sendProgress(`  autowsgr ${ver} \u2713`);
      autowsgrVersion = ver;
    } else {
      missingPackages.push('autowsgr');
      ctx.sendProgress(`  autowsgr \u2717`);
    }
    if (depResult.backendRuntimeContract) {
      ctx.sendProgress('  AutoWSGR GUI 运行契约 ✓');
    } else {
      missingPackages.push('autowsgr-runtime-contract');
      ctx.sendProgress(
        '  AutoWSGR GUI 运行契约 ✗  请更新后端版本',
      );
    }
  } catch {
    missingPackages.push(
      ...PYTHON_DEPENDENCY_SPECS.map(
        dependency => dependency.packageName,
      ),
      'autowsgr',
    );
    ctx.sendProgress('  依赖检查失败');
  }

  const forceBackendInstall = shouldForceManagedBackendInstall(environment);
  const allReady = missingPackages.length === 0;
  if (!allReady && forceBackendInstall) {
    ctx.sendProgress('覆盖安装后正在增量更新后端及依赖…');
    const updatedVer = await autoUpdateAutowsgr(
      pythonCmd,
      buildAutoUpdateDeps(),
      true,
    );
    if (updatedVer) {
      writeEnvMarker(environment, pythonVersion || '', updatedVer);
      ctx.sendProgress(`环境增量更新完成 (autowsgr ${updatedVer}) ✓`);
      return {
        pythonCmd,
        pythonVersion,
        missingPackages: [],
        allReady: true,
      };
    }
    ctx.sendProgress('WARNING 增量更新未完成，将尝试修复缺失依赖');
  }

  if (allReady) {
    ctx.sendProgress('依赖检查通过 ✓');

    // 检查 ADB 可用性。
    const adbDir = path.join(ctx.appRoot(), 'adb');
    const builtinAdb = path.join(adbDir, 'adb.exe');
    if (fs.existsSync(builtinAdb)) {
      ctx.sendProgress('ADB (内置) ✓');
    } else {
      ctx.sendProgress('ADB (内置) ✗  将使用模拟器自带 ADB');
    }

    // 自动模式下检查并更新 autowsgr。
    let finalVer = autowsgrVersion;
    if (shouldAutoUpdate(environment) || forceBackendInstall) {
      const updatedVer = await autoUpdateAutowsgr(
        pythonCmd,
        buildAutoUpdateDeps(),
        forceBackendInstall,
      );
      finalVer = updatedVer || autowsgrVersion;
      if (forceBackendInstall && !updatedVer) {
        ctx.sendProgress('WARNING 本包固定后端提交强制更新未完成，下次启动将重试');
        return {
          pythonCmd,
          pythonVersion,
          missingPackages: [],
          allReady: true,
        };
      }
    } else {
      ctx.sendProgress(autoUpdateSkipMessage(environment));
    }
    writeEnvMarker(environment, pythonVersion || '', finalVer);
  }

  return {
    pythonCmd,
    pythonVersion,
    missingPackages,
    allReady,
  };
}
