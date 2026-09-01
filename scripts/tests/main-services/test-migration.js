/**
 * 用户数据和旧计划迁移服务测试。
 *
 * 复用同一隔离临时目录，不读取或修改真实用户数据。
 */
const context = require('./test-context');
const {
  buildLegacyMigrationNotice,
} = require('../../../dist/electron/services/LegacyMigrationNotice.js');
const {
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
  AdbService,
  CudaEnvironmentService,
  GuiConfigurationService,
  PythonEnvironmentService,
  temporaryDirectory,
} = context;

function createLegacyPlanMigration(
  appPaths,
  atomicFiles,
  userDataMigration,
) {
  const teamCodec = new TeamPlanCodec();
  const teamRepository = new TeamPlanRepository(
    appPaths,
    atomicFiles,
    teamCodec,
  );
  const combatRepository = new CombatPlanRepository(
    appPaths,
    atomicFiles,
  );
  const combatCodec = new CombatPlanCodec(
    teamCodec,
    teamRepository,
  );
  const taskPresetCodec = new TaskPresetCodec();
  return new LegacyPlanMigration(
    appPaths,
    atomicFiles,
    userDataMigration,
    userDataMigration.migrationState,
    {
      yamlFiles: directory => combatRepository.yamlFiles(directory),
      safePlanBaseName: value => combatCodec.safeBaseName(value),
      normalizeUserTeamPlan: raw => teamCodec.normalizeLegacy(raw),
      teamPlanMatches: (filePath, team) => (
        teamRepository.matches(filePath, team)
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
      ) => combatCodec.normalizeLegacyFleetPresets(
        root,
        source,
        requireEmbeddedShips,
      ),
      buildTeamPlanWrites: (teams, directory) => (
        teamRepository.buildWrites(teams, directory)
      ),
      serializeCombatPlan: (root, originalContent) => (
        combatCodec.serialize(root, originalContent)
      ),
      isStandaloneTaskPreset: root => taskPresetCodec.isStandalone(root),
      normalizeTaskPreset: root => taskPresetCodec.normalize(root),
    },
  );
}

/** 验证迁移账本独立处理损坏回退、完成项合并和版本单调递增。 */
function testMigrationStateStore() {
  const root = path.join(temporaryDirectory, 'migration-state-store');
  const statePath = path.join(root, '.migration-state.json');
  fs.rmSync(root, { recursive: true, force: true });
  const store = new MigrationStateStore(
    () => statePath,
    new AtomicFileStore(),
  );

  assert.deepEqual(store.read(), { version: 0, completed: [] });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(statePath, '{invalid', 'utf8');
  assert.deepEqual(store.read(), { version: 0, completed: [] });

  store.write({ version: 5, completed: ['existing'] });
  store.completeStage('next', 3);
  store.mergeCompleted(['third', 'existing'], 6);
  assert.deepEqual(store.read(), {
    version: 6,
    completed: ['existing', 'next', 'third'],
  });
}

/** 验证分类选择、异常退出重问和明确跳过的完成边界。 */
function testMigrationSelection() {
  const root = path.join(temporaryDirectory, 'migration-selection');
  const projectRoot = path.join(root, 'project');
  const userData = path.join(root, 'user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const atomicFiles = new AtomicFileStore();

  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectRoot, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'templates'), { recursive: true });
  fs.mkdirSync(
    path.join(projectRoot, 'resource', 'user_team_plans'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(projectRoot, 'usersettings.yaml'),
    'legacy_setting: true\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'task_groups.json'),
    JSON.stringify({ version: 4, groups: [] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'templates', 'legacy.json'),
    '{"legacy":true}',
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'plans', 'daily.yaml'),
    'task_type: exercise\nfleet_id: 1\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'plans', 'battle.yaml'),
    'chapter: 1\nmap: 1\nfleet_presets: []\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(
      projectRoot,
      'resource',
      'user_team_plans',
      'team-selection.yaml',
    ),
    'name: Selection Team\nships:\n  - name: 吹雪\n',
    'utf8',
  );

  const dailySelection = {
    dailyPlans: true,
    taskQueue: false,
    taskYamls: false,
  };
  const firstMigration = new UserDataMigrationService(
    appPaths,
    atomicFiles,
  );
  firstMigration.migrateLegacyUserDataFiles(dailySelection);
  firstMigration.migratePresetInventory();
  createLegacyPlanMigration(
    appPaths,
    atomicFiles,
    firstMigration,
  ).migrate(dailySelection);

  assert.equal(
    fs.existsSync(path.join(
      appPaths.userDailyPlansDir(),
      'exercise-队伍1演习.yaml',
    )),
    true,
  );
  assert.equal(fs.existsSync(
    path.join(userData, 'task_groups.json'),
  ), false);
  assert.equal(fs.existsSync(
    path.join(appPaths.userBattlePlansDir(), 'bettle-battle.yaml'),
  ), false);
  assert.equal(fs.existsSync(
    path.join(appPaths.userTeamPlansDir(), 'team-Selection Team.yaml'),
  ), false);

  // 模拟计划阶段完成后、旧来源最终封存前异常退出。
  const resumedMigration = new UserDataMigrationService(
    appPaths,
    atomicFiles,
  );
  assert.equal(
    resumedMigration.shouldMigrateLegacyInstallation(),
    true,
  );
  const remainingSelection = {
    dailyPlans: false,
    taskQueue: true,
    taskYamls: true,
  };
  fs.mkdirSync(appPaths.userBattlePlansDir(), { recursive: true });
  fs.mkdirSync(appPaths.userTeamPlansDir(), { recursive: true });
  resumedMigration.migrateLegacyUserDataFiles(remainingSelection);
  resumedMigration.migratePresetInventory();
  const resumedResult = createLegacyPlanMigration(
    appPaths,
    atomicFiles,
    resumedMigration,
  ).migrate(remainingSelection);
  assert.equal(resumedResult.failed, 0);
  resumedMigration.completeLegacySourceMigration();

  assert.equal(fs.existsSync(
    path.join(userData, 'task_groups.json'),
  ), true);
  assert.equal(fs.existsSync(
    path.join(userData, 'templates', 'legacy.json'),
  ), true);
  assert.equal(fs.existsSync(
    path.join(appPaths.userBattlePlansDir(), 'bettle-battle.yaml'),
  ), true);
  assert.equal(
    fs.readdirSync(appPaths.userTeamPlansDir()).length,
    1,
  );
  const completedMigration = new UserDataMigrationService(
    appPaths,
    atomicFiles,
  );
  assert.equal(
    completedMigration.shouldMigrateLegacyInstallation(),
    false,
  );

  const skipRoot = path.join(temporaryDirectory, 'migration-skip');
  const skipProject = path.join(skipRoot, 'project');
  const skipUserData = path.join(skipRoot, 'user-data');
  const skipPaths = new AppPaths({
    moduleDirectory: path.join(skipProject, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(skipProject, 'AutoWSGR.exe')
      : skipUserData,
    getResourcesPath: () => path.join(skipProject, 'resources'),
  });
  fs.mkdirSync(skipProject, { recursive: true });
  fs.writeFileSync(
    path.join(skipProject, 'usersettings.yaml'),
    'always_migrate: true\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(skipProject, 'task_groups.json'),
    JSON.stringify({ version: 4, groups: [] }),
    'utf8',
  );
  const skippedMigration = new UserDataMigrationService(
    skipPaths,
    atomicFiles,
  );
  const skipSelection = {
    dailyPlans: false,
    taskQueue: false,
    taskYamls: false,
  };
  skippedMigration.migrateLegacyUserDataFiles(skipSelection);
  skippedMigration.migratePresetInventory();
  createLegacyPlanMigration(
    skipPaths,
    atomicFiles,
    skippedMigration,
  ).migrate(skipSelection);
  skippedMigration.completeLegacySourceMigration();
  assert.equal(
    fs.existsSync(path.join(skipUserData, 'usersettings.yaml')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(skipUserData, 'task_groups.json')),
    false,
  );
  assert.equal(
    new UserDataMigrationService(
      skipPaths,
      atomicFiles,
    ).shouldMigrateLegacyInstallation(),
    false,
  );
}

