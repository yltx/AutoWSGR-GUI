/**
 * 统一描述 Python 安装、检查和启动环境。
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCtx } from './context';
import { isLocalPython, localSitePackages } from './utils';

export type BackendStartupMode = 'managed' | 'external';
export type PythonSource = 'configured' | 'bundled' | 'system';

/** 安装、检查和启动共同使用的 Python 环境。 */
export interface PythonEnvironment {
  startupMode: BackendStartupMode;
  pythonSource: PythonSource;
  pythonCmd: string;
  backendRoot: string | null;
  localSite: string;
  useLocalSite: boolean;
  installTarget: string | null;
  identity: string;
}

function normalizeIdentityPath(value: string | null): string | null {
  if (!value) return null;
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSamePath(left: string, right: string): boolean {
  return normalizeIdentityPath(left) === normalizeIdentityPath(right);
}

/** 解析 external 模式的仓库根目录；managed 模式返回 null。 */
export function resolveExternalBackendRoot(): string | null {
  const ctx = getCtx();
  if (ctx.getBackendStartupMode() !== 'external') return null;

  const configured = process.env.AUTOWSGR_BACKEND_REPO?.trim()
    || ctx.getBackendRepoPath().trim();
  if (!configured) {
    throw new Error('external 模式未配置 AutoWSGR 本地仓库路径');
  }

  let root = path.resolve(configured);
  if (!fs.existsSync(root)) {
    throw new Error(`external 后端仓库路径不存在: ${root}`);
  }

  const isPackageDirectory = path.basename(root).toLowerCase() === 'autowsgr'
    && fs.existsSync(path.join(root, '__init__.py'))
    && fs.existsSync(path.join(root, 'server', 'main.py'));
  if (isPackageDirectory) root = path.dirname(root);

  if (!fs.existsSync(path.join(root, 'autowsgr', 'server', 'main.py'))) {
    throw new Error(
      `external 后端仓库无效，未找到 autowsgr/server/main.py: ${root}`,
    );
  }
  return root;
}

/** 根据当前设置生成唯一的 Python 环境描述。 */
export function resolvePythonEnvironment(
  pythonCmd: string,
): PythonEnvironment {
  const ctx = getCtx();
  const startupMode = ctx.getBackendStartupMode();
  const backendRoot = resolveExternalBackendRoot();
  const localSite = localSitePackages();
  const useLocalSite = startupMode === 'managed' || isLocalPython(pythonCmd);
  const installTarget = useLocalSite ? localSite : null;
  const configuredPython = ctx.getConfiguredPythonPath();
  const bundledPython = path.join(ctx.appRoot(), 'python', 'python.exe');
  const pythonSource: PythonSource = (
    configuredPython && isSamePath(pythonCmd, configuredPython)
  )
    ? 'configured'
    : isSamePath(pythonCmd, bundledPython)
      ? 'bundled'
      : 'system';
  const identity = JSON.stringify({
    startupMode,
    pythonCmd: normalizeIdentityPath(pythonCmd),
    backendRoot: normalizeIdentityPath(backendRoot),
    installTarget: normalizeIdentityPath(installTarget),
  });

  return {
    startupMode,
    pythonSource,
    pythonCmd,
    backendRoot,
    localSite,
    useLocalSite,
    installTarget,
    identity,
  };
}

/** 返回当前 managed 或 external 后端实际使用的舰名库路径。 */
export function backendShipNamesPath(pythonCmd: string): string {
  const environment = resolvePythonEnvironment(pythonCmd);
  const backendRoot = environment.backendRoot ?? environment.localSite;
  return path.join(
    backendRoot,
    'autowsgr',
    'data',
    'shipnames.yaml',
  );
}

/** 构造子进程环境，并隔离外部解释器与 managed 包目录。 */
export function buildPythonProcessEnv(
  environment: PythonEnvironment,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...baseEnv };
  if (environment.useLocalSite) {
    const existing = result.PYTHONPATH || '';
    const entries = existing.split(path.delimiter).filter(Boolean);
    if (!entries.some(entry => isSamePath(entry, environment.localSite))) {
      entries.unshift(environment.localSite);
    }
    result.PYTHONPATH = entries.join(path.delimiter);
    result.PYTHONUSERBASE = path.join(getCtx().appRoot(), 'python');
    return result;
  }

  const entries = (result.PYTHONPATH || '')
    .split(path.delimiter)
    .filter(entry => entry && !isSamePath(entry, environment.localSite));
  if (entries.length > 0) result.PYTHONPATH = entries.join(path.delimiter);
  else delete result.PYTHONPATH;

  const managedUserBase = path.join(getCtx().appRoot(), 'python');
  if (
    result.PYTHONUSERBASE
    && isSamePath(result.PYTHONUSERBASE, managedUserBase)
  ) {
    delete result.PYTHONUSERBASE;
  }
  return result;
}

/** 返回 pip 安装目标参数；外部解释器使用自身环境时返回空数组。 */
export function installTargetArgs(
  environment: PythonEnvironment,
): string[] {
  return environment.installTarget
    ? ['--target', environment.installTarget]
    : [];
}
