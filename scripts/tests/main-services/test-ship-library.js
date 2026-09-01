/**
 * 舰船资料库同步和更新器测试。
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
  ShipNameSynchronizer,
  AdbService,
  CudaEnvironmentService,
  GuiConfigurationService,
  PythonEnvironmentService,
  temporaryDirectory,
} = context;

/** 验证舰船资料库目录同步、清单读取和失败恢复。 */
function testShipLibraryService() {
  const projectRoot = path.join(temporaryDirectory, 'ship-library-project');
  const userData = path.join(temporaryDirectory, 'ship-library-user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const service = new ShipLibraryService(appPaths, {
    processId: 77,
    now: () => 12345,
  });
  const bundledDirectory = path.join(
    projectRoot,
    'resource',
    'ship-library',
  );
  const bundledManifestPath = path.join(
    bundledDirectory,
    'manifest.json',
  );
  const userManifestPath = path.join(
    service.directory(),
    'manifest.json',
  );
  const writeBundledManifest = (
    schemaVersion,
    generatedAt,
    marker,
  ) => {
    fs.mkdirSync(
      path.join(bundledDirectory, 'assets'),
      { recursive: true },
    );
    fs.writeFileSync(
      bundledManifestPath,
      JSON.stringify({
        schema_version: schemaVersion,
        generated_at: generatedAt,
        labels: { nationality: '国籍' },
        type_groups: { surface: ['BB'] },
        counts: {
          ships: 1,
          assets: 2,
          missing_assets: 0,
        },
        ships: [{
          name: '测试舰',
          portrait: 'assets/portrait.png',
          background: '../outside.png',
          frame: '',
          type_icon: 'assets/type.png',
        }],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(bundledDirectory, 'bundled-marker.txt'),
      marker,
      'utf8',
    );
    fs.writeFileSync(
      path.join(bundledDirectory, 'assets', 'portrait.png'),
      'portrait',
      'utf8',
    );
    fs.writeFileSync(
      path.join(bundledDirectory, 'assets', 'type.png'),
      'type',
      'utf8',
    );
  };

  service.initialize();
  assert.deepEqual(service.getStatus(), {
    exists: false,
    path: service.directory(),
    shipCount: 0,
    assetCount: 0,
    missingAssets: 0,
  });
  assert.throws(
    () => service.getManifest(),
    /舰船资料库尚未建立，请先在配置页更新舰船数据库/,
  );

  writeBundledManifest(1, '2026-01-01T00:00:00Z', 'version-1');
  service.initialize();
  assert.equal(
    fs.readFileSync(
      path.join(service.directory(), 'bundled-marker.txt'),
      'utf8',
    ),
    'version-1',
  );
  assert.deepEqual(service.getStatus(), {
    exists: true,
    path: service.directory(),
    generatedAt: '2026-01-01T00:00:00Z',
    shipCount: 1,
    assetCount: 2,
    missingAssets: 0,
  });
  const manifest = service.getManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.generatedAt, '2026-01-01T00:00:00Z');
  assert.deepEqual(manifest.labels, { nationality: '国籍' });
  assert.deepEqual(manifest.typeGroups, { surface: ['bb'] });
  assert.match(manifest.ships[0].portraitUrl, /^file:/);
  assert.match(manifest.ships[0].portraitUrl, /portrait\.png$/);
  assert.equal(manifest.ships[0].backgroundUrl, '');
  assert.equal(manifest.ships[0].frameUrl, '');
  assert.match(manifest.ships[0].typeIconUrl, /type\.png$/);
  assert.equal(service.assetUrl('../outside.png'), '');
  assert.equal(service.assetUrl(''), '');

  fs.writeFileSync(
    path.join(service.directory(), 'user-only.txt'),
    'remove-on-upgrade',
    'utf8',
  );
  writeBundledManifest(2, '2026-02-01T00:00:00Z', 'version-2');
  service.initialize();
  assert.equal(
    fs.existsSync(path.join(service.directory(), 'user-only.txt')),
    false,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(userManifestPath, 'utf8')).schema_version,
    2,
  );

  const legacyManifest = JSON.parse(
    fs.readFileSync(userManifestPath, 'utf8'),
  );
  legacyManifest.labels = {
    ship_types: {
      cav: '航空巡洋舰',
      cg: '反舰导弹巡洋舰',
      cgaa: '防空导弹巡洋舰',
      cbg: '导弹大型巡洋舰',
      ddg: '反舰导弹驱逐舰',
      ddgaa: '防空导弹驱逐舰',
      cf: '旗舰',
    },
  };
  legacyManifest.type_groups = {
    size_classes: {
      medium: ['cav', 'cg', 'cgaa', 'cf'],
      large: ['cbg'],
      small: ['ddg', 'ddgaa'],
    },
  };
  legacyManifest.ships = [
    'cg',
    'cgaa',
    'cbg',
    'ddg',
    'ddgaa',
    'cf',
  ].map((shipType, index) => ({
    id: index + 1,
    name: `旧资料库舰船${index + 1}`,
    ship_type: shipType,
    portrait: 'assets/portrait.png',
    background: '',
    frame: '',
    type_icon: 'assets/type.png',
  }));
  fs.writeFileSync(
    userManifestPath,
    JSON.stringify(legacyManifest),
    'utf8',
  );
  const normalizedLegacyManifest = service.getManifest();
  assert.deepEqual(
    normalizedLegacyManifest.ships.map(ship => ship.ship_type),
    ['kp', 'cg', 'bg', 'asdg', 'aadg', 'cav'],
  );
  assert.deepEqual(normalizedLegacyManifest.labels.ship_types, {
    cav: '航空巡洋舰',
    kp: '反舰导弹巡洋舰',
    cg: '防空导弹巡洋舰',
    bg: '导弹大型巡洋舰',
    asdg: '反舰导弹驱逐舰',
    aadg: '防空导弹驱逐舰',
  });
  assert.deepEqual(normalizedLegacyManifest.typeGroups, {
    size_classes: {
      medium: ['cav', 'kp', 'cg'],
      large: ['bg'],
      small: ['asdg', 'aadg'],
    },
  });
  assert.equal(
    normalizedLegacyManifest.ships.every(
      ship => /assets\/type\.png$/.test(ship.typeIconUrl),
    ),
    true,
  );

  legacyManifest.schema_version = 3;
  legacyManifest.labels.ship_types = {
    cav: '航空巡洋舰',
    cf: '旗舰',
    cg: '防空导弹巡洋舰',
  };
  legacyManifest.type_groups = {
    size_classes: {
      medium: ['cav', 'cf', 'cg'],
    },
  };
  legacyManifest.ships = [
    { name: 'canonical 防巡', ship_type: 'cg' },
    { name: '旧旗舰类型', ship_type: 'cf' },
  ].map((ship, index) => ({
    id: index + 1,
    ...ship,
    portrait: 'assets/portrait.png',
    background: '',
    frame: '',
    type_icon: 'assets/type.png',
  }));
  fs.writeFileSync(
    userManifestPath,
    JSON.stringify(legacyManifest),
    'utf8',
  );
  const normalizedSchemaThree = service.getManifest();
  assert.deepEqual(
    normalizedSchemaThree.ships.map(ship => ship.ship_type),
    ['cg', 'cav'],
  );
  assert.deepEqual(normalizedSchemaThree.labels.ship_types, {
    cav: '航空巡洋舰',
    cg: '防空导弹巡洋舰',
  });
  assert.deepEqual(normalizedSchemaThree.typeGroups, {
    size_classes: {
      medium: ['cav', 'cg'],
    },
  });

  fs.writeFileSync(
    userManifestPath,
    JSON.stringify({
      schema_version: 99,
      generated_at: '2099-01-01T00:00:00Z',
      ships: [],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(service.directory(), 'newer-user.txt'),
    'preserve',
    'utf8',
  );
  writeBundledManifest(4, '2026-03-01T00:00:00Z', 'version-4');
  service.initialize();
  assert.equal(
    fs.readFileSync(
      path.join(service.directory(), 'newer-user.txt'),
      'utf8',
    ),
    'preserve',
  );

  fs.writeFileSync(userManifestPath, '{invalid', 'utf8');
  assert.match(
    service.getStatus().error,
    /^资料库清单读取失败:/,
  );
  service.initialize();
  assert.equal(
    JSON.parse(fs.readFileSync(userManifestPath, 'utf8')).schema_version,
    4,
  );
  assert.equal(
    fs.existsSync(path.join(service.directory(), 'newer-user.txt')),
    false,
  );

  fs.writeFileSync(
    path.join(service.directory(), 'old-version.txt'),
    'must-survive',
    'utf8',
  );
  writeBundledManifest(5, '2026-04-01T00:00:00Z', 'version-5');
  const originalRename = fs.renameSync;
  const originalConsoleError = console.error;
  let renameCall = 0;
  fs.renameSync = (source, destination) => {
    renameCall += 1;
    if (renameCall === 2) {
      throw new Error('simulated ship library replacement failure');
    }
    return originalRename(source, destination);
  };
  console.error = () => {};
  try {
    service.initialize();
  } finally {
    fs.renameSync = originalRename;
    console.error = originalConsoleError;
  }
  assert.equal(
    fs.readFileSync(
      path.join(service.directory(), 'old-version.txt'),
      'utf8',
    ),
    'must-survive',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(userManifestPath, 'utf8')).schema_version,
    4,
  );
  assert.deepEqual(
    fs.readdirSync(userData)
      .filter(name => name.startsWith('ship-library.')),
    [],
  );
}