/** 验证旧配置、旧计划和任务组引用迁移保持幂等。 */
function testUserDataMigration() {
  testMigrationStateStore();
  testMigrationSelection();
  const migrationRoot = path.join(temporaryDirectory, 'migration');
  const projectRoot = path.join(migrationRoot, 'project');
  const moduleDirectory = path.join(projectRoot, 'dist', 'electron');
  const userData = path.join(migrationRoot, 'user-data');
  const appPaths = new AppPaths({
    moduleDirectory,
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const atomicFiles = new AtomicFileStore();
  const userDataMigration = new UserDataMigrationService(
    appPaths,
    atomicFiles,
  );

  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'usersettings.yaml'),
    'legacy: true\n',
    'utf8',
  );
  assert.equal(
    userDataMigration.shouldMigrateLegacyInstallation(),
    true,
  );
  fs.mkdirSync(path.join(projectRoot, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'plans'), { recursive: true });
  fs.mkdirSync(
    path.join(projectRoot, 'resource', 'user_battle_plans'),
    { recursive: true },
  );
  fs.mkdirSync(
    path.join(projectRoot, 'resource', 'user_team_plans'),
    { recursive: true },
  );
  fs.mkdirSync(appPaths.userBattlePlansDir(), { recursive: true });
  fs.mkdirSync(appPaths.userTeamPlansDir(), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'usersettings.yaml'),
    [
      'legacy: false',
      'new_setting: keep',
      'nested:',
      '  new_only: 1',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(userData, 'gui_settings.json'),
    JSON.stringify({
      legacy: false,
      new_setting: 'keep',
      nested: { new_only: 1 },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'usersettings.yaml'),
    [
      'legacy: true',
      'nested:',
      '  old_value: 2',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'gui_settings.json'),
    JSON.stringify({
      legacy: true,
      nested: { old_value: 2 },
      decisive_plan: {
        chapter: 3,
        use_quick_repair: false,
        level1: ['U-47', 'U-96'],
        level2: ['U-505'],
      },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'templates', 'legacy.json'),
    '{"template":true}',
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'task_groups.json'),
    JSON.stringify({
      rootExtension: { preserved: true },
      groups: [{
        name: 'legacy',
        groupExtension: 'keep',
        items: [{
          path: 'plans/legacy.yaml',
          itemExtension: { preserved: true },
        }, {
          path: [
            'python',
            'site-packages',
            'autowsgr',
            'data',
            'plan',
            '自动演习.yaml',
          ].join(path.sep),
          label: '旧自动演习',
          times: 1,
        }, {
          path: 'resource/user_battle_plans/bettle-普通驱逐.yaml',
          managedSource: 'user',
          managedFile: 'bettle-普通驱逐.yaml',
          kind: 'preset',
          label: '旧普通驱逐战役',
          times: 3,
        }],
      }],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'plans', 'legacy.yaml'),
    [
      'chapter: 1',
      'map: 2',
      'node_args:',
      '  A: {detour: true, SL_when_detour_fails: null, sl_when_detour_fails: false}',
      '  B: {detour: true, sl_when_detour_fails: true}',
      'fleet_presets:',
      '  - name: Legacy Team',
      '    ships:',
      '      - U-47',
      '      - priority: [U-96, U-81]',
      '        ship_type: [ss]',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(
      projectRoot,
      'resource',
      'user_team_plans',
      'old-reference.yaml',
    ),
    [
      'name: Referenced Team',
      'ships:',
      '  - candidates:',
      '      - name: U-505',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(
      projectRoot,
      'resource',
      'user_battle_plans',
      'weekly.yml',
    ),
    [
      'chapter: 2',
      'map: 3',
      'fleet_presets:',
      '  - name: Referenced Team',
      '',
    ].join('\n'),
    'utf8',
  );
  const recursivePreset = path.join(
    projectRoot,
    'python',
    'site-packages',
    'autowsgr',
    'data',
    'plan',
    '自动演习.yaml',
  );
  fs.mkdirSync(path.dirname(recursivePreset), { recursive: true });
  fs.writeFileSync(
    recursivePreset,
    'task_type: exercise\nfleet_id: 4\ntimes: 1\n',
    'utf8',
  );
  const misplacedCampaign = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-普通驱逐.yaml',
  );
  fs.writeFileSync(
    misplacedCampaign,
    'task_type: campaign\ncampaign_name: 普通驱逐\ntimes: 3\n',
    'utf8',
  );
  const unrelatedYaml = path.join(
    projectRoot,
    'python',
    'unrelated.yaml',
  );
  fs.mkdirSync(path.dirname(unrelatedYaml), { recursive: true });
  fs.writeFileSync(unrelatedYaml, 'package: metadata\n', 'utf8');

  const userDataResult = (
    userDataMigration.migrateLegacyUserDataFiles()
  );
  assert.deepEqual(
    {
      total: userDataResult.total,
      succeeded: userDataResult.succeeded,
      failed: userDataResult.failed,
    },
    { total: 4, succeeded: 4, failed: 0 },
  );
  assert.deepEqual(
    yaml.load(
      fs.readFileSync(path.join(userData, 'usersettings.yaml'), 'utf8'),
    ),
    {
      legacy: true,
      new_setting: 'keep',
      nested: {
        new_only: 1,
        old_value: 2,
      },
    },
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(userData, 'gui_settings.json'), 'utf8'),
    ),
    {
      legacy: true,
      new_setting: 'keep',
      nested: {
        new_only: 1,
        old_value: 2,
      },
      decisive_plan: {
        chapter: 3,
        use_quick_repair: false,
        level1: ['U-47', 'U-96'],
        level2: ['U-505'],
      },
    },
  );
  assert.equal(
    fs.readFileSync(
      path.join(userData, 'templates', 'legacy.json'),
      'utf8',
    ),
    '{"template":true}',
  );
  assert.equal(
    userDataMigration.migrateLegacyUserDataFiles().total,
    0,
  );

  const migratedState = userDataMigration.migrationState.read();
  userDataMigration.migrationState.write({
    version: 2,
    completed: [
      ...migratedState.completed,
      `plan:${path.join(projectRoot, 'plans')}:legacy.yaml`,
    ],
  });

  const teamCodec = new TeamPlanCodec();
  const teamRepository = new TeamPlanRepository(
    appPaths,
    atomicFiles,
    teamCodec,
  );
  const combatCodec = new CombatPlanCodec(
    teamCodec,
    teamRepository,
  );
  const combatRepository = new CombatPlanRepository(
    appPaths,
    atomicFiles,
  );
  const taskPresetCodec = new TaskPresetCodec();
  const legacyMigration = new LegacyPlanMigration(
    appPaths,
    atomicFiles,
    userDataMigration,
    userDataMigration.migrationState,
    {
      yamlFiles: directory => combatRepository.yamlFiles(directory),
      safePlanBaseName: value => combatCodec.safeBaseName(value),
      normalizeUserTeamPlan: raw => teamCodec.normalizeLegacy(raw),
      teamPlanMatches: (filePath, team) => (
        teamRepository.matches(filePath, team)
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
      ) => combatCodec.normalizeLegacyFleetPresets(
        root,
        source,
        requireEmbeddedShips,
      ),
      buildTeamPlanWrites: (teams, directory) => (
        teamRepository.buildWrites(teams, directory)
      ),
      serializeCombatPlan: (root, originalContent) => (
        combatCodec.serialize(root, originalContent)
      ),
      isStandaloneTaskPreset: root => (
        taskPresetCodec.isStandalone(root)
      ),
      normalizeTaskPreset: root => taskPresetCodec.normalize(root),
    },
  );
  assert.equal(userDataMigration.migratePresetInventory().failed, 0);
  assert.equal(userDataMigration.migrationState.read().version, 6);
  const planResult = legacyMigration.migrate();
  assert.deepEqual(
    {
      total: planResult.total,
      succeeded: planResult.succeeded,
      failed: planResult.failed,
    },
    { total: 6, succeeded: 6, failed: 0 },
  );

  const migratedPlanPath = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-legacy.yaml',
  );
  const migratedTeamPath = path.join(
    appPaths.userTeamPlansDir(),
    'team-Legacy Team.yaml',
  );
  const referencedPlanPath = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-weekly.yaml',
  );
  const referencedTeamPath = path.join(
    appPaths.userTeamPlansDir(),
    'team-Referenced Team.yaml',
  );
  assert.equal(fs.existsSync(migratedPlanPath), true);
  assert.equal(fs.existsSync(migratedTeamPath), true);
  assert.equal(fs.existsSync(referencedPlanPath), true);
  assert.equal(fs.existsSync(referencedTeamPath), true);
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userDailyPlansDir(),
      'exercise-队伍4演习.yaml',
    )),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userBattlePlansDir(),
      'bettle-自动演习.yaml',
    )),
    false,
  );
  const migratedDecisive = yaml.load(fs.readFileSync(path.join(
    appPaths.userDailyPlansDir(),
    'decisive-决战第3章.yaml',
  ), 'utf8'));
  assert.equal(migratedDecisive.chapter, 3);
  assert.equal(migratedDecisive.use_quick_repair, false);
  assert.deepEqual(migratedDecisive.level1, ['U-47', 'U-96']);
  assert.deepEqual(migratedDecisive.level2, ['U-505']);
  const migratedCampaign = yaml.load(fs.readFileSync(path.join(
    appPaths.userDailyPlansDir(),
    'campaign-普通驱逐.yaml',
  ), 'utf8'));
  assert.equal(migratedCampaign.campaign_name, '简单驱逐');
  assert.equal(migratedCampaign.times, 3);
  assert.equal(fs.existsSync(misplacedCampaign), true);
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userBattlePlansDir(),
      'bettle-unrelated.yaml',
    )),
    false,
  );
  const migratedPlan = yaml.load(fs.readFileSync(migratedPlanPath, 'utf8'));
  assert.deepEqual(
    migratedPlan.fleet_presets,
    [{ name: 'Legacy Team' }],
  );
  assert.deepEqual(migratedPlan.node_args.A, {
    detour: true,
    SL_when_detour_fails: false,
  });
  assert.deepEqual(migratedPlan.node_args.B, {
    detour: true,
    SL_when_detour_fails: true,
  });
  assert.deepEqual(
    yaml.load(fs.readFileSync(migratedTeamPath, 'utf8')).ships,
    [
      { name: 'U-47', relaxed: true },
      {
        ship_type: ['ss'],
        candidates: [
          { name: 'U-96', ship_type: ['ss'], relaxed: true },
          { name: 'U-81', ship_type: ['ss'], relaxed: true },
        ],
      },
    ],
  );
  assert.deepEqual(
    yaml.load(fs.readFileSync(referencedPlanPath, 'utf8')).fleet_presets,
    [{ name: 'Referenced Team' }],
  );
  assert.deepEqual(
    yaml.load(fs.readFileSync(referencedTeamPath, 'utf8')).ships,
    [{
      candidates: [{ name: 'U-505', relaxed: true }],
    }],
  );
  assert.equal(
    fs.existsSync(path.join(projectRoot, 'plans', 'legacy.yaml')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      projectRoot,
      'resource',
      'user_battle_plans',
      'weekly.yml',
    )),
    true,
  );
  const taskGroups = JSON.parse(
    fs.readFileSync(path.join(userData, 'task_groups.json'), 'utf8'),
  );
  assert.equal(taskGroups.version, 4);
  assert.equal(taskGroups.rootExtension.preserved, true);
  assert.equal(taskGroups.groups[0].groupExtension, 'keep');
  assert.equal(
    taskGroups.groups[0].items[0].itemExtension.preserved,
    true,
  );
  assert.equal(taskGroups.groups[0].items[0].path, 'plans/legacy.yaml');
  assert.equal(taskGroups.groups[0].items[0].managedSource, 'user');
  assert.equal(
    taskGroups.groups[0].items[0].managedFile,
    'bettle-legacy.yaml',
  );
  assert.equal(taskGroups.groups[0].items[1].kind, 'daily');
  assert.equal(
    taskGroups.groups[0].items[1].dailySource,
    'user',
  );
  assert.equal(
    taskGroups.groups[0].items[1].dailyFile,
    'exercise-队伍4演习.yaml',
  );
  assert.equal(
    taskGroups.groups[0].items[1].dailyTaskType,
    'exercise',
  );
  assert.equal(taskGroups.groups[0].items[1].managedFile, undefined);
  assert.equal(taskGroups.groups[0].items[2].kind, 'daily');
  assert.equal(
    taskGroups.groups[0].items[2].dailyFile,
    'campaign-普通驱逐.yaml',
  );
  assert.equal(
    taskGroups.groups[0].items[2].dailyTaskType,
    'campaign',
  );
  assert.equal(taskGroups.groups[0].items[2].managedFile, undefined);
  assert.equal(userDataMigration.migrationState.read().version, 7);
  assert.equal(
    userDataMigration.migrationState.read().version,
    7,
    'v6 库存升级后必须继续执行 v7 日常任务分类迁移',
  );
  assert.equal(userDataMigration.migratePresetInventory().total, 0);

  const planBeforeSecondRun = fs.readFileSync(migratedPlanPath, 'utf8');
  assert.equal(legacyMigration.migrate().total, 0);
  assert.equal(
    fs.readFileSync(migratedPlanPath, 'utf8'),
    planBeforeSecondRun,
  );
  testLegacyMigrationNotice();
  testLegacyPlanConflictRetry();
  testInitializedUserDataBlocksLegacyInstall();
  testLegacyLootPlanIndexMigration();
  testPresetInventoryMigration();
  testMigrationStageOrderingAndRecursivePlans();
  testMigrationConflictResolution();
}

