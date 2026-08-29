/** 定义 Renderer 与 Electron 主进程之间的桥接方法、文件结果和资源契约。 */

import type {
  BattleResultGrade,
  GuiAutomationSettings,
  TaskPreset,
} from './model.js';
import type {
  LegacyDecisiveAutomationSettings,
} from '../shared/legacyDecisiveAutomation.js';
import type {
  DecisivePlanSettings,
} from '../shared/decisivePlan.js';
import type {
  MigrationConflictListResult,
  MigrationConflictResolutionResult,
} from '../shared/migrationConflicts.js';

export type { GuiAutomationSettings } from './model.js';
export type {
  LegacyDecisiveAutomationSettings,
} from '../shared/legacyDecisiveAutomation.js';
export type {
  DecisivePlanSettings,
} from '../shared/decisivePlan.js';

export interface WindowPreferences {
  defaultWidth: number;
  defaultHeight: number;
  rememberBounds: boolean;
  lastActivePage: string;
}

export interface GuiSettingsCommitRequest {
  updateMode: 'auto' | 'manual';
  backendUpdateMode: 'auto' | 'manual';
  allowTestUpdates: boolean;
  backendPort: number;
  backendStartupMode: 'managed' | 'external';
  backendRepoPath: string | null;
  ocrGpuMode: 'auto' | 'cpu' | 'cuda';
  cudaPath: string | null;
  saveBackendScreenshots: boolean;
  pythonPath: string | null;
  guiLogRoot: string;
  windowPreferences: Omit<WindowPreferences, 'lastActivePage'>;
  automation: GuiAutomationSettings;
  usersettingsYaml: string;
}

export interface GuiSettingsCommitResult {
  automation: GuiAutomationSettings;
  windowPreferences: WindowPreferences;
}

export interface AdbOperationResult {
  success: boolean;
  serial: string;
  status: string;
  message: string;
}

export interface CudaValidationResult {
  valid: boolean;
  path: string;
  version: string | null;
  kind?: 'toolkit' | 'runtime';
  torchVersion?: string | null;
  device?: string | null;
  error?: string;
}

export type GuiUpdateStatus =
  | {
      status: 'checking';
    }
  | {
      status: 'available';
      version: string;
      releaseNotes?: string;
    }
  | {
      status: 'up-to-date';
    }
  | {
      status: 'downloading';
    }
  | {
      status: 'downloaded';
      version: string;
    }
  | {
      status: 'deferred';
      version: string;
    }
  | {
      status: 'installing' | 'error';
      message: string;
    };

export type BackendUpdateCheckResult =
  | { status: 'available'; commit: string }
  | { status: 'up-to-date'; commit: string }
  | { status: 'error'; message: string };

export type BackendUpdateStatus =
  | { status: 'checking' }
  | { status: 'available'; commit: string }
  | { status: 'up-to-date' }
  | { status: 'downloading'; progress: number }
  | { status: 'downloaded'; commit: string }
  | { status: 'deferred'; commit: string }
  | { status: 'error'; message: string };

export type PlanPresetSource = 'system' | 'user';
export type DailyPlanType = 'exercise' | 'campaign' | 'decisive';

export interface UserTeamShipRule {
  name: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  relaxed?: boolean;
}

export interface UserTeamPlanSlot {
  name?: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  relaxed?: boolean;
  candidates?: UserTeamShipRule[];
}

export interface UserTeamPlan {
  file?: string;
  modifiedAt?: number;
  source?: PlanPresetSource;
  name: string;
  ships: UserTeamPlanSlot[];
}

export interface UserTeamPlanResult {
  success: boolean;
  canceled?: boolean;
  exists?: boolean;
  file?: string;
  plan?: UserTeamPlan;
  renamedFrom?: string;
  updatedBattlePlans?: number;
  error?: string;
}

export interface UserTeamPlanListResult {
  plans: UserTeamPlan[];
  errors: PlanFileReadError[];
}

export interface PlanTeamBinding {
  planFile: string;
  planName: string;
  source: PlanPresetSource;
  teamName: string | null;
}

export interface ManagedTeamPlan {
  file: string;
  name: string;
  source: PlanPresetSource;
}

