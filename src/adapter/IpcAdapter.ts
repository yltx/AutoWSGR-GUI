/** 封装 Electron IPC 文件与计划操作，提供 Renderer 侧仓储接口。 */
import type {
  DecisivePlanSettings,
  ElectronBridge,
  ShipLibraryManifest,
} from '../types/ipc.js';

export interface RendererIpc {
  readonly bridge: ElectronBridge;
}

export function getRendererIpc(): RendererIpc {
  const bridge = window.electronBridge;
  if (!bridge) throw new Error('Electron IPC bridge 不可用');
  return { bridge };
}

export type ManagedCombatPlanRepository = Partial<Pick<
  ElectronBridge,
  | 'getShipLibraryManifest'
  | 'getPlanManagement'
  | 'importLocalCombatPlan'
  | 'readManagedCombatPlan'
  | 'saveManagedCombatPlan'
>>;

export function getManagedCombatPlanRepository(
): ManagedCombatPlanRepository | undefined {
  return window.electronBridge;
}

export type TaskGroupRepository = Partial<Pick<
  ElectronBridge,
  | 'getShipLibraryManifest'
  | 'getPlanManagement'
  | 'listDailyPlans'
  | 'readDailyPlan'
  | 'readManagedCombatPlan'
  | 'readCombatPlanFile'
  | 'readFile'
  | 'saveFile'
  | 'openFileDialog'
>>;

export function getTaskGroupRepository(
): TaskGroupRepository | undefined {
  return window.electronBridge;
}

export type TemplateRepository = Pick<
  ElectronBridge,
  'listPlanFiles' | 'openFileDialog' | 'readFile'
>;

export function getTemplateRepository(
): TemplateRepository | undefined {
  return window.electronBridge;
}

export type SettingsGateway = Pick<
  ElectronBridge,
  | 'checkAdbDevices'
  | 'checkBackendUpdates'
  | 'checkGuiUpdates'
  | 'connectAdbDevice'
  | 'disconnectAdbDevice'
  | 'getShipLibraryStatus'
  | 'getUpdateMode'
  | 'onBackendUpdateStatus'
  | 'onShipLibraryUpdateProgress'
  | 'onUpdateStatus'
  | 'openDirectoryDialog'
  | 'openFileDialog'
  | 'openFolder'
  | 'prepareBackendUpdate'
  | 'readManagedCombatPlan'
  | 'updateShipLibrary'
  | 'validateCudaPath'
  | 'validatePython'
>;

export function getSettingsGateway(): SettingsGateway | undefined {
  return window.electronBridge;
}

export type NavigationGateway = Pick<
  ElectronBridge,
  'getWindowPreferences' | 'rememberActivePage'
>;

export function getNavigationGateway(): NavigationGateway | undefined {
  return window.electronBridge;
}

export type AppRuntimeGateway = Pick<
  ElectronBridge,
  'getAppVersion' | 'getBackendPort' | 'getGuiLogRoot'
>;

export function getAppRuntimeGateway(): AppRuntimeGateway | undefined {
  return window.electronBridge;
}

export type StartupGateway = Pick<
  ElectronBridge,
  | 'appendGuiLog'
  | 'autoCheckBackendUpdates'
  | 'checkEnvironment'
  | 'checkGuiUpdates'
  | 'getAppRoot'
  | 'getBackendStartupMode'
  | 'getConfigDir'
  | 'getPlansDir'
  | 'getUpdateMode'
  | 'installDeps'
  | 'installPortablePython'
  | 'onBackendLog'
  | 'onSetupLog'
  | 'onUpdateStatus'
  | 'readFile'
  | 'runSetup'
  | 'saveFile'
  | 'startBackend'
>;

export function getStartupGateway(): StartupGateway | undefined {
  return window.electronBridge;
}

export type ConfigurationGateway = Pick<
  ElectronBridge,
  | 'checkAdbDevices'
  | 'commitGuiSettings'
  | 'detectEmulator'
  | 'getBackendPort'
  | 'getGuiLogRoot'
  | 'getBackendRepoPath'
  | 'getBackendStartupMode'
  | 'getBackendUpdateMode'
  | 'getCudaPath'
  | 'getGuiAutomationSettings'
  | 'getAllowTestUpdates'
  | 'getOcrGpuMode'
  | 'getPythonPath'
  | 'getSaveBackendScreenshots'
  | 'getUpdateMode'
  | 'getWindowPreferences'
  | 'migrateLegacyDecisiveAutomation'
  | 'readFile'
  | 'saveFile'
  | 'setGuiAutomationSettings'
  | 'setPythonPath'
>;

export function getConfigurationGateway(
): ConfigurationGateway | undefined {
  return window.electronBridge;
}

