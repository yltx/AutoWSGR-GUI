/**
 * 路径、文件安全和原子写入服务测试。
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
  GuiLogService,
  resolveGuiLogDirectory,
  PythonEnvironmentService,
  temporaryDirectory,
} = context;

/** 验证 AppPaths 不依赖真实 Electron app 对象。 */
function testAppPaths() {
  const projectRoot = path.join(temporaryDirectory, 'project');
  const moduleDirectory = path.join(projectRoot, 'dist', 'electron');
  const userData = path.join(temporaryDirectory, 'user-data');
  const executable = path.join(temporaryDirectory, 'install', 'AutoWSGR.exe');
  const resources = path.join(temporaryDirectory, 'install', 'resources');
  const packaged = { value: false };
  const paths = new AppPaths({
    moduleDirectory,
    isPackaged: () => packaged.value,
    getPath: name => name === 'exe' ? executable : userData,
    getResourcesPath: () => resources,
  });
  const safePaths = new SafePathService(paths);

  assert.equal(paths.appRoot(), projectRoot);
  assert.equal(paths.resourceRoot(), projectRoot);
  assert.equal(paths.userDataRoot(), userData);
  assert.equal(
    paths.systemBattlePlansDir(),
    path.join(projectRoot, 'resource', 'system_battle_plans'),
  );
  assert.equal(
    paths.userBattlePlansDir(),
    path.join(userData, 'user_battle_plans'),
  );
  assert.equal(
    paths.systemTeamPlansDir(),
    path.join(projectRoot, 'resource', 'system_team_plans'),
  );
  assert.equal(
    paths.userTeamPlansDir(),
    path.join(userData, 'user_team_plans'),
  );
  assert.equal(
    safePaths.resolveAppPath('usersettings.yaml'),
    path.join(userData, 'usersettings.yaml'),
  );
  assert.equal(
    safePaths.resolveAppPath(path.join(userData, 'absolute.yaml')),
    path.join(userData, 'absolute.yaml'),
  );
  assert.equal(
    safePaths.resolveAppPath(path.join('resource', 'maps', '1.json')),
    path.join(projectRoot, 'resource', 'maps', '1.json'),
  );
  assert.throws(
    () => safePaths.resolveAppPath(''),
    /文件路径不能为空/,
  );
  assert.throws(
    () => safePaths.resolveAppPath(path.join(temporaryDirectory, 'outside.yaml')),
    /文件路径超出应用允许目录/,
  );
  assert.throws(
    () => safePaths.resolveAppPath('nested/../settings.json'),
    /文件路径不允许包含 \.\./,
  );
  assert.throws(
    () => safePaths.resolveAppPath('C:relative.yaml'),
    /不允许使用盘符相对路径/,
  );
  assert.throws(
    () => safePaths.resolveAppPath('Z:\\outside\\plan.yaml'),
    /不允许切换路径根目录|文件路径超出应用允许目录/,
  );
  assert.throws(
    () => safePaths.resolveAppPath('\\\\server\\share\\plan.yaml'),
    /不允许使用 UNC 路径/,
  );

  packaged.value = true;
  assert.equal(paths.appRoot(), path.dirname(executable));
  assert.equal(paths.resourceRoot(), resources);
}

