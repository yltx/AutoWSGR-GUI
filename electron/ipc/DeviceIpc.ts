/**
 * 连接模拟器和 ADB 设备 IPC。
 */
import type { AdbService } from '../services/AdbService';
import type { IpcRegistrar } from './IpcRegistrar';

export interface DeviceIpcDependencies {
  adb: AdbService;
  detectEmulator(): unknown;
}

/** 注册模拟器检测和 ADB 设备操作 IPC。 */
export function registerDeviceIpc(
  ipc: IpcRegistrar,
  dependencies: DeviceIpcDependencies,
): void {
  ipc.handle('detect-emulator', async () => {
    return dependencies.detectEmulator();
  });

  ipc.handle('check-adb-devices', async () => {
    try {
      return await dependencies.adb.listDevices();
    } catch (error) {
      console.warn('[ADB] 设备查询失败:', error);
      return [];
    }
  });

  ipc.handle(
    'connect-adb-device',
    async (_event, serial: string) => {
      return dependencies.adb.runDeviceCommand('connect', serial);
    },
  );

  ipc.handle(
    'disconnect-adb-device',
    async (_event, serial: string) => {
      return dependencies.adb.runDeviceCommand('disconnect', serial);
    },
  );
}
