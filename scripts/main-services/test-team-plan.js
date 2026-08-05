/**
 * 编队 Codec、Repository 和 Service 测试。
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
  ShipLibraryService,
  ShipLibraryUpdater,
  AdbService,
  CudaEnvironmentService,
  GuiConfigurationService,
  PythonEnvironmentService,
  temporaryDirectory,
} = context;

/** 验证编队格式、仓储和保存流程保持原有业务语义。 */
function testTeamPlanServices() {
  const projectRoot = path.join(temporaryDirectory, 'team-project');
  const userData = path.join(temporaryDirectory, 'team-user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const codec = new TeamPlanCodec();
  const repository = new TeamPlanRepository(
    appPaths,
    new AtomicFileStore(),
    codec,
  );
  const service = new TeamPlanService(codec, repository);
  repository.initializeSystemDirectory();
  repository.initializeUserDirectory();

  const candidateOnly = codec.normalize({
    name: '备选位置',
    rootExtension: { preserved: true },
    ships: [{
      slotExtension: 'keep',
      candidates: [{
        name: 'U-47',
        ship_type: ['SS'],
        customCandidate: true,
      }],
    }],
  });
  assert.equal(candidateOnly.ships[0].name, undefined);
  assert.deepEqual(candidateOnly.ships[0].ship_type, undefined);
  assert.deepEqual(
    candidateOnly.ships[0].candidates[0].ship_type,
    ['ss'],
  );

  const serialized = codec.serialize(candidateOnly);
  const serializedObject = yaml.load(serialized);
  assert.equal(serializedObject.rootExtension.preserved, true);
  assert.equal(serializedObject.ships[0].name, undefined);
  assert.equal(serializedObject.ships[0].slotExtension, 'keep');
  assert.equal(
    serializedObject.ships[0].candidates[0].customCandidate,
    true,
  );
  const relaxedRules = codec.normalize({
    name: '宽泛校验',
    ships: [{
      name: '重庆',
      relaxed: true,
      candidates: [
        '长春',
        { name: '昆西', relaxed: true },
      ],
    }],
  });
  assert.equal(relaxedRules.ships[0].relaxed, true);
  assert.equal(relaxedRules.ships[0].candidates[0].relaxed, undefined);
  assert.equal(relaxedRules.ships[0].candidates[1].relaxed, true);
  const serializedRelaxedRule = yaml.load(
    codec.serialize(relaxedRules),
  ).ships[0];
  assert.equal(serializedRelaxedRule.relaxed, true);
  assert.equal(
    Object.hasOwn(serializedRelaxedRule.candidates[0], 'relaxed'),
    false,
  );
  assert.equal(serializedRelaxedRule.candidates[1].relaxed, true);
  const orderedRelaxedContent = codec.serialize(codec.normalize({
    name: '宽泛字段顺序',
    ships: [{
      relaxed: true,
      max_level: 90,
      min_level: 20,
      ship_type: ['CL'],
      name: '重庆',
      candidates: [{
        relaxed: true,
        max_level: 80,
        min_level: 30,
        ship_type: ['DD'],
        name: '昆西',
      }],
    }],
  }));
  assert.equal(orderedRelaxedContent, [
    'name: 宽泛字段顺序',
    'ships:',
    '  - name: 重庆',
    '    ship_type: [cl]',
    '    min_level: 20',
    '    max_level: 90',
    '    relaxed: true',
    '    candidates:',
    '      - {name: 昆西, ship_type: [dd], min_level: 30, max_level: 80, relaxed: true}',
    '',
  ].join('\n'));
  const disabledRelaxedContent = codec.serialize(codec.normalize({
    name: '关闭宽泛校验',
    ships: [{
      name: '重庆',
      relaxed: false,
      candidates: [{ name: '昆西', relaxed: false }],
    }],
  }));
  assert.doesNotMatch(disabledRelaxedContent, /relaxed/);
  const loadedRelaxedPath = path.join(
    appPaths.userTeamPlansDir(),
    'team-加载宽泛校验.yaml',
  );
  repository.write(loadedRelaxedPath, orderedRelaxedContent);
  const loadedRelaxedPlan = repository.read(loadedRelaxedPath);
  assert.equal(loadedRelaxedPlan.ships[0].relaxed, true);
  assert.equal(loadedRelaxedPlan.ships[0].candidates[0].relaxed, true);
  repository.remove(loadedRelaxedPath);
  assert.throws(
    () => codec.normalize({
      name: '非法宽泛校验',
      ships: [{ name: '重庆', relaxed: 'true' }],
    }),
    /relaxed 必须是布尔值/,
  );
  assert.throws(
    () => codec.normalize({
      name: '非法备选宽泛校验',
      ships: [{
        name: '重庆',
        candidates: [{ name: '昆西', relaxed: 1 }],
      }],
    }),
    /relaxed 必须是布尔值/,
  );
  const legacyCandidateOnly = codec.normalize({
    name: '旧版纯候选',
    ships: [
      {
        search_name: '契卡洛夫',
        ship_type: ['CV'],
        min_level: 90,
        max_level: 110,
        candidates: ['85工程', '岛风'],
      },
      {
        priority: ['胡德', '扶桑'],
      },
      {
        search_name: '大凤',
        ship_type: ['CV'],
        min_level: 80,
        max_level: 100,
        candidates: [
          '大凤·改',
          {
            name: '岛风',
            search_name: '岛风',
            ship_type: ['DD'],
            min_level: 20,
            max_level: 30,
          },
        ],
      },
    ],
  });
  assert.equal(legacyCandidateOnly.ships[0].name, undefined);
  assert.equal(legacyCandidateOnly.ships[0].search_name, undefined);
  assert.deepEqual(
    legacyCandidateOnly.ships[0].candidates.map(rule => ({
      name: rule.name,
      search_name: rule.search_name,
      ship_type: rule.ship_type,
      min_level: rule.min_level,
      max_level: rule.max_level,
    })),
    [
      {
        name: '85工程',
        search_name: '契卡洛夫',
        ship_type: ['cv'],
        min_level: 90,
        max_level: 110,
      },
      {
        name: '岛风',
        search_name: '契卡洛夫',
        ship_type: ['cv'],
        min_level: 90,
        max_level: 110,
      },
    ],
  );
  assert.equal(legacyCandidateOnly.ships[1].name, undefined);
  assert.deepEqual(
    legacyCandidateOnly.ships[1].candidates.map(rule => rule.name),
    ['胡德', '扶桑'],
  );
  assert.equal(legacyCandidateOnly.ships[2].name, undefined);
  assert.equal(legacyCandidateOnly.ships[2].search_name, undefined);
  assert.deepEqual(legacyCandidateOnly.ships[2].candidates, [
    {
      name: '大凤·改',
      search_name: '大凤',
      ship_type: ['cv'],
      min_level: 80,
      max_level: 100,
    },
    {
      name: '岛风',
      search_name: '岛风',
      ship_type: ['dd'],
      min_level: 20,
      max_level: 30,
    },
  ]);
  const serializedLegacy = yaml.load(codec.serialize(legacyCandidateOnly));
  assert.equal(serializedLegacy.ships[0].name, undefined);
  assert.equal(serializedLegacy.ships[0].search_name, undefined);
  assert.equal(serializedLegacy.ships[1].priority, undefined);
  assert.deepEqual(
    serializedLegacy.ships[1].candidates.map(rule => rule.name),
    ['胡德', '扶桑'],
  );
  assert.equal(serializedLegacy.ships[2].search_name, undefined);
  assert.deepEqual(
    serializedLegacy.ships[2].candidates,
    legacyCandidateOnly.ships[2].candidates,
  );
  const nativeShipTypes = [
    'aadg', 'ap', 'asdg', 'av', 'bb', 'bbg', 'bbv', 'bc', 'bg', 'bm',
    'ca', 'cav', 'cg', 'cl', 'clt', 'cv', 'cvl', 'dd', 'kp', 'sc',
    'ss', 'ssg', 'ss_or_ssg',
  ];
  for (const shipType of nativeShipTypes) {
    const plan = codec.normalize({
      name: `舰种-${shipType}`,
      ships: [{ name: '测试舰船', ship_type: [shipType] }],
    });
    assert.deepEqual(plan.ships[0].ship_type, [shipType]);
  }
  for (const invalidShipType of ['cf', 'cgaa', 'cbg', 'ddg', 'ddgaa']) {
    assert.throws(
      () => codec.normalize({
        name: '非 canonical 舰种',
        ships: [{ name: '测试舰船', ship_type: [invalidShipType] }],
      }),
      new RegExp(`不符合后端接口: ${invalidShipType}`),
    );
  }
  assert.equal(codec.fileName('测试/编队'), 'team-测试_编队.yaml');

  const systemPath = path.join(
    appPaths.systemTeamPlansDir(),
    'team-同名.yaml',
  );
  const userPath = path.join(
    appPaths.userTeamPlansDir(),
    'team-同名.yaml',
  );
  repository.write(systemPath, codec.serialize(codec.normalize({
    name: '同名',
    ships: [{ name: '系统舰' }],
  })));
  repository.write(userPath, codec.serialize(codec.normalize({
    name: '同名',
    ships: [{ name: '用户舰' }],
  })));
  fs.writeFileSync(
    path.join(appPaths.userTeamPlansDir(), 'invalid.yaml'),
    'name: 无效命名\nships:\n  - name: 测试舰\n',
    'utf8',
  );

  const listed = repository.list();
  assert.equal(listed.plans.length, 2);
  assert.equal(listed.errors.length, 1);
  assert.equal(
    repository.find('同名', 'user', listed.plans).ships[0].name,
    '用户舰',
  );
  assert.equal(
    repository.find('同名', 'system', listed.plans).ships[0].name,
    '系统舰',
  );

  const systemCopyFile = 'team-系统另存.yaml';
  const systemCopyPath = path.join(
    appPaths.systemTeamPlansDir(),
    systemCopyFile,
  );
  const systemCopyPlan = codec.normalize({
    name: '系统另存',
    ships: [{ name: '系统原版' }],
  });
  repository.write(systemCopyPath, codec.serialize(systemCopyPlan));
  const unchangedSystemCopy = service.save(
    systemCopyPlan,
    false,
    systemCopyFile,
    'system',
  );
  assert.equal(unchangedSystemCopy.success, true);
  assert.equal(unchangedSystemCopy.plan.source, 'user');
  assert.deepEqual(
    repository.read(path.join(
      appPaths.userTeamPlansDir(),
      systemCopyFile,
    )),
    systemCopyPlan,
  );
  const systemCopy = service.save({
    name: '系统另存',
    ships: [{ name: '用户修改版' }],
  }, true, systemCopyFile, 'system');
  assert.equal(systemCopy.success, true);
  assert.equal(systemCopy.plan.source, 'user');
  assert.equal(repository.read(systemCopyPath).ships[0].name, '系统原版');
  assert.equal(
    repository.read(path.join(
      appPaths.userTeamPlansDir(),
      systemCopyFile,
    )).ships[0].name,
    '用户修改版',
  );

  const firstSave = service.save({
    name: '可重命名',
    ships: [{ name: '重庆' }],
  }, false);
  assert.equal(firstSave.success, true);
  assert.equal(firstSave.file, 'team-可重命名.yaml');

  const duplicate = service.save({
    name: '可重命名',
    ships: [{ name: '重庆' }],
  }, false);
  assert.deepEqual(duplicate, {
    success: false,
    exists: true,
    file: 'team-可重命名.yaml',
    error: '存在同名配置',
  });

  const renamed = service.save({
    name: '重命名完成',
    ships: [{ name: '重庆' }],
  }, false, 'team-可重命名.yaml');
  assert.equal(renamed.success, true);
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userTeamPlansDir(),
      'team-可重命名.yaml',
    )),
    false,
  );
  const renamedPath = path.join(
    appPaths.userTeamPlansDir(),
    'team-重命名完成.yaml',
  );
  assert.equal(fs.existsSync(renamedPath), true);
  assert.equal(service.loadSelected(renamedPath).success, true);
  assert.deepEqual(
    service.loadSelected(path.join(temporaryDirectory, 'outside.yaml')),
    {
      success: false,
      error: '当前yaml格式不符合规则',
    },
  );
}

module.exports = {
  testTeamPlanServices,
};
