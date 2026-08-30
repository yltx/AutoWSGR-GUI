/**
 * 组装主进程服务、注册 IPC，并管理 Electron 生命周期。
 */
import { app, BrowserWindow, ipcMain, dialog, screen, shell, Menu } from 'electron';
import * as path from 'path';
import {
  initPythonEnv, clearPythonCache,
  isAllowedPythonVersion, findPython, checkEnvironment,
  installDependencies, installPortablePython,
  backendShipNamesPath,
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
  GuiUpdateStateStore,
} from './services/GuiUpdateStateStore';
import {
  resolveGuiUpdateSelectionPolicy,
  validateGuiUpdateCandidate,
} from './services/GuiUpdatePolicy';
import { GuiUpdateInstaller } from './services/GuiUpdateInstaller';
import { GuiUpdaterLogger } from './services/GuiUpdaterLogger';
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
import { ShipNameSynchronizer } from './services/ShipNameSynchronizer';
import { AdbService } from './services/AdbService';
import { CudaEnvironmentService } from './services/CudaEnvironmentService';
import { GuiConfigurationService } from './services/GuiConfigurationService';
import {
  GuiSettingsCommitService,
} from './services/GuiSettingsCommitService';
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
const guiUpdateStateStore = new GuiUpdateStateStore(
  () => path.join(appPaths.userDataRoot(), '.gui-update-state.json'),
  atomicFileStore,
);
const guiUpdaterLogger = new GuiUpdaterLogger(
  path.join(
    appPaths.isPackaged()
      ? appPaths.appRoot()
      : appPaths.userDataRoot(),
    'logs',
    'updater.log',
  ),
  path.join(appPaths.userDataRoot(), 'logs', 'updater.log'),
);
const guiUpdateInstaller = new GuiUpdateInstaller(
  guiUpdateStateStore,
  guiUpdaterLogger,
  process.resourcesPath,
);
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
const combatPlanRepository = new CombatPlanRepository(
  appPaths,
  atomicFileStore,
);
const combatPlanCodec = new CombatPlanCodec(
  teamPlanCodec,
  teamPlanRepository,
);
const teamPlanService = new TeamPlanService(
  teamPlanCodec,
  teamPlanRepository,
  combatPlanCodec,
  combatPlanRepository,
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
  combatPlanCodec,
);
const shipLibraryService = new ShipLibraryService(appPaths, {
  processId: process.pid,
});
const shipNameSynchronizer = new ShipNameSynchronizer(atomicFileStore);
const adbService = new AdbService(appPaths);

/** 关闭 GUI 管理的后端与内置 ADB server，释放安装目录中的可执行文件。 */
async function stopRuntimeResources(): Promise<void> {
  await stopBackend();
  try {
    const stopped = await adbService.stopServer();
    console.log(
      stopped
        ? '[ADB] GUI 内置 server 已停止'
        : '[ADB] 未发现 GUI 内置 server，跳过停止',
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error);
    console.warn(`[ADB] GUI 内置 server 停止失败，将继续退出: ${message}`);
  }
}

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
    defaultAllowTestUpdates: () => (
      resolveGuiUpdateSelectionPolicy(app.getVersion(), true).stage
        === 'prerelease'
    ),
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
const guiSettingsCommitService = new GuiSettingsCommitService(
  guiConfigurationService,
  secureFileService,
  windowService,
);
singleInstanceService.setMainWindowProvider(
  () => windowService.getMainWindow(),
);
let updateInProgressDialogOpen = false;

