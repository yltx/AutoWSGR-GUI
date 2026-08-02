/** 通过 preload 注入的 IPC 桥 */
export interface ShipLibraryStatus {
  exists: boolean;
  path: string;
  generatedAt?: string;
  shipCount: number;
  assetCount: number;
  missingAssets: number;
  error?: string;
}

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

export interface UserTeamShipRule {
  name: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
}

export interface UserTeamPlanSlot {
  name?: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  candidates?: UserTeamShipRule[];
}

export interface UserTeamPlan {
  file?: string;
  name: string;
  ships: UserTeamPlanSlot[];
}

export interface UserTeamPlanResult {
  success: boolean;
  canceled?: boolean;
  exists?: boolean;
  file?: string;
  plan?: UserTeamPlan;
  error?: string;
}

export interface UserTeamPlanListResult {
  plans: UserTeamPlan[];
  errors: string[];
}

export interface ElectronBridge {
  openDirectoryDialog: (title?: string) => Promise<string | null>;
  openFileDialog: (filters: { name: string; extensions: string[] }[], defaultDir?: string) => Promise<{ path: string; content: string } | null>;
  saveFile: (path: string, content: string) => Promise<void>;
  saveFileDialog: (defaultName: string, content: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  readFile: (path: string) => Promise<string>;
  appendFile: (path: string, content: string) => Promise<void>;
  detectEmulator: () => Promise<{ type: string; path: string; serial: string; adbPath: string } | null>;
  checkAdbDevices: () => Promise<{ serial: string; status: string }[]>;
  getAppRoot: () => Promise<string>;
  resolveAppPath: (filePath: string) => Promise<string>;
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
  /*
   * 测试期接口（后端源码更新）已停用，类型保留便于回滚恢复。
  checkUpdates: () => Promise<{
    gitAvailable: boolean;
    hasUpdates: boolean;
    currentBranch: string;
    behindCount: number;
    remoteUrl: string;
  }>;
  */
  installDeps: () => Promise<{ success: boolean; output: string }>;
  /*
   * 测试期接口（后端源码更新）已停用，类型保留便于回滚恢复。
  pullUpdates: () => Promise<{ success: boolean; output: string }>;
  */
  startBackend: () => Promise<{ success: boolean; message: string }>;
  runSetup: () => Promise<{ success: boolean; output: string }>;
  installPortablePython: () => Promise<{ success: boolean }>;
  checkGuiUpdates: () => Promise<{ version: string } | null>;
  downloadGuiUpdate: () => Promise<{ success: boolean; message?: string }>;
  installGuiUpdate: () => void;
  onUpdateStatus: (callback: (status: any) => void) => void;
  onBackendLog: (callback: (line: string) => void) => void;
  onSetupLog: (callback: (text: string) => void) => void;
  getAppVersion: () => string;
  getBackendPort: () => number;
  setBackendPort: (port: number) => Promise<void>;
  getBackendStartupMode: () => 'managed' | 'external';
  setBackendStartupMode: (mode: 'managed' | 'external') => Promise<void>;
  getBackendRepoPath: () => string;
  setBackendRepoPath: (repoPath: string | null) => Promise<void>;
  getOcrGpuMode: () => 'auto' | 'cpu' | 'cuda';
  setOcrGpuMode: (mode: 'auto' | 'cpu' | 'cuda') => Promise<void>;
  getCudaPath: () => string;
  setCudaPath: (cudaPath: string | null) => Promise<void>;
  validateCudaPath: (cudaPath: string) => Promise<{ valid: boolean; path: string; version: string | null; kind?: 'toolkit' | 'runtime'; error?: string }>;
  getSaveBackendScreenshots: () => boolean;
  setSaveBackendScreenshots: (enabled: boolean) => Promise<void>;
  getUpdateMode: () => 'auto' | 'manual';
  setUpdateMode: (mode: 'auto' | 'manual') => Promise<void>;
  getShipLibraryStatus: () => Promise<ShipLibraryStatus>;
  getShipLibraryManifest: () => Promise<ShipLibraryManifest>;
  updateShipLibrary: () => Promise<ShipLibraryUpdateResult>;
  onShipLibraryUpdateProgress: (
    callback: (progress: { message: string }) => void,
  ) => void;
  saveUserTeamPlan: (
    plan: UserTeamPlan,
    overwrite?: boolean,
  ) => Promise<UserTeamPlanResult>;
  pickUserTeamPlan: () => Promise<UserTeamPlanResult>;
  listUserTeamPlans: () => Promise<UserTeamPlanListResult>;
  getPythonPath: () => string | null;
  setPythonPath: (pythonPath: string | null) => Promise<void>;
  validatePython: (pythonPath: string) => Promise<{ valid: boolean; version: string | null; error?: string }>;
}

declare global {
  interface Window {
    electronBridge?: ElectronBridge;
  }
}
