/**
 * 作战计划 Codec、Repository 和 Service 测试。
 *
 * 复用同一隔离临时目录，不读取或修改真实用户数据。
 */
const context = require('./test-context');
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
  LegacyPlanMigration,
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

/** 验证出征计划格式、运行时展开和管理流程保持既有语义。 */
function testCombatPlanServices() {
  const projectRoot = path.join(temporaryDirectory, 'combat-project');
  const userData = path.join(temporaryDirectory, 'combat-user-data');
  const tempDirectory = path.join(temporaryDirectory, 'combat-temp');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const atomicFiles = new AtomicFileStore();
  const settings = new GuiSettingsStore(
    () => path.join(userData, 'gui_settings.json'),
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
  const runtimePlans = new RuntimePlanService(
    combatCodec,
    combatRepository,
    atomicFiles,
    {
      getTempDirectory: () => tempDirectory,
      processId: 42,
      now: () => 123456,
    },
  );
  const management = new PlanManagementService(
    combatCodec,
    combatRepository,
    runtimePlans,
    teamRepository,
    settings,
    new TaskPresetCodec(),
  );
  combatRepository.initializeSystemDirectory();
  combatRepository.initializeUserDirectory();
  teamRepository.initializeSystemDirectory();
  teamRepository.initializeUserDirectory();

  const split = combatCodec.normalizeFleetPresets({
    chapter: 1,
    map: 2,
    rootExtension: { preserved: true },
    fleet_presets: [{
      name: '内嵌舰队',
      ships: [{
        candidates: [{ name: 'U-47', customCandidate: true }],
      }],
    }],
  }, 'user', true);
  assert.equal(split.mapRoot.rootExtension.preserved, true);
  assert.deepEqual(split.mapRoot.fleet_presets, [{
    name: '内嵌舰队',
  }]);
  assert.equal(split.teams[0].ships[0].name, undefined);
  assert.equal(
    split.teams[0].ships[0].candidates[0].customCandidate,
    true,
  );

  const serialized = combatCodec.serialize(
    split.mapRoot,
    '# 保留注释\nchapter: 1\n',
  );
  assert.match(serialized, /^# 保留注释\n/);
  assert.equal(yaml.load(serialized).rootExtension.preserved, true);
  assert.equal(combatCodec.safeBaseName('bettle-测试?.yaml'), '测试_');

  assert.equal(
    combatRepository.safeUserPath('../outside.yaml'),
    null,
  );
  assert.equal(
    combatRepository.safeManagedPath('user', 'not-yaml.txt'),
    null,
  );
  assert.throws(
    () => runtimePlans.write(
      'chapter: 1\nmap: 2\nfleet_presets:\n  - name: 未展开\n',
      'unexpanded',
    ),
    /运行时出征计划包含尚未展开的舰队引用/,
  );

  const editableContent = [
    '# 编辑器注释',
    'chapter: 1',
    'map: 2',
    'times: 3',
    'selected_nodes: [A, B]',
    'customRoot: keep',
    'fleet_presets:',
    '  - name: 测试舰队',
    '    ships:',
    '      - name: 重庆',
    '        ship_type: [CL]',
    '        min_level: 20',
    '        max_level: 90',
    '        relaxed: true',
    '        candidates:',
    '          - name: U-47',
    '            ship_type: [SS]',
    '            min_level: 30',
    '            max_level: 80',
    '            relaxed: true',
    '',
  ].join('\n');
  const saved = management.saveManaged(
    '测试计划',
    editableContent,
    false,
  );
  assert.equal(saved.success, true);
  assert.deepEqual(saved.teamFiles, ['team-测试舰队.yaml']);
  const savedMap = combatRepository.read(saved.path);
  assert.match(savedMap, /^# 编辑器注释\n/);
  assert.equal(yaml.load(savedMap).customRoot, 'keep');
  assert.deepEqual(yaml.load(savedMap).fleet_presets, [{
    name: '测试舰队',
  }]);
  const savedTeamContent = fs.readFileSync(path.join(
    appPaths.userTeamPlansDir(),
    'team-测试舰队.yaml',
  ), 'utf8');
  const savedTeam = yaml.load(savedTeamContent);
  assert.equal(savedTeamContent.includes([
    '  - name: 重庆',
    '    ship_type: [cl]',
    '    min_level: 20',
    '    max_level: 90',
    '    relaxed: true',
  ].join('\n')), true);
  assert.equal(savedTeamContent.includes([
    '{name: U-47, ship_type: [ss], min_level: 30,',
    'max_level: 80, relaxed: true}',
  ].join(' ')), true);
  assert.deepEqual(savedTeam.ships[0].ship_type, ['cl']);
  assert.equal(savedTeam.ships[0].min_level, 20);
  assert.equal(savedTeam.ships[0].max_level, 90);
  assert.equal(savedTeam.ships[0].relaxed, true);
  assert.deepEqual(savedTeam.ships[0].candidates[0].ship_type, ['ss']);
  assert.equal(savedTeam.ships[0].candidates[0].min_level, 30);
  assert.equal(savedTeam.ships[0].candidates[0].max_level, 80);
  assert.equal(savedTeam.ships[0].candidates[0].relaxed, true);

  // 旧 renderer 即使继续多传 system，也只能保存为用户计划。
  const readonlyBoundary = management.saveManaged(
    '只读边界',
    'chapter: 1\nmap: 1\n',
    false,
    undefined,
    'system',
  );
  assert.equal(readonlyBoundary.success, true);
  assert.equal(readonlyBoundary.source, 'user');
  assert.equal(
    readonlyBoundary.path,
    path.join(
      appPaths.userBattlePlansDir(),
      'bettle-只读边界.yaml',
    ),
  );
  assert.equal(
    fs.existsSync(path.join(
      appPaths.systemBattlePlansDir(),
      'bettle-只读边界.yaml',
    )),
    false,
  );
  assert.deepEqual(
    management.deleteUserCombat('bettle-只读边界.yaml'),
    { success: true },
  );

  const prepared = management.readManaged(
    'user',
    'bettle-测试计划.yaml',
  );
  assert.equal(prepared.success, true);
  assert.equal(prepared.sourcePath, saved.path);
  assert.match(
    prepared.runtimePath,
    /测试计划-123456-1\.yaml$/,
  );
  const preparedPlan = yaml.load(prepared.content);
  const preparedSlot = preparedPlan.fleet_presets[0].ships[0];
  assert.equal(preparedSlot.name, '重庆');
  assert.deepEqual(preparedSlot.ship_type, ['cl']);
  assert.equal(preparedSlot.min_level, 20);
  assert.equal(preparedSlot.max_level, 90);
  assert.equal(preparedSlot.relaxed, true);
  assert.deepEqual(preparedSlot.candidates[0].ship_type, ['ss']);
  assert.equal(preparedSlot.candidates[0].min_level, 30);
  assert.equal(preparedSlot.candidates[0].max_level, 80);
  assert.equal(preparedSlot.candidates[0].relaxed, true);

  const duplicate = management.saveManaged(
    '测试计划',
    editableContent.replace('重庆', '长春'),
    false,
  );
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.exists, true);
  assert.equal(duplicate.error, '存在同名配置');
  assert.deepEqual(duplicate.conflicts, [
    '地图：bettle-测试计划.yaml',
    '舰队：测试舰队',
  ]);

  const localLegacyPlan = path.join(
    temporaryDirectory,
    'local-legacy-plan.yaml',
  );
  const legacyContent = [
    '# 本地旧计划',
    'chapter: 2',
    'map: 3',
    'customRoot: keep',
    'fleet_presets:',
    '  - name: 旧版导入舰队',
    '    ships:',
    '      - U-47',
    '      - priority: [U-96, U-81]',
    '        ship_type: [ss]',
    '      - ship_type: ss',
    '        min_level: 100',
    '',
  ].join('\n');
  fs.writeFileSync(localLegacyPlan, legacyContent, 'utf8');
  const imported = management.importLocal(localLegacyPlan);
  assert.equal(imported.success, true);
  assert.equal(imported.file, 'bettle-local-legacy-plan.yaml');
  assert.equal(fs.readFileSync(localLegacyPlan, 'utf8'), legacyContent);
  assert.deepEqual(
    yaml.load(fs.readFileSync(imported.path, 'utf8')).fleet_presets,
    [{ name: '旧版导入舰队' }],
  );
  const importedTeamPath = path.join(
    appPaths.userTeamPlansDir(),
    'team-旧版导入舰队.yaml',
  );
  assert.deepEqual(
    yaml.load(fs.readFileSync(importedTeamPath, 'utf8')).ships,
    [
      { name: 'U-47' },
      {
        ship_type: ['ss'],
        candidates: [
          { name: 'U-96', ship_type: ['ss'] },
          { name: 'U-81', ship_type: ['ss'] },
        ],
      },
      {
        ship_type: ['ss'],
        min_level: 100,
      },
    ],
  );

  fs.writeFileSync(
    localLegacyPlan,
    legacyContent.replace('U-47', 'U-505'),
    'utf8',
  );
  const importConflict = management.importLocal(localLegacyPlan);
  assert.equal(importConflict.success, false);
  assert.equal(importConflict.exists, true);
  assert.deepEqual(importConflict.conflicts, [
    '地图：bettle-local-legacy-plan.yaml',
    '舰队：旧版导入舰队',
  ]);
  assert.equal(
    yaml.load(fs.readFileSync(importedTeamPath, 'utf8')).ships[0].name,
    'U-47',
  );
  const importedOverwrite = management.importLocal(
    localLegacyPlan,
    true,
  );
  assert.equal(importedOverwrite.success, true);
  assert.equal(
    yaml.load(fs.readFileSync(importedTeamPath, 'utf8')).ships[0].name,
    'U-505',
  );

  const dailyTaskFixtures = [
    {
      file: '战役.yaml',
      type: 'campaign',
      content: 'task_type: campaign\ncampaign_name: 困难航母\ntimes: 8\n',
    },
    {
      file: '自动演习.yaml',
      type: 'exercise',
      content: 'task_type: exercise\nfleet_id: 4\n',
    },
    {
      file: '决战.yaml',
      type: 'decisive',
      content: [
        'task_type: decisive',
        'chapter: 6',
        'level1: [鲃鱼]',
        'level2: [巧言]',
        '',
      ].join('\n'),
    },
  ];
  dailyTaskFixtures.forEach((fixture) => {
    const sourcePath = path.join(temporaryDirectory, fixture.file);
    fs.writeFileSync(sourcePath, fixture.content, 'utf8');
    const result = management.importLocal(sourcePath);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      '演习、战役和决战配置请使用“加载日常任务”管理',
    );
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), fixture.content);
  });
  const normalFightPreset = path.join(
    temporaryDirectory,
    '普通出征任务.yaml',
  );
  fs.writeFileSync(
    normalFightPreset,
    'task_type: normal_fight\nplan_id: 1-1\ntimes: 2\n',
    'utf8',
  );
  const importedPreset = management.importLocal(normalFightPreset);
  assert.equal(importedPreset.success, true);
  assert.equal(importedPreset.kind, 'preset');
  const managedPreset = management.readManaged(
    'user',
    importedPreset.file,
  );
  assert.equal(managedPreset.success, true);
  assert.equal(managedPreset.kind, 'preset');
  assert.equal(managedPreset.runtimePath, undefined);
  const taskPresetCodec = new TaskPresetCodec();
  assert.throws(
    () => taskPresetCodec.normalize({
      task_type: 'normal_fight',
      plan_id: '../outside.yaml',
    }),
    /plan_id 不能引用受管目录外的路径/,
  );
  assert.throws(
    () => taskPresetCodec.normalize({
      task_type: 'exercise',
      fleet_id: 5,
    }),
    /fleet_id 必须是 1 到 4/,
  );
  assert.throws(
    () => taskPresetCodec.normalize({
      task_type: 'campaign',
      campaign_name: '困难航母',
      stop_condition: 'invalid',
    }),
    /stop_condition 必须是对象/,
  );
  assert.deepEqual(
    management.deleteUserCombat(importedPreset.file),
    { success: true },
  );

  assert.deepEqual(
    management.importLocal(path.join(temporaryDirectory, 'plan.txt')),
    { success: false, error: '本地出征计划路径不合法' },
  );
  assert.deepEqual(
    management.deleteUserCombat('bettle-local-legacy-plan.yaml'),
    { success: true },
  );
  assert.deepEqual(
    management.deleteUserTeam('team-旧版导入舰队.yaml'),
    { success: true },
  );

  assert.deepEqual(
    management.setUnlinkedIgnored(
      'battle',
      'user',
      'bettle-测试计划.yaml',
      true,
    ),
    ['battle/user/bettle-测试计划.yaml'],
  );
  const renamed = management.saveManaged(
    '重命名计划',
    [
      'chapter: 1',
      'map: 2',
      'fleet_presets:',
      '  - name: 测试舰队',
      '',
    ].join('\n'),
    false,
    'bettle-测试计划.yaml',
  );
  assert.equal(renamed.success, true);
  assert.equal(combatRepository.exists(saved.path), false);
  assert.deepEqual(
    settings.read().plan_management_ignored_unlinked,
    ['battle/user/bettle-重命名计划.yaml'],
  );

  teamRepository.write(
    path.join(
      appPaths.systemTeamPlansDir(),
      'team-系统舰队.yaml',
    ),
    [
      'name: 系统舰队',
      'ships:',
      '  - name: 系统舰',
      '',
    ].join('\n'),
  );
  combatRepository.write(
    path.join(
      appPaths.systemBattlePlansDir(),
      'bettle-系统计划.yaml',
    ),
    [
      'chapter: 3',
      'map: 4',
      'fleet_presets:',
      '  - name: 系统舰队',
      '',
    ].join('\n'),
  );
  const summary = management.get();
  assert.equal(summary.battlePlans.length, 2);
  const userSummary = summary.battlePlans.find(
    plan => plan.source === 'user',
  );
  const systemSummary = summary.battlePlans.find(
    plan => plan.source === 'system',
  );
  assert.equal(userSummary.name, '重命名计划');
  assert.equal(userSummary.chapter, 1);
  assert.equal(userSummary.map, 2);
  assert.equal(userSummary.fleetCount, 1);
  assert.equal(userSummary.fleets[0].primaryCount, 1);
  assert.equal(userSummary.fleets[0].backupCount, 1);
  assert.equal(systemSummary.name, '系统计划');
  assert.equal(systemSummary.chapter, 3);
  assert.equal(systemSummary.map, 4);
  assert.equal(
    summary.teamPlans.some(plan => plan.source === 'system'),
    true,
  );
  const preparedSystem = management.readManaged(
    'system',
    'bettle-系统计划.yaml',
  );
  assert.equal(preparedSystem.success, true);
  assert.equal(
    yaml.load(preparedSystem.content).fleet_presets[0].ships[0].name,
    '系统舰',
  );

  const legacyEventPlans = [
    {
      file: 'E1炸鱼.yaml',
      content: [
        '# 20260730 激斗漩涡 E-1 alpha 入口示例',
        'event: "20260730"',
        'chapter: E',
        'map: 1a',
        'selected_nodes: [B]',
        'node_defaults:',
        '  proceed: False',
        '  formation: 5',
        '',
      ].join('\n'),
      expected: ['E', '1a', ['B']],
    },
    {
      file: 'E5夜战.yaml',
      content: [
        '# 20260730 激斗漩涡 E-5 alpha 入口示例',
        'event: "20260730"',
        'chapter: E',
        'map: 5a',
        'selected_nodes: [A, B, C, D, F]',
        'node_defaults:',
        '  night: True',
        '  proceed: True',
        '  formation: 4',
        'node_args:',
        '  C:',
        '    proceed: False',
        '  D:',
        '    proceed: False',
        '  F:',
        '    proceed: False',
        '',
      ].join('\n'),
      expected: ['E', '5a', ['A', 'B', 'C', 'D', 'F']],
    },
    {
      file: 'H1炸鱼.yaml',
      content: [
        '# 20260730 激斗漩涡 H-1 alpha 入口示例',
        'event: "20260730"',
        'chapter: H',
        'map: 1a',
        'selected_nodes: [B]',
        'node_defaults:',
        '  proceed: False',
        '  formation: 5',
        '',
      ].join('\n'),
      expected: ['H', '1a', ['B']],
    },
    {
      file: 'H5夜战.yaml',
      content: [
        '# 20260730 激斗漩涡 H-5 alpha 入口示例',
        'event: "20260730"',
        'chapter: H',
        'map: 5a',
        'selected_nodes: [A, B, C, D, F]',
        'node_defaults:',
        '  night: True',
        '  proceed: True',
        '  formation: 4',
        'node_args:',
        '  C:',
        '    proceed: False',
        '  D:',
        '    proceed: False',
        '  F:',
        '    proceed: False',
        '',
      ].join('\n'),
      expected: ['H', '5a', ['A', 'B', 'C', 'D', 'F']],
    },
  ];
  legacyEventPlans.forEach((fixture) => {
    const systemFile = `bettle-${fixture.file}`;
    combatRepository.write(
      path.join(appPaths.systemBattlePlansDir(), systemFile),
      fixture.content,
    );
    const preparedEvent = management.readManaged(
      'system',
      systemFile,
    );
    assert.equal(preparedEvent.success, true);
    assert.equal(fs.existsSync(preparedEvent.runtimePath), true);
    const eventPlan = yaml.load(preparedEvent.content);
    assert.equal(eventPlan.event, '20260730');
    assert.deepEqual(
      [eventPlan.chapter, eventPlan.map, eventPlan.selected_nodes],
      fixture.expected,
    );
  });

  assert.deepEqual(
    management.deleteUserCombat('bettle-重命名计划.yaml'),
    { success: true },
  );
  assert.deepEqual(
    management.deleteUserTeam('team-测试舰队.yaml'),
    { success: true },
  );
}

module.exports = {
  testCombatPlanServices,
};