/** 安装期间的重复启动只显示系统提示，不创建旧版主窗口。 */
async function showUpdateInProgressDialog(): Promise<void> {
  if (updateInProgressDialogOpen) return;
  updateInProgressDialogOpen = true;
  try {
    await app.whenReady();
    await dialog.showMessageBox({
      type: 'info',
      title: 'AutoWSGR-GUI 正在更新',
      message: '后台正在更新，请稍后',
      buttons: ['确认'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } finally {
    updateInProgressDialogOpen = false;
  }
}

singleInstanceService.setDuplicateLaunchHandler(() => {
  const state = guiUpdateStateStore.read();
  if (
    !state
    || state.sourceVersion !== app.getVersion()
    || !guiUpdateStateStore.isInstallationActive(state)
  ) {
    return false;
  }
  void showUpdateInProgressDialog();
  return true;
});
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
    compareShipNames: pythonCmd => {
      return shipNameSynchronizer.compare(
        backendShipNamesPath(pythonCmd),
        shipLibraryService.getManifest().ships,
      );
    },
    syncShipNames: pythonCmd => {
      return shipNameSynchronizer.sync(
        backendShipNamesPath(pythonCmd),
        shipLibraryService.getManifest().ships,
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
  settingsCommit: guiSettingsCommitService,
  cudaEnvironment: cudaEnvironmentService,
  pythonEnvironment: pythonEnvironmentService,
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
  getStatus: async () => {
    const status = shipLibraryService.getStatus();
    if (
      !status.exists
      || status.error
      || status.shipCount <= 0
      || status.missingAssets > 0
    ) {
      return status;
    }
    try {
      const backend = await shipLibraryUpdater.getBackendSyncStatus();
      return {
        ...status,
        backendSynchronized: backend.synchronized,
        backendMissingRecords: backend.missingRecords,
        backendMissingAliases: backend.missingAliases,
      };
    } catch (error) {
      return {
        ...status,
        backendSynchronized: false,
        backendError: error instanceof Error
          ? error.message
          : String(error),
      };
    }
  },
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
    normalizeUserTeamPlan: raw => teamPlanCodec.normalizeLegacy(raw),
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
    ) => combatPlanCodec.normalizeLegacyFleetPresets(
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
  let runtimeShutdownInProgress = false;
  let runtimeShutdownComplete = false;

  /** 在任何迁移、后端初始化和主窗口创建前处理待安装更新。 */
  const handleStartupUpdate = async (): Promise<boolean> => {
    const pendingUpdate = guiUpdateStateStore.read();
    if (pendingUpdate) {
      const updatePolicy = resolveGuiUpdateSelectionPolicy(
        app.getVersion(),
        guiConfigurationService.allowTestUpdates(),
      );
      const mismatch = validateGuiUpdateCandidate(
        updatePolicy,
        pendingUpdate.targetVersion,
      );
      if (mismatch) {
        guiUpdaterLogger.warn(
          `Discarded pending GUI update after channel change: ${mismatch}`,
        );
        guiUpdateStateStore.clear();
      }
    }
    const resolution = guiUpdateStateStore.resolveStartup(
      app.getVersion(),
    );
    if (resolution.action === 'continue') return false;
    if (resolution.action === 'cleanup') {
      const cleanupTimer = setTimeout(() => {
        guiUpdateInstaller.cleanupAppliedUpdate(resolution.state);
      }, 10_000);
      cleanupTimer.unref();
      return false;
    }
    if (resolution.action === 'wait') {
      guiUpdaterLogger.info(
        `Blocked old GUI startup while v`
        + `${resolution.state.targetVersion} is installing`,
      );
      await showUpdateInProgressDialog();
      runtimeShutdownComplete = true;
      app.quit();
      return true;
    }

    try {
      await guiUpdateInstaller.launchPendingUpdate();
      runtimeShutdownComplete = true;
      app.quit();
      return true;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);
      guiUpdaterLogger.error(
        `Cannot install pending GUI update: ${message}`,
      );
      await dialog.showMessageBox({
        type: 'error',
        title: 'GUI 更新失败',
        message: '后台更新无法启动',
        detail: `${message}\n本次将继续打开当前版本。`,
        buttons: ['确认'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return false;
    }
  };

  app.whenReady().then(async () => {
    if (await handleStartupUpdate()) return;

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
      allowTestUpdates: () => guiConfigurationService.allowTestUpdates(),
      logger: guiUpdaterLogger,
      updateStates: guiUpdateStateStore,
      chooseDownload: async (version) => {
        const options = {
          type: 'question' as const,
          title: '发现 GUI 更新',
          message: `发现 GUI v${version}，是否现在更新？`,
          detail: [
            '“现在更新”只会在后台静默下载和校验，不会关闭 GUI 或中断当前任务。',
            '“稍后”本次不下载，下次打开 GUI 时仍会提示。',
          ].join('\n'),
          buttons: ['现在更新', '稍后'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const mainWindow = windowService.getMainWindow();
        const result = mainWindow
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        return result.response === 0 ? 'now' : 'later';
      },
      chooseRestartTiming: async (version) => {
        const options = {
          type: 'question' as const,
          title: 'GUI 更新准备完成',
          message: `GUI v${version} 已下载并校验完成`,
          detail: [
            '“立即重启”会安全停止后端和 ADB，静默安装完成后启动新版本。',
            '“下次启动”会继续当前任务，下次打开 GUI 时先完成更新再显示主窗口。',
          ].join('\n'),
          buttons: ['立即重启', '下次启动'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const mainWindow = windowService.getMainWindow();
        const result = mainWindow
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        return result.response === 0
          ? 'restart'
          : 'next-launch';
      },
      installDownloadedUpdate: async () => {
        await stopRuntimeResources();
        await guiUpdateInstaller.launchPendingUpdate();
        runtimeShutdownComplete = true;
        app.quit();
      },
    });
    Menu.setApplicationMenu(null);
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

  app.on('before-quit', (event) => {
    windowService.captureWindowBounds();
    windowService.persistWindowBounds();
    if (runtimeShutdownComplete) return;
    event.preventDefault();
    if (runtimeShutdownInProgress) return;

    runtimeShutdownInProgress = true;
    void stopRuntimeResources().then(() => {
      runtimeShutdownComplete = true;
      runtimeShutdownInProgress = false;
      app.quit();
    }).catch(error => {
      runtimeShutdownInProgress = false;
      const message = error instanceof Error
        ? error.message
        : String(error);
      console.error('[Backend] 无法安全退出:', message);
      dialog.showErrorBox(
        '无法安全退出',
        `后端进程仍在运行，应用没有退出：${message}`,
      );
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