/** 验证不同旧版本的数字索引都迁移为原地图的稳定文件名。 */
function testLegacyLootPlanIndexMigration() {
  const legacyFivePlanPaths = [
    'resource/builtin_plans/9-4胖次6SS.yaml',
    'resource/builtin_plans/周常9章-9-2.yaml',
    'resource/builtin_plans/周常7章-7-4.yaml',
    'resource/builtin_plans/8-5胖次.yaml',
    'resource/builtin_plans/周常2章-2-1.yaml',
  ];
  const cases = [
    {
      name: 'fallback-four-item-layout',
      index: 2,
      expected: 'bettle-old-8-5AI六潜胖次.yaml',
    },
    {
      name: 'installed-five-item-index-zero',
      index: 0,
      planPaths: legacyFivePlanPaths,
      expected: 'bettle-old-9-4六潜练级.yaml',
    },
    {
      name: 'installed-five-item-index-two',
      index: 2,
      planPaths: legacyFivePlanPaths,
      expected: 'bettle-周常-7-4.yaml',
    },
    {
      name: 'installed-template-with-unknown-path',
      index: 0,
      planPaths: ['resource/builtin_plans/未知地图.yaml'],
      expected: 'bettle-周常-9-2.yaml',
      expectedAutoLoot: false,
    },
    {
      name: 'invalid-null-index',
      index: null,
      expected: 'bettle-周常-9-2.yaml',
      expectedAutoLoot: false,
    },
  ];

  for (const migrationCase of cases) {
    const root = path.join(
      temporaryDirectory,
      `loot-index-${migrationCase.name}`,
    );
    const projectRoot = path.join(root, 'project');
    const userData = path.join(root, 'user-data');
    const appPaths = new AppPaths({
      moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
      isPackaged: () => false,
      getPath: name => name === 'exe'
        ? path.join(projectRoot, 'AutoWSGR.exe')
        : userData,
      getResourcesPath: () => path.join(projectRoot, 'resources'),
    });
    const source = path.join(projectRoot, 'usersettings.yaml');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(source, [
      'daily_automation:',
      '  auto_loot: true',
      `  loot_plan_index: ${migrationCase.index}`,
      '',
    ].join('\n'), 'utf8');

    if (migrationCase.planPaths) {
      const templateFile = path.join(
        projectRoot,
        'resources',
        'resource',
        'builtin_templates.json',
      );
      fs.mkdirSync(path.dirname(templateFile), { recursive: true });
      fs.writeFileSync(templateFile, JSON.stringify([{
        id: 'builtin_farm_loot',
        planPaths: migrationCase.planPaths,
      }]), 'utf8');
    }

    const migration = new UserDataMigrationService(
      appPaths,
      new AtomicFileStore(),
    );
    const result = migration.migrateLegacyUserDataFiles();
    assert.equal(result.failed, 0);
    const migrated = yaml.load(fs.readFileSync(
      path.join(userData, 'usersettings.yaml'),
      'utf8',
    ));
    assert.equal(
      migrated.daily_automation.loot_plan_id,
      migrationCase.expected,
    );
    assert.equal(
      migrated.daily_automation.auto_loot,
      migrationCase.expectedAutoLoot ?? true,
    );
    assert.equal(
      Object.hasOwn(
        migrated.daily_automation,
        'loot_plan_index',
      ),
      false,
    );
    assert.equal(
      yaml.load(fs.readFileSync(source, 'utf8'))
        .daily_automation.loot_plan_index,
      migrationCase.index,
      '旧安装源配置不应被修改',
    );
  }

  const root = path.join(
    temporaryDirectory,
    'loot-index-already-moved-to-gui-json',
  );
  const projectRoot = path.join(root, 'project');
  const userData = path.join(root, 'user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const source = path.join(projectRoot, 'usersettings.yaml');
  const templateFile = path.join(
    projectRoot,
    'resources',
    'resource',
    'builtin_templates.json',
  );
  const guiSettingsFile = path.join(userData, 'gui_settings.json');
  fs.mkdirSync(path.dirname(templateFile), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(source, [
    'daily_automation:',
    '  auto_loot: true',
    '  loot_plan_index: 2',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(templateFile, JSON.stringify([{
    id: 'builtin_farm_loot',
    planPaths: legacyFivePlanPaths,
  }]), 'utf8');
  const migration = new UserDataMigrationService(
    appPaths,
    new AtomicFileStore(),
  );
  assert.equal(migration.shouldMigrateLegacyInstallation(), true);
  fs.writeFileSync(guiSettingsFile, JSON.stringify({
    automation: {
      autoLoot: true,
      lootPlanIndex: 2,
    },
  }), 'utf8');

  assert.equal(migration.migrateLegacyUserDataFiles().failed, 0);
  const migratedGui = JSON.parse(fs.readFileSync(guiSettingsFile, 'utf8'));
  assert.equal(
    migratedGui.automation.lootPlanId,
    'bettle-周常-7-4.yaml',
    '已搬到 GUI JSON 的旧五项索引没有恢复原地图',
  );
  assert.equal(
    Object.hasOwn(migratedGui.automation, 'lootPlanIndex'),
    false,
  );
  migration.migrateLegacyUserDataFiles();
  assert.equal(
    JSON.parse(fs.readFileSync(guiSettingsFile, 'utf8'))
      .automation.lootPlanId,
    'bettle-周常-7-4.yaml',
    '稳定标识不应在再次启动时被重复解释',
  );

  const retryRoot = path.join(
    temporaryDirectory,
    'loot-index-reconcile-retry',
  );
  const retryProjectRoot = path.join(retryRoot, 'project');
  const retryUserData = path.join(retryRoot, 'user-data');
  const retryAppPaths = new AppPaths({
    moduleDirectory: path.join(retryProjectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(retryProjectRoot, 'AutoWSGR.exe')
      : retryUserData,
    getResourcesPath: () => path.join(retryProjectRoot, 'resources'),
  });
  const retryGuiSettings = path.join(
    retryUserData,
    'gui_settings.json',
  );
  const retryTemplate = path.join(
    retryProjectRoot,
    'resources',
    'resource',
    'builtin_templates.json',
  );
  fs.mkdirSync(path.dirname(retryTemplate), { recursive: true });
  fs.mkdirSync(retryUserData, { recursive: true });
  fs.writeFileSync(
    path.join(retryProjectRoot, 'usersettings.yaml'),
    'daily_automation:\n  loot_plan_index: 2\n',
    'utf8',
  );
  fs.writeFileSync(retryTemplate, JSON.stringify([{
    id: 'builtin_farm_loot',
    planPaths: legacyFivePlanPaths,
  }]), 'utf8');

  const realAtomicFiles = new AtomicFileStore();
  let failReconcileWrite = true;
  const retryMigration = new UserDataMigrationService(
    retryAppPaths,
    {
      write(file, content) {
        if (
          failReconcileWrite
          && file === retryGuiSettings
          && content.includes('"lootPlanId"')
        ) {
          failReconcileWrite = false;
          throw new Error('模拟 GUI 索引纠正写入失败');
        }
        realAtomicFiles.write(file, content);
      },
    },
  );
  assert.equal(
    retryMigration.shouldMigrateLegacyInstallation(),
    true,
  );
  fs.writeFileSync(retryGuiSettings, JSON.stringify({
    automation: { autoLoot: true, lootPlanIndex: 2 },
  }), 'utf8');
  const originalConsoleError = console.error;
  let migrationFailureLogged = false;
  let failed;
  console.error = (...args) => {
    migrationFailureLogged = String(args[0]).startsWith('[Migration]');
  };
  try {
    failed = retryMigration.migrateLegacyUserDataFiles();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failed.failed, 1);
  assert.equal(migrationFailureLogged, true);
  assert.equal(failed.failedFiles.includes(retryGuiSettings), true);
  assert.equal(
    JSON.parse(fs.readFileSync(retryGuiSettings, 'utf8'))
      .automation.lootPlanIndex,
    2,
  );

  const resumedMigration = new UserDataMigrationService(
    retryAppPaths,
    realAtomicFiles,
  );
  assert.equal(
    resumedMigration.shouldMigrateLegacyInstallation(),
    true,
    '同一来源迁移失败后必须允许下一次启动重试',
  );
  const retried = resumedMigration.migrateLegacyUserDataFiles();
  assert.equal(retried.failed, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(retryGuiSettings, 'utf8'))
      .automation.lootPlanId,
    'bettle-周常-7-4.yaml',
    '纠正失败后必须在下次启动重试',
  );
}

/** 验证 v6 淘汰预设转为个人计划，并在失败后稳定重试。 */
function testPresetInventoryMigration() {
  const root = path.join(temporaryDirectory, 'preset-inventory-v6');
  const projectRoot = path.join(root, 'project');
  const userData = path.join(root, 'user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const sourceResources = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'resource',
    'migrations',
    'v6',
    'system_battle_plans',
  );
  const migrationResources = path.join(
    appPaths.resourceRoot(),
    'resource',
    'migrations',
    'v6',
    'system_battle_plans',
  );
  fs.mkdirSync(path.dirname(migrationResources), { recursive: true });
  fs.cpSync(sourceResources, migrationResources, { recursive: true });
  fs.mkdirSync(path.join(userData, 'templates'), { recursive: true });
  fs.mkdirSync(appPaths.userBattlePlansDir(), { recursive: true });

  const guiSettings = path.join(userData, 'gui_settings.json');
  const userSettings = path.join(userData, 'usersettings.yaml');
  const taskGroups = path.join(userData, 'task_groups.json');
  const templates = path.join(userData, 'templates', 'templates.json');
  fs.writeFileSync(guiSettings, JSON.stringify({
    automation: {
      autoLoot: true,
      lootPlanId: 'bettle-捞胖次-8-5.yaml',
    },
  }), 'utf8');
  fs.writeFileSync(userSettings, [
    'daily_automation:',
    '  auto_loot: true',
    '  loot_plan_id: bettle-捞胖次-9-4-6SS.yaml',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(taskGroups, JSON.stringify({
    version: 3,
    activeGroup: '旧预设',
    groups: [{
      name: '旧预设',
      items: [
        {
          path: 'resource/system_battle_plans/bettle-E1炸鱼.yaml',
          managedSource: 'system',
          managedFile: 'bettle-E1炸鱼.yaml',
          kind: 'plan',
          times: 1,
          label: 'E1 炸鱼',
        },
        {
          path: 'resource/builtin_plans/周常3章-3-3.yaml',
          kind: 'plan',
          times: 1,
          label: '旧周常 3-3',
        },
        {
          path: 'resource/system_battle_plans/bettle-周常-2-1.yaml',
          managedSource: 'system',
          managedFile: 'bettle-周常-2-1.yaml',
          kind: 'plan',
          times: 1,
          label: '当前周常 2-1',
        },
      ],
    }],
  }), 'utf8');
  fs.writeFileSync(templates, JSON.stringify([
    {
      id: 'legacy-event',
      planPath: 'resource/system_battle_plans/bettle-E5夜战.yaml',
    },
    {
      id: 'legacy-weekly',
      planPaths: [
        'resource/builtin_plans/周常6章-6-3.yaml',
        'resource/system_battle_plans/bettle-周常-2-1.yaml',
      ],
    },
  ]), 'utf8');

  const e1Source = path.join(migrationResources, 'bettle-E1炸鱼.yaml');
  const e5Source = path.join(migrationResources, 'bettle-E5夜战.yaml');
  const e1Target = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-E1炸鱼.yaml',
  );
  const e1LegacyTarget = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-E1炸鱼（旧版）.yaml',
  );
  fs.writeFileSync(e1Target, 'chapter: 99\nmap: 99\n', 'utf8');
  fs.copyFileSync(
    e5Source,
    path.join(appPaths.userBattlePlansDir(), 'bettle-E5夜战.yaml'),
  );

  const realAtomicFiles = new AtomicFileStore();
  let failTaskGroupWrite = true;
  const migration = new UserDataMigrationService(appPaths, {
    write(file, content) {
      if (failTaskGroupWrite && file === taskGroups) {
        failTaskGroupWrite = false;
        throw new Error('模拟 v6 任务组写入失败');
      }
      realAtomicFiles.write(file, content);
    },
  });
  migration.migrationState.write({
    version: 5,
    completed: ['v5-complete'],
  });

  const originalConsoleError = console.error;
  let firstResult;
  console.error = () => {};
  try {
    firstResult = migration.migratePresetInventory();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(firstResult.failed, 1);
  assert.equal(firstResult.failedFiles.includes(taskGroups), true);
  assert.equal(migration.migrationState.read().version, 5);
  assert.equal(
    fs.readFileSync(e1LegacyTarget, 'utf8'),
    fs.readFileSync(e1Source, 'utf8'),
    '同名不同内容的个人计划必须保留为旧版副本',
  );

  const retried = migration.migratePresetInventory();
  assert.deepEqual(
    {
      total: retried.total,
      succeeded: retried.succeeded,
      failed: retried.failed,
    },
    { total: 1, succeeded: 1, failed: 0 },
  );
  assert.equal(migration.migrationState.read().version, 6);
  assert.equal(
    migration.migrationState.read().completed.includes('v5-complete'),
    true,
  );

  const migratedGroups = JSON.parse(fs.readFileSync(taskGroups, 'utf8'));
  const [eventItem, weeklyItem, currentItem] = (
    migratedGroups.groups[0].items
  );
  assert.equal(eventItem.managedSource, 'user');
  assert.equal(eventItem.managedFile, 'bettle-E1炸鱼（旧版）.yaml');
  assert.equal(weeklyItem.managedSource, 'user');
  assert.equal(weeklyItem.managedFile, 'bettle-周常-3-3-v1.yaml');
  assert.equal(currentItem.managedSource, 'system');
  assert.equal(currentItem.managedFile, 'bettle-周常-2-1.yaml');

  const migratedTemplates = JSON.parse(fs.readFileSync(templates, 'utf8'));
  assert.equal(
    migratedTemplates[0].planPath,
    'user_battle_plans/bettle-E5夜战.yaml',
    '同名同内容的个人计划必须直接复用',
  );
  assert.deepEqual(migratedTemplates[1].planPaths, [
    'user_battle_plans/bettle-周常-6-3-v1.yaml',
    'resource/system_battle_plans/bettle-周常-2-1.yaml',
  ]);
  assert.equal(
    JSON.parse(fs.readFileSync(guiSettings, 'utf8'))
      .automation.lootPlanId,
    'bettle-old-8-5AI六潜胖次.yaml',
  );
  assert.equal(
    yaml.load(fs.readFileSync(userSettings, 'utf8'))
      .daily_automation.loot_plan_id,
    'bettle-old-9-4六潜练级.yaml',
  );
  assert.equal(migration.migratePresetInventory().total, 0);
  assert.equal(
    fs.readdirSync(appPaths.userBattlePlansDir())
      .filter(file => file.startsWith('bettle-E1炸鱼（旧版'))
      .length,
    1,
    '失败重试不能生成重复旧版副本',
  );
}

/** 验证阶段顺序、跨启动重试、递归计划扫描和持久报告。 */
function testMigrationStageOrderingAndRecursivePlans() {
  const root = path.join(temporaryDirectory, 'migration-stage-order');
  const legacyRoot = path.join(root, 'old-install');
  const userData = path.join(root, 'user-data');
  const resources = path.join(root, 'resources');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(root, 'unused', 'dist', 'electron'),
    isPackaged: () => true,
    getPath: name => name === 'exe'
      ? path.join(legacyRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => resources,
  });
  const migrationResources = path.join(
    resources,
    'resource',
    'migrations',
    'v6',
    'system_battle_plans',
  );
  fs.mkdirSync(path.dirname(migrationResources), { recursive: true });
  fs.cpSync(
    path.join(
      __dirname,
      '..',
      '..',
      '..',
      'resource',
      'migrations',
      'v6',
      'system_battle_plans',
    ),
    migrationResources,
    { recursive: true },
  );

  const nestedSource = path.join(
    legacyRoot,
    'plans',
    'nested',
    'deep',
    'nested.yaml',
  );
  fs.mkdirSync(path.dirname(nestedSource), { recursive: true });
  fs.writeFileSync(nestedSource, 'chapter: 1\nmap: 1\n', 'utf8');

  const taskGroups = path.join(userData, 'task_groups.json');
  const realAtomicFiles = new AtomicFileStore();
  let failV6Write = true;
  const firstMigration = new UserDataMigrationService(appPaths, {
    write(file, content) {
      if (failV6Write && file === taskGroups) {
        failV6Write = false;
        throw new Error('模拟 v6 阶段失败');
      }
      realAtomicFiles.write(file, content);
    },
  });
  assert.equal(
    firstMigration.shouldMigrateLegacyInstallation(),
    true,
  );
  assert.equal(
    firstMigration.migrateLegacyUserDataFiles().failed,
    0,
  );
  fs.writeFileSync(taskGroups, JSON.stringify({
    version: 3,
    groups: [{
      name: '旧任务',
      items: [{
        path: 'resource/system_battle_plans/bettle-E1炸鱼.yaml',
        managedSource: 'system',
        managedFile: 'bettle-E1炸鱼.yaml',
      }, {
        path: 'plans/nested/deep/nested.yaml',
      }],
    }],
  }), 'utf8');

  const blockedPlanMigration = createLegacyPlanMigration(
    appPaths,
    realAtomicFiles,
    firstMigration,
  );
  const originalConsoleError = console.error;
  let failedV6;
  console.error = () => {};
  try {
    failedV6 = firstMigration.migratePresetInventory();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failedV6.failed, 1);
  assert.equal(blockedPlanMigration.migrate().total, 0);
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userBattlePlansDir(),
      'bettle-nested.yaml',
    )),
    false,
    'v6 失败时 v7 不得提前迁移旧计划',
  );

  const resumedMigration = new UserDataMigrationService(
    appPaths,
    realAtomicFiles,
  );
  assert.equal(
    resumedMigration.shouldMigrateLegacyInstallation(),
    true,
  );
  const retriedV6 = resumedMigration.migratePresetInventory();
  assert.equal(retriedV6.failed, 0);
  const resumedPlanMigration = createLegacyPlanMigration(
    appPaths,
    realAtomicFiles,
    resumedMigration,
  );
  const planResult = resumedPlanMigration.migrate();
  assert.deepEqual(
    {
      total: planResult.total,
      succeeded: planResult.succeeded,
      failed: planResult.failed,
    },
    { total: 1, succeeded: 1, failed: 0 },
  );
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userBattlePlansDir(),
      'bettle-nested.yaml',
    )),
    true,
  );
  const migratedGroups = JSON.parse(
    fs.readFileSync(taskGroups, 'utf8'),
  );
  assert.equal(
    migratedGroups.groups[0].items[1].managedFile,
    'bettle-nested.yaml',
  );

  const report = resumedMigration.writeMigrationReport({
    detected: true,
    total: retriedV6.total + planResult.total,
    succeeded: retriedV6.succeeded + planResult.succeeded,
    failed: 0,
    failedFiles: [],
  });
  assert.ok(report);
  assert.match(report.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(
      path.join(userData, '.migration-report.json'),
      'utf8',
    )),
    report,
  );
  resumedMigration.completeLegacySourceMigration();
  assert.equal(
    new UserDataMigrationService(
      appPaths,
      realAtomicFiles,
    ).shouldMigrateLegacyInstallation(),
    false,
    '完整成功并写入报告后不应再次迁移同一来源',
  );

  const oldStateRoot = path.join(
    temporaryDirectory,
    'migration-old-version-seven',
  );
  const oldStateUserData = path.join(oldStateRoot, 'user-data');
  const oldStatePaths = new AppPaths({
    moduleDirectory: path.join(oldStateRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(oldStateRoot, 'AutoWSGR.exe')
      : oldStateUserData,
    getResourcesPath: () => path.join(oldStateRoot, 'resources'),
  });
  fs.mkdirSync(oldStateUserData, { recursive: true });
  const oldStateSettings = path.join(
    oldStateUserData,
    'gui_settings.json',
  );
  fs.writeFileSync(oldStateSettings, JSON.stringify({
    automation: {
      lootPlanId: 'bettle-捞胖次-8-5.yaml',
    },
  }), 'utf8');
  const oldStateMigration = new UserDataMigrationService(
    oldStatePaths,
    realAtomicFiles,
  );
  oldStateMigration.migrationState.write({
    version: 7,
    completed: [],
  });
  assert.equal(oldStateMigration.migratePresetInventory().failed, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(oldStateSettings, 'utf8'))
      .automation.lootPlanId,
    'bettle-old-8-5AI六潜胖次.yaml',
    '旧 version=7 状态缺少 v6 完成键时仍必须执行 v6',
  );
  assert.equal(
    oldStateMigration.migrationState.isStageComplete(
      'migration:v6:preset-inventory:complete',
    ),
    true,
  );
}

