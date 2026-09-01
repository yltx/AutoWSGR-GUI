/**
 * 后端进程安全关闭流程。
 *
 * 1. 调用后端系统停止接口，让运行中的任务完成清理。
 * 2. 终止后端服务进程；Windows 同时处理完整进程树。
 * 3. 等待进程 close，确认操作系统已经释放进程资源。
 * 4. 超时后才强制终止，并再次等待 close。
 *
 * 更新安装和应用退出共用这一流程，任何阶段无法确认进程退出时都会
 * 抛出错误，调用方不得继续安装更新。
 */
import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as http from 'http';
import { platform as nodePlatform } from 'process';

export interface BackendShutdownOptions {
  backendPort: number;
  systemStopTimeoutMs?: number;
  terminateTimeoutMs?: number;
  forceTerminateTimeoutMs?: number;
}

export interface BackendShutdownDependencies {
  platform?: NodeJS.Platform;
  requestSystemStop?: (port: number, timeoutMs: number) => Promise<void>;
  terminateProcessTree?: (
    process: ChildProcess,
    force: boolean,
    platform: NodeJS.Platform,
  ) => Promise<void>;
  waitForProcessClose?: (
    process: ChildProcess,
    timeoutMs: number,
  ) => Promise<boolean>;
  warn?: (message: string) => void;
}

const DEFAULT_SYSTEM_STOP_TIMEOUT_MS = 35000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 5000;
const DEFAULT_FORCE_TERMINATE_TIMEOUT_MS = 5000;

function hasExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

function executeFile(
  command: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: 10000,
        encoding: 'utf8',
      },
      (error, _stdout, _stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const exitCode = typeof error.code === 'number'
          || typeof error.code === 'string'
          ? error.code
          : 'unknown';
        reject(new Error(`${command} 执行失败，退出码 ${exitCode}`));
      },
    );
  });
}

/** 调用后端正式停止接口并验证返回结果。 */
export function requestBackendSystemStop(
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/system/stop',
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Length': '0',
        },
      },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(
              `后端停止接口返回 HTTP ${statusCode}: ${body.trim()}`,
            ));
            return;
          }
          try {
            const result = JSON.parse(body) as {
              success?: boolean;
              message?: string;
              error?: string;
            };
            if (result.success !== true) {
              reject(new Error(
                result.error
                || result.message
                || '后端拒绝停止当前任务',
              ));
              return;
            }
            resolve();
          } catch (error) {
            reject(new Error(
              `后端停止接口返回无效 JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ));
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`后端任务停止等待超过 ${timeoutMs}ms`));
    });
    request.on('error', reject);
    request.end();
  });
}

/** 等待进程真正退出；返回 false 表示超时。 */
export function waitForProcessClose(
  process: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(process)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      process.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(hasExited(process)), timeoutMs);
    process.once('close', onClose);
  });
}

/** 终止服务进程；Windows 使用 /T 保证完整进程树被处理。 */
export async function terminateBackendProcessTree(
  process: ChildProcess,
  force: boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  if (hasExited(process)) return;
  if (platform === 'win32') {
    if (!process.pid) throw new Error('后端进程没有可用 PID');
    const args = ['/PID', String(process.pid), '/T'];
    if (force) args.push('/F');
    await executeFile('taskkill.exe', args);
    return;
  }

  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  if (!process.kill(signal) && !hasExited(process)) {
    throw new Error(`无法向后端进程发送 ${signal}`);
  }
}

/** 执行完整关闭流程；无法确认退出时抛错并阻止更新安装。 */
export async function shutdownBackendProcess(
  process: ChildProcess,
  options: BackendShutdownOptions,
  dependencies: BackendShutdownDependencies = {},
): Promise<void> {
  if (hasExited(process)) return;

  const platform = dependencies.platform ?? nodePlatform;
  const requestSystemStop = dependencies.requestSystemStop
    ?? requestBackendSystemStop;
  const terminateProcessTree = dependencies.terminateProcessTree
    ?? terminateBackendProcessTree;
  const waitForClose = dependencies.waitForProcessClose
    ?? waitForProcessClose;
  const warn = dependencies.warn ?? (message => console.warn(message));

  try {
    await requestSystemStop(
      options.backendPort,
      options.systemStopTimeoutMs ?? DEFAULT_SYSTEM_STOP_TIMEOUT_MS,
    );
  } catch (error) {
    warn(
      `[Backend] 优雅停止任务失败，将继续关闭进程：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (hasExited(process)) return;

  try {
    await terminateProcessTree(process, false, platform);
  } catch (error) {
    warn(
      `[Backend] 普通终止失败，将等待后强制终止：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const terminated = await waitForClose(
    process,
    options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
  );
  if (terminated) return;

  let forceError: unknown = null;
  try {
    await terminateProcessTree(process, true, platform);
  } catch (error) {
    forceError = error;
  }
  const forced = await waitForClose(
    process,
    options.forceTerminateTimeoutMs
      ?? DEFAULT_FORCE_TERMINATE_TIMEOUT_MS,
  );
  if (forced) return;

  const detail = forceError instanceof Error
    ? `：${forceError.message}`
    : '';
  throw new Error(`无法确认后端进程树已经退出${detail}`);
}
