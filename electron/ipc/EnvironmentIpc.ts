/**
 * 连接 Python 环境 IPC 与 PythonEnvironmentService。
 */
import type { PythonEnvironmentService } from '../services/PythonEnvironmentService';
import type { IpcRegistrar } from './IpcRegistrar';

/** 注册 Python 环境检查和安装 IPC。 */
export function registerEnvironmentIpc(
  ipc: IpcRegistrar,
  pythonEnvironment: PythonEnvironmentService,
): void {
  ipc.handle('check-environment', async () => {
    return await pythonEnvironment.check();
  });

  ipc.handle('install-deps', async () => {
    return pythonEnvironment.installDependencies();
  });

  ipc.handle('install-portable-python', async () => {
    return pythonEnvironment.installPortablePython();
  });
}
