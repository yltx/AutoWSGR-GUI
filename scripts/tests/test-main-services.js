/**
 * Electron 主进程服务测试入口。
 *
 * 各领域测试共享一个隔离临时目录并按固定顺序执行。
 * Electron 与真实用户数据不会被加载。
 */
const { fs, temporaryDirectory } = require('./main-services/test-context');
const {
  testAppPaths,
  testSecureFileService,
  testGuiLogService,
  testAtomicFileStore,
} = require('./main-services/test-path-and-file');
const {
  testWindowService,
  testGuiSettingsStore,
  testGuiConfigurationService,
  testGuiSettingsCommitService,
} = require('./main-services/test-configuration-and-window');
const { testTeamPlanServices } = require('./main-services/test-team-plan');
const { testCombatPlanServices } = require('./main-services/test-combat-plan');
const { testPlanExportService } = require('./main-services/test-plan-export');
const {
  testBackendShipNamesPath,
  testPythonEnvironmentService,
  testAdbService,
  testCudaEnvironmentService,
} = require('./main-services/test-environment-and-device');
const {
  testShipLibraryService,
  testShipNameSynchronizer,
  testShipLibraryUpdater,
} = require('./main-services/test-ship-library');
const { testUpdaterAndBackendShutdown } = require('./main-services/test-updater-and-shutdown');
const { testSingleInstanceService } = require('./main-services/test-single-instance');
const { testBackendUpdateService } = require('./main-services/test-backend-update');

async function main() {
  testSingleInstanceService();
  testAppPaths();
  testSecureFileService();
  testGuiLogService();
  testWindowService();
  testGuiSettingsStore();
  testGuiConfigurationService();
  testGuiSettingsCommitService();
  testBackendShipNamesPath();
  await testPythonEnvironmentService();
  testAtomicFileStore();
  testTeamPlanServices();
  testCombatPlanServices();
  await testPlanExportService();
  await testAdbService();
  await testCudaEnvironmentService();
  testShipLibraryService();
  testShipNameSynchronizer();
  await testShipLibraryUpdater();
  await testUpdaterAndBackendShutdown();
  await testBackendUpdateService();
  console.log('main services tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
