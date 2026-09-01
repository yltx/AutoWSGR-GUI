/**
 * 解析 CUDA 配置并构造 Python 子进程环境。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildPythonProcessEnv,
  type PythonEnvironment,
} from './environment';

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

function nestedVersion(
  root: Record<string, unknown>,
  key: string,
): string | null {
  const section = root[key];
  if (!isRecord(section)) return null;
  const version = section.version;
  return typeof version === 'string' && version.trim()
    ? version.trim()
    : null;
}

/** 读取 CUDA version.json；无效或缺失时由调用方执行目录名回退。 */
export function readCudaVersionFile(cudaRoot: string): string | null {
  try {
    const versionJson = path.join(cudaRoot, 'version.json');
    if (!fs.existsSync(versionJson)) return null;
    const parsed: unknown = JSON.parse(
      fs.readFileSync(versionJson, 'utf-8').replace(/^\uFEFF/, ''),
    );
    if (!isRecord(parsed)) return null;
    return nestedVersion(parsed, 'cuda')
      ?? nestedVersion(parsed, 'cuda_cudart');
  } catch {
    return null;
  }
}

function normalizeCudaRoot(candidate: string): string {
  const resolved = path.resolve(candidate.trim());
  if (isCudaRuntimeDirectory(resolved)) return resolved;
  return path.basename(resolved).toLowerCase() === 'bin'
    ? path.dirname(resolved)
    : resolved;
}

function isCudaRuntimeDirectory(candidate: string): boolean {
  try {
    const names = fs.readdirSync(candidate);
    return names.some(name => /^cudart64.*\.dll$/i.test(name))
      && names.some(name => /^cublas64.*\.dll$/i.test(name));
  } catch {
    return false;
  }
}

/** 校验用户配置并返回 CUDA Toolkit 根目录或运行库目录。 */
export function resolveConfiguredCudaRoot(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const cudaRoot = normalizeCudaRoot(value);
  const binDir = path.join(cudaRoot, 'bin');
  const runtimeDir = isCudaRuntimeDirectory(cudaRoot)
    ? cudaRoot
    : isCudaRuntimeDirectory(binDir)
      ? binDir
      : null;
  if (!fs.existsSync(path.join(binDir, 'nvcc.exe')) && !runtimeDir) {
    return null;
  }
  return fs.existsSync(path.join(binDir, 'nvcc.exe'))
    ? cudaRoot
    : runtimeDir;
}

/** 在同一个 Python 基础环境上叠加 CUDA 运行变量。 */
export function buildCudaEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  configuredCudaRoot: string | null,
): NodeJS.ProcessEnv {
  if (!configuredCudaRoot) return { ...baseEnv };

  const cudaRoot = normalizeCudaRoot(configuredCudaRoot);
  const isToolkit = fs.existsSync(path.join(cudaRoot, 'bin', 'nvcc.exe'));
  const cudaBin = isToolkit ? path.join(cudaRoot, 'bin') : cudaRoot;
  const existingPath = baseEnv.PATH || baseEnv.Path || '';
  const pathEntries = existingPath.split(path.delimiter).filter(Boolean);
  const withoutDuplicate = pathEntries.filter(
    entry => path.resolve(entry).toLowerCase()
      !== path.resolve(cudaBin).toLowerCase(),
  );
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  if (isToolkit) {
    env.CUDA_PATH = cudaRoot;
    env.CUDA_HOME = cudaRoot;
  }
  env.PATH = [cudaBin, ...withoutDuplicate].join(path.delimiter);

  let version = readCudaVersionFile(cudaRoot);
  version ??= path.basename(cudaRoot).match(/v(\d+(?:\.\d+)?)/i)?.[1]
    ?? null;
  const versionMatch = version?.match(/^(\d+)\.(\d+)/);
  if (isToolkit && versionMatch) {
    env[`CUDA_PATH_V${versionMatch[1]}_${versionMatch[2]}`] = cudaRoot;
  }
  return env;
}

/** 构造 CUDA 检测和后端启动共同使用的完整 Python 运行环境。 */
export function buildBackendRuntimeEnvironment(
  environment: PythonEnvironment,
  configuredCudaRoot: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildCudaEnvironment(
    buildPythonProcessEnv(environment, baseEnv),
    configuredCudaRoot,
  );
}
