/**
 * 连接后端进程 IPC 与 BackendService。
 */
import type { ChildProcess } from 'child_process';
import type { IpcRegistrar } from './IpcRegistrar';

export interface BackendIpcDependencies {
  getBackendProcess(): ChildProcess | null;
  startBackend(): Promise<void>;
  runSetupScript(): Promise<unknown>;
}

/** 注册后端安装脚本和启动 IPC。 */
export function registerBackendIpc(
  ipc: IpcRegistrar,
  dependencies: BackendIpcDependencies,
): void {
  ipc.handle('run-setup', async () => {
    return dependencies.runSetupScript();
  });

  ipc.handle('start-backend', async () => {
    if (dependencies.getBackendProcess()) {
      return { success: true, message: '后端已在运行' };
    }
    try {
      await dependencies.startBackend();
      return { success: true, message: '后端启动中' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error
          ? error.message
          : String(error),
      };
    }
  });
}