/** 验证 GUI 舰名以编号为准非破坏性同步到后端 YAML。 */
function testShipNameSynchronizer() {
  const backendRoot = path.join(
    temporaryDirectory,
    'ship-name-sync-backend',
  );
  const shipnamesPath = path.join(
    backendRoot,
    'autowsgr',
    'data',
    'shipnames.yaml',
  );
  fs.mkdirSync(path.dirname(shipnamesPath), { recursive: true });
  const original = [
    'No.1: # 旧名称',
    '  - "旧名称"',
    '  - "用户别名"',
    '',
    'No.3: # 旧三号',
    '  - "旧三号"',
    '',
    'Other:',
    '  - "技能名称"',
    '',
  ].join('\n');
  fs.writeFileSync(shipnamesPath, original, 'utf8');
  const synchronizer = new ShipNameSynchronizer(new AtomicFileStore());
  const ships = [
    { id: 4, name: '四号舰(改)', search_name: '四号舰' },
    { id: 2, name: '测试舰(CVA-01)', search_name: '测试舰' },
    { id: 1, name: '旧名称(00)', search_name: '旧名称' },
    { id: 3, name: '三号舰(CV)', search_name: '三号舰' },
  ];

  assert.deepEqual(synchronizer.compare(shipnamesPath, ships), {
    path: fs.realpathSync(shipnamesPath),
    missingRecords: 2,
    missingAliases: 1,
    totalRecords: 4,
    synchronized: false,
  });
  assert.equal(fs.readFileSync(shipnamesPath, 'utf8'), original);

  assert.deepEqual(synchronizer.sync(shipnamesPath, ships), {
    path: fs.realpathSync(shipnamesPath),
    addedRecords: 2,
    addedAliases: 1,
    totalRecords: 4,
    changed: true,
  });
  const updatedText = fs.readFileSync(shipnamesPath, 'utf8');
  const updated = yaml.load(updatedText);
  assert.deepEqual(Object.keys(updated), [
    'No.1',
    'No.2',
    'No.3',
    'No.4',
    'Other',
  ]);
  assert.deepEqual(updated['No.1'], ['旧名称', '用户别名']);
  assert.deepEqual(updated['No.2'], ['测试舰']);
  assert.deepEqual(updated['No.3'], ['旧三号', '三号舰']);
  assert.deepEqual(updated['No.4'], ['四号舰']);
  assert.deepEqual(updated.Other, ['技能名称']);
  assert.doesNotMatch(updatedText, /测试舰\(CVA-01\)|四号舰\(改\)/);

  assert.deepEqual(synchronizer.sync(shipnamesPath, ships), {
    path: fs.realpathSync(shipnamesPath),
    addedRecords: 0,
    addedAliases: 0,
    totalRecords: 4,
    changed: false,
  });
  assert.deepEqual(synchronizer.compare(shipnamesPath, ships), {
    path: fs.realpathSync(shipnamesPath),
    missingRecords: 0,
    missingAliases: 0,
    totalRecords: 4,
    synchronized: true,
  });

  const invalidPath = path.join(
    backendRoot,
    'not-autowsgr',
    'data',
    'shipnames.yaml',
  );
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
  fs.writeFileSync(invalidPath, original, 'utf8');
  assert.throws(
    () => synchronizer.sync(invalidPath, ships),
    /后端舰名库路径无效/,
  );

  fs.writeFileSync(shipnamesPath, '{invalid', 'utf8');
  assert.throws(() => synchronizer.sync(shipnamesPath, ships));
  fs.writeFileSync(shipnamesPath, original, 'utf8');
  assert.throws(
    () => synchronizer.sync(
      shipnamesPath,
      [{ id: 0, search_name: '无效编号' }],
    ),
    /GUI 舰船清单包含无效的 id 或 search_name/,
  );
  assert.throws(
    () => synchronizer.sync(
      shipnamesPath,
      [
        { id: 1, search_name: '名称一' },
        { id: 1, search_name: '名称二' },
      ],
    ),
    /GUI 舰船编号 1 对应多个搜索名称/,
  );
  fs.writeFileSync(shipnamesPath, 'No.1: "错误格式"\n', 'utf8');
  assert.throws(
    () => synchronizer.sync(
      shipnamesPath,
      [{ id: 1, search_name: '名称一' }],
    ),
    /后端舰名记录格式无效: No.1/,
  );
}