/** 验证迁移提示展示真实计数、失败文件和源文件保留说明。 */
function testLegacyMigrationNotice() {
  assert.equal(
    buildLegacyMigrationNotice({
      detected: false,
      total: 1,
      succeeded: 1,
      failed: 0,
      failedFiles: [],
    }),
    null,
  );
  assert.equal(
    buildLegacyMigrationNotice({
      detected: true,
      total: 0,
      succeeded: 0,
      failed: 0,
      failedFiles: [],
    }),
    null,
  );
  const successNotice = buildLegacyMigrationNotice({
    detected: true,
    total: 3,
    succeeded: 3,
    failed: 0,
    failedFiles: [],
  });
  assert.ok(successNotice);
  assert.equal(successNotice.type, 'info');
  assert.match(successNotice.message, /成功：3 项/);
  assert.match(successNotice.message, /失败：0 项/);
  const notice = buildLegacyMigrationNotice({
    detected: true,
    total: 5,
    succeeded: 4,
    failed: 1,
    failedFiles: ['C:\\old\\broken.yaml'],
  });
  assert.ok(notice);
  assert.equal(notice.type, 'warning');
  assert.match(notice.message, /当前已迁移旧版数据：5 项/);
  assert.match(notice.message, /成功：4 项/);
  assert.match(notice.message, /失败：1 项/);
  assert.match(notice.detail, /旧版本原始目录/);
  assert.match(notice.detail, /broken\.yaml/);
}

