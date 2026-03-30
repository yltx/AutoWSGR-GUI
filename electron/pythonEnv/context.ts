/**
 * Python 环境共享上下文与缓存状态。
 * 由 main.ts 在启动时通过 initPythonEnv() 注入。
 */

export interface PythonEnvContext {
  appRoot: () => string;
  sendProgress: (msg: string) => void;
  getConfiguredPythonPath: () => string | null;
  getTempDir: () => string;
}

let ctx: PythonEnvContext;

export function initPythonEnv(context: PythonEnvContext): void {
  ctx = context;
}

/** 内部访问器：获取已注入的上下文 */
export function getCtx(): PythonEnvContext {
  return ctx;
}

// ════════════════════════════════════════
// Python 路径缓存
// ════════════════════════════════════════

/** 缓存的 Python 路径 (undefined = 尚未查找) */
let cachedPythonCmd: string | null | undefined;

/** 清除 Python 路径缓存（用户切换路径后调用） */
export function clearPythonCache(): void {
  cachedPythonCmd = undefined;
}

export function getCachedPythonCmd(): string | null | undefined {
  return cachedPythonCmd;
}

export function setCachedPythonCmd(value: string | null | undefined): void {
  cachedPythonCmd = value;
}
