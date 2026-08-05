/**
 * 组装主进程服务、注册 IPC，并管理 Electron 生命周期。
 */
import { app, BrowserWindow, ipcMain, dialog, screen, shell } from 'electron';
import * as path from 'path';
import {
  initPythonEnv, clearPythonCache,
  isAllowedPythonVersion, findPython, checkEnvironment,
  installDependencies, installPortablePython,
} from './pythonEnv';
import { detectEmulator } from './emulatorDetect';
import {
  initBackend,
  getBackendProcess,
  startBackend,
  stopBackend,
  runSetupScript,
} from './services/BackendService';
import { AppPaths } from './services/AppPaths';
import { AtomicFileStore } from './services/AtomicFileStore';
import { GuiSettingsStore } from './services/GuiSettingsStore';
import { SafePathService } from './services/SafePathService';
import { SecureFileService } from './services/SecureFileService';
import { WindowService } from './services/WindowService';
import { SingleInstanceService } from './services/SingleInstanceService';
import {
  DEFAULT_LEGACY_MIGRATION_SELECTION,
  UserDataMigrationService,
  type LegacyMigrationSelection,
} from './services/UserDataMigrationService';
import {
  LegacyMigrationPrompt,
} from './services/LegacyMigrationPrompt';
import { MigrationStateStore } from './services/MigrationStateStore';
import {
  LEGACY_PLAN_MIGRATION_STAGE,
  LegacyPlanMigration,
} from './services/LegacyPlanMigration';
import {
  MigrationConflictService,
} from './services/MigrationConflictService';
import {
  emptyLegacyMigrationSummary,
  mergeLegacyMigrationSummaries,
} from './services/LegacyMigrationSummary';
import {
  buildLegacyMigrationNotice,
} from './services/LegacyMigrationNotice';
import {
  TeamPlanCodec,
  type UserTeamPlan,
} from './services/TeamPlanCodec';
import { TeamPlanRepository } from './services/TeamPlanRepository';
import { TeamPlanService } from './services/TeamPlanService';
import { CombatPlanCodec } from './services/CombatPlanCodec';
import { CombatPlanRepository } from './services/CombatPlanRepository';
import { RuntimePlanService } from './services/RuntimePlanService';
import { PlanManagementService } from './services/PlanManagementService';
import { PlanExportService } from './services/PlanExportService';
import { TaskPresetCodec } from '../src/shared/taskPreset';
import { DailyPlanService } from './services/DailyPlanService';
import { ShipLibraryService } from './services/ShipLibraryService';
import { ShipLibraryUpdater } from './services/ShipLibraryUpdater';
import { AdbService } from './services/AdbService';
import { CudaEnvironmentService } from './services/CudaEnvironmentService';
import { GuiConfigurationService } from './services/GuiConfigurationService';
import { PythonEnvironmentService } from './services/PythonEnvironmentService';
import { registerBackendIpc } from './ipc/BackendIpc';
import { registerCombatPlanIpc } from './ipc/CombatPlanIpc';
import { registerConfigurationIpc } from './ipc/ConfigurationIpc';
import { registerDailyPlanIpc } from './ipc/DailyPlanIpc';
import { registerDeviceIpc } from './ipc/DeviceIpc';
import { registerEnvironmentIpc } from './ipc/EnvironmentIpc';
import { registerFileIpc } from './ipc/FileIpc';
import {
  registerMigrationConflictIpc,
} from './ipc/MigrationConflictIpc';
import { registerShipLibraryIpc } from './ipc/ShipLibraryIpc';
import { registerTeamPlanIpc } from './ipc/TeamPlanIpc';
import { registerUpdaterIpc } from './ipc/UpdaterIpc';

/** 启动终端关闭输出管道时，不让 EPIPE 终止 GUI 主进程。 */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

const singleInstanceService = new SingleInstanceService(app);
const isPrimaryInstance = singleInstanceService.acquire();

