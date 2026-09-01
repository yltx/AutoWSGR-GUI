/**
 * 通过 contextBridge 向渲染进程安全暴露 IPC 方法。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  LootAutomationPlan,
  LootPlanSource,
} from '../src/shared/lootPlans';
import type {
  LegacyDecisiveAutomationSettings,
} from '../src/shared/legacyDecisiveAutomation';
import type {
  DecisiveAutomationSource,
} from '../src/shared/decisiveAutomation';
import type {
  DecisivePlanSettings,
  ElectronBridge,
  GuiSettingsCommitRequest,
  GuiSettingsCommitResult,
  GuiUpdateStatus,
  ShipLibraryUpdateTarget,
} from '../src/types/ipc';

const electronBridge = {
  getAppVersion: () => {
    return ipcRenderer.sendSync('get-app-version-sync') as string;
  },

  getBackendPort: () => {
    return ipcRenderer.sendSync('get-backend-port-sync') as number;
  },

  getBackendStartupMode: () => {
    return ipcRenderer.sendSync('get-backend-startup-mode-sync') as 'managed' | 'external';
  },

  getBackendRepoPath: () => {
    return ipcRenderer.sendSync('get-backend-repo-path-sync') as string;
  },

  getOcrGpuMode: () => {
    return ipcRenderer.sendSync('get-ocr-gpu-mode-sync') as 'auto' | 'cpu' | 'cuda';
  },

  getCudaPath: () => {
    return ipcRenderer.sendSync('get-cuda-path-sync') as string;
  },

  getSaveBackendScreenshots: () => {
    return ipcRenderer.sendSync('get-save-backend-screenshots-sync') as boolean;
  },

  getWindowPreferences: () => {
    return ipcRenderer.sendSync('get-window-preferences-sync') as {
      defaultWidth: number;
      defaultHeight: number;
      rememberBounds: boolean;
    };
  },

  setWindowPreferences: (preferences: {
    defaultWidth: number;
    defaultHeight: number;
    rememberBounds: boolean;
  }) => {
    return ipcRenderer.invoke('set-window-preferences', preferences);
  },

  getGuiAutomationSettings: () => {
    return ipcRenderer.invoke('get-gui-automation-settings');
  },

  setGuiAutomationSettings: (settings: {
    expeditionInterval: number;
    battleTimes: number;
    autoDecisive: boolean;
    decisiveTemplateId: DecisiveAutomationSource;
    autoLoot: boolean;
    lootPlanSource: LootPlanSource;
    lootPlanId: string;
    lootPlans: LootAutomationPlan[];
    lootStopCount: number;
  }) => {
    return ipcRenderer.invoke('set-gui-automation-settings', settings);
  },

  commitGuiSettings: (
    settings: GuiSettingsCommitRequest,
  ): Promise<GuiSettingsCommitResult> => {
    return ipcRenderer.invoke('commit-gui-settings', settings);
  },

  migrateLegacyDecisiveAutomation: (
    settings: LegacyDecisiveAutomationSettings,
  ) => {
    return ipcRenderer.invoke(
      'migrate-legacy-decisive-automation',
      settings,
    );
  },

  getDecisivePlanSettings: () => {
    return ipcRenderer.invoke('get-decisive-plan-settings');
  },

  setDecisivePlanSettings: (settings: DecisivePlanSettings) => {
    return ipcRenderer.invoke('set-decisive-plan-settings', settings);
  },

  setBackendPort: (port: number) => {
    return ipcRenderer.invoke('set-backend-port', port);
  },

  setBackendStartupMode: (mode: 'managed' | 'external') => {
    return ipcRenderer.invoke('set-backend-startup-mode', mode);
  },

  setBackendRepoPath: (repoPath: string | null) => {
    return ipcRenderer.invoke('set-backend-repo-path', repoPath);
  },

  setOcrGpuMode: (mode: 'auto' | 'cpu' | 'cuda') => {
    return ipcRenderer.invoke('set-ocr-gpu-mode', mode);
  },

  setCudaPath: (cudaPath: string | null) => {
    return ipcRenderer.invoke('set-cuda-path', cudaPath);
  },

  validateCudaPath: (cudaPath: string) => {
    return ipcRenderer.invoke('validate-cuda-path', cudaPath);
  },

  setSaveBackendScreenshots: (enabled: boolean) => {
    return ipcRenderer.invoke('set-save-backend-screenshots', enabled);
  },

  getUpdateMode: () => {
    return ipcRenderer.sendSync('get-update-mode-sync') as 'auto' | 'manual';
  },

  getAllowTestUpdates: () => {
    return ipcRenderer.sendSync('get-allow-test-updates-sync') as boolean;
  },

  setUpdateMode: (mode: 'auto' | 'manual') => {
    return ipcRenderer.invoke('set-update-mode', mode);
  },

  getShipLibraryStatus: () => {
    return ipcRenderer.invoke('get-ship-library-status');
  },

  getShipLibraryManifest: () => {
    return ipcRenderer.invoke('get-ship-library-manifest');
  },

  updateShipLibrary: (target: ShipLibraryUpdateTarget = 'wiki') => {
    return ipcRenderer.invoke('update-ship-library', target);
  },

  onShipLibraryUpdateProgress: (callback: (progress: { message: string }) => void) => {
    ipcRenderer.on('ship-library-update-progress', (_event, progress) => callback(progress));
  },

  saveUserTeamPlan: (
    plan: unknown,
    overwrite = false,
    currentFile?: string,
    source: 'system' | 'user' = 'user',
  ) => {
    return ipcRenderer.invoke(
      'save-user-team-plan',
      plan,
      overwrite,
      currentFile,
      source,
    );
  },

  pickUserTeamPlan: () => {
    return ipcRenderer.invoke('pick-user-team-plan');
  },

  listTeamPlans: () => {
    return ipcRenderer.invoke('list-team-plans');
  },

  getPlanManagement: () => {
    return ipcRenderer.invoke('get-plan-management');
  },

  listDailyPlans: () => {
    return ipcRenderer.invoke('list-daily-plans');
  },

  readDailyPlan: (
    source: 'system' | 'user',
    file: string,
  ) => {
    return ipcRenderer.invoke('read-daily-plan', source, file);
  },

  getDailyDecisivePlan: (chapter: number) => {
    return ipcRenderer.invoke('get-daily-decisive-plan', chapter);
  },

  getSystemDailyDecisivePlan: (chapter: number) => {
    return ipcRenderer.invoke(
      'get-system-daily-decisive-plan',
      chapter,
    );
  },

  saveDailyDecisivePlan: (settings: DecisivePlanSettings) => {
    return ipcRenderer.invoke('save-daily-decisive-plan', settings);
  },

  getMigrationConflicts: () => {
    return ipcRenderer.invoke('get-migration-conflicts');
  },

  resolveMigrationConflicts: (keepIds: string[]) => {
    return ipcRenderer.invoke('resolve-migration-conflicts', keepIds);
  },

  exportUserPlans: (
    selections: Array<{
      kind: 'battle' | 'team';
      file: string;
    }>,
  ) => {
    return ipcRenderer.invoke('export-user-plans', selections);
  },

  exportLegacy143Plans: (
    selections: Array<{ kind: 'battle' | 'team'; file: string }>,
  ) => ipcRenderer.invoke('export-legacy-143-plans', selections),

  importLocalCombatPlan: () => {
    return ipcRenderer.invoke('import-local-combat-plan');
  },

  setPlanUnlinkedIgnored: (
    kind: 'battle' | 'team',
    source: 'system' | 'user',
    file: string,
    ignored: boolean,
  ) => {
    return ipcRenderer.invoke(
      'set-plan-unlinked-ignored',
      kind,
      source,
      file,
      ignored,
    );
  },

  readManagedCombatPlan: (
    source: 'system' | 'user',
    file: string,
  ) => {
    return ipcRenderer.invoke('read-managed-combat-plan', source, file);
  },

  readCombatPlanFile: (filePath: string) => {
    return ipcRenderer.invoke('read-combat-plan-file', filePath);
  },

  prepareCombatPlanExecution: (
    content: string,
    hint: string,
  ) => {
    return ipcRenderer.invoke(
      'prepare-combat-plan-execution',
      content,
      hint,
    );
  },

  saveManagedCombatPlan: (
    name: string,
    content: string,
    overwrite = false,
    currentFile?: string,
  ) => {
    return ipcRenderer.invoke(
      'save-managed-combat-plan',
      name,
      content,
      overwrite,
      currentFile,
    );
  },

  renameUserCombatPlan: (file: string, newName: string) => {
    return ipcRenderer.invoke('rename-user-combat-plan', file, newName);
  },

  deleteUserCombatPlan: (file: string) => {
    return ipcRenderer.invoke('delete-user-combat-plan', file);
  },

  deleteUserTeamPlan: (file: string) => {
    return ipcRenderer.invoke('delete-user-team-plan', file);
  },

  openDirectoryDialog: (title?: string) => {
    return ipcRenderer.invoke('open-directory-dialog', title);
  },

  openFileDialog: (filters: { name: string; extensions: string[] }[], defaultDir?: string) => {
    return ipcRenderer.invoke('open-file-dialog', filters, defaultDir);
  },

  saveFile: (filePath: string, content: string) => {
    return ipcRenderer.invoke('save-file', filePath, content);
  },

  saveFileDialog: (defaultName: string, content: string, filters: { name: string; extensions: string[] }[]) => {
    return ipcRenderer.invoke('save-file-dialog', defaultName, content, filters);
  },

  readFile: (filePath: string) => {
    return ipcRenderer.invoke('read-file', filePath);
  },

  appendFile: (filePath: string, content: string) => {
    return ipcRenderer.invoke('append-file', filePath, content);
  },

  detectEmulator: () => {
    return ipcRenderer.invoke('detect-emulator');
  },

  checkAdbDevices: () => {
    return ipcRenderer.invoke('check-adb-devices');
  },

  connectAdbDevice: (serial: string) => {
    return ipcRenderer.invoke('connect-adb-device', serial);
  },

  disconnectAdbDevice: (serial: string) => {
    return ipcRenderer.invoke('disconnect-adb-device', serial);
  },

  getAppRoot: () => {
    return ipcRenderer.invoke('get-app-root');
  },

  getPlansDir: () => {
    return ipcRenderer.invoke('get-plans-dir');
  },

  listPlanFiles: () => {
    return ipcRenderer.invoke('list-plan-files');
  },

  getConfigDir: () => {
    return ipcRenderer.invoke('get-config-dir');
  },

  openFolder: (folderPath: string) => {
    return ipcRenderer.invoke('open-folder', folderPath);
  },

  checkEnvironment: () => {
    return ipcRenderer.invoke('check-environment');
  },

  installDeps: () => {
    return ipcRenderer.invoke('install-deps');
  },

  startBackend: () => {
    return ipcRenderer.invoke('start-backend');
  },

  runSetup: () => {
    return ipcRenderer.invoke('run-setup');
  },

  installPortablePython: () => {
    return ipcRenderer.invoke('install-portable-python');
  },

  // Python 路径配置
  getPythonPath: () => {
    return ipcRenderer.sendSync('get-python-path-sync') as string | null;
  },

  setPythonPath: (pythonPath: string | null) => {
    return ipcRenderer.invoke('set-python-path', pythonPath);
  },

  validatePython: (pythonPath: string) => {
    return ipcRenderer.invoke('validate-python', pythonPath);
  },

  // GUI 自动更新
  checkGuiUpdates: () => {
    return ipcRenderer.invoke('check-gui-updates');
  },

  onUpdateStatus: (callback: (status: GuiUpdateStatus) => void) => {
    ipcRenderer.on('update-status', (_event, status) => callback(status));
  },

  onBackendLog: (callback: (line: string) => void) => {
    ipcRenderer.on('backend-log', (_event, line: string) => callback(line));
  },

  onSetupLog: (callback: (text: string) => void) => {
    ipcRenderer.on('setup-log', (_event, text: string) => callback(text));
  },
} satisfies ElectronBridge;

contextBridge.exposeInMainWorld('electronBridge', electronBridge);
