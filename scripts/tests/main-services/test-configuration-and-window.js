/**
 * 窗口、设置存储和 GUI 配置服务测试。
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
  GuiSettingsCommitService,
  PythonEnvironmentService,
  temporaryDirectory,
} = context;
const {
  DEFAULT_LOOT_PLANS,
} = require('../../../dist/src/shared/lootPlans.js');

/** 验证窗口偏好、创建参数和唯一窗口状态。 */
function testWindowService() {
  const settingsPath = path.join(temporaryDirectory, 'window-settings.json');
  const settings = new GuiSettingsStore(
    () => settingsPath,
    new AtomicFileStore(),
  );
  settings.write({
    default_window_width: 400,
    default_window_height: 'invalid',
    remember_window_bounds: true,
    window_bounds: {
      x: 20,
      y: 30,
      width: 1400,
      height: 800,
    },
  });

  let createdOptions = null;
  let loadedFile = null;
  let headersHandler = null;
  let normalBounds = { x: 20, y: 30, width: 1400, height: 800 };
  let windowDestroyed = false;
  let webContentsDestroyed = false;
  let sendFailsAsDestroyed = false;
  const sentMessages = [];
  const windowHandlers = new Map();
  const webContentsHandlers = new Map();
  const fakeWindow = {
    isDestroyed: () => windowDestroyed,
    getNormalBounds: () => normalBounds,
    webContents: {
      isDestroyed: () => webContentsDestroyed,
      send: (...args) => {
        if (
          windowDestroyed
          || webContentsDestroyed
          || sendFailsAsDestroyed
        ) {
          throw new TypeError('Object has been destroyed');
        }
        sentMessages.push(args);
      },
      session: {
        webRequest: {
          onHeadersReceived: handler => {
            headersHandler = handler;
          },
        },
      },
      on: (event, handler) => {
        webContentsHandlers.set(event, handler);
      },
    },
    loadFile: filePath => {
      loadedFile = filePath;
      return Promise.resolve();
    },
    on: (event, handler) => {
      windowHandlers.set(event, handler);
    },
  };
  const service = new WindowService(settings, {
    backendPort: 18438,
    moduleDirectory: path.join(temporaryDirectory, 'dist', 'electron'),
    createBrowserWindow: options => {
      createdOptions = options;
      return fakeWindow;
    },
    getDisplays: () => [{
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }],
    getAppPath: () => path.join(temporaryDirectory, 'app'),
    isPackaged: () => false,
    resourceRoot: () => path.join(temporaryDirectory, 'resources'),
    showMessageBox: () => {},
  });

  assert.deepEqual(service.getPreferences(), {
    defaultWidth: 854,
    defaultHeight: 720,
    rememberBounds: true,
  });
  service.createWindow();
  assert.equal(createdOptions.width, 1400);
  assert.equal(createdOptions.height, 800);
  assert.equal(createdOptions.x, 20);
  assert.equal(createdOptions.y, 30);
  assert.equal(createdOptions.center, false);
  assert.equal(
    createdOptions.webPreferences.preload,
    path.join(temporaryDirectory, 'dist', 'electron', 'preload.js'),
  );
  assert.equal(
    loadedFile,
    path.join(temporaryDirectory, 'app', 'src', 'view', 'index.html'),
  );
  assert.equal(service.getMainWindow(), fakeWindow);
  assert.equal(
    service.sendToRenderer('backend-log', 'backend running'),
    true,
  );
  assert.deepEqual(sentMessages, [
    ['backend-log', 'backend running'],
  ]);
  sendFailsAsDestroyed = true;
  assert.equal(
    service.sendToRenderer('backend-log', 'racing close output'),
    false,
  );
  assert.equal(sentMessages.length, 1);
  sendFailsAsDestroyed = false;
  webContentsDestroyed = true;
  assert.equal(
    service.sendToRenderer('backend-log', 'late output'),
    false,
  );
  assert.equal(sentMessages.length, 1);
  webContentsDestroyed = false;
  windowDestroyed = true;
  assert.equal(
    service.sendToRenderer('backend-log', 'destroyed window output'),
    false,
  );
  assert.equal(sentMessages.length, 1);
  windowDestroyed = false;

  let responseHeaders = null;
  headersHandler(
    { responseHeaders: { existing: ['value'] } },
    response => {
      responseHeaders = response.responseHeaders;
    },
  );
  assert.match(
    responseHeaders['Content-Security-Policy'][0],
    /localhost:18438/,
  );

  normalBounds = { x: 40, y: 50, width: 1500, height: 900 };
  windowHandlers.get('close')();
  assert.deepEqual(settings.read().window_bounds, normalBounds);
  windowHandlers.get('closed')();
  assert.equal(service.getMainWindow(), null);
  assert.equal(
    service.sendToRenderer('backend-log', 'closed window output'),
    false,
  );

  assert.deepEqual(service.setPreferences({
    defaultWidth: 1440,
    defaultHeight: 810,
    rememberBounds: false,
  }), {
    defaultWidth: 1440,
    defaultHeight: 810,
    rememberBounds: false,
  });
  assert.equal(webContentsHandlers.has('did-fail-load'), true);
}