/** 验证同名计划保留为旧版副本，并在下次启动恢复实际引用。 */
function testLegacyPlanConflictRetry() {
  const root = path.join(temporaryDirectory, 'migration-conflict');
  const projectRoot = path.join(root, 'project');
  const userData = path.join(root, 'user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const atomicFiles = new AtomicFileStore();
  const userDataMigration = new UserDataMigrationService(
    appPaths,
    atomicFiles,
  );
  const teamCodec = new TeamPlanCodec();
  const teamRepository = new TeamPlanRepository(
    appPaths,
    atomicFiles,
    teamCodec,
  );
  const combatRepository = new CombatPlanRepository(
    appPaths,
    atomicFiles,
  );
  const combatCodec = new CombatPlanCodec(
    teamCodec,
    teamRepository,
  );
  const migration = new LegacyPlanMigration(
    appPaths,
    atomicFiles,
    userDataMigration,
    userDataMigration.migrationState,
    {
      yamlFiles: directory => combatRepository.yamlFiles(directory),
      safePlanBaseName: value => combatCodec.safeBaseName(value),
      normalizeUserTeamPlan: raw => teamCodec.normalizeLegacy(raw),
      teamPlanMatches: (filePath, team) => (
        teamRepository.matches(filePath, team)
      ),
      teamName: team => team.name,
      renameTeam: (team, name) => ({
        ...structuredClone(team),
        name,
      }),
      normalizeCombatPlanFleetPresets: (
        planRoot,
        source,
        requireEmbeddedShips,
      ) => combatCodec.normalizeLegacyFleetPresets(
        planRoot,
        source,
        requireEmbeddedShips,
      ),
      buildTeamPlanWrites: (teams, directory) => (
        teamRepository.buildWrites(teams, directory)
      ),
      serializeCombatPlan: (planRoot, originalContent) => (
        combatCodec.serialize(planRoot, originalContent)
      ),
    },
  );
  const source = path.join(projectRoot, 'plans', 'conflict.yaml');
  const target = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-conflict.yaml',
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'chapter: 1\nmap: 1\n', 'utf8');
  assert.equal(
    userDataMigration.shouldMigrateLegacyInstallation(),
    true,
  );
  assert.equal(
    userDataMigration.migrateLegacyUserDataFiles().failed,
    0,
  );
  assert.equal(userDataMigration.migratePresetInventory().failed, 0);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'chapter: 9\nmap: 9\n', 'utf8');
  fs.writeFileSync(
    path.join(userData, 'task_groups.json'),
    JSON.stringify({
      groups: [{
        name: '旧任务',
        items: [{ path: 'plans/conflict.yaml' }],
      }],
    }),
    'utf8',
  );

  const result = migration.migrate();
  const legacyTarget = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-conflict（旧版）.yaml',
  );
  assert.deepEqual(
    {
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
    },
    { total: 1, succeeded: 1, failed: 0 },
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'chapter: 9\nmap: 9\n');
  assert.equal(fs.existsSync(source), true);
  assert.equal(yaml.load(fs.readFileSync(legacyTarget, 'utf8')).chapter, 1);
  assert.equal(userDataMigration.migrationState.read().version, 7);
  assert.equal(
    userDataMigration.migrationState.read().completed.some(
      value => value.startsWith('plan-output-v7:'),
    ),
    true,
  );
  let taskGroups = JSON.parse(
    fs.readFileSync(path.join(userData, 'task_groups.json'), 'utf8'),
  );
  assert.equal(
    taskGroups.groups[0].items[0].managedFile,
    'bettle-conflict（旧版）.yaml',
  );

  assert.equal(migration.migrate().total, 0);
  taskGroups = JSON.parse(
    fs.readFileSync(path.join(userData, 'task_groups.json'), 'utf8'),
  );
  assert.equal(
    taskGroups.groups[0].items[0].managedFile,
    'bettle-conflict（旧版）.yaml',
  );
}

