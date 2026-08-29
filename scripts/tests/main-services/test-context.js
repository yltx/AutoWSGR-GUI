/**
 * 主进程服务测试共享上下文。
 *
 * 只集中测试依赖和单次临时目录，不包含业务断言。
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const yaml = require('js-yaml');
const {
  AppPaths,
} = require('../../../dist/electron/services/AppPaths.js');
const {
  AtomicFileStore,
} = require('../../../dist/electron/services/AtomicFileStore.js');
const {
  GuiSettingsStore,
} = require('../../../dist/electron/services/GuiSettingsStore.js');
const {
  SafePathService,
} = require('../../../dist/electron/services/SafePathService.js');
const {
  SecureFileService,
} = require('../../../dist/electron/services/SecureFileService.js');
const {
  WindowService,
} = require('../../../dist/electron/services/WindowService.js');
const {
  UserDataMigrationService,
} = require('../../../dist/electron/services/UserDataMigrationService.js');
const {
  MigrationStateStore,
} = require('../../../dist/electron/services/MigrationStateStore.js');
const {
  LegacyPlanMigration,
} = require('../../../dist/electron/services/LegacyPlanMigration.js');
const {
  MigrationConflictService,
} = require('../../../dist/electron/services/MigrationConflictService.js');
const {
  TeamPlanCodec,
} = require('../../../dist/electron/services/TeamPlanCodec.js');
const {
  TeamPlanRepository,
} = require('../../../dist/electron/services/TeamPlanRepository.js');
const {
  TeamPlanService,
} = require('../../../dist/electron/services/TeamPlanService.js');
const {
  CombatPlanCodec,
} = require('../../../dist/electron/services/CombatPlanCodec.js');
const {
  CombatPlanRepository,
} = require('../../../dist/electron/services/CombatPlanRepository.js');
const {
  RuntimePlanService,
} = require('../../../dist/electron/services/RuntimePlanService.js');
const {
  PlanManagementService,
} = require('../../../dist/electron/services/PlanManagementService.js');
const {
  TaskPresetCodec,
} = require('../../../dist/src/shared/taskPreset.js');
const {
  ShipLibraryService,
} = require('../../../dist/electron/services/ShipLibraryService.js');
const {
  ShipLibraryUpdater,
} = require('../../../dist/electron/services/ShipLibraryUpdater.js');
const {
  ShipNameSynchronizer,
} = require('../../../dist/electron/services/ShipNameSynchronizer.js');
const {
  AdbService,
} = require('../../../dist/electron/services/AdbService.js');
const {
  CudaEnvironmentService,
} = require('../../../dist/electron/services/CudaEnvironmentService.js');
const {
  GuiConfigurationService,
} = require('../../../dist/electron/services/GuiConfigurationService.js');
const {
  GuiSettingsCommitService,
} = require('../../../dist/electron/services/GuiSettingsCommitService.js');
const {
  GuiLogService,
  resolveGuiLogDirectory,
} = require('../../../dist/electron/services/GuiLogService.js');
const {
  PythonEnvironmentService,
} = require('../../../dist/electron/services/PythonEnvironmentService.js');
const {
  BackendUpdateService,
} = require('../../../dist/electron/services/BackendUpdateService.js');

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-main-services-'),
);

module.exports = {
  assert,
  EventEmitter,
  fs,
  os,
  path,
  PassThrough,
  yaml,
  AppPaths,
  AtomicFileStore,
  GuiSettingsStore,
  SafePathService,
  SecureFileService,
  WindowService,
  UserDataMigrationService,
  MigrationStateStore,
  LegacyPlanMigration,
  MigrationConflictService,
  TeamPlanCodec,
  TeamPlanRepository,
  TeamPlanService,
  CombatPlanCodec,
  CombatPlanRepository,
  RuntimePlanService,
  PlanManagementService,
  TaskPresetCodec,
  ShipLibraryService,
  ShipLibraryUpdater,
  ShipNameSynchronizer,
  AdbService,
  CudaEnvironmentService,
  GuiConfigurationService,
  GuiSettingsCommitService,
  GuiLogService,
  resolveGuiLogDirectory,
  PythonEnvironmentService,
  BackendUpdateService,
  temporaryDirectory,
};
