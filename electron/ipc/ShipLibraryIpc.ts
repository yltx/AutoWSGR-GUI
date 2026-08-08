/**
 * 连接舰船资料库 IPC 与查询、更新服务。
 */
import type {
  ShipLibraryService,
  ShipLibraryStatus,
} from '../services/ShipLibraryService';
import type { ShipLibraryUpdater } from '../services/ShipLibraryUpdater';
import type { IpcRegistrar } from './IpcRegistrar';

export interface ShipLibraryIpcDependencies {
  library: ShipLibraryService;
  updater: ShipLibraryUpdater;
  getStatus?(): ShipLibraryStatus | Promise<ShipLibraryStatus>;
}

/** 注册舰船资料库读取和更新 IPC。 */
export function registerShipLibraryIpc(
  ipc: IpcRegistrar,
  dependencies: ShipLibraryIpcDependencies,
): void {
  ipc.handle('get-ship-library-status', async () => {
    if (dependencies.getStatus) return await dependencies.getStatus();
    return dependencies.library.getStatus();
  });

  ipc.handle('get-ship-library-manifest', () => {
    return dependencies.library.getManifest();
  });

  ipc.handle('update-ship-library', async (_event, target?: unknown) => {
    if (target === 'backend') {
      return await dependencies.updater.syncBackend();
    }
    return await dependencies.updater.update();
  });
}