/** 验证 GUI 设置读取、损坏回退和浅合并格式。 */
function testGuiSettingsStore() {
  const settingsPath = path.join(temporaryDirectory, 'gui_settings.json');
  const store = new GuiSettingsStore(
    () => settingsPath,
    new AtomicFileStore(),
  );

  assert.deepEqual(store.read(), {});
  fs.writeFileSync(settingsPath, '{invalid', 'utf8');
  assert.deepEqual(store.read(), {});
  assert.throws(
    () => store.write({ backend_port: 18438 }),
    /Unexpected token|JSON/,
  );
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{invalid');

  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      preserved: 'keep',
      nested: { old: true },
    }),
    'utf8',
  );
  store.write({
    backend_port: 18438,
    nested: { current: true },
  });
  assert.equal(
    fs.readFileSync(settingsPath, 'utf8'),
    JSON.stringify({
      preserved: 'keep',
      nested: { current: true },
      backend_port: 18438,
    }, null, 2),
  );
}

/** 验证 GUI 配置字段保持既有默认值、边界和迁移规则。 */
function testGuiConfigurationService() {
  const settingsPath = path.join(
    temporaryDirectory,
    'gui_configuration.json',
  );
  const store = new GuiSettingsStore(
    () => settingsPath,
    new AtomicFileStore(),
  );
  const environmentPort = { value: undefined };
  let clearPythonCacheCalls = 0;
  const service = new GuiConfigurationService(store, {
    clearPythonCache: () => {
      clearPythonCacheCalls += 1;
    },
    normalizeCudaPath: candidate => candidate.replaceAll('/', '\\'),
    environmentPort: () => environmentPort.value,
  });

  assert.deepEqual(service.legacyDecisiveAutomation(), {
    exists: false,
    settings: {},
  });
  assert.equal(service.backendPort(), 8438);
  service.setBackendPort(18438.9);
  assert.equal(service.backendPort(), 18438);
  service.setBackendPort(0);
  service.setBackendPort(Number.NaN);
  assert.equal(service.backendPort(), 18438);
  environmentPort.value = '28438';
  assert.equal(service.backendPort(), 28438);
  environmentPort.value = undefined;

  assert.equal(service.configuredPythonPath(), null);
  service.setPythonPath('C:\\Python313\\python.exe');
  assert.equal(
    service.configuredPythonPath(),
    'C:\\Python313\\python.exe',
  );
  service.setPythonPath(null);
  assert.equal(service.configuredPythonPath(), null);
  assert.equal(clearPythonCacheCalls, 2);

  assert.equal(service.updateMode(), 'auto');
  assert.equal(service.allowTestUpdates(), false);
  const alphaSettingsPath = path.join(
    temporaryDirectory,
    'alpha_gui_configuration.json',
  );
  const alphaService = new GuiConfigurationService(
    new GuiSettingsStore(
      () => alphaSettingsPath,
      new AtomicFileStore(),
    ),
    {
      clearPythonCache: () => {},
      normalizeCudaPath: candidate => candidate,
      defaultAllowTestUpdates: () => true,
    },
  );
  assert.equal(alphaService.allowTestUpdates(), true);
  service.setUpdateMode('manual');
  assert.equal(service.updateMode(), 'manual');
  service.setUpdateMode('invalid');
  assert.equal(service.updateMode(), 'auto');

  assert.equal(service.backendStartupMode(), 'managed');
  service.setBackendStartupMode('external');
  assert.equal(service.backendStartupMode(), 'external');
  service.setBackendStartupMode('invalid');
  assert.equal(service.backendStartupMode(), 'managed');

  service.setBackendRepoPath('  C:\\AutoWSGR  ');
  assert.equal(service.backendRepoPath(), 'C:\\AutoWSGR');
  service.setBackendRepoPath(null);
  assert.equal(service.backendRepoPath(), '');

  assert.equal(service.ocrGpuMode(), 'auto');
  service.setOcrGpuMode('cuda');
  assert.equal(service.ocrGpuMode(), 'cuda');
  service.setOcrGpuMode('invalid');
  assert.equal(service.ocrGpuMode(), 'auto');

  service.setCudaPath('  C:/CUDA/v12.8  ');
  assert.equal(service.cudaPath(), 'C:\\CUDA\\v12.8');
  service.setCudaPath(null);
  assert.equal(service.cudaPath(), '');

  assert.equal(service.saveBackendScreenshots(), false);
  service.setSaveBackendScreenshots(true);
  assert.equal(service.saveBackendScreenshots(), true);
  service.setSaveBackendScreenshots('true');
  assert.equal(service.saveBackendScreenshots(), false);

  assert.deepEqual(service.automation(), {
    exists: false,
    settings: {},
  });
  store.write({
    automation: {
      expeditionInterval: 20,
    },
  });
  assert.deepEqual(service.automation(), {
    exists: true,
    settings: {
      expeditionInterval: 20,
    },
  });
  store.write({
    automation: {
      expeditionInterval: 20,
      battleTimes: 4,
      autoLoot: true,
      lootPlanIndex: 2,
      lootStopCount: 16,
    },
  });
  assert.deepEqual(service.automation(), {
    exists: true,
    settings: {
      expeditionInterval: 20,
      battleTimes: 8,
      autoLoot: true,
      lootPlanSource: 'system',
      lootPlanId: 'bettle-周常-8-2.yaml',
      lootStopCount: 16,
    },
  });
  assert.equal(
    Object.hasOwn(store.read().automation, 'lootPlanIndex'),
    false,
  );
  assert.equal(
    store.read().automation.battleTimes,
    8,
    '启动读取时必须把历史战役次数改写为固定 8 次',
  );
  store.write({
    automation: {
      autoLoot: true,
      lootPlanId: 'bettle-不存在.yaml',
    },
  });
  assert.deepEqual(service.automation(), {
    exists: true,
    settings: {
      autoLoot: false,
    },
  });
  assert.deepEqual(store.read().automation, {
    autoLoot: false,
    lootPlanId: 'bettle-不存在.yaml',
  });
  for (const invalidIndex of [99, null, '', false, 2.5]) {
    store.write({
      automation: {
        autoLoot: true,
        lootPlanIndex: invalidIndex,
      },
    });
    assert.deepEqual(service.automation(), {
      exists: true,
      settings: {
        autoLoot: false,
      },
    });
    assert.equal(
      Object.hasOwn(store.read().automation, 'lootPlanIndex'),
      false,
    );
  }
  store.write({ automation: { autoLoot: true } });
  assert.deepEqual(service.automation(), {
    exists: true,
    settings: {
      autoLoot: true,
    },
  });
  const userLootPlans = [
    {
      source: 'system',
      file: 'bettle-周常-8-2.yaml',
      name: '周常 8-2',
    },
    {
      source: 'user',
      file: 'bettle-用户胖次测试.yaml',
      name: '用户胖次测试',
    },
  ];
  assert.deepEqual(service.setAutomation({
    expeditionInterval: 20,
    battleTimes: 4,
    autoDecisive: false,
    decisiveTemplateId: 'user_plan',
    autoLoot: true,
    lootPlanSource: 'user',
    lootPlanId: 'bettle-用户胖次测试.yaml',
    lootPlans: userLootPlans,
    lootStopCount: 16,
  }), {
    expeditionInterval: 20,
    battleTimes: 8,
    autoDecisive: false,
    decisiveTemplateId: 'user_plan',
    autoLoot: true,
    lootPlanSource: 'user',
    lootPlanId: 'bettle-用户胖次测试.yaml',
    lootPlans: userLootPlans,
    lootStopCount: 16,
  });
  assert.deepEqual(service.automation(), {
    exists: true,
    settings: {
      expeditionInterval: 20,
      battleTimes: 8,
      autoDecisive: false,
      decisiveTemplateId: 'user_plan',
      autoLoot: true,
      lootPlanSource: 'user',
      lootPlanId: 'bettle-用户胖次测试.yaml',
      lootPlans: userLootPlans,
      lootStopCount: 16,
    },
  });
  assert.deepEqual(service.setAutomation({
    expeditionInterval: 20,
    battleTimes: 4,
    autoDecisive: false,
    decisiveTemplateId: 'user_plan',
    autoLoot: true,
    lootPlanSource: 'user',
    lootPlanId: 'bettle-用户胖次测试.yaml',
    lootPlans: [],
    lootStopCount: 16,
  }), {
    expeditionInterval: 20,
    battleTimes: 8,
    autoDecisive: false,
    decisiveTemplateId: 'user_plan',
    autoLoot: false,
    lootPlanSource: 'system',
    lootPlanId: 'bettle-old-9-2ADGHM速刷胖次.yaml',
    lootPlans: [],
    lootStopCount: 16,
  });
  assert.deepEqual(service.setAutomation({
    expeditionInterval: 999,
    battleTimes: 0,
    autoDecisive: true,
    decisiveTemplateId: '  builtin_decisive_6  ',
    autoLoot: true,
    lootPlanId: 'bettle-捞胖次-8-5.yaml',
    lootStopCount: 0,
  }), {
    expeditionInterval: 120,
    battleTimes: 8,
    autoDecisive: true,
    decisiveTemplateId: 'system_preset',
    autoLoot: true,
    lootPlanSource: 'system',
    lootPlanId: 'bettle-old-8-5AI六潜胖次.yaml',
    lootPlans: DEFAULT_LOOT_PLANS,
    lootStopCount: 50,
  });
  assert.deepEqual(service.automation(), {
    exists: true,
    settings: {
      expeditionInterval: 120,
      battleTimes: 8,
      autoDecisive: true,
      decisiveTemplateId: 'system_preset',
      autoLoot: true,
      lootPlanSource: 'system',
      lootPlanId: 'bettle-old-8-5AI六潜胖次.yaml',
      lootPlans: DEFAULT_LOOT_PLANS,
      lootStopCount: 50,
    },
  });

  const automationWithoutLegacyDecisive = {
    ...store.read().automation,
  };
  delete automationWithoutLegacyDecisive.autoDecisive;
  delete automationWithoutLegacyDecisive.decisiveTemplateId;
  store.write({ automation: automationWithoutLegacyDecisive });
  store.write({
    preserved: 'keep',
    legacy_decisive_automation: {
      preserved_extension: 'keep',
    },
    decisive_plan: {
      chapter: 9,
      use_quick_repair: false,
      level1: [' A ', 'B', 'C', 'D', 'E', 'F', 'G'],
      level2: ['B', 'H'],
      level3: ['I', 'H'],
    },
  });
  assert.deepEqual(service.legacyDecisiveAutomation(), {
    exists: true,
    settings: {},
  });
  const decisivePlanBeforeLegacyMigration = structuredClone(
    store.read().decisive_plan,
  );
  const legacyDecisive = {
    autoDecisive: true,
    ticketReserve: 0,
    templateId: 'builtin_decisive_6',
  };
  assert.deepEqual(
    service.migrateLegacyDecisiveAutomation(legacyDecisive),
    legacyDecisive,
  );
  assert.deepEqual(service.legacyDecisiveAutomation(), {
    exists: true,
    settings: legacyDecisive,
  });
  assert.deepEqual(service.automation(), {
    exists: true,
    settings: {
      expeditionInterval: 120,
      battleTimes: 8,
      autoDecisive: true,
      decisiveTemplateId: 'system_preset',
      autoLoot: true,
      lootPlanSource: 'system',
      lootPlanId: 'bettle-old-8-5AI六潜胖次.yaml',
      lootPlans: DEFAULT_LOOT_PLANS,
      lootStopCount: 50,
    },
  });
  assert.deepEqual(
    store.read().legacy_decisive_automation,
    {
      preserved_extension: 'keep',
      auto_decisive: true,
      decisive_ticket_reserve: 0,
      decisive_template_id: 'builtin_decisive_6',
    },
  );
  assert.deepEqual(
    store.read().decisive_plan,
    decisivePlanBeforeLegacyMigration,
    '旧版决战字段不能覆盖当前决战计划',
  );
  assert.deepEqual(
    service.migrateLegacyDecisiveAutomation(legacyDecisive),
    legacyDecisive,
    '重复迁移必须保持原值',
  );
  assert.throws(
    () => service.migrateLegacyDecisiveAutomation({
      ticketReserve: Number.NaN,
    }),
    /decisive_ticket_reserve/,
  );
  assert.deepEqual(service.decisivePlan(), {
    chapter: 6,
    useQuickRepair: false,
    level1: ['A', 'B', 'C', 'D', 'E', 'F'],
    level2: ['G', 'H', 'I'],
  });
  assert.deepEqual(store.read(), {
    backend_port: 18438,
    python_path: '',
    update_mode: 'auto',
    backend_startup_mode: 'managed',
    backend_repo_path: '',
    ocr_gpu_mode: 'auto',
    cuda_path: '',
    save_backend_screenshots: false,
    automation: {
      expeditionInterval: 120,
      battleTimes: 8,
      autoDecisive: true,
      decisiveTemplateId: 'system_preset',
      autoLoot: true,
      lootPlanSource: 'system',
      lootPlanId: 'bettle-old-8-5AI六潜胖次.yaml',
      lootPlans: DEFAULT_LOOT_PLANS,
      lootStopCount: 50,
    },
    preserved: 'keep',
    legacy_decisive_automation: {
      preserved_extension: 'keep',
      auto_decisive: true,
      decisive_ticket_reserve: 0,
      decisive_template_id: 'builtin_decisive_6',
    },
    decisive_plan: {
      chapter: 6,
      use_quick_repair: false,
      level1: ['A', 'B', 'C', 'D', 'E', 'F'],
      level2: ['G', 'H', 'I'],
    },
  });

  const committedAutomation = service.commitSettings({
    updateMode: 'manual',
    allowTestUpdates: true,
    backendPort: 19438,
    backendStartupMode: 'external',
    backendRepoPath: '  C:\\AutoWSGR  ',
    ocrGpuMode: 'cuda',
    cudaPath: ' C:/CUDA/v12.8 ',
    saveBackendScreenshots: true,
    pythonPath: 'C:\\Python313\\python.exe',
    windowPreferences: {
      defaultWidth: 1400,
      defaultHeight: 800,
      rememberBounds: true,
    },
    automation: {
      expeditionInterval: 30,
      battleTimes: 5,
      autoDecisive: true,
      decisiveTemplateId: 'system_preset',
      autoLoot: false,
      lootPlanSource: 'system',
      lootPlanId: DEFAULT_LOOT_PLANS[0].file,
      lootPlans: DEFAULT_LOOT_PLANS,
      lootStopCount: 40,
    },
    usersettingsYaml: 'ignored by service',
  }, {
    default_window_width: 1400,
    default_window_height: 800,
    remember_window_bounds: true,
  });
  const committedSettings = store.read();
  assert.equal(
    committedAutomation.battleTimes,
    8,
    '设置提交必须忽略历史自定义值并固定每日战役为 8 次',
  );
  assert.equal(committedSettings.update_mode, 'manual');
  assert.equal(committedSettings.allow_test_updates, true);
  assert.equal(committedSettings.backend_port, 19438);
  assert.equal(
    committedSettings.backend_startup_mode,
    'external',
  );
  assert.equal(committedSettings.backend_repo_path, 'C:\\AutoWSGR');
  assert.equal(committedSettings.ocr_gpu_mode, 'cuda');
  assert.equal(committedSettings.cuda_path, 'C:\\CUDA\\v12.8');
  assert.equal(committedSettings.save_backend_screenshots, true);
  assert.equal(
    committedSettings.python_path,
    'C:\\Python313\\python.exe',
  );
  assert.equal(committedSettings.default_window_width, 1400);
  assert.equal(committedSettings.default_window_height, 800);
  assert.equal(committedSettings.remember_window_bounds, true);
  assert.deepEqual(committedSettings.automation, committedAutomation);
  assert.equal(clearPythonCacheCalls, 3);

  fs.rmSync(settingsPath, { force: true });
  const defaults = service.decisivePlan();
  assert.equal(defaults.chapter, 6);
  assert.equal(defaults.useQuickRepair, true);
  assert.equal(defaults.level1.length, 6);
  assert.ok(defaults.level2.length > 0);
}