/** 验证已有 userData 时切换安装目录不会重新导入旧文件。 */
function testInitializedUserDataBlocksLegacyInstall() {
  const root = path.join(temporaryDirectory, 'migration-existing-data');
  const projectRoot = path.join(root, 'old-install');
  const userData = path.join(root, 'user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const atomicFiles = new AtomicFileStore();
  const userDataMigration = new UserDataMigrationService(
    appPaths,
    atomicFiles,
  );
  const teamCodec = new TeamPlanCodec();
  const teamRepository = new TeamPlanRepository(
    appPaths,
    atomicFiles,
    teamCodec,
  );
  const combatRepository = new CombatPlanRepository(
    appPaths,
    atomicFiles,
  );
  const combatCodec = new CombatPlanCodec(
    teamCodec,
    teamRepository,
  );
  const sourceTaskGroups = path.join(projectRoot, 'task_groups.json');
  const targetTaskGroups = path.join(userData, 'task_groups.json');
  const sourcePlan = path.join(projectRoot, 'plans', 'old.yaml');
  const migratedPlan = path.join(
    appPaths.userBattlePlansDir(),
    'bettle-old.yaml',
  );
  const sourcePlanContent = [
    'chapter: 9',
    'map: 3',
    'fleet_presets:',
    '  - name: Legacy Team',
    '    ships:',
    '      - Old Ship',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(sourcePlan), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(appPaths.userBattlePlansDir(), { recursive: true });
  fs.mkdirSync(appPaths.userTeamPlansDir(), { recursive: true });
  fs.writeFileSync(sourcePlan, sourcePlanContent, 'utf8');
  const split = combatCodec.normalizeFleetPresets(
    yaml.load(sourcePlanContent),
    'user',
    false,
  );
  fs.writeFileSync(
    migratedPlan,
    combatCodec.serialize(split.mapRoot, sourcePlanContent),
    'utf8',
  );
  const [existingTeam] = teamRepository.buildWrites(
    [{
      name: 'Legacy Team',
      ships: [{ name: 'Current Ship' }],
    }],
    appPaths.userTeamPlansDir(),
  );
  assert.ok(existingTeam);
  fs.writeFileSync(existingTeam.path, existingTeam.content, 'utf8');
  fs.writeFileSync(
    sourceTaskGroups,
    JSON.stringify({
      activeGroup: '默认',
      groups: [
        {
          name: '默认',
          items: [{
            path: 'plans/old.yaml',
            kind: 'plan',
            times: 2,
            label: '旧计划',
          }],
        },
        { name: '决战', items: [] },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    targetTaskGroups,
    JSON.stringify({
      version: 2,
      activeGroup: '默认',
      groups: [{
        name: '默认',
        items: [{
          managedSource: 'system',
          managedFile: 'weekly.yaml',
          kind: 'plan',
          times: 1,
          label: '当前计划',
        }],
      }],
    }),
    'utf8',
  );
  userDataMigration.migrationState.write({
    version: 3,
    completed: ['existing-install-complete'],
  });

  assert.equal(
    userDataMigration.shouldMigrateLegacyInstallation(),
    false,
  );
  assert.equal(
    userDataMigration.migrateLegacyUserDataFiles().total,
    0,
  );
  let taskGroups = JSON.parse(
    fs.readFileSync(targetTaskGroups, 'utf8'),
  );
  assert.deepEqual(
    taskGroups.groups.map(group => group.name),
    ['默认'],
  );
  assert.equal(taskGroups.activeGroup, '默认');

  const migration = new LegacyPlanMigration(
    appPaths,
    atomicFiles,
    userDataMigration,
    userDataMigration.migrationState,
    {
      yamlFiles: directory => combatRepository.yamlFiles(directory),
      safePlanBaseName: value => combatCodec.safeBaseName(value),
      normalizeUserTeamPlan: raw => teamCodec.normalizeLegacy(raw),
      teamPlanMatches: (filePath, team) => (
        teamRepository.matches(filePath, team)
      ),
      teamName: team => team.name,
      renameTeam: (team, name) => ({
        ...structuredClone(team),
        name,
      }),
      normalizeCombatPlanFleetPresets: (
        planRoot,
        source,
        requireEmbeddedShips,
      ) => combatCodec.normalizeLegacyFleetPresets(
        planRoot,
        source,
        requireEmbeddedShips,
      ),
      buildTeamPlanWrites: (teams, directory) => (
        teamRepository.buildWrites(teams, directory)
      ),
      serializeCombatPlan: (planRoot, originalContent) => (
        combatCodec.serialize(planRoot, originalContent)
      ),
    },
  );
  userDataMigration.migratePresetInventory();
  assert.equal(userDataMigration.migrationState.read().version, 6);
  migration.migrate();

  taskGroups = JSON.parse(fs.readFileSync(targetTaskGroups, 'utf8'));
  assert.equal(fs.existsSync(migratedPlan), true);
  assert.equal(fs.existsSync(sourcePlan), true);
  assert.equal(taskGroups.groups.length, 1);
  assert.equal(taskGroups.groups[0].items[0].managedFile, 'weekly.yaml');
  assert.equal(
    fs.readFileSync(existingTeam.path, 'utf8'),
    existingTeam.content,
  );
  assert.equal(userDataMigration.migrationState.read().version, 7);

  userDataMigration.migrateLegacyUserDataFiles();
  migration.migrate();
  taskGroups = JSON.parse(fs.readFileSync(targetTaskGroups, 'utf8'));
  assert.equal(taskGroups.groups.length, 1);
}

/** 验证迁移冲突识别、保留、删除和任务列表引用重写。 */
function testMigrationConflictResolution() {
  const root = path.join(temporaryDirectory, 'migration-conflicts');
  const projectRoot = path.join(root, 'project');
  const userData = path.join(root, 'user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const atomicFiles = new AtomicFileStore();
  const conflicts = new MigrationConflictService(appPaths, atomicFiles);
  for (const directory of [
    appPaths.systemBattlePlansDir(),
    appPaths.userBattlePlansDir(),
    appPaths.systemDailyPlansDir(),
    appPaths.userDailyPlansDir(),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const systemBattleFile = 'bettle-系统相同.yaml';
  const userBattleFile = 'bettle-迁移副本.yaml';
  fs.writeFileSync(
    path.join(appPaths.systemBattlePlansDir(), systemBattleFile),
    'chapter: 1\nmap: 2\nnode_defaults:\n  formation: 2\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(appPaths.userBattlePlansDir(), userBattleFile),
    'node_defaults: { formation: 2 }\nmap: 2\nchapter: 1\n',
    'utf8',
  );

  const dailyFile = 'campaign-普通驱逐.yaml';
  fs.writeFileSync(
    path.join(appPaths.systemDailyPlansDir(), dailyFile),
    'task_type: campaign\ncampaign_name: 简单驱逐\ntimes: 1\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(appPaths.userDailyPlansDir(), dailyFile),
    'task_type: campaign\ncampaign_name: 简单驱逐\ntimes: 3\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(appPaths.userBattlePlansDir(), 'bettle-重名.yaml'),
    'chapter: 2\nmap: 1\n',
    'utf8',
  );
  const legacyCopyFile = 'bettle-重名（旧版）.yaml';
  fs.writeFileSync(
    path.join(appPaths.userBattlePlansDir(), legacyCopyFile),
    'chapter: 3\nmap: 1\n',
    'utf8',
  );
  const taskGroupsPath = path.join(userData, 'task_groups.json');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    taskGroupsPath,
    JSON.stringify({
      version: 4,
      groups: [{
        name: '默认',
        items: [{
          kind: 'plan',
          managedSource: 'user',
          managedFile: userBattleFile,
          label: '迁移副本',
        }],
      }],
    }),
    'utf8',
  );
  const guiSettingsPath = path.join(userData, 'gui_settings.json');
  fs.writeFileSync(
    guiSettingsPath,
    JSON.stringify({
      automation: {
        autoLoot: true,
        lootPlanSource: 'user',
        lootPlanId: userBattleFile,
        lootPlans: [
          {
            source: 'system',
            file: systemBattleFile,
            name: '系统相同',
          },
          {
            source: 'user',
            file: userBattleFile,
            name: '迁移副本',
          },
        ],
      },
    }),
    'utf8',
  );

  conflicts.prepareAfterMigration(false);
  const pending = conflicts.pending();
  assert.equal(pending.pending, true);
  assert.equal(pending.conflicts.length, 3);
  const sameContent = pending.conflicts.find(conflict => (
    conflict.file === userBattleFile
  ));
  assert.ok(sameContent);
  assert.equal(
    sameContent.reasons[0].reasonCode,
    'same_as_system_preset',
  );
  const sameName = pending.conflicts.find(conflict => (
    conflict.file === dailyFile
  ));
  assert.ok(sameName);
  assert.equal(
    sameName.reasons[0].reasonCode,
    'same_name_as_system_preset',
  );
  const legacyCopy = pending.conflicts.find(conflict => (
    conflict.file === legacyCopyFile
  ));
  assert.ok(legacyCopy);
  assert.equal(
    legacyCopy.reasons[0].reasonCode,
    'legacy_copy_name_conflict',
  );

  const result = conflicts.resolve([
    sameName.id,
    legacyCopy.id,
  ]);
  assert.equal(result.success, true);
  assert.equal(result.deleted, 1);
  assert.equal(result.kept, 2);
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userBattlePlansDir(),
      userBattleFile,
    )),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(appPaths.userDailyPlansDir(), dailyFile)),
    true,
  );
  const migratedGroups = JSON.parse(
    fs.readFileSync(taskGroupsPath, 'utf8'),
  );
  assert.equal(
    migratedGroups.groups[0].items[0].managedSource,
    'system',
  );
  assert.equal(
    migratedGroups.groups[0].items[0].managedFile,
    systemBattleFile,
  );
  const migratedGuiSettings = JSON.parse(
    fs.readFileSync(guiSettingsPath, 'utf8'),
  );
  assert.equal(
    migratedGuiSettings.automation.lootPlanSource,
    'system',
  );
  assert.equal(
    migratedGuiSettings.automation.lootPlanId,
    systemBattleFile,
  );
  assert.deepEqual(
    migratedGuiSettings.automation.lootPlans,
    [{
      source: 'system',
      file: systemBattleFile,
      name: '系统相同',
    }],
  );
  assert.equal(conflicts.pending().pending, false);

  conflicts.prepareAfterMigration(true);
  assert.equal(
    conflicts.pending().pending,
    false,
    '已确认保留且内容未变化的冲突不应重复提示',
  );
  const newCopyFile = 'bettle-新增迁移副本.yaml';
  fs.writeFileSync(
    path.join(appPaths.userBattlePlansDir(), newCopyFile),
    'chapter: 1\nmap: 2\nnode_defaults:\n  formation: 2\n',
    'utf8',
  );
  conflicts.prepareAfterMigration(true);
  const rescanned = conflicts.pending();
  assert.equal(rescanned.conflicts.length, 1);
  assert.equal(rescanned.conflicts[0].file, newCopyFile);
  const keepAll = conflicts.resolve(
    rescanned.conflicts.map(conflict => conflict.id),
  );
  assert.equal(keepAll.success, true);
  assert.equal(keepAll.deleted, 0);
  assert.equal(keepAll.kept, 1);
  assert.equal(conflicts.pending().pending, false);
}

module.exports = {
  testUserDataMigration,
};
