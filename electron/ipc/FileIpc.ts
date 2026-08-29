/**
 * 连接文件、路径和目录 IPC 与安全文件服务。
 */
import * as fs from 'fs';
import type { FileFilter } from 'electron';
import type { CombatPlanRepository } from '../services/CombatPlanRepository';
import type { GuiLogService } from '../services/GuiLogService';
import type { SafePathService } from '../services/SafePathService';
import type { SecureFileService } from '../services/SecureFileService';
import type { IpcRegistrar } from './IpcRegistrar';

export interface FileDialogAdapter {
  showOpenDialog(options: {
    properties: Array<'openFile' | 'openDirectory'>;
    title?: string;
    defaultPath?: string;
    filters?: FileFilter[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: {
    defaultPath?: string;
    filters?: FileFilter[];
  }): Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
}

export interface FolderAdapter {
  openPath(folderPath: string): Promise<string>;
}

export interface FileIpcDependencies {
  dialog: FileDialogAdapter;
  shell: FolderAdapter;
  guiLogs: GuiLogService;
  secureFiles: SecureFileService;
  safePaths: SafePathService;
  combatPlans: CombatPlanRepository;
  appRoot(): string;
  userDataRoot(): string;
}

/** 注册文件、路径和目录相关 IPC。 */
export function registerFileIpc(
  ipc: IpcRegistrar,
  dependencies: FileIpcDependencies,
): void {
  ipc.handle('open-directory-dialog', async (_event, title?: string) => {
    const result = await dependencies.dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: title || '选择文件夹',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipc.handle(
    'open-file-dialog',
    async (
      _event,
      filters: FileFilter[],
      defaultDir?: string,
    ) => {
      const result = await dependencies.dialog.showOpenDialog({
        properties: ['openFile'],
        defaultPath: defaultDir || undefined,
        filters,
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const filePath = result.filePaths[0];
      const content = dependencies.secureFiles.readSelectedFile(
        filePath,
      );
      return { path: filePath, content };
    },
  );

  ipc.handle(
    'save-file',
    async (_event, filePath: string, content: string) => {
      dependencies.secureFiles.save(filePath, content);
    },
  );

  ipc.handle(
    'save-file-dialog',
    async (
      _event,
      defaultName: string,
      content: string,
      filters: FileFilter[],
    ) => {
      const result = await dependencies.dialog.showSaveDialog({
        defaultPath: defaultName,
        filters,
      });
      if (result.canceled || !result.filePath) return null;
      dependencies.secureFiles.writeSelectedFile(
        result.filePath,
        content,
      );
      return result.filePath;
    },
  );

  ipc.handle('read-file', async (_event, filePath: string) => {
    return dependencies.secureFiles.read(filePath);
  });

  ipc.handle(
    'append-file',
    async (_event, filePath: string, content: string) => {
      dependencies.secureFiles.append(filePath, content);
    },
  );

  ipc.handle('append-gui-log', async (_event, content: string) => {
    dependencies.guiLogs.append(content);
  });

  ipc.handle('get-app-root', () => dependencies.appRoot());

  ipc.handle('get-plans-dir', () => {
    return dependencies.combatPlans.directory('user');
  });

  ipc.handle('list-plan-files', () => {
    return dependencies.combatPlans.listUserFiles();
  });

  ipc.handle('get-config-dir', () => dependencies.userDataRoot());

  ipc.handle(
    'open-folder',
    async (_event, folderPath: string) => {
      const resolved = dependencies.safePaths.resolveWritablePath(
        folderPath,
      );
      if (fs.existsSync(resolved)) {
        await dependencies.shell.openPath(resolved);
      }
    },
  );
}
