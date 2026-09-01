/**
 * 连接作战计划 IPC、文件对话框和计划服务。
 */
import type {
  MessageBoxOptions,
  OpenDialogOptions,
  SaveDialogOptions,
} from 'electron';
import type { PlanManagementService } from '../services/PlanManagementService';
import type { PlanExportService } from '../services/PlanExportService';
import type { SafePathService } from '../services/SafePathService';
import type { PlanPresetSource } from '../services/TeamPlanCodec';
import type { IpcRegistrar } from './IpcRegistrar';

export interface CombatPlanDialogAdapter {
  showOpenDialog(options: OpenDialogOptions): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
  showMessageBox(options: MessageBoxOptions): Promise<{
    response: number;
  }>;
  showSaveDialog(options: SaveDialogOptions): Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
}

export interface CombatPlanIpcDependencies {
  dialog: CombatPlanDialogAdapter;
  safePaths: SafePathService;
  plans: PlanManagementService;
  planExports: PlanExportService;
}

/** 注册作战计划管理和运行时准备 IPC。 */
export function registerCombatPlanIpc(
  ipc: IpcRegistrar,
  dependencies: CombatPlanIpcDependencies,
): void {
  ipc.handle('get-plan-management', () => {
    return dependencies.plans.get();
  });

  ipc.handle('export-user-plans', async (_event, selections: unknown) => {
    try {
      const archive = await dependencies.planExports.createArchive(
        selections,
      );
      const selected = await dependencies.dialog.showSaveDialog({
        title: '批量导出用户配置',
        defaultPath: dependencies.planExports.archiveFileName(),
        filters: [{
          name: 'ZIP 压缩包',
          extensions: ['zip'],
        }],
      });
      if (selected.canceled || !selected.filePath) {
        return { success: false, canceled: true };
      }
      dependencies.planExports.writeArchive(selected.filePath, archive);
      return {
        success: true,
        path: selected.filePath,
        count: archive.count,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipc.handle('export-legacy-143-plans', async (_event, selections: unknown) => {
    try {
      const archive = await dependencies.planExports.createLegacy143Archive(
        selections,
      );
      const selected = await dependencies.dialog.showSaveDialog({
        title: '导出 1.4.3 降级计划备份',
        defaultPath: 'AutoWSGR-GUI-1.4.3-plans-backup.zip',
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });
      if (selected.canceled || !selected.filePath) {
        return { success: false, canceled: true };
      }
      dependencies.planExports.writeArchive(selected.filePath, archive);
      return {
        success: true,
        path: selected.filePath,
        count: archive.count,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipc.handle('import-local-combat-plan', async () => {
    try {
      const selected = await dependencies.dialog.showOpenDialog({
        title: '添加本地出征计划',
        properties: ['openFile'],
        filters: [{
          name: '出征计划 YAML',
          extensions: ['yaml', 'yml'],
        }],
      });
      if (selected.canceled || selected.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const selectedPath = selected.filePaths[0];
      const result = dependencies.plans.importLocal(
        selectedPath,
        false,
      );
      if (result.exists !== true) return result;

      const conflicts = Array.isArray(result.conflicts)
        ? result.conflicts.filter(
          (value): value is string => typeof value === 'string',
        )
        : [];
      const confirmation = await dependencies.dialog.showMessageBox({
        type: 'warning',
        title: '覆盖用户配置',
        message: '导入目标存在同名配置，是否覆盖？',
        detail: conflicts.join('\n'),
        buttons: ['取消', '覆盖'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) {
        return { success: false, canceled: true };
      }
      return dependencies.plans.importLocal(selectedPath, true);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipc.handle(
    'set-plan-unlinked-ignored',
    (
      _event,
      kind: 'battle' | 'team',
      source: PlanPresetSource,
      file: string,
      ignored: boolean,
    ) => {
      return dependencies.plans.setUnlinkedIgnored(
        kind,
        source,
        file,
        ignored,
      );
    },
  );

  ipc.handle(
    'read-managed-combat-plan',
    (_event, source: PlanPresetSource, file: string) => {
      return dependencies.plans.readManaged(source, file);
    },
  );

  ipc.handle(
    'read-combat-plan-file',
    (_event, rawPath: string) => {
      try {
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
          throw new Error('出征计划路径不能为空');
        }
        const resolved = dependencies.safePaths.resolveAppPath(
          rawPath,
        );
        return dependencies.plans.readResolvedFile(resolved);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error
            ? error.message
            : String(error),
        };
      }
    },
  );

  ipc.handle(
    'prepare-combat-plan-execution',
    (_event, content: string, hint: string) => {
      return dependencies.plans.prepareExecution(content, hint);
    },
  );

  ipc.handle(
    'save-managed-combat-plan',
    (
      _event,
      rawName: string,
      content: string,
      overwrite: boolean,
      currentFile?: string,
    ) => {
      return dependencies.plans.saveManaged(
        rawName,
        content,
        overwrite,
        currentFile,
      );
    },
  );

  ipc.handle(
    'rename-user-combat-plan',
    (_event, file: string, newName: string) => {
      return dependencies.plans.renameUser(file, newName);
    },
  );

  ipc.handle(
    'delete-user-combat-plan',
    (_event, file: string) => {
      return dependencies.plans.deleteUserCombat(file);
    },
  );

  ipc.handle(
    'delete-user-team-plan',
    (_event, file: string) => {
      return dependencies.plans.deleteUserTeam(file);
    },
  );
}