export interface ManagedBattlePlanFleet {
  name: string;
  source: PlanPresetSource | 'deleted';
  primaryCount: number;
  backupCount: number;
}

export interface ManagedBattlePlan {
  kind: 'battle' | 'preset';
  file: string;
  name: string;
  source: PlanPresetSource;
  modifiedAt: number;
  chapter: number | string;
  map: number | string;
  times: number;
  gap: number;
  fleetId: number;
  repairMode: number | number[];
  result: BattleResultGrade | null;
  lootCountGe: number;
  shipCountGe: number;
  fleetCount: number;
  nodeCount: number;
  fleets: ManagedBattlePlanFleet[];
  taskType?: TaskPreset['task_type'];
  campaignName?: string;
}

export interface ManagedBattlePlanSelection {
  plan: ManagedBattlePlan;
  fleetPresetIndex?: number;
  /** 仅用于自动出征：该计划每日最多完成的有效轮数。 */
  dailyMaxExecutions?: number;
}

export interface ManagedDailyPlan {
  source: PlanPresetSource;
  file: string;
  name: string;
  taskType: DailyPlanType;
  times: number;
  fleetId?: number;
  campaignName?: string;
  chapter?: number;
  useQuickRepair?: boolean;
}

export interface DailyPlanListResult {
  plans: ManagedDailyPlan[];
  errors: Array<{
    source: PlanPresetSource;
    file: string;
    message: string;
  }>;
}

export interface DailyPlanSelection {
  plan: ManagedDailyPlan;
  times: number;
  useQuickRepair?: boolean;
}

export interface PlanFileReadError {
  file: string;
  source: PlanPresetSource;
  kind: 'battle' | 'team';
  message: string;
}

export interface PlanManagementResult {
  bindings: PlanTeamBinding[];
  battlePlans: ManagedBattlePlan[];
  teamPlans: ManagedTeamPlan[];
  errors: PlanFileReadError[];
  ignoredUnlinkedPlans: string[];
}

export interface UserPlanExportSelection {
  kind: 'battle' | 'team';
  file: string;
}

export interface UserPlanExportResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  count?: number;
  error?: string;
}

export interface PlanFileOperationResult {
  success: boolean;
  kind?: 'battle' | 'preset' | 'daily';
  canceled?: boolean;
  exists?: boolean;
  file?: string;
  path?: string;
  sourcePath?: string;
  runtimePath?: string;
  content?: string;
  source?: PlanPresetSource;
  teamFiles?: string[];
  missingTeamNames?: string[];
  conflicts?: string[];
  error?: string;
}

export interface ShipLibraryStatus {
  exists: boolean;
  path: string;
  generatedAt?: string;
  shipCount: number;
  assetCount: number;
  missingAssets: number;
  backendSynchronized?: boolean;
  backendMissingRecords?: number;
  backendMissingAliases?: number;
  backendError?: string;
  error?: string;
}

export type ShipLibraryUpdateTarget = 'wiki' | 'backend';

export interface ShipLibraryUpdateResult {
  success: boolean;
  output?: string;
  generated_at?: string;
  ship_count?: number;
  asset_count?: number;
  added?: number;
  updated?: number;
  removed?: number;
  downloaded?: number;
  failed?: number;
  failures?: string[];
  shipnames_sync_error?: string;
  error?: string;
}

export interface ShipLibraryLabels {
  locale?: string;
  ship_types: Record<string, string>;
  size_classes: Record<string, string>;
  role_classes: Record<string, string>;
  countries: Record<string, string>;
  variants: Record<string, string>;
}

export interface ShipLibraryShip {
  id: number;
  name: string;
  search_name: string;
  variant: 'normal' | 'refit' | 'special';
  rarity: number;
  ship_type: string;
  size_class: string;
  role_class: string;
  country: string;
  portraitUrl: string;
  backgroundUrl: string;
  frameUrl: string;
  typeIconUrl: string;
  wiki_url?: string;
}

