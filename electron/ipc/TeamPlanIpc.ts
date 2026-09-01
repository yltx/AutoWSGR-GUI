/**
 * 连接编队计划 IPC、文件对话框和编队服务。
 */
import type { PlanPresetSource } from '../services/TeamPlanCodec';
import type { TeamPlanRepository } from '../services/TeamPlanRepository';
import type { TeamPlanService } from '../services/TeamPlanService';
import type { FileDialogAdapter } from './FileIpc';
import type { IpcRegistrar } from './IpcRegistrar';

export interface TeamPlanIpcDependencies {
  dialog: FileDialogAdapter;
  repository: TeamPlanRepository;
  service: TeamPlanService;
}

/** 注册编队保存、选择和列表 IPC。 */
export function registerTeamPlanIpc(
  ipc: IpcRegistrar,
  dependencies: TeamPlanIpcDependencies,
): void {
  ipc.handle(
    'save-user-team-plan',
    (
      _event,
      rawPlan: unknown,
      overwrite: boolean,
      currentFile?: string,
      rawSource?: PlanPresetSource,
    ) => {
      return dependencies.service.save(
        rawPlan,
        overwrite,
        currentFile,
        rawSource,
      );
    },
  );

  ipc.handle('pick-user-team-plan', async () => {
    const directory = dependencies.repository.directory('user');
    const result = await dependencies.dialog.showOpenDialog({
      title: '加载编队预设',
      defaultPath: directory,
      properties: ['openFile'],
      filters: [{
        name: '编队 YAML',
        extensions: ['yaml', 'yml'],
      }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return dependencies.service.loadSelected(result.filePaths[0]);
  });

  ipc.handle('list-team-plans', () => {
    return dependencies.service.list();
  });
}