export type ScheduledTaskRepository = Pick<
  ElectronBridge,
  | 'getDecisivePlanSettings'
  | 'getShipLibraryManifest'
  | 'readManagedCombatPlan'
  | 'readCombatPlanFile'
  | 'readFile'
>;

export function getScheduledTaskRepository(
): ScheduledTaskRepository | undefined {
  return window.electronBridge;
}

export type MigrationConflictRepository = Partial<Pick<
  ElectronBridge,
  | 'getMigrationConflicts'
  | 'resolveMigrationConflicts'
>>;

export function getMigrationConflictRepository(
): MigrationConflictRepository | undefined {
  return window.electronBridge;
}

export type FileRepository = Pick<ElectronBridge, 'readFile' | 'saveFile' | 'appendFile'>;

export const rendererFileRepository: FileRepository = {
  readFile(path: string): Promise<string> {
    return getRendererIpc().bridge.readFile(path);
  },

  saveFile(path: string, content: string): Promise<void> {
    return getRendererIpc().bridge.saveFile(path, content);
  },

  appendFile(path: string, content: string): Promise<void> {
    return getRendererIpc().bridge.appendFile(path, content);
  },
};

export interface MapDataRepository {
  read(path: string): Promise<string>;
}

export function createMapDataRepository(
  files: FileRepository = rendererFileRepository,
): MapDataRepository {
  return {
    read(path: string): Promise<string> {
      return files.readFile(path);
    },
  };
}

export const mapDataRepository = createMapDataRepository();

export interface DecisivePlanRepository {
  loadSettings(): Promise<DecisivePlanSettings>;
  loadChapter(chapter: number): Promise<DecisivePlanSettings>;
  loadSystemDefaults(chapter: number): Promise<DecisivePlanSettings>;
  saveSettings(
    settings: DecisivePlanSettings,
  ): Promise<DecisivePlanSettings>;
  loadShipLibrary(): Promise<ShipLibraryManifest>;
}

export const decisivePlanRepository: DecisivePlanRepository = {
  async loadSettings(): Promise<DecisivePlanSettings> {
    const lastSaved = await getRendererIpc()
      .bridge
      .getDecisivePlanSettings();
    return getRendererIpc().bridge.getDailyDecisivePlan(
      lastSaved.chapter,
    );
  },

  loadChapter(chapter: number): Promise<DecisivePlanSettings> {
    return getRendererIpc().bridge.getDailyDecisivePlan(chapter);
  },

  loadSystemDefaults(chapter: number): Promise<DecisivePlanSettings> {
    return getRendererIpc().bridge.getSystemDailyDecisivePlan(chapter);
  },

  saveSettings(
    settings: DecisivePlanSettings,
  ): Promise<DecisivePlanSettings> {
    return getRendererIpc().bridge.saveDailyDecisivePlan(settings);
  },

  loadShipLibrary(): Promise<ShipLibraryManifest> {
    return getRendererIpc().bridge.getShipLibraryManifest();
  },
};

export type FleetPlannerRepository = Pick<
  ElectronBridge,
  | 'getShipLibraryManifest'
  | 'saveUserTeamPlan'
  | 'listTeamPlans'
  | 'getPlanManagement'
  | 'exportUserPlans'
  | 'exportLegacy143Plans'
  | 'setPlanUnlinkedIgnored'
  | 'renameUserCombatPlan'
  | 'deleteUserCombatPlan'
  | 'deleteUserTeamPlan'
>;

export const fleetPlannerRepository: FleetPlannerRepository = {
  getShipLibraryManifest() {
    return getRendererIpc().bridge.getShipLibraryManifest();
  },

  saveUserTeamPlan(plan, overwrite, currentFile, source) {
    return getRendererIpc().bridge.saveUserTeamPlan(
      plan,
      overwrite,
      currentFile,
      source,
    );
  },

  listTeamPlans() {
    return getRendererIpc().bridge.listTeamPlans();
  },

  getPlanManagement() {
    return getRendererIpc().bridge.getPlanManagement();
  },

  exportUserPlans(selections) {
    return getRendererIpc().bridge.exportUserPlans(selections);
  },

  exportLegacy143Plans(selections) {
    return getRendererIpc().bridge.exportLegacy143Plans(selections);
  },

  setPlanUnlinkedIgnored(kind, source, file, ignored) {
    return getRendererIpc().bridge.setPlanUnlinkedIgnored(
      kind,
      source,
      file,
      ignored,
    );
  },

  renameUserCombatPlan(file, newName) {
    return getRendererIpc().bridge.renameUserCombatPlan(file, newName);
  },

  deleteUserCombatPlan(file) {
    return getRendererIpc().bridge.deleteUserCombatPlan(file);
  },

  deleteUserTeamPlan(file) {
    return getRendererIpc().bridge.deleteUserTeamPlan(file);
  },
};