const appPaths = new AppPaths({
  moduleDirectory: __dirname,
  isPackaged: () => app.isPackaged,
  getPath: name => app.getPath(name),
  getResourcesPath: () => process.resourcesPath,
});
const atomicFileStore = new AtomicFileStore();
const migrationStateStore = new MigrationStateStore(
  () => path.join(appPaths.userDataRoot(), '.migration-state.json'),
  atomicFileStore,
);
const userDataMigrationService = new UserDataMigrationService(
  appPaths,
  atomicFileStore,
  migrationStateStore,
);
const migrationConflictService = new MigrationConflictService(
  appPaths,
  atomicFileStore,
);
let legacyUserDataMigration = emptyLegacyMigrationSummary();
const legacyMigrationPrompt = new LegacyMigrationPrompt({
  createWindow: options => new BrowserWindow(options),
});
const guiSettingsStore = new GuiSettingsStore(
  () => path.join(appPaths.userDataRoot(), 'gui_settings.json'),
  atomicFileStore,
);
const safePathService = new SafePathService(appPaths);
const secureFileService = new SecureFileService(
  safePathService,
  atomicFileStore,
);
const teamPlanCodec = new TeamPlanCodec();
const teamPlanRepository = new TeamPlanRepository(
  appPaths,
  atomicFileStore,
  teamPlanCodec,
);
const teamPlanService = new TeamPlanService(
  teamPlanCodec,
  teamPlanRepository,
);
const combatPlanRepository = new CombatPlanRepository(
  appPaths,
  atomicFileStore,
);
const combatPlanCodec = new CombatPlanCodec(
  teamPlanCodec,
  teamPlanRepository,
);
const taskPresetCodec = new TaskPresetCodec();
const dailyPlanService = new DailyPlanService(
  appPaths,
  atomicFileStore,
  combatPlanCodec,
  taskPresetCodec,
);
const runtimePlanService = new RuntimePlanService(
  combatPlanCodec,
  combatPlanRepository,
  atomicFileStore,
  {
    getTempDirectory: () => app.getPath('temp'),
    processId: process.pid,
  },
);
const planManagementService = new PlanManagementService(
  combatPlanCodec,
  combatPlanRepository,
  runtimePlanService,
  teamPlanRepository,
  guiSettingsStore,
  taskPresetCodec,
);
const planExportService = new PlanExportService(
  combatPlanRepository,
  teamPlanRepository,
  atomicFileStore,
);
const shipLibraryService = new ShipLibraryService(appPaths, {
  processId: process.pid,
});
const adbService = new AdbService(appPaths);
const cudaEnvironmentService = new CudaEnvironmentService(
  CudaEnvironmentService.createDependencies(findPython),
);
const guiConfigurationService = new GuiConfigurationService(
  guiSettingsStore,
  {
    clearPythonCache,
    normalizeCudaPath: candidate => (
      cudaEnvironmentService.normalizePath(candidate)
    ),
    environmentPort: () => process.env.AUTOWSGR_PORT,
  },
);
const pythonEnvironmentService = new PythonEnvironmentService(
  PythonEnvironmentService.createDependencies({
    isAllowedVersion: isAllowedPythonVersion,
    findPython,
    checkEnvironment,
    installDependencies,
    installPortablePython,
  }),
);
const BACKEND_PORT = guiConfigurationService.backendPort();
const windowService = new WindowService(guiSettingsStore, {
  backendPort: BACKEND_PORT,
  moduleDirectory: __dirname,
  createBrowserWindow: options => new BrowserWindow(options),
  getDisplays: () => screen.getAllDisplays(),
  getAppPath: () => app.getAppPath(),
  isPackaged: () => appPaths.isPackaged(),
  resourceRoot: () => appPaths.resourceRoot(),
  showMessageBox: options => {
    void dialog.showMessageBox(options);
  },
});
singleInstanceService.setMainWindowProvider(
  () => windowService.getMainWindow(),
);
const shipLibraryUpdater = new ShipLibraryUpdater(
  shipLibraryService,
  {
    findPython,
    appRoot,
    sendProgress: message => {
      windowService.sendToRenderer(
        'ship-library-update-progress',
        { message },
      );
    },
  },
);

/** 返回开发项目根目录或打包后的 exe 目录。 */
function appRoot(): string {
  return appPaths.appRoot();
}

/** 返回包含 resource 和 setup.bat 的 extraResources 目录。 */
function resourceRoot(): string {
  return appPaths.resourceRoot();
}

/** 返回 Electron userData 根目录。 */
function userDataRoot(): string {
  return appPaths.userDataRoot();
}

// IPC 注册

registerFileIpc(ipcMain, {
  dialog,
  shell,
  secureFiles: secureFileService,
  safePaths: safePathService,
  combatPlans: combatPlanRepository,
  appRoot,
  userDataRoot,
});
registerDeviceIpc(ipcMain, {
  adb: adbService,
  detectEmulator,
});
registerConfigurationIpc(ipcMain, {
  getAppVersion: () => app.getVersion(),
  backendPort: BACKEND_PORT,
  configuration: guiConfigurationService,
  cudaEnvironment: cudaEnvironmentService,
  pythonEnvironment: pythonEnvironmentService,
  secureFiles: secureFileService,
  windows: windowService,
});
registerDailyPlanIpc(ipcMain, {
  dailyPlans: dailyPlanService,
  configuration: guiConfigurationService,
});
registerMigrationConflictIpc(ipcMain, migrationConflictService);
registerEnvironmentIpc(ipcMain, pythonEnvironmentService);
registerTeamPlanIpc(ipcMain, {
  dialog,
  repository: teamPlanRepository,
  service: teamPlanService,
});
registerCombatPlanIpc(ipcMain, {
  dialog,
  safePaths: safePathService,
  plans: planManagementService,
  planExports: planExportService,
});
registerShipLibraryIpc(ipcMain, {
  library: shipLibraryService,
  updater: shipLibraryUpdater,
});
registerBackendIpc(ipcMain, {
  getBackendProcess,
  startBackend,
  runSetupScript,
});