/** 创建可由更新服务监听的最小子进程替身。 */
function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

/** 验证资料库更新器保持原有进度、结果和互斥语义。 */
async function testShipLibraryUpdater() {
  const projectRoot = path.join(temporaryDirectory, 'ship-updater-project');
  const userData = path.join(temporaryDirectory, 'ship-updater-user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const library = new ShipLibraryService(appPaths, {
    processId: 88,
  });
  const missingPython = new ShipLibraryUpdater(library, {
    findPython: async () => null,
    appRoot: () => projectRoot,
    sendProgress: () => {},
  });
  assert.deepEqual(await missingPython.update(), {
    success: false,
    error: '找不到可用的 Python 3.12 或 3.13',
  });

  const missingScript = new ShipLibraryUpdater(library, {
    findPython: async () => 'python.exe',
    appRoot: () => projectRoot,
    sendProgress: () => {},
  });
  assert.deepEqual(await missingScript.update(), {
    success: false,
    error: `找不到舰船资料库更新程序: ${library.updaterPath()}`,
  });

  fs.mkdirSync(path.dirname(library.updaterPath()), { recursive: true });
  fs.writeFileSync(library.updaterPath(), '# updater', 'utf8');
  const progress = [];
  const spawnCalls = [];
  const compareCalls = [];
  const syncCalls = [];
  let spawnCount = 0;
  const updater = new ShipLibraryUpdater(library, {
    findPython: async () => 'python.exe',
    appRoot: () => projectRoot,
    sendProgress: message => progress.push(message),
    compareShipNames: pythonCmd => {
      compareCalls.push(pythonCmd);
      return {
        path: 'shipnames.yaml',
        missingRecords: 2,
        missingAliases: 1,
        totalRecords: 12,
        synchronized: false,
      };
    },
    syncShipNames: pythonCmd => {
      syncCalls.push(pythonCmd);
      return {
        path: 'shipnames.yaml',
        addedRecords: 2,
        addedAliases: 1,
        totalRecords: 12,
        changed: true,
      };
    },
    spawnProcess: (command, args, options) => {
      spawnCount += 1;
      spawnCalls.push({ command, args, options });
      const child = createFakeChild();
      setImmediate(() => {
        child.stdout.write([
          'PROGRESS sources started',
          'PROGRESS records parsed=12',
          'PROGRESS assets 1/2 down',
        ].join('\n'));
        child.stdout.write([
          'loaded=1 failed=0',
          `RESULT_JSON=${JSON.stringify({
            success: true,
            ship_count: 12,
          })}`,
          '',
        ].join('\n'));
        child.emit('close', 0);
      });
      return child;
    },
  });

  const firstUpdate = updater.update();
  assert.deepEqual(await updater.update(), {
    success: false,
    error: '舰船资料库正在更新，请稍候',
  });
  assert.deepEqual(await firstUpdate, {
    success: true,
    ship_count: 12,
  });
  assert.deepEqual(progress, [
    '正在获取舰R百科数据…',
    '已读取 12 艘舰船，正在检查本地资源…',
    '正在检查资源 1/2，已下载 1，失败 0',
    '正在同步后端舰名库…',
  ]);
  assert.deepEqual(syncCalls, ['python.exe']);
  assert.equal(spawnCalls[0].command, 'python.exe');
  assert.equal(spawnCalls[0].args[0], '-c');
  assert.match(
    spawnCalls[0].args[1],
    /sys\.path\.insert\(0,.+runpy\.run_path/,
  );
  assert.deepEqual(spawnCalls[0].args.slice(2), [
    library.updaterPath(),
    '--output',
    library.directory(),
    '--workers',
    '8',
    '--force-assets',
  ]);
  assert.deepEqual(spawnCalls[0].options, {
    cwd: projectRoot,
    windowsHide: true,
  });
  assert.deepEqual(await updater.update(), {
    success: true,
    ship_count: 12,
  });
  assert.equal(spawnCount, 2);
  assert.deepEqual(syncCalls, ['python.exe', 'python.exe']);
  assert.deepEqual(await updater.getBackendSyncStatus(), {
    path: 'shipnames.yaml',
    missingRecords: 2,
    missingAliases: 1,
    totalRecords: 12,
    synchronized: false,
  });
  assert.deepEqual(compareCalls, ['python.exe']);
  assert.deepEqual(await updater.syncBackend(), {
    success: true,
    ship_count: 12,
  });
  assert.equal(spawnCount, 2);
  assert.deepEqual(
    syncCalls,
    ['python.exe', 'python.exe', 'python.exe'],
  );

  const syncFailure = new ShipLibraryUpdater(library, {
    findPython: async () => 'python.exe',
    appRoot: () => projectRoot,
    sendProgress: () => {},
    syncShipNames: () => {
      throw new Error('shipnames locked');
    },
    spawnProcess: () => {
      const child = createFakeChild();
      setImmediate(() => {
        child.stdout.write(
          'RESULT_JSON={"success":true,"ship_count":12}\n',
        );
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.deepEqual(await syncFailure.update(), {
    success: true,
    ship_count: 12,
    shipnames_sync_error: 'shipnames locked',
  });
  assert.deepEqual(await syncFailure.syncBackend(), {
    success: false,
    error: '后端舰名同步失败: shipnames locked',
  });

  const invalidResult = new ShipLibraryUpdater(library, {
    findPython: async () => 'python.exe',
    appRoot: () => projectRoot,
    sendProgress: () => {},
    spawnProcess: () => {
      const child = createFakeChild();
      setImmediate(() => {
        child.stdout.write('RESULT_JSON={invalid\n');
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.deepEqual(await invalidResult.update(), {
    success: false,
    error: '更新程序返回了无效结果',
  });

  const stderrFailure = new ShipLibraryUpdater(library, {
    findPython: async () => 'python.exe',
    appRoot: () => projectRoot,
    sendProgress: () => {},
    spawnProcess: () => {
      const child = createFakeChild();
      setImmediate(() => {
        child.stderr.write('updater failed');
        child.emit('close', 7);
      });
      return child;
    },
  });
  assert.deepEqual(await stderrFailure.update(), {
    success: false,
    error: 'updater failed',
  });

  const exitFailure = new ShipLibraryUpdater(library, {
    findPython: async () => 'python.exe',
    appRoot: () => projectRoot,
    sendProgress: () => {},
    spawnProcess: () => {
      const child = createFakeChild();
      setImmediate(() => child.emit('close', 9));
      return child;
    },
  });
  assert.deepEqual(await exitFailure.update(), {
    success: false,
    error: '更新程序异常退出（代码 9）',
  });

  const startFailure = new ShipLibraryUpdater(library, {
    findPython: async () => 'python.exe',
    appRoot: () => projectRoot,
    sendProgress: () => {},
    spawnProcess: () => {
      const child = createFakeChild();
      setImmediate(() => {
        child.emit('error', new Error('cannot start'));
      });
      return child;
    },
  });
  assert.deepEqual(await startFailure.update(), {
    success: false,
    error: '更新程序启动失败: cannot start',
  });
}

module.exports = {
  testShipLibraryService,
  testShipNameSynchronizer,
  testShipLibraryUpdater,
};
