/**
 * 向 Renderer 暴露迁移冲突清单及受限处理入口。
 */
import type {
  MigrationConflictService,
} from '../services/MigrationConflictService';
import type { IpcRegistrar } from './IpcRegistrar';

/** 注册迁移冲突读取和确认处理 IPC。 */
export function registerMigrationConflictIpc(
  ipc: IpcRegistrar,
  conflicts: MigrationConflictService,
): void {
  ipc.handle('get-migration-conflicts', () => conflicts.pending());
  ipc.handle(
    'resolve-migration-conflicts',
    (_event, keepIds: unknown) => conflicts.resolve(keepIds),
  );
}