export interface ShipLibraryManifest {
  schemaVersion: number;
  generatedAt: string;
  labels: ShipLibraryLabels;
  typeGroups: {
    size_classes: Record<string, string[]>;
    role_classes: Record<string, string[]>;
  };
  ships: ShipLibraryShip[];
}

export interface ElectronBridge {
  openDirectoryDialog: (title?: string) => Promise<string | null>;
  openFileDialog: (
    filters: { name: string; extensions: string[] }[],
    defaultDir?: string,
  ) => Promise<{ path: string; content: string } | null>;
  saveFile: (path: string, content: string) => Promise<void>;
  saveFileDialog: (
    defaultName: string,
    content: string,
    filters: { name: string; extensions: string[] }[],
  ) => Promise<string | null>;
  readFile: (path: string) => Promise<string>;
  appendFile: (path: string, content: string) => Promise<void>;
  appendGuiLog: (content: string) => Promise<void>;
  detectEmulator: () => Promise<{
    type: string;
    path: string;
    serial: string;
    adbPath: string;
  } | null>;
  checkAdbDevices: () => Promise<{ serial: string; status: string }[]>;
  connectAdbDevice: (serial: string) => Promise<AdbOperationResult>;
  disconnectAdbDevice: (serial: string) => Promise<AdbOperationResult>;
  getAppRoot: () => Promise<string>;
  getPlansDir: () => Promise<string>;
  getConfigDir: () => Promise<string>;
  listPlanFiles: () => Promise<{ name: string; file: string }[]>;
  openFolder: (folderPath: string) => Promise<void>;
  checkEnvironment: () => Promise<{
    pythonCmd: string | null;
    pythonVersion: string | null;
    missingPackages: string[];
    allReady: boolean;
  }>;
  installDeps: () => Promise<{ success: boolean; output: string }>;
  startBackend: () => Promise<{ success: boolean; message: string }>;
  runSetup: () => Promise<{ success: boolean; output: string }>;
  installPortablePython: () => Promise<{ success: boolean }>;
  checkGuiUpdates: () => Promise<
    | { status: 'available'; version: string }
    | { status: 'up-to-date' }
    | { status: 'error'; message: string }
  >;
  onUpdateStatus: (
    callback: (status: GuiUpdateStatus) => void,
  ) => void;
  checkBackendUpdates: () => Promise<BackendUpdateCheckResult>;
  autoCheckBackendUpdates: () => Promise<void>;
  prepareBackendUpdate: (commit: string) => Promise<void>;
  onBackendUpdateStatus: (
    callback: (status: BackendUpdateStatus) => void,
  ) => void;
  onBackendLog: (callback: (line: string) => void) => void;
  onSetupLog: (callback: (text: string) => void) => void;
  getAppVersion: () => string;
  getBackendPort: () => number;
  getGuiLogRoot: () => string;
  setBackendPort: (port: number) => Promise<void>;
  getGuiAutomationSettings: () => Promise<{
    exists: boolean;
    settings: Partial<GuiAutomationSettings>;
  }>;
  setGuiAutomationSettings: (
    settings: GuiAutomationSettings,
  ) => Promise<GuiAutomationSettings>;
  commitGuiSettings: (
    request: GuiSettingsCommitRequest,
  ) => Promise<GuiSettingsCommitResult>;
  migrateLegacyDecisiveAutomation: (
    settings: LegacyDecisiveAutomationSettings,
  ) => Promise<LegacyDecisiveAutomationSettings>;
  getDecisivePlanSettings: () => Promise<DecisivePlanSettings>;
  setDecisivePlanSettings: (
    settings: DecisivePlanSettings,
  ) => Promise<DecisivePlanSettings>;
  getBackendStartupMode: () => 'managed' | 'external';
  setBackendStartupMode: (
    mode: 'managed' | 'external',
  ) => Promise<void>;
  getBackendRepoPath: () => string;
  setBackendRepoPath: (
    repoPath: string | null,
  ) => Promise<void>;
  getOcrGpuMode: () => 'auto' | 'cpu' | 'cuda';
  setOcrGpuMode: (
    mode: 'auto' | 'cpu' | 'cuda',
  ) => Promise<void>;
  getCudaPath: () => string;
  setCudaPath: (cudaPath: string | null) => Promise<void>;
  validateCudaPath: (
    cudaPath: string,
  ) => Promise<CudaValidationResult>;
  getSaveBackendScreenshots: () => boolean;
  setSaveBackendScreenshots: (enabled: boolean) => Promise<void>;
  getWindowPreferences: () => WindowPreferences;
  setWindowPreferences: (
    preferences: Omit<WindowPreferences, 'lastActivePage'>,
  ) => Promise<WindowPreferences>;
  rememberActivePage: (pageId: string) => Promise<void>;
  getUpdateMode: () => 'auto' | 'manual';
  getBackendUpdateMode: () => 'auto' | 'manual';
  getAllowTestUpdates?: () => boolean;
  setUpdateMode: (mode: 'auto' | 'manual') => Promise<void>;
  getShipLibraryStatus: () => Promise<ShipLibraryStatus>;
  getShipLibraryManifest: () => Promise<ShipLibraryManifest>;
  updateShipLibrary: (
    target?: ShipLibraryUpdateTarget,
  ) => Promise<ShipLibraryUpdateResult>;
  onShipLibraryUpdateProgress: (
    callback: (progress: { message: string }) => void,
  ) => void;
  saveUserTeamPlan: (
    plan: UserTeamPlan,
    overwrite?: boolean,
    currentFile?: string,
    source?: PlanPresetSource,
  ) => Promise<UserTeamPlanResult>;
  pickUserTeamPlan: () => Promise<UserTeamPlanResult>;
  listTeamPlans: () => Promise<UserTeamPlanListResult>;
  getPlanManagement: () => Promise<PlanManagementResult>;
  listDailyPlans: () => Promise<DailyPlanListResult>;
  readDailyPlan: (
    source: PlanPresetSource,
    file: string,
  ) => Promise<PlanFileOperationResult>;
  getDailyDecisivePlan: (
    chapter: number,
  ) => Promise<DecisivePlanSettings>;
  getSystemDailyDecisivePlan: (
    chapter: number,
  ) => Promise<DecisivePlanSettings>;
  saveDailyDecisivePlan: (
    settings: DecisivePlanSettings,
  ) => Promise<DecisivePlanSettings>;
  getMigrationConflicts: () => Promise<MigrationConflictListResult>;
  resolveMigrationConflicts: (
    keepIds: string[],
  ) => Promise<MigrationConflictResolutionResult>;
  exportUserPlans: (
    selections: UserPlanExportSelection[],
  ) => Promise<UserPlanExportResult>;
  exportLegacy143Plans: (
    selections: UserPlanExportSelection[],
  ) => Promise<UserPlanExportResult>;
  importLocalCombatPlan: () => Promise<PlanFileOperationResult>;
  setPlanUnlinkedIgnored: (
    kind: 'battle' | 'team',
    source: PlanPresetSource,
    file: string,
    ignored: boolean,
  ) => Promise<string[]>;
  readManagedCombatPlan: (
    source: PlanPresetSource,
    file: string,
  ) => Promise<PlanFileOperationResult>;
  readCombatPlanFile: (
    filePath: string,
  ) => Promise<PlanFileOperationResult>;
  prepareCombatPlanExecution: (
    content: string,
    hint: string,
  ) => Promise<PlanFileOperationResult>;
  saveManagedCombatPlan: (
    name: string,
    content: string,
    overwrite?: boolean,
    currentFile?: string,
  ) => Promise<PlanFileOperationResult>;
  renameUserCombatPlan: (
    file: string,
    newName: string,
  ) => Promise<PlanFileOperationResult>;
  deleteUserCombatPlan: (
    file: string,
  ) => Promise<PlanFileOperationResult>;
  deleteUserTeamPlan: (
    file: string,
  ) => Promise<PlanFileOperationResult>;
  getPythonPath: () => string | null;
  setPythonPath: (pythonPath: string | null) => Promise<void>;
  validatePython: (pythonPath: string) => Promise<{
    valid: boolean;
    version: string | null;
    error?: string;
  }>;
}

declare global {
  interface Window {
    electronBridge?: ElectronBridge;
  }
}