/** 验证跨文件设置提交成功，以及 JSON 写入失败时恢复 YAML。 */
function testGuiSettingsCommitService() {
  const actions = [];
  let yamlContent = 'old: yaml\n';
  let failGuiSettingsWrite = true;
  const automation = {
    expeditionInterval: 15,
    battleTimes: 3,
    autoDecisive: false,
    decisiveTemplateId: 'builtin',
    autoLoot: false,
    lootPlanSource: 'system',
    lootPlanId: 'loot.yaml',
    lootPlans: [],
    lootStopCount: 50,
  };
  const service = new GuiSettingsCommitService(
    {
      commitSettings: (_request, patch) => {
        actions.push('commit-json');
        assert.deepEqual(patch, {
          default_window_width: 1280,
          default_window_height: 720,
          remember_window_bounds: true,
        });
        if (failGuiSettingsWrite) {
          throw new Error('模拟 GUI JSON 写入失败');
        }
        return automation;
      },
    },
    {
      snapshot: () => {
        actions.push('snapshot-yaml');
        return { exists: true, content: yamlContent };
      },
      save: (_file, content) => {
        actions.push('save-yaml');
        yamlContent = content;
      },
      restore: (_file, snapshot) => {
        actions.push('restore-yaml');
        yamlContent = snapshot.content;
      },
    },
    {
      preparePreferences: preferences => {
        actions.push('prepare-window');
        return {
          preferences,
          settingsPatch: {
            default_window_width: preferences.defaultWidth,
            default_window_height: preferences.defaultHeight,
            remember_window_bounds: preferences.rememberBounds,
          },
        };
      },
    },
  );
  const request = {
    windowPreferences: {
      defaultWidth: 1280,
      defaultHeight: 720,
      rememberBounds: true,
    },
    usersettingsYaml: 'new: yaml\n',
  };

  assert.throws(
    () => service.commitAtomic(request),
    /模拟 GUI JSON 写入失败/,
  );
  assert.equal(yamlContent, 'old: yaml\n');
  assert.deepEqual(actions, [
    'prepare-window',
    'snapshot-yaml',
    'save-yaml',
    'commit-json',
    'restore-yaml',
  ]);

  actions.length = 0;
  failGuiSettingsWrite = false;
  assert.deepEqual(service.commitAtomic(request), {
    automation,
    windowPreferences: request.windowPreferences,
  });
  assert.equal(yamlContent, 'new: yaml\n');
  assert.deepEqual(actions, [
    'prepare-window',
    'snapshot-yaml',
    'save-yaml',
    'commit-json',
  ]);
  assert.throws(
    () => service.commitAtomic(null),
    /设置提交内容无效/,
  );
}

module.exports = {
  testWindowService,
  testGuiSettingsStore,
  testGuiConfigurationService,
  testGuiSettingsCommitService,
};
