/**
 * 保存由 main.ts 注入的 Python 环境上下文和路径缓存。
 */

export interface PythonEnvContext {
  appRoot: () => string;
  sendProgress: (msg: string) => void;
  getConfiguredPythonPath: () => string | null;
  getUpdateMode: () => 'auto' | 'manual';
  getBackendStartupMode: () => 'managed' | 'external';
  getBackendRepoPath: () => string;
  getTempDir: () => string;
}

let ctx: PythonEnvContext;

export function initPythonEnv(context: PythonEnvContext): void {
  ctx = context;
}

/** 获取已注入的 Python 环境上下文。 */
export function getCtx(): PythonEnvContext {
  return ctx;
}

// Python 路径缓存

/** 缓存的 Python 路径，undefined 表示尚未查找。 */
let cachedPythonCmd: string | null | undefined;

/** 清除 Python 路径缓存。 */
export function clearPythonCache(): void {
  cachedPythonCmd = undefined;
}

export function getCachedPythonCmd(): string | null | undefined {
  return cachedPythonCmd;
}

export function setCachedPythonCmd(value: string | null | undefined): void {
  cachedPythonCmd = value;
}