/** 验证文件服务只在允许目录内保存、读取和追加。 */
function testSecureFileService() {
  const userData = path.join(temporaryDirectory, 'secure-user-data');
  const resources = path.join(temporaryDirectory, 'secure-resources');
  const bundledResources = path.join(resources, 'resource');
  const outside = path.join(temporaryDirectory, 'secure-outside');
  fs.mkdirSync(path.join(bundledResources, 'maps'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(bundledResources, 'maps', '1.json'),
    '{"map":1}',
    'utf8',
  );
  const appPaths = new AppPaths({
    moduleDirectory: path.join(temporaryDirectory, 'dist', 'electron'),
    isPackaged: () => true,
    getPath: name => name === 'exe'
      ? path.join(temporaryDirectory, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => resources,
  });
  const service = new SecureFileService(
    new SafePathService(appPaths),
    new AtomicFileStore(),
  );

  service.save(path.join('nested', 'settings.txt'), 'first');
  assert.equal(
    service.read(path.join('nested', 'settings.txt')),
    'first',
  );
  service.append(path.join('nested', 'settings.txt'), '-second');
  assert.equal(
    service.read(path.join('nested', 'settings.txt')),
    'first-second',
  );
  assert.equal(service.read('missing.txt'), '');
  assert.equal(service.read('resource/maps/1.json'), '{"map":1}');
  assert.throws(
    () => service.save(
      path.join(temporaryDirectory, 'outside.txt'),
      'rejected',
    ),
    /文件路径超出应用允许目录/,
  );
  assert.throws(
    () => service.append(
      path.join(temporaryDirectory, 'outside.log'),
      'rejected',
    ),
    /文件路径超出应用允许目录/,
  );
  assert.throws(
    () => service.save('resource/maps/1.json', 'changed'),
    /安装资源目录为只读/,
  );
  assert.throws(
    () => service.save(
      path.join(bundledResources, 'maps', '1.json'),
      'changed',
    ),
    /文件路径超出应用允许目录/,
  );
  assert.equal(
    fs.readFileSync(path.join(bundledResources, 'maps', '1.json'), 'utf8'),
    '{"map":1}',
  );

  const linkedDirectory = path.join(userData, 'outside-link');
  fs.symlinkSync(
    outside,
    linkedDirectory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => service.save(
      path.join('outside-link', 'escaped.txt'),
      'rejected',
    ),
    /文件路径不允许包含符号链接或联接点/,
  );
  assert.throws(
    () => service.read(path.join('outside-link', 'secret.txt')),
    /文件路径不允许包含符号链接或联接点/,
  );
  assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false);

  const internalTarget = path.join(userData, 'internal-target');
  const internalLink = path.join(userData, 'internal-link');
  fs.mkdirSync(internalTarget, { recursive: true });
  fs.writeFileSync(
    path.join(internalTarget, 'settings.txt'),
    'internal',
    'utf8',
  );
  fs.symlinkSync(
    internalTarget,
    internalLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => service.read(path.join('internal-link', 'settings.txt')),
    /文件路径不允许包含符号链接或联接点/,
  );

  const internalFile = path.join(userData, 'internal-file.txt');
  const internalFileLink = path.join(userData, 'internal-file-link.txt');
  fs.writeFileSync(internalFile, 'internal-file', 'utf8');
  try {
    fs.symlinkSync(internalFile, internalFileLink, 'file');
    assert.throws(
      () => service.read('internal-file-link.txt'),
      /文件路径不允许包含符号链接或联接点/,
    );
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }

  const danglingTarget = path.join(
    temporaryDirectory,
    'secure-dangling-target',
  );
  const danglingLink = path.join(userData, 'dangling-link');
  fs.mkdirSync(danglingTarget, { recursive: true });
  fs.symlinkSync(
    danglingTarget,
    danglingLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.rmSync(danglingTarget, { recursive: true, force: true });
  assert.throws(
    () => service.save(
      path.join('dangling-link', 'escaped.txt'),
      'rejected',
    ),
    /文件路径不允许包含符号链接或联接点/,
  );
}

/** Verifies GUI logs use the latest configured root without weakening file IPC. */
function testGuiLogService() {
  const userData = path.join(temporaryDirectory, 'gui-log-user-data');
  const externalRoot = path.join(temporaryDirectory, 'gui-log-external');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(temporaryDirectory, 'dist', 'electron'),
    isPackaged: () => true,
    getPath: name => name === 'exe'
      ? path.join(temporaryDirectory, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(temporaryDirectory, 'resources'),
  });
  fs.mkdirSync(userData, { recursive: true });
  const settings = new GuiSettingsStore(
    () => path.join(userData, 'gui_settings.json'),
    new AtomicFileStore(),
  );
  const configuration = new GuiConfigurationService(settings, {
    clearPythonCache: () => {},
    normalizeCudaPath: value => value,
  });
  settings.write({ gui_log_root: externalRoot });
  const service = new GuiLogService(appPaths, configuration);

  service.append('external\n');
  const externalLog = fs.readdirSync(externalRoot).find(name =>
    /^gui_\d{4}-\d{2}-\d{2}\.debug\.log$/.test(name),
  );
  assert.ok(externalLog);
  assert.equal(
    fs.readFileSync(path.join(externalRoot, externalLog), 'utf8'),
    'external\n',
  );

  const relativeRootName = 'logs-after-save';
  settings.write({ gui_log_root: relativeRootName });
  service.append('relative\n');
  const relativeRoot = path.join(userData, relativeRootName);
  const relativeLog = fs.readdirSync(relativeRoot).find(name =>
    /^gui_\d{4}-\d{2}-\d{2}\.debug\.log$/.test(name),
  );
  assert.ok(relativeLog);
  assert.equal(
    fs.readFileSync(path.join(relativeRoot, relativeLog), 'utf8'),
    'relative\n',
  );

  assert.equal(
    resolveGuiLogDirectory('\\\\server\\share\\logs', userData),
    '\\\\server\\share\\logs',
  );
}

/** 验证普通写入、覆盖写入和替换失败时保留旧文件。 */
function testAtomicFileStore() {
  const store = new AtomicFileStore();
  const target = path.join(temporaryDirectory, 'atomic.txt');
  const temporaryArtifacts = filePath => (
    fs.readdirSync(path.dirname(filePath))
      .filter(name => (
        name.startsWith(`${path.basename(filePath)}.`)
        && /\.(?:tmp|bak)$/.test(name)
      ))
  );
  const assertRenameFailurePreservesTarget = (name, code) => {
    const failureTarget = path.join(temporaryDirectory, name);
    const oldContent = `old-${code}`;
    fs.writeFileSync(failureTarget, oldContent, 'utf8');
    const originalRename = fs.renameSync;
    let renameCall = 0;
    fs.renameSync = (source, destination) => {
      if (destination === failureTarget) {
        renameCall += 1;
        const error = new Error(`simulated ${code} rename failure`);
        error.code = code;
        throw error;
      }
      return originalRename(source, destination);
    };
    try {
      assert.throws(
        () => store.write(failureTarget, `new-${code}`),
        { code },
      );
    } finally {
      fs.renameSync = originalRename;
    }
    const transient = ['EACCES', 'EBUSY', 'EPERM'].includes(code);
    const expectedAttempts = process.platform === 'win32' && transient
      ? 4
      : 1;
    assert.equal(renameCall, expectedAttempts);
    assert.equal(fs.readFileSync(failureTarget, 'utf8'), oldContent);
    assert.deepEqual(temporaryArtifacts(failureTarget), []);
  };

  store.write(target, 'first');
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  store.write(target, 'second');
  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  const binaryTarget = path.join(temporaryDirectory, 'atomic.bin');
  const binaryContent = Uint8Array.from([0, 1, 2, 127, 128, 255]);
  store.write(binaryTarget, binaryContent);
  assert.deepEqual(
    fs.readFileSync(binaryTarget),
    Buffer.from(binaryContent),
  );

  if (process.platform === 'win32') {
    const retryTarget = path.join(temporaryDirectory, 'atomic-retry.txt');
    const originalWrite = fs.writeFileSync;
    let writeCall = 0;
    fs.writeFileSync = (...args) => {
      if (
        String(args[0]).startsWith(`${retryTarget}.`)
        && writeCall === 0
      ) {
        writeCall += 1;
        const error = new Error('simulated temporary file lock');
        error.code = 'EPERM';
        throw error;
      }
      writeCall += 1;
      return originalWrite(...args);
    };
    try {
      store.write(retryTarget, 'retry-success');
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(writeCall, 2);
    assert.equal(fs.readFileSync(retryTarget, 'utf8'), 'retry-success');

    const renameRetryTarget = path.join(
      temporaryDirectory,
      'atomic-rename-retry.txt',
    );
    fs.writeFileSync(renameRetryTarget, 'old-before-retry', 'utf8');
    const originalRename = fs.renameSync;
    let renameCall = 0;
    fs.renameSync = (source, destination) => {
      if (destination === renameRetryTarget) {
        renameCall += 1;
      }
      if (destination === renameRetryTarget && renameCall <= 2) {
        const error = new Error('simulated occupied target');
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(source, destination);
    };
    try {
      store.write(renameRetryTarget, 'new-after-retry');
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(renameCall, 3);
    assert.equal(
      fs.readFileSync(renameRetryTarget, 'utf8'),
      'new-after-retry',
    );
    assert.deepEqual(temporaryArtifacts(renameRetryTarget), []);
  }

  assertRenameFailurePreservesTarget('atomic-occupied.txt', 'EBUSY');
  assertRenameFailurePreservesTarget('atomic-permission.txt', 'EACCES');
  assertRenameFailurePreservesTarget('atomic-cross-volume.txt', 'EXDEV');
  assertRenameFailurePreservesTarget('atomic-repeated-rename.txt', 'EPERM');
  assert.deepEqual(
    temporaryArtifacts(target),
    [],
  );
}

module.exports = {
  testAppPaths,
  testSecureFileService,
  testGuiLogService,
  testAtomicFileStore,
};
