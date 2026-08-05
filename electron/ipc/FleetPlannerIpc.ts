/** 注册舰队规划所需的窄 IPC 用例。 */
import type { IpcMain } from 'electron';

import type { PlanPresetSource } from '../../src/types/ipc.js';
import { BundledShipLibraryService } from '../services/BundledShipLibraryService.js';
import { TeamPlanService } from '../services/TeamPlanService.js';

export interface FleetPlannerIpcDependencies {
  shipLibrary: BundledShipLibraryService;
  teamPlans: TeamPlanService;
}

/** Renderer 只能访问只读资料库和受管编队目录，不能传入任意路径。 */
export function registerFleetPlannerIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  dependencies: FleetPlannerIpcDependencies,
): void {
  ipcMain.handle('fleet-planner:get-ship-library', () => (
    dependencies.shipLibrary.getManifest()
  ));

  ipcMain.handle(
    'fleet-planner:save-team-plan',
    (
      _event,
      plan: unknown,
      overwrite = false,
      currentFile?: string,
      currentSource?: PlanPresetSource,
    ) => dependencies.teamPlans.save(
      plan,
      overwrite,
      currentFile,
      currentSource,
    ),
  );

  ipcMain.handle('fleet-planner:list-team-plans', () => (
    dependencies.teamPlans.list()
  ));
}
