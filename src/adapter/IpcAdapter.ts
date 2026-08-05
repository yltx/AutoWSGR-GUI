/** 编队规划页使用的最小 Electron IPC 仓储。 */
import type {
  FleetPlanSource,
  FleetShipLibrary,
  FleetTeamPlan,
  FleetTeamPlanListResult,
  FleetTeamPlanSaveResult,
} from '../types/fleet.js';
import {
  toFleetShipLibrary,
  toFleetTeamPlanListResult,
  toFleetTeamPlanSaveResult,
  toUserTeamPlanDto,
} from './FleetPlannerDtoAdapter.js';

export interface FleetPlannerRepository {
  getShipLibrary(): Promise<FleetShipLibrary>;
  saveUserTeamPlan(
    plan: FleetTeamPlan,
    overwrite?: boolean,
    currentFile?: string,
    currentSource?: FleetPlanSource,
  ): Promise<FleetTeamPlanSaveResult>;
  listTeamPlans(): Promise<FleetTeamPlanListResult>;
}

function requireBridge(): NonNullable<typeof window.electronBridge> {
  const bridge = window.electronBridge;
  if (!bridge) throw new Error('当前环境无法访问 Electron IPC');
  return bridge;
}

export const fleetPlannerRepository: FleetPlannerRepository = {
  async getShipLibrary(): Promise<FleetShipLibrary> {
    return toFleetShipLibrary(
      await requireBridge().getShipLibraryManifest(),
    );
  },

  async saveUserTeamPlan(
    plan: FleetTeamPlan,
    overwrite = false,
    currentFile?: string,
    currentSource?: FleetPlanSource,
  ): Promise<FleetTeamPlanSaveResult> {
    return toFleetTeamPlanSaveResult(
      await requireBridge().saveUserTeamPlan(
        toUserTeamPlanDto(plan),
        overwrite,
        currentFile,
        currentSource,
      ),
    );
  },

  async listTeamPlans(): Promise<FleetTeamPlanListResult> {
    return toFleetTeamPlanListResult(
      await requireBridge().listTeamPlans(),
    );
  },
};