const legacyPlanMigration = new LegacyPlanMigration<UserTeamPlan>(
  appPaths,
  atomicFileStore,
  userDataMigrationService,
  migrationStateStore,
  {
    yamlFiles: directory => combatPlanRepository.yamlFiles(directory),
    safePlanBaseName: value => combatPlanCodec.safeBaseName(value),
    normalizeUserTeamPlan: raw => teamPlanCodec.normalize(raw),
    teamPlanMatches: (filePath, team) => (
      teamPlanRepository.matches(filePath, team)
    ),
    teamName: team => team.name,
    renameTeam: (team, name) => ({
      ...structuredClone(team),
      name,
    }),
    normalizeCombatPlanFleetPresets: (
      root,
      source,
      requireEmbeddedShips,
    ) => combatPlanCodec.normalizeFleetPresets(
      root,
      source,
      requireEmbeddedShips,
    ),
    buildTeamPlanWrites: (teams, directory) => (
      teamPlanRepository.buildWrites(teams, directory)
    ),
    serializeCombatPlan: (root, originalContent) => (
      combatPlanCodec.serialize(root, originalContent)
    ),
    isStandaloneTaskPreset: root => (
      taskPresetCodec.isStandalone(root)
    ),
    normalizeTaskPreset: root => taskPresetCodec.normalize(root),
  },
);

/** 向渲染进程发送环境检查进度。 */
function sendProgress(msg: string): void {
  windowService.sendToRenderer('backend-log', msg);
}

// 应用生命周期

if (isPrimaryInstance) initializeApplicationLifecycle();

function initializeApplicationLifecycle(): void {
  app.whenReady().then(async () => {
    let migrationSelection: LegacyMigrationSelection = {
      ...DEFAULT_LEGACY_MIGRATION_SELECTION,
    };
    if (userDataMigrationService.shouldMigrateLegacyInstallation()) {
      const selected = await legacyMigrationPrompt.show();
      if (!selected) {
        app.quit();
        return;
      }
      migrationSelection = selected;
      legacyUserDataMigration = (
        userDataMigrationService.migrateLegacyUserDataFiles(
          migrationSelection,
        )
      );
    }

    initPythonEnv({
      appRoot,
      sendProgress,
      getConfiguredPythonPath: () => (
        guiConfigurationService.configuredPythonPath()
      ),
      getUpdateMode: () => guiConfigurationService.updateMode(),
      getBackendStartupMode: () => (
        guiConfigurationService.backendStartupMode()
      ),
      getBackendRepoPath: () => (
        guiConfigurationService.backendRepoPath()
      ),
      getTempDir: () => app.getPath('temp'),
    });
    initBackend({
      appRoot,
      userDataRoot,
      resourceRoot,
      BACKEND_PORT,
      sendToRenderer: (channel, ...args) => (
        windowService.sendToRenderer(channel, ...args)
      ),
    });
    combatPlanRepository.initializeUserDirectory();
    shipLibraryService.initialize();
    teamPlanRepository.initializeUserDirectory();
    const presetInventoryResult = (
      userDataMigrationService.migratePresetInventory()
    );
    const legacyPlanResult = legacyPlanMigration.migrate(
      migrationSelection,
    );
    const legacyMigrationResult = mergeLegacyMigrationSummaries(
      legacyUserDataMigration,
      legacyPlanResult,
      presetInventoryResult,
    );
    userDataMigrationService.writeMigrationReport(
      legacyMigrationResult,
    );
    if (
      legacyMigrationResult.failed === 0
      && migrationStateStore.isStageComplete(
        LEGACY_PLAN_MIGRATION_STAGE,
      )
    ) {
      userDataMigrationService.completeLegacySourceMigration();
    }
    migrationConflictService.prepareAfterMigration(
      legacyMigrationResult.total > 0,
    );
    registerUpdaterIpc(ipcMain, {
      sendToRenderer: (channel, ...args) => (
        windowService.sendToRenderer(channel, ...args)
      ),
      getAppVersion: () => app.getVersion(),
      stopBackend,
    });
    windowService.createWindow();
    const migrationNotice = buildLegacyMigrationNotice(
      legacyMigrationResult,
    );
    const mainWindow = windowService.getMainWindow();
    if (migrationNotice && mainWindow) {
      void dialog.showMessageBox(mainWindow, migrationNotice);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowService.createWindow();
      }
    });
  });

  let backendShutdownInProgress = false;

  app.on('before-quit', (event) => {
    windowService.captureWindowBounds();
    windowService.persistWindowBounds();
    if (backendShutdownInProgress) return;
    if (getBackendProcess()) {
      backendShutdownInProgress = true;
      event.preventDefault();
      void stopBackend().then(() => {
        backendShutdownInProgress = false;
        app.quit();
      }).catch(error => {
        backendShutdownInProgress = false;
        const message = error instanceof Error
          ? error.message
          : String(error);
        console.error('[Backend] 无法安全退出:', message);
        dialog.showErrorBox(
          '无法安全退出',
          `后端进程仍在运行，应用没有退出：${message}`,
        );
      });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
