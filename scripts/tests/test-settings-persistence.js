/**
 * 设置页持久化隔离测试。
 *
 * 测试流程：
 * 1. 使用隐藏的 Electron BrowserWindow 加载真实设置页 HTML。
 * 2. 拦截正式 renderer bundle，避免启动应用和后端。
 * 3. 实例化真实 ConfigView、ConfigModel 和 ConfigController。
 * 4. 向所有可保存表单字段写入一组测试值。
 * 5. 验证 ConfigView 渲染和收集结果完全一致。
 * 6. 通过模拟 Electron Bridge 执行真实控制器保存逻辑。
 * 7. 将 YAML 和 GUI JSON 写入系统临时目录。
 * 8. 从磁盘重新读取并验证全部字段。
 * 9. 验证主题、主色调和调试模式的 localStorage 写入。
 * 10. 验证非法延迟区间会被表单校验拒绝。
 * 11. 测试过程不读取或修改项目中的真实用户配置。
 * 12. 完成后删除临时目录并清理测试会话数据。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  session,
} = require('electron');

app.commandLine.appendSwitch('disable-gpu');

const projectRoot = path.resolve(__dirname, '..', '..');
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-settings-test-'),
);
app.setPath(
  'userData',
  path.join(temporaryDirectory, 'electron-user-data'),
);

/**
 * 在真实设置页 DOM 中执行设置保存测试。
 *
 * @param {string} root 项目根目录。
 * @param {string} tempDirectory 隔离配置输出目录。
 * @returns {Promise<Record<string, number>>} 测试覆盖统计。
 */
async function runRendererTest(root, tempDirectory) {
  const rendererAssert = require('node:assert/strict');
  const rendererFs = require('node:fs');
  const rendererPath = require('node:path');
  const yaml = require('js-yaml');
  const {
    ConfigView,
  } = require(rendererPath.join(
    root,
    'dist/src/view/config/ConfigView.js',
  ));
  const {
    ConfigModel,
  } = require(rendererPath.join(
    root,
    'dist/src/model/ConfigModel.js',
  ));
  const {
    NormalFightDailyQuota,
  } = require(rendererPath.join(
    root,
    'dist/src/model/scheduler/NormalFightDailyQuota.js',
  ));
  const {
    ConfigController,
  } = require(rendererPath.join(
    root,
    'dist/src/controller/app/ConfigController.js',
  ));
  const {
    SettingsController,
  } = require(rendererPath.join(
    root,
    'dist/src/controller/app/SettingsController.js',
  ));
  const {
    NavigationController,
  } = require(rendererPath.join(
    root,
    'dist/src/controller/app/NavigationController.js',
  ));
  const {
    BattlePlanLoaderController,
  } = require(rendererPath.join(
    root,
    'dist/src/controller/plan/BattlePlanLoaderController.js',
  ));
  const {
    BattlePlanLoaderView,
  } = require(rendererPath.join(
    root,
    'dist/src/view/plan/BattlePlanLoaderView.js',
  ));
  const {
    TaskGroupModel,
  } = require(rendererPath.join(
    root,
    'dist/src/model/TaskGroupModel.js',
  ));
  const {
    TaskListLoaderController,
  } = require(rendererPath.join(
    root,
    'dist/src/controller/taskGroup/TaskListLoaderController.js',
  ));
  const {
    TaskListLoaderView,
  } = require(rendererPath.join(
    root,
    'dist/src/view/taskGroup/TaskListLoaderView.js',
  ));
  const {
    DEFAULT_LOOT_PLANS,
  } = require(rendererPath.join(
    root,
    'dist/src/shared/lootPlans.js',
  ));

  const shipNameAliases = {
    测试别名: 'U-47',
  };
  const shipNameCorrections = {
    测试错字: 'U-81',
  };
  const sample = {
    emulatorType: '蓝叠',
    emulatorPath: 'C:\\SettingsTest\\Emulator.exe',
    emulatorSerial: '127.0.0.1:26555',
    gameApp: '小米',
    updateMode: 'manual',
    allowTestUpdates: true,
    autoExpedition: false,
    expeditionInterval: 23,
    autoBattle: true,
    battleType: '困难航母',
    autoExercise: true,
    exerciseFleetId: 3,
    battleTimes: 7,
    autoNormalFight: true,
    normalFightTasks: [
      {
        name: 'battle.yaml',
        source: 'user',
        fleet_id: 3,
        fleet_preset_index: 1,
        times: 2,
      },
    ],
    normalFightRemaining: 2,
    autoDecisive: true,
    decisiveTemplateId: 'system_preset',
    autoLoot: true,
    lootPlanSource: 'user',
    lootPlanId: 'bettle-用户胖次测试.yaml',
    lootPlans: [
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
    ],
    lootStopCount: 17,
    logLevel: 'WARNING',
    logRoot: 'C:\\SettingsTest\\logs',
    guiLogRoot: 'C:\\SettingsTest\\gui-logs',
    themeMode: 'light',
    accentColor: '#123456',
    debugMode: true,
    backendPort: 18438,
    backendStartupMode: 'external',
    backendRepoPath: 'C:\\SettingsTest\\AutoWSGR',
    ocrGpuMode: 'cuda',
    ocrGpu: true,
    ocrMirror: 'github',
    enhancedShipOcr: true,
    ocrConfidence: 0.73,
    shipNameAliasesText: '测试别名:U-47',
    shipNameCorrectionsText: '测试错字:U-81',
    cudaPath: 'C:\\SettingsTest\\CUDA',
    saveBackendScreenshots: true,
    pythonPath: 'C:\\SettingsTest\\python.exe',
    defaultWindowWidth: 1440,
    defaultWindowHeight: 810,
    rememberWindowBounds: true,
    operationDelayMin: 0.4,
    operationDelayMax: 1.6,
    dockFullDestroy: false,
    repairManually: true,
    bathroomCount: 6,
    destroyShipWorkMode: 2,
    destroyShipTypes: ['驱逐', '潜艇'],
    removeEquipmentMode: false,
    planRoot: 'C:\\SettingsTest\\plans',
  };

  const sectionByTitle = title => Array.from(
    document.querySelectorAll('.config-list-section'),
  ).find(section => (
    section.querySelector('.config-section-heading h3')?.textContent === title
  ));
  const systemPanel = document.querySelector(
    '[data-config-panel="system"]',
  );
  const behaviorPanel = document.querySelector(
    '[data-config-panel="behavior"]',
  );
  const delaySection = sectionByTitle('全局延迟');
  const automationSection = sectionByTitle('自动化设置');
  const fleetSection = sectionByTitle('舰队设置');
  const ocrSection = sectionByTitle('OCR 设置');
  rendererAssert.equal(
    automationSection?.parentElement,
    behaviorPanel,
    '自动化设置必须位于脚本行为面板',
  );
  rendererAssert.equal(
    systemPanel?.contains(automationSection),
    false,
    '系统设置面板不得再包含自动化设置',
  );
  rendererAssert.ok(
    delaySection.compareDocumentPosition(automationSection)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    '自动化设置必须位于全局延迟设置之后',
  );
  rendererAssert.equal(
    fleetSection?.parentElement,
    behaviorPanel,
    '舰队设置必须位于脚本行为面板',
  );
  rendererAssert.ok(
    fleetSection.compareDocumentPosition(ocrSection)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    '舰队设置必须位于 OCR 设置之前',
  );

  const view = new ConfigView();
  const updateProgress = document.getElementById('gui-update-progress');
  const updateProgressTrack = document.getElementById(
    'gui-update-progress-track',
  );
  const updateProgressFill = document.getElementById(
    'gui-update-progress-fill',
  );
  const updateStatus = document.getElementById('gui-update-status');
  const updatePercent = document.getElementById('gui-update-percent');
  const updateControls = updateProgress.closest('.config-update-controls');
  const backendUpdateProgress = document.getElementById(
    'backend-update-progress',
  );
  const backendUpdateControls = backendUpdateProgress.closest(
    '.config-update-controls',
  );
  rendererAssert.notEqual(
    backendUpdateControls,
    updateControls,
    '后端更新与 GUI 更新必须位于不同的设置行',
  );
  rendererAssert.equal(
    updateProgress.parentElement,
    updateControls,
    'GUI 更新进度必须与更新模式和检查按钮位于同一行',
  );
  rendererAssert.equal(updateProgress.hidden, true);
  rendererAssert.equal(backendUpdateProgress.hidden, true);
  view.setBackendUpdateStatus({ status: 'checking' });
  rendererAssert.equal(backendUpdateProgress.hidden, false);
  rendererAssert.equal(
    document.getElementById('backend-update-percent').textContent,
    '检查中',
  );
  view.setBackendUpdateStatus({
    status: 'downloading',
    progress: 42,
  });
  rendererAssert.equal(
    document.getElementById('backend-update-status').textContent,
    '正在下载后端更新…',
  );
  rendererAssert.equal(
    document.getElementById('backend-update-percent').textContent,
    '42%',
  );
  view.setBackendUpdateStatus({ status: 'downloaded', commit: 'b'.repeat(40) });
  rendererAssert.equal(
    backendUpdateProgress.dataset.state,
    'complete',
  );
  rendererAssert.equal(
    document.getElementById('backend-update-status').textContent,
    '后端更新已准备完成，重启 GUI 后生效',
  );
  view.setGuiUpdateStatus({ status: 'checking' });
  rendererAssert.equal(updateProgress.hidden, false);
  rendererAssert.equal(updatePercent.textContent, '检查中');
  rendererAssert.equal(
    updateProgressTrack.classList.contains('is-indeterminate'),
    true,
  );
  view.setGuiUpdateStatus({ status: 'downloading' });
  rendererAssert.equal(
    updateStatus.textContent,
    '正在后台下载并校验更新…',
  );
  rendererAssert.equal(updatePercent.textContent, '后台');
  rendererAssert.equal(updateProgressFill.style.width, '0%');
  rendererAssert.equal(
    updateProgressTrack.classList.contains('is-indeterminate'),
    true,
  );
  view.setGuiUpdateStatus({ status: 'downloaded', version: '2.0.5-alpha' });
  rendererAssert.equal(updateProgress.dataset.state, 'complete');
  rendererAssert.equal(updatePercent.textContent, '100%');
  rendererAssert.equal(
    updateStatus.textContent,
    'v2.0.5-alpha 已准备完成，等待选择重启时间',
  );
  view.setGuiUpdateStatus({ status: 'deferred', version: '2.0.5-alpha' });
  rendererAssert.equal(
    updateStatus.textContent,
    'v2.0.5-alpha 将在下次打开前更新',
  );
  const shipLibraryStatus = document.getElementById('ship-library-status');
  view.setShipLibraryStatus(
    '前后端舰名库不一致',
    'error',
    '后端缺少 12 条舰名',
  );
  rendererAssert.equal(
    shipLibraryStatus.textContent,
    '前后端舰名库不一致',
  );
  rendererAssert.equal(shipLibraryStatus.title, '后端缺少 12 条舰名');

  const decisiveOptions = Array.from(
    document.getElementById('cfg-decisive-template').options,
  ).map(option => [option.value, option.textContent]);
  rendererAssert.deepStrictEqual(decisiveOptions, [
    ['user_plan', '用户计划'],
    ['system_preset', '系统预设'],
  ]);
  const battleTypeStyle = getComputedStyle(
    document.getElementById('cfg-battle-type'),
  );
  const exerciseFleetStyle = getComputedStyle(
    document.getElementById('cfg-exercise-fleet'),
  );
  rendererAssert.equal(
    document.getElementById('cfg-battle-type')
      .dataset.animatedSelectWidth,
    'source',
    '自动战役选项浮层必须跟随输入框宽度',
  );
  rendererAssert.equal(
    document.getElementById('cfg-exercise-fleet')
      .dataset.animatedSelectWidth,
    'source',
    '出征舰队选项浮层必须跟随输入框宽度',
  );
  rendererAssert.equal(
    document.getElementById('cfg-battle-type')
      .dataset.configSelectWidth,
    document.getElementById('cfg-exercise-fleet')
      .dataset.configSelectWidth,
    '自动战役与出征舰队必须使用同一个固定宽度',
  );
  rendererAssert.equal(
    document.getElementById('cfg-battle-type')
      .style.getPropertyValue('--config-select-width'),
    document.getElementById('cfg-exercise-fleet')
      .style.getPropertyValue('--config-select-width'),
    '自动战役与出征舰队渲染后的宽度必须一致',
  );
  ['width', 'minWidth', 'maxWidth', 'flexBasis'].forEach((property) => {
    rendererAssert.equal(
      battleTypeStyle[property],
      exerciseFleetStyle[property],
      `自动战役与出征舰队下拉框的 ${property} 必须一致`,
    );
  });
  view.render(sample);
  const backendUpdateRow = document.getElementById(
    'cfg-backend-update-row',
  );
  const backendUpdateMode = document.getElementById(
    'cfg-backend-update-mode',
  );
  const backendUpdateButton = document.getElementById(
    'btn-check-backend-updates',
  );
  const allowTestUpdates = document.getElementById(
    'cfg-allow-test-updates',
  );
  const externalBackend = document.getElementById(
    'cfg-use-external-backend',
  );
  rendererAssert.equal(backendUpdateRow.hidden, false);
  rendererAssert.equal(
    backendUpdateButton.disabled,
    true,
    'external 模式不得触发 managed 后端更新',
  );
  allowTestUpdates.checked = false;
  allowTestUpdates.dispatchEvent(new Event('change'));
  rendererAssert.equal(backendUpdateRow.hidden, true);
  rendererAssert.equal(backendUpdateMode.disabled, true);
  allowTestUpdates.checked = true;
  allowTestUpdates.dispatchEvent(new Event('change'));
  externalBackend.checked = false;
  externalBackend.dispatchEvent(new Event('change'));
  rendererAssert.equal(backendUpdateRow.hidden, false);
  rendererAssert.equal(backendUpdateButton.disabled, false);
  view.setBackendUpdateCheckLoading(true);
  rendererAssert.equal(backendUpdateButton.disabled, true);
  view.setBackendUpdateCheckLoading(false);
  rendererAssert.equal(backendUpdateButton.disabled, false);
  externalBackend.checked = true;
  externalBackend.dispatchEvent(new Event('change'));
  rendererAssert.equal(
    document.querySelector('#cfg-normal-fight-tasks .config-task-remaining')
      ?.textContent,
    '今日剩余执行次数：2',
    '加载自动出征任务后必须显示今日剩余执行次数',
  );
  view.setNormalFightPlan(
    { ...sample.normalFightTasks[0], times: 5 },
    '草稿舰队',
    3,
  );
  view.setNormalFightRemaining(sample.normalFightTasks, 1);
  rendererAssert.equal(
    document.querySelector('#cfg-normal-fight-tasks .config-task-remaining')
      ?.textContent,
    '今日剩余执行次数：3',
    '已修改但未保存的每日次数不得被旧配置刷新覆盖',
  );
  view.render(sample);

  [
    ['cfg-auto-battle', 'cfg-auto-battle-body'],
    ['cfg-auto-exercise', 'cfg-auto-exercise-body'],
    ['cfg-auto-normal-fight', 'cfg-auto-normal-fight-body'],
    ['cfg-auto-decisive', 'cfg-auto-decisive-body'],
    ['cfg-auto-loot', 'cfg-auto-loot-body'],
  ].forEach(([switchId, bodyId]) => {
    const automationSwitch = document.getElementById(switchId);
    const automationBody = document.getElementById(bodyId);
    const originalChecked = automationSwitch.checked;
    automationSwitch.checked = false;
    automationSwitch.dispatchEvent(new Event('change'));
    rendererAssert.notEqual(
      getComputedStyle(automationBody).display,
      'none',
      `关闭 ${switchId} 后不得收起内部配置`,
    );
    automationSwitch.checked = originalChecked;
  });

  const collected = view.collect();
  rendererAssert.deepStrictEqual(
    collected,
    {
      ...sample,
      battleTimes: 8,
      backendUpdateMode: 'auto',
    },
    '设置页必须把历史战役次数强制归一化为 8',
  );
  view.setLootPlans([
    {
      source: 'system',
      file: 'short.yaml',
      name: '短',
    },
    {
      source: 'user',
      file: 'long.yaml',
      name: '这是一个较长的自动胖次计划名称',
    },
  ]);
  const lootPlanSelect = document.getElementById('cfg-loot-plan');
  const lootPlanWidth = Number.parseFloat(
    lootPlanSelect.style.getPropertyValue('--config-select-width'),
  );
  lootPlanSelect.selectedIndex = 1;
  lootPlanSelect.dispatchEvent(new Event('change'));
  rendererAssert.ok(
    Number.isFinite(lootPlanWidth) && lootPlanWidth <= 320,
    `自动胖次下拉框必须使用有效的分级宽度（${lootPlanWidth}）`,
  );
  rendererAssert.match(
    lootPlanSelect.title,
    /这是一个较长的自动胖次计划名称/,
    '自动胖次下拉框必须保留完整文案提示',
  );
  view.render(sample);
  view.setLootPlans([]);
  const emptyLootCollected = view.collect();
  rendererAssert.equal(
    emptyLootCollected.autoLoot,
    false,
    '删除全部自动胖次计划后必须关闭开关',
  );
  rendererAssert.deepStrictEqual(
    emptyLootCollected.lootPlans,
    [],
    '显式空列表不得恢复默认计划',
  );
  view.render(sample);

  const autoLootControl = document.querySelector(
    '.config-auto-loot-control',
  );
  rendererAssert.ok(autoLootControl, '自动胖次设置行不存在');
  rendererAssert.equal(
    getComputedStyle(autoLootControl).flexWrap,
    'nowrap',
    '自动胖次加载、下拉框、停止数量和开关必须保持同一行',
  );
  [
    'btn-load-loot-plans',
    'cfg-loot-plan',
    'cfg-loot-stop-count',
    'cfg-auto-loot',
  ].forEach((id) => {
    rendererAssert.equal(
      document.getElementById(id)?.closest('.config-auto-loot-control'),
      autoLootControl,
      `自动胖次控件 ${id} 没有放在同一设置行`,
    );
  });

  const managedBattlePlans = [
    {
      kind: 'battle',
      file: 'bettle-周常-8-2.yaml',
      name: '周常 8-2',
      source: 'system',
      modifiedAt: 1,
      chapter: 8,
      map: 2,
      times: 1,
      gap: 0,
      fleetId: 1,
      repairMode: 1,
      result: 'S',
      lootCountGe: 48,
      shipCountGe: 7,
      fleetCount: 0,
      nodeCount: 1,
      fleets: [],
    },
    {
      kind: 'battle',
      file: 'bettle-用户胖次测试.yaml',
      name: '用户胖次测试',
      source: 'user',
      modifiedAt: 2,
      chapter: 9,
      map: 2,
      times: 1,
      gap: 0,
      fleetId: 1,
      repairMode: 1,
      result: 'S',
      lootCountGe: 48,
      shipCountGe: 7,
      fleetCount: 0,
      nodeCount: 1,
      fleets: [],
    },
  ];
  window.electronBridge = {
    getPlanManagement: async () => ({
      bindings: [],
      battlePlans: structuredClone(managedBattlePlans),
      teamPlans: [],
      errors: [],
      ignoredUnlinkedPlans: [],
    }),
  };
  const taskGroupModel = new TaskGroupModel();
  taskGroupModel.upsertGroup('常规任务', [
    {
      kind: 'plan',
      managedSource: 'system',
      managedFile: 'bettle-周常-8-2.yaml',
      times: 2,
      label: '周常 8-2',
    },
    {
      kind: 'daily',
      dailySource: 'user',
      dailyFile: 'daily-test.yaml',
      times: 1,
      label: '日常测试',
    },
  ]);
  taskGroupModel.upsertGroup('空任务组', []);
  taskGroupModel.setActiveGroup('常规任务');
  const taskListLoaderView = new TaskListLoaderView();
  const taskListLoaderController = new TaskListLoaderController(
    taskGroupModel,
    () => {},
    window.electronBridge,
    taskListLoaderView,
  );
  taskListLoaderController.open();
  await new Promise(resolve => setTimeout(resolve, 0));

  rendererAssert.equal(
    document.getElementById('task-list-loader')?.style.display,
    'flex',
    '队列管理浮窗没有打开',
  );
  const taskListDialog = document.querySelector(
    '.task-list-loader-dialog',
  );
  const taskListActions = taskListDialog?.querySelector('.modal-actions');
  rendererAssert.equal(
    getComputedStyle(taskListDialog).overflowY,
    'hidden',
    '队列管理外层浮窗不应整体滚动',
  );
  rendererAssert.ok(
    taskListActions.getBoundingClientRect().bottom
      <= taskListDialog.getBoundingClientRect().bottom + 1,
    '队列管理底部操作区必须始终位于浮窗内',
  );
  rendererAssert.equal(
    document.getElementById('task-list-loader-count')?.textContent,
    '共 2 个计划组',
    '队列管理浮窗没有显示正确的计划组数量',
  );
  rendererAssert.equal(
    document.querySelectorAll('.task-list-loader-group-card').length,
    2,
    '队列管理浮窗没有渲染全部计划组',
  );
  rendererAssert.deepStrictEqual(
    Array.from(
      document.querySelectorAll(
        '#task-list-loader-preview .tg-label',
      ),
    ).map(element => element.textContent),
    ['周常 8-2', '日常测试'],
    '队列管理浮窗没有按原顺序渲染计划预览',
  );
  rendererAssert.deepStrictEqual(
    Array.from(
      document.querySelectorAll(
        '#task-list-loader-preview .tg-source',
      ),
    ).map(element => element.textContent),
    ['系统预设', '日常任务'],
    '队列管理浮窗没有显示正确的计划来源',
  );
  const emptyTaskGroupButton = Array.from(
    document.querySelectorAll('.task-list-loader-group-select'),
  ).find(button => (
    button.querySelector('strong')?.textContent === '空任务组'
  ));
  rendererAssert.ok(
    emptyTaskGroupButton,
    '队列管理浮窗缺少空任务组',
  );
  const taskGroupList = document.getElementById('task-list-loader-groups');
  taskGroupList.style.height = '44px';
  taskGroupList.style.flex = '0 0 44px';
  taskGroupList.scrollTop = 20;
  const taskGroupScrollTop = taskGroupList.scrollTop;
  rendererAssert.ok(
    taskGroupScrollTop > 0,
    '计划组滚动测试未形成真实滚动区域',
  );
  emptyTaskGroupButton.click();
  rendererAssert.equal(
    taskGroupList.scrollTop,
    taskGroupScrollTop,
    '切换计划组后左侧滚动位置不得重置',
  );
  rendererAssert.equal(
    document.getElementById('task-list-loader-preview-title')
      ?.textContent,
    '计划列表预览：空任务组',
    '切换任务组后预览标题没有更新',
  );
  rendererAssert.equal(
    document.getElementById('task-list-loader-preview')
      ?.textContent,
    '该计划组尚未关联出征计划',
    '空任务组没有显示空状态',
  );
  document.getElementById('btn-cancel-task-list-loader')?.click();
  rendererAssert.equal(
    document.getElementById('task-list-loader')?.style.display,
    'none',
    '取消队列管理后浮窗没有关闭',
  );

  const loaderView = new BattlePlanLoaderView();
  const loaderController = new BattlePlanLoaderController(
    loaderView,
    {
      getCurrentPlanIdentity: () => ({
        file: null,
        source: 'user',
      }),
      openManagedPlan: async () => false,
    },
  );
  loaderController.bindActions();
  const pickedLootPlansPromise = loaderController.pickLootPlans([
    {
      source: 'system',
      file: 'bettle-周常-8-2.yaml',
      name: '周常 8-2',
    },
  ]);
  await new Promise(resolve => setTimeout(resolve, 0));

  rendererAssert.equal(
    document.getElementById('battle-plan-loader')?.style.display,
    'flex',
    '加载自动胖次时没有打开复用的出征计划浮窗',
  );
  rendererAssert.equal(
    document.getElementById('battle-plan-loader-title')?.textContent,
    '加载自动胖次计划',
  );
  rendererAssert.equal(
    document.getElementById('btn-confirm-battle-plan-loader')?.textContent,
    '确认',
    '浮窗底部按钮没有改为确认',
  );
  const findAddButton = (file) => (
    Array.from(document.querySelectorAll('[data-loot-plan-add]'))
      .find(button => button.dataset.lootPlanFile === file)
  );
  const userAddButton = findAddButton('bettle-用户胖次测试.yaml');
  rendererAssert.ok(userAddButton, '用户计划卡片缺少加入列表按钮');
  rendererAssert.equal(userAddButton.textContent, '加入列表');
  rendererAssert.equal(userAddButton.disabled, false);
  rendererAssert.equal(
    getComputedStyle(userAddButton).backgroundColor,
    'rgb(37, 99, 235)',
    '加入列表按钮必须使用蓝色背景',
  );
  rendererAssert.equal(
    getComputedStyle(userAddButton).position,
    'absolute',
    '加入列表按钮没有嵌入任务卡片右下角',
  );
  rendererAssert.equal(getComputedStyle(userAddButton).right, '7px');
  rendererAssert.equal(getComputedStyle(userAddButton).bottom, '7px');
  const addButtonBadge = userAddButton
    .closest('.loot-automation-plan-card')
    ?.querySelector('.fleet-team-source-badge');
  rendererAssert.ok(
    Math.abs(
      userAddButton.getBoundingClientRect().height
      - (addButtonBadge?.getBoundingClientRect().height ?? 0),
    ) < 0.1,
    '加入列表按钮必须与配置标签同高',
  );
  rendererAssert.ok(
    Math.abs(
      userAddButton.getBoundingClientRect().width
      - (addButtonBadge?.getBoundingClientRect().width ?? 0),
    ) < 0.1,
    '加入列表按钮必须与配置标签同宽',
  );
  rendererAssert.equal(
    document.querySelector('.battle-plan-preview-stop-values'),
    null,
    '自动胖次列表浮窗不应展示 YAML 停止检测',
  );
  const configPreviewTitle = document.getElementById(
    'battle-plan-loader-preview-title',
  );
  const lootPreviewTitle = document.querySelector(
    '.loot-plan-list-preview-heading h3',
  );
  rendererAssert.match(lootPreviewTitle?.textContent ?? '', /^列表预览：/);
  rendererAssert.equal(
    lootPreviewTitle?.tagName,
    configPreviewTitle?.tagName,
    '列表预览与配置预览必须使用同级标题',
  );
  rendererAssert.equal(
    getComputedStyle(lootPreviewTitle).fontSize,
    getComputedStyle(configPreviewTitle).fontSize,
    '列表预览与配置预览标题字号必须一致',
  );
  rendererAssert.equal(
    getComputedStyle(lootPreviewTitle).lineHeight,
    getComputedStyle(configPreviewTitle).lineHeight,
    '列表预览与配置预览标题行高必须一致',
  );
  rendererAssert.equal(
    document.querySelector(
      '.loot-plan-list-preview-heading span',
    )?.textContent,
    '设置自动胖次的下拉列表',
  );
  const previewFrame = document.querySelector(
    '.battle-plan-loader-preview',
  );
  const previewFrameHeight = previewFrame.getBoundingClientRect().height;

  userAddButton.click();
  rendererAssert.equal(
    document.querySelectorAll('.loot-plan-list-preview-card').length,
    2,
    '加入列表后右侧预览没有立即更新',
  );
  rendererAssert.equal(
    findAddButton('bettle-用户胖次测试.yaml')?.textContent,
    '已加入',
  );
  rendererAssert.equal(
    previewFrame.getBoundingClientRect().height,
    previewFrameHeight,
    '加入列表不得改变右侧配置预览框架高度',
  );
  const lootPreview = document.querySelector('.loot-plan-list-preview');
  const lootPreviewCards = document.querySelector(
    '.loot-plan-list-preview-cards',
  );
  rendererAssert.equal(
    lootPreview.classList.contains('battle-plan-preview-section'),
    true,
    '列表预览必须复用使用舰队的灰底分区样式',
  );
  const fleetPreviewSection = document.querySelector(
    '.battle-plan-preview-section:not(.loot-plan-list-preview)',
  );
  rendererAssert.equal(
    getComputedStyle(lootPreview).backgroundColor,
    getComputedStyle(fleetPreviewSection).backgroundColor,
    '列表预览与使用舰队必须使用相同灰色背景',
  );
  rendererAssert.ok(
    lootPreview.getBoundingClientRect().bottom
      <= previewFrame.getBoundingClientRect().bottom,
    '列表预览不得超出右侧配置预览框架',
  );
  rendererAssert.equal(
    getComputedStyle(lootPreview).maxHeight,
    '150px',
    '列表预览必须限制最大高度',
  );
  rendererAssert.equal(
    getComputedStyle(lootPreviewCards).overflowY,
    'auto',
    '列表预览超高后必须在框架内滚动',
  );
  const findDeleteButton = (file) => (
    Array.from(document.querySelectorAll('[data-loot-plan-delete]'))
      .find(button => button.dataset.lootPlanFile === file)
  );
  findDeleteButton('bettle-周常-8-2.yaml')?.click();
  rendererAssert.equal(
    document.getElementById('generic-prompt-title')?.textContent,
    '删除自动胖次计划',
    '删除计划没有弹出二次确认',
  );
  rendererAssert.match(
    document.getElementById('generic-prompt-message')?.textContent ?? '',
    /周常 8-2/,
  );
  document.getElementById('generic-prompt-ok')?.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }),
  );
  await Promise.resolve();
  rendererAssert.equal(
    document.getElementById('generic-prompt')?.style.display,
    'none',
    'Escape 必须关闭最上层确认框',
  );
  rendererAssert.equal(
    document.getElementById('battle-plan-loader')?.style.display,
    'flex',
    'Escape 关闭确认框时不得同时关闭底层计划浮窗',
  );
  rendererAssert.equal(
    document.querySelectorAll('.loot-plan-list-preview-card').length,
    2,
    '取消删除后不应修改列表草稿',
  );

  findDeleteButton('bettle-周常-8-2.yaml')?.click();
  document.getElementById('generic-prompt-ok')?.click();
  await Promise.resolve();
  rendererAssert.equal(
    document.querySelectorAll('.loot-plan-list-preview-card').length,
    1,
    '确认删除后右侧列表没有移除任务',
  );
  const previewCard = document.querySelector(
    '.loot-plan-list-preview-card',
  );
  const currentLootPreviewCards = document.querySelector(
    '.loot-plan-list-preview-cards',
  );
  rendererAssert.equal(
    previewCard?.children.length,
    2,
    '列表卡片只能显示任务名称和删除按钮',
  );
  rendererAssert.equal(
    getComputedStyle(previewCard).paddingTop,
    '3px',
    '列表卡片顶部必须预留 3px',
  );
  rendererAssert.equal(
    getComputedStyle(previewCard).paddingBottom,
    '3px',
    '列表卡片底部必须预留 3px',
  );
  rendererAssert.ok(
    (
      (currentLootPreviewCards?.getBoundingClientRect().width ?? 0)
      - (previewCard?.getBoundingClientRect().width ?? 0)
    ) <= 12,
    '列表卡片宽度必须铺满列表预览区域',
  );
  rendererAssert.ok(
    (previewCard?.getBoundingClientRect().height ?? 0) <= 24,
    '列表预览卡片不得被删除按钮额外撑高',
  );
  rendererAssert.ok(
    Math.abs(
      (
        previewCard?.querySelector('button')
          ?.getBoundingClientRect().height ?? 0
      ) - (
        document.getElementById('battle-plan-loader-preview-source')
          ?.getBoundingClientRect().height ?? 0
      ),
    ) < 0.1,
    '列表预览删除按钮必须与用户预设标签同高',
  );
  document.getElementById('btn-confirm-battle-plan-loader')?.click();
  rendererAssert.deepStrictEqual(
    await pickedLootPlansPromise,
    [{
      source: 'user',
      file: 'bettle-用户胖次测试.yaml',
      name: '用户胖次测试',
    }],
    '确认后没有返回完整的自动胖次下拉列表草稿',
  );

  const canceledLootPlansPromise = loaderController.pickLootPlans([
    {
      source: 'user',
      file: 'bettle-用户胖次测试.yaml',
      name: '用户胖次测试',
    },
  ]);
  await new Promise(resolve => setTimeout(resolve, 0));
  document.getElementById('btn-cancel-battle-plan-loader')?.click();
  rendererAssert.equal(
    await canceledLootPlansPromise,
    null,
    '取消浮窗不应回填列表草稿',
  );

  const noFleetPlan = managedBattlePlans[0];
  const fleetPlan = managedBattlePlans[1];
  noFleetPlan.modifiedAt = 3;
  noFleetPlan.lootCountGe = -1;
  noFleetPlan.shipCountGe = -1;
  fleetPlan.fleets = [{
    name: `${fleetPlan.name}舰队`,
    source: fleetPlan.source,
    primaryCount: 6,
    backupCount: 0,
  }];
  fleetPlan.fleetCount = 1;
  fleetPlan.lootCountGe = -1;
  fleetPlan.shipCountGe = -1;
  const taskListPlanPromise = loaderController.pick('task-list');
  await new Promise(resolve => setTimeout(resolve, 0));
  const findPlanCard = (file) => (
    Array.from(
      document.querySelectorAll('button[data-battle-plan-file]'),
    ).find(button => button.dataset.battlePlanFile === file)
  );
  rendererAssert.equal(
    document.getElementById('battle-plan-loader-title')?.textContent,
    '添加计划到任务列表',
    '任务列表入口没有打开共用的计划加载浮窗',
  );
  rendererAssert.deepStrictEqual(
    Array.from(
      document.querySelectorAll(
        '.battle-plan-preview-stop-values strong',
      ),
    ).map(element => element.textContent),
    ['未开启', '未开启'],
    '任务列表浮窗中未开启的停止检测不得显示为 -1',
  );
  rendererAssert.equal(
    document.querySelector(
      '.battle-plan-preview-fleet-list .battle-plan-preview-empty',
    )?.textContent,
    '未配置编队预设，将使用 YAML 的舰队编号和游戏当前编成',
    '任务列表浮窗的无编队提示不正确',
  );
  const battlePlanList = document.getElementById(
    'battle-plan-loader-list',
  );
  battlePlanList.style.height = '80px';
  battlePlanList.style.maxHeight = '80px';
  battlePlanList.style.flex = '0 0 80px';
  rendererAssert.ok(
    battlePlanList.scrollHeight > battlePlanList.clientHeight,
    '滚动位置测试必须构造真实可滚动的任务列表',
  );
  const requestedScrollTop = Math.min(
    41,
    battlePlanList.scrollHeight - battlePlanList.clientHeight,
  );
  battlePlanList.scrollTop = requestedScrollTop;
  const preservedScrollTop = battlePlanList.scrollTop;
  rendererAssert.ok(
    preservedScrollTop > 0,
    '滚动位置测试未能设置非零滚动位置',
  );
  findPlanCard(fleetPlan.file)?.click();
  rendererAssert.equal(
    battlePlanList.scrollTop,
    preservedScrollTop,
    '任务列表浮窗选择任务后左侧滚动位置不得重置',
  );
  findPlanCard(noFleetPlan.file)?.click();
  rendererAssert.equal(
    document.getElementById('btn-confirm-battle-plan-loader')?.disabled,
    false,
    '任务列表浮窗必须允许提交没有关联编队的计划',
  );
  document.getElementById('btn-confirm-battle-plan-loader')?.click();
  const pickedTaskListPlan = await taskListPlanPromise;
  rendererAssert.equal(
    pickedTaskListPlan?.plan.file,
    noFleetPlan.file,
    '任务列表浮窗没有返回所选的无编队计划',
  );
  rendererAssert.equal(
    pickedTaskListPlan?.fleetPresetIndex,
    undefined,
    '无编队计划不应返回舰队索引',
  );

  const noFleetAutomationPromise = loaderController.pick(
    'automation',
    {
      name: noFleetPlan.file,
      source: noFleetPlan.source,
      times: 7,
    },
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  rendererAssert.equal(
    findPlanCard(noFleetPlan.file)?.disabled,
    false,
    '自动任务浮窗不得禁用没有关联编队的计划',
  );
  rendererAssert.equal(
    document.getElementById('btn-confirm-battle-plan-loader')?.disabled,
    false,
    '自动任务浮窗必须允许提交没有关联编队的计划',
  );
  rendererAssert.equal(
    document.querySelector(
      '.battle-plan-preview-fleet-list .battle-plan-preview-empty',
    )?.textContent,
    '未配置编队预设，将使用 YAML 的舰队编号和游戏当前编成',
    '自动任务浮窗不应提示无编队计划无法提交',
  );
  document.getElementById('btn-confirm-battle-plan-loader')?.click();
  const pickedNoFleetAutomation = await noFleetAutomationPromise;
  rendererAssert.equal(
    pickedNoFleetAutomation?.plan.file,
    noFleetPlan.file,
    '自动任务浮窗没有返回所选的无编队计划',
  );
  rendererAssert.equal(
    pickedNoFleetAutomation?.fleetPresetIndex,
    undefined,
    '无编队自动任务不应返回舰队索引',
  );

  const pickedAutomationPlanPromise = loaderController.pick(
    'automation',
    {
      name: 'bettle-用户胖次测试.yaml',
      source: 'user',
      fleet_preset_index: 0,
      times: 7,
    },
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  const dailyMaxField = document.querySelector(
    '.automation-daily-max-field',
  );
  const dailyMaxInput = dailyMaxField?.querySelector('input');
  rendererAssert.equal(
    dailyMaxField?.querySelector(':scope > span')?.textContent,
    '每日最大执行次数',
    '自动出征浮窗缺少每日执行上限标题',
  );
  rendererAssert.equal(dailyMaxInput?.min, '1');
  rendererAssert.equal(dailyMaxInput?.max, '999');
  rendererAssert.equal(
    dailyMaxInput?.value,
    '7',
    '重新打开同一个自动出征计划时必须回填已保存的每日次数',
  );
  rendererAssert.equal(
    document.getElementById('battle-plan-loader-preview-title')?.textContent,
    '配置预览：用户胖次测试',
    '重新打开自动出征浮窗时必须定位到当前已加载计划',
  );
  dailyMaxInput.value = '1000';
  dailyMaxInput.dispatchEvent(new Event('change'));
  rendererAssert.equal(
    dailyMaxInput.value,
    '999',
    '每日执行上限不得超过 999',
  );
  document.getElementById('btn-confirm-battle-plan-loader')?.click();
  const pickedAutomationPlan = await pickedAutomationPlanPromise;
  rendererAssert.equal(
    pickedAutomationPlan?.fleetPresetIndex,
    0,
    '单个舰队的自动出征计划应自动选中舰队',
  );
  rendererAssert.equal(
    pickedAutomationPlan?.dailyMaxExecutions,
    999,
    '自动出征计划没有返回浮窗设置的每日执行上限',
  );
  rendererAssert.equal(
    pickedAutomationPlan?.plan.file,
    'bettle-用户胖次测试.yaml',
    '自动出征浮窗确认后没有返回当前已加载计划',
  );

  let savedAutomationTask = null;
  const selectedManagedPlan = managedBattlePlans.find(plan => (
    plan.source === 'user'
    && plan.file === 'bettle-用户胖次测试.yaml'
  ));
  let automationSelection = {
    plan: selectedManagedPlan,
    fleetPresetIndex: 0,
    dailyMaxExecutions: 7,
  };
  const automationSettingsController = new SettingsController(
    {
      configView: {
        getNormalFightTasks: () => [],
        setNormalFightPlan: (task) => {
          savedAutomationTask = task;
        },
      },
      pickAutomationPlan: async () => automationSelection,
      getNormalFightRemaining: () => 7,
    },
    {
      readManagedCombatPlan: async () => ({
        success: true,
        path: 'runtime-only-path',
      }),
    },
  );
  await automationSettingsController.selectAutomationPlan();
  rendererAssert.deepEqual(
    savedAutomationTask,
    {
      name: 'bettle-用户胖次测试.yaml',
      source: 'user',
      fleet_preset_index: 0,
      times: 7,
    },
    '自动出征配置必须保存受管计划来源和文件名，不得保存物理路径',
  );
  automationSelection = {
    plan: noFleetPlan,
    dailyMaxExecutions: 6,
  };
  savedAutomationTask = null;
  await automationSettingsController.selectAutomationPlan();
  rendererAssert.deepEqual(
    savedAutomationTask,
    {
      name: noFleetPlan.file,
      source: noFleetPlan.source,
      times: 6,
    },
    '无关联编队的自动出征计划不得强制保存编队索引',
  );

  const globalScrollButtonRule = Array.from(document.styleSheets)
    .flatMap(sheet => Array.from(sheet.cssRules))
    .find(rule => rule.selectorText === '::-webkit-scrollbar-button');
  rendererAssert.equal(
    globalScrollButtonRule?.style.display,
    'none',
    '所有下拉框的滚动条顶部和底部按钮必须统一隐藏',
  );

  const delayMinimum = document.getElementById('cfg-delay-min');
  const delayMaximum = document.getElementById('cfg-delay-max');
  delayMinimum.value = '2';
  delayMaximum.value = '1';
  rendererAssert.throws(
    () => view.collect(),
    /最小值不能大于最大值/,
    '非法延迟区间未被拦截',
  );
  view.render(sample);

  const adbStatuses = [];
  const adbLoadingStates = [];
  let reconnectCalls = 0;
  let finishReconnect;
  const reconnectGate = new Promise((resolve) => {
    finishReconnect = resolve;
  });
  const adbController = new SettingsController(
    {
      configView: {
        getEmulatorSerial: () => sample.emulatorSerial,
        setAdbConnectionLoading: (action, loading) => {
          adbLoadingStates.push({ action, loading });
        },
        setAdbStatus: (text, status) => {
          adbStatuses.push({ text, status });
        },
      },
      ensureSystemConnected: () => {
        reconnectCalls += 1;
        return reconnectGate;
      },
    },
    {
      connectAdbDevice: async serial => ({
        success: true,
        serial,
        status: 'device',
        message: 'connected',
      }),
    },
  );
  const reconnectOperation = adbController.changeAdbConnection('connect');
  await new Promise(resolve => setTimeout(resolve, 0));
  rendererAssert.equal(
    reconnectCalls,
    1,
    'ADB 连接成功后没有继续启动后端系统',
  );
  rendererAssert.deepStrictEqual(
    adbStatuses.at(-1),
    {
      text: 'ADB 在线，正在连接后端',
      status: 'unknown',
    },
    '后端尚未连接时不应提前显示 ADB 完全在线',
  );
  finishReconnect(true);
  await reconnectOperation;
  rendererAssert.deepStrictEqual(
    adbStatuses.at(-1),
    {
      text: `在线 (${sample.emulatorSerial})`,
      status: 'online',
    },
    '只有后端系统连接完成后才能显示 ADB 在线',
  );
  rendererAssert.deepStrictEqual(
    adbLoadingStates,
    [
      { action: 'connect', loading: true },
      { action: 'connect', loading: false },
    ],
    'ADB 重连完成后没有恢复连接按钮',
  );

  const model = new ConfigModel();
  rendererAssert.equal(
    model.current.log.root,
    'logs',
    '新建配置的默认日志目录必须为 logs',
  );
  model.loadFromYaml([
    'emulator:',
    '  type: 雷电',
    '  backend_options:',
    '    transport:',
    '      retry: 7',
    'account:',
    '  game_app: 官服',
    '  backend_identity:',
    '    region:',
    '      code: cn',
    'ocr:',
    '  ship_name_corrections:',
    '    stale_correction: stale',
    '    backend_metadata:',
    '      source: backend',
    '  ship_name_aliases:',
    '    stale_alias: stale',
    '    backend_metadata:',
    '      source: backend',
    '  backend_options:',
    '    detector:',
    '      timeout: 30',
    'log:',
    '  channels:',
    '    stale.channel: DEBUG',
    '    backend_metadata:',
    '      sink:',
    '        name: audit',
    '  backend_options:',
    '    rotation:',
    '      compress: true',
    'daily_automation:',
    '  auto_gain_bonus: true',
    '  auto_bath_repair: true',
    '  auto_decisive: true',
    '  decisive_ticket_reserve: 0',
    '  decisive_template_id: builtin_decisive_6',
    '  loot_plan_index: 2',
    '  backend_options:',
    '    scheduler:',
    '      jitter: 3',
    'custom_unknown:',
    '  keep: true',
    '',
  ].join('\n'));
  rendererAssert.equal(
    model.current.ocr.enhanced_ship_ocr,
    false,
    '旧配置缺少 enhanced_ship_ocr 时必须保持默认关闭',
  );
  rendererAssert.equal(
    model.migratedGuiAutomation.lootPlanId,
    'bettle-old-8-5AI六潜胖次.yaml',
    '旧 usersettings.yaml 的索引没有保持 8-5 语义',
  );
  rendererAssert.deepStrictEqual(
    model.migratedLegacyDecisiveAutomation,
    {
      autoDecisive: true,
      ticketReserve: 0,
      templateId: 'builtin_decisive_6',
    },
    '旧版决战自动化原值没有被逐字段读取',
  );

  const guiSettings = {
    preserved_key: 'keep',
    allow_test_updates: true,
    decisive_plan: {
      chapter: 5,
      use_quick_repair: false,
      level1: ['当前主力'],
      level2: ['当前替补'],
    },
  };
  let failGuiAutomationMigration = false;
  let failLegacyDecisiveMigration = false;
  let failSettingsCommit = false;
  let legacyDecisiveMigrationCalls = 0;
  const writeGuiSettings = patch => {
    Object.assign(guiSettings, patch);
    rendererFs.writeFileSync(
      rendererPath.join(tempDirectory, 'gui_settings.json'),
      JSON.stringify(guiSettings, null, 2),
      'utf8',
    );
  };

  window.electronBridge = {
    readFile: async name => {
      const file = rendererPath.join(tempDirectory, name);
      return rendererFs.existsSync(file)
        ? rendererFs.readFileSync(file, 'utf8')
        : '';
    },
    saveFile: async (name, content) => {
      rendererFs.writeFileSync(
        rendererPath.join(tempDirectory, name),
        content,
        'utf8',
      );
    },
    getGuiAutomationSettings: async () => ({
      exists: Boolean(guiSettings.automation),
      settings: structuredClone(guiSettings.automation ?? {}),
    }),
    getAllowTestUpdates: () => guiSettings.allow_test_updates === true,
    getGuiLogRoot: () => guiSettings.gui_log_root ?? 'logs',
    setGuiAutomationSettings: async settings => {
      if (failGuiAutomationMigration) {
        throw new Error('模拟 GUI 自动化配置写入失败');
      }
      writeGuiSettings({
        automation: structuredClone(settings),
      });
      return settings;
    },
    commitGuiSettings: async request => {
      if (failSettingsCommit) {
        throw new Error('模拟设置批量提交失败');
      }
      rendererFs.writeFileSync(
        rendererPath.join(tempDirectory, 'usersettings.yaml'),
        request.usersettingsYaml,
        'utf8',
      );
      writeGuiSettings({
        update_mode: request.updateMode,
        backend_update_mode: request.backendUpdateMode,
        allow_test_updates: request.allowTestUpdates,
        backend_port: request.backendPort,
        backend_startup_mode: request.backendStartupMode,
        backend_repo_path: request.backendRepoPath ?? '',
        ocr_gpu_mode: request.ocrGpuMode,
        cuda_path: request.cudaPath ?? '',
        save_backend_screenshots: request.saveBackendScreenshots,
        python_path: request.pythonPath ?? '',
        gui_log_root: request.guiLogRoot ?? 'logs',
        default_window_width: request.windowPreferences.defaultWidth,
        default_window_height: request.windowPreferences.defaultHeight,
        remember_window_bounds: request.windowPreferences.rememberBounds,
        automation: structuredClone(request.automation),
      });
      return {
        automation: structuredClone(request.automation),
        windowPreferences: structuredClone(request.windowPreferences),
      };
    },
    migrateLegacyDecisiveAutomation: async settings => {
      legacyDecisiveMigrationCalls += 1;
      if (failLegacyDecisiveMigration) {
        throw new Error('模拟旧版决战配置写入失败');
      }
      writeGuiSettings({
        legacy_decisive_automation: {
          auto_decisive: settings.autoDecisive,
          decisive_ticket_reserve: settings.ticketReserve,
          decisive_template_id: settings.templateId,
        },
      });
      return structuredClone(settings);
    },
    setBackendPort: async backendPort => {
      writeGuiSettings({
        backend_port: backendPort,
      });
    },
    setBackendStartupMode: async mode => {
      writeGuiSettings({
        backend_startup_mode: mode,
      });
    },
    setBackendRepoPath: async repoPath => {
      writeGuiSettings({
        backend_repo_path: repoPath ?? '',
      });
    },
    setOcrGpuMode: async mode => {
      writeGuiSettings({
        ocr_gpu_mode: mode,
      });
    },
    setCudaPath: async cudaPath => {
      writeGuiSettings({
        cuda_path: cudaPath ?? '',
      });
    },
    setSaveBackendScreenshots: async enabled => {
      writeGuiSettings({
        save_backend_screenshots: enabled === true,
      });
    },
    setPythonPath: async pythonPath => {
      writeGuiSettings({
        python_path: pythonPath ?? '',
      });
    },
    setUpdateMode: async mode => {
      writeGuiSettings({
        update_mode: mode,
      });
    },
    rememberActivePage: async () => {},
    setWindowPreferences: async preferences => {
      writeGuiSettings({
        default_window_width: preferences.defaultWidth,
        default_window_height: preferences.defaultHeight,
        remember_window_bounds: preferences.rememberBounds,
      });
      return preferences;
    },
  };

  const host = {
    configModel: model,
    configView: view,
    setupView: {},
    mainView: {
      setDebugMode: () => {},
    },
    scheduler: {
      status: 'connected',
      setAutoExpedition: () => {},
      setExpeditionInterval: () => {},
    },
    cronScheduler: {
      updateConfig: () => {},
    },
    normalFightDailyQuota: new NormalFightDailyQuota(),
    templateCtrl: {},
    startupCtrl: {
      startSystem: () => {},
    },
    configDir: tempDirectory,
  };

  const partialYaml = [
    'daily_automation:',
    '  expedition_interval: 41',
    '  battle_times: 6',
    '  auto_loot: false',
    '  loot_plan_id: bettle-捞胖次-8-5.yaml',
    '  loot_stop_count: 12',
    '',
  ].join('\n');
  rendererFs.writeFileSync(
    rendererPath.join(tempDirectory, 'usersettings.yaml'),
    partialYaml,
    'utf8',
  );
  writeGuiSettings({
    automation: {
      expeditionInterval: 29,
      autoLoot: true,
    },
  });
  const partialModel = new ConfigModel();
  const partialController = new ConfigController({
    ...host,
    configModel: partialModel,
  });

  failGuiAutomationMigration = true;
  await rendererAssert.rejects(
    () => partialController.loadConfig(),
    /模拟 GUI 自动化配置写入失败/,
  );
  const yamlAfterFailedGuiMigration = yaml.load(
    rendererFs.readFileSync(
      rendererPath.join(tempDirectory, 'usersettings.yaml'),
      'utf8',
    ),
  );
  rendererAssert.equal(
    yamlAfterFailedGuiMigration.daily_automation.battle_times,
    6,
    'GUI JSON 写入失败时不得删除 YAML 的缺失字段',
  );
  rendererAssert.equal(
    yamlAfterFailedGuiMigration.daily_automation.loot_plan_id,
    'bettle-捞胖次-8-5.yaml',
    'GUI JSON 写入失败时不得删除 YAML 的计划标识',
  );

  failGuiAutomationMigration = false;
  await partialController.loadConfig();
  rendererAssert.deepStrictEqual(
    partialModel.currentGuiAutomation,
    {
      expeditionInterval: 29,
      battleTimes: 8,
      autoDecisive: false,
      decisiveTemplateId: 'system_preset',
      autoLoot: true,
      lootPlanSource: 'system',
      lootPlanId: 'bettle-old-8-5AI六潜胖次.yaml',
      lootPlans: structuredClone(DEFAULT_LOOT_PLANS),
      lootStopCount: 12,
    },
    '部分 GUI JSON 没有按字段优先级与 YAML 合并',
  );
  rendererAssert.deepStrictEqual(
    guiSettings.automation,
    partialModel.currentGuiAutomation,
    '逐字段合并结果没有完整写入 gui_settings.json',
  );
  const yamlAfterSuccessfulGuiMigration = yaml.load(
    rendererFs.readFileSync(
      rendererPath.join(tempDirectory, 'usersettings.yaml'),
      'utf8',
    ),
  );
  for (const field of [
    'expedition_interval',
    'battle_times',
    'auto_loot',
    'loot_plan_id',
    'loot_stop_count',
  ]) {
    rendererAssert.equal(
      Object.hasOwn(
        yamlAfterSuccessfulGuiMigration.daily_automation,
        field,
      ),
      false,
      `完整写入 GUI JSON 后未清理 ${field}`,
    );
  }

  rendererFs.writeFileSync(
    rendererPath.join(tempDirectory, 'usersettings.yaml'),
    [
      'daily_automation:',
      '  auto_loot: true',
      '  loot_plan_id: bettle-不存在.yaml',
      '',
    ].join('\n'),
    'utf8',
  );
  writeGuiSettings({
    automation: {
      autoLoot: true,
    },
  });
  const unsafeLootModel = new ConfigModel();
  const unsafeLootController = new ConfigController({
    ...host,
    configModel: unsafeLootModel,
  });
  await unsafeLootController.loadConfig();
  rendererAssert.equal(
    unsafeLootModel.currentGuiAutomation.autoLoot,
    false,
    '缺少有效计划标识时必须关闭自动刷取',
  );
  rendererAssert.equal(
    unsafeLootModel.currentGuiAutomation.lootPlanId,
    'bettle-周常-9-2.yaml',
    '损坏计划标识只能安全回退到默认计划',
  );

  const runWithAutoClosedAlert = async action => {
    const notices = [];
    const timer = window.setInterval(() => {
      const overlay = document.getElementById('generic-prompt');
      if (!overlay || overlay.style.display === 'none') return;
      const title = document.getElementById(
        'generic-prompt-title',
      )?.textContent ?? '';
      const message = document.getElementById(
        'generic-prompt-message',
      )?.textContent ?? '';
      if (!title) return;
      notices.push({ title, message });
      document.getElementById('generic-prompt-ok')?.click();
    }, 5);
    try {
      await action();
    } finally {
      window.clearInterval(timer);
    }
    return notices;
  };

  const runWithDialogChoice = async (action, buttonId) => {
    let dialog = null;
    const timer = window.setInterval(() => {
      const overlay = document.getElementById('generic-prompt');
      if (!overlay || overlay.style.display === 'none') return;
      const title = document.getElementById(
        'generic-prompt-title',
      )?.textContent ?? '';
      if (!title) return;
      dialog = {
        title,
        message: document.getElementById(
          'generic-prompt-message',
        )?.textContent ?? '',
      };
      document.getElementById(buttonId)?.click();
    }, 5);
    try {
      await action();
    } finally {
      window.clearInterval(timer);
    }
    rendererAssert.ok(dialog, '页面切换必须显示未保存设置提示框');
    return dialog;
  };

  const controller = new ConfigController(host);
  const yamlBeforeFailedCommit = rendererFs.readFileSync(
    rendererPath.join(tempDirectory, 'usersettings.yaml'),
    'utf8',
  );
  const guiBeforeFailedCommit = rendererFs.readFileSync(
    rendererPath.join(tempDirectory, 'gui_settings.json'),
    'utf8',
  );
  const modelBeforeFailedCommit = model.toYaml();
  const localStorageBeforeFailedCommit = {
    themeMode: localStorage.getItem('themeMode'),
    accentColor: localStorage.getItem('accentColor'),
    debugMode: localStorage.getItem('debugMode'),
    updateMode: localStorage.getItem('updateMode'),
  };
  failSettingsCommit = true;
  const failedCommitNotices = await runWithAutoClosedAlert(
    () => controller.saveConfig(),
  );
  failSettingsCommit = false;
  rendererAssert.match(
    failedCommitNotices[0]?.message ?? '',
    /模拟设置批量提交失败/,
  );
  rendererAssert.equal(
    rendererFs.readFileSync(
      rendererPath.join(tempDirectory, 'usersettings.yaml'),
      'utf8',
    ),
    yamlBeforeFailedCommit,
    '批量提交失败不得改写 usersettings.yaml',
  );
  rendererAssert.equal(
    rendererFs.readFileSync(
      rendererPath.join(tempDirectory, 'gui_settings.json'),
      'utf8',
    ),
    guiBeforeFailedCommit,
    '批量提交失败不得改写 gui_settings.json',
  );
  rendererAssert.equal(
    model.toYaml(),
    modelBeforeFailedCommit,
    '批量提交失败不得修改 ConfigModel',
  );
  rendererAssert.deepStrictEqual({
    themeMode: localStorage.getItem('themeMode'),
    accentColor: localStorage.getItem('accentColor'),
    debugMode: localStorage.getItem('debugMode'),
    updateMode: localStorage.getItem('updateMode'),
  }, localStorageBeforeFailedCommit);

  await controller.saveConfig();
  rendererAssert.equal(
    controller.hasUnsavedChanges(),
    false,
    '成功保存后设置页不得被标记为未保存',
  );
  const guiLogRootInput = document.getElementById('cfg-gui-log-root');
  guiLogRootInput.value = sample.guiLogRoot;
  rendererAssert.equal(
    controller.hasUnsavedChanges(),
    true,
    '修改 GUI 日志目录后必须被标记为未保存',
  );
  await controller.saveConfig();
  view.setNormalFightRemaining(sample.normalFightTasks, 1);
  rendererAssert.equal(
    controller.hasUnsavedChanges(),
    false,
    '今日剩余次数刷新不得被误判为用户修改设置',
  );

  const navigationController = new NavigationController({
    loadFleetPlanner: async () => {},
    ensureDefaultPlan: async () => {},
    loadPlanManagement: async () => {},
    refreshAdbStatus: async () => {},
    refreshShipLibraryStatus: async () => {},
    hasUnsavedConfigChanges: () => controller.hasUnsavedChanges(),
  });
  const activePage = () => (
    document.querySelector('.nav-tab.active')?.dataset.page ?? ''
  );
  await navigationController.switchPage('config');
  await navigationController.switchPage('main');
  rendererAssert.equal(
    activePage(),
    'main',
    '配置未修改时必须直接离开设置页',
  );
  await navigationController.switchPage('config');

  const logRootInput = document.getElementById('cfg-log-root');
  const savedLogRoot = logRootInput.value;
  logRootInput.value = `${savedLogRoot}\\unsaved`;
  rendererAssert.equal(
    controller.hasUnsavedChanges(),
    true,
    '修改设置后必须被标记为未保存',
  );

  const canceledDialog = await runWithDialogChoice(
    () => navigationController.switchPage('plan'),
    'generic-prompt-cancel',
  );
  rendererAssert.equal(canceledDialog.title, '设置尚未保存');
  rendererAssert.match(canceledDialog.message, /当前配置尚未保存/);
  rendererAssert.equal(
    activePage(),
    'config',
    '取消切换后必须留在设置页',
  );

  await runWithDialogChoice(
    () => navigationController.switchPage('plan'),
    'generic-prompt-ok',
  );
  rendererAssert.equal(
    activePage(),
    'plan',
    '确认切换后必须进入目标页面',
  );
  logRootInput.value = savedLogRoot;
  rendererAssert.equal(
    controller.hasUnsavedChanges(),
    false,
    '恢复保存值后不得继续提示未保存',
  );

  const savedYaml = yaml.load(rendererFs.readFileSync(
    rendererPath.join(tempDirectory, 'usersettings.yaml'),
    'utf8',
  ));
  const savedGui = JSON.parse(rendererFs.readFileSync(
    rendererPath.join(tempDirectory, 'gui_settings.json'),
    'utf8',
  ));

  rendererAssert.deepStrictEqual(savedYaml.emulator, {
    type: sample.emulatorType,
    path: sample.emulatorPath,
    serial: sample.emulatorSerial,
    backend_options: {
      transport: {
        retry: 7,
      },
    },
  });
  rendererAssert.deepStrictEqual(savedYaml.account, {
    game_app: sample.gameApp,
    backend_identity: {
      region: {
        code: 'cn',
      },
    },
  });
  rendererAssert.deepStrictEqual(savedYaml.daily_automation, {
    auto_expedition: sample.autoExpedition,
    auto_battle: sample.autoBattle,
    battle_type: sample.battleType,
    auto_exercise: sample.autoExercise,
    exercise_fleet_id: sample.exerciseFleetId,
    auto_normal_fight: sample.autoNormalFight,
    auto_decisive: true,
    decisive_ticket_reserve: 0,
    decisive_template_id: 'builtin_decisive_6',
    auto_gain_bonus: true,
    auto_bath_repair: true,
    auto_set_support: false,
    bath_repair_blacklist: [],
    normal_fight_tasks: sample.normalFightTasks,
    stop_max_ship: false,
    stop_max_loot: false,
    backend_options: {
      scheduler: {
        jitter: 3,
      },
    },
  });
  rendererAssert.deepStrictEqual(savedYaml.ocr, {
    gpu: sample.ocrGpu,
    mirror: sample.ocrMirror,
    enhanced_ship_ocr: sample.enhancedShipOcr,
    ship_name_match_confidence: sample.ocrConfidence,
    ship_name_corrections: {
      ...shipNameCorrections,
      backend_metadata: {
        source: 'backend',
      },
    },
    ship_name_aliases: {
      ...shipNameAliases,
      backend_metadata: {
        source: 'backend',
      },
    },
    backend_options: {
      detector: {
        timeout: 30,
      },
    },
  });
  rendererAssert.deepStrictEqual(savedYaml.log, {
    level: sample.logLevel,
    root: sample.logRoot,
    show_emulator_debug: sample.debugMode,
    show_ui_debug: sample.debugMode,
    show_vision_debug: sample.debugMode,
    show_ops_debug: sample.debugMode,
    show_combat_state_debug: sample.debugMode,
    show_combat_recognition_debug: sample.debugMode,
    channels: {
      'stale.channel': 'DEBUG',
      backend_metadata: {
        sink: {
          name: 'audit',
        },
      },
    },
    backend_options: {
      rotation: {
        compress: true,
      },
    },
  });
  rendererAssert.equal(
    savedYaml.operation_delay_min,
    sample.operationDelayMin,
  );
  rendererAssert.equal(
    savedYaml.operation_delay_max,
    sample.operationDelayMax,
  );
  rendererAssert.equal(
    savedYaml.dock_full_destroy,
    sample.dockFullDestroy,
  );
  rendererAssert.equal(
    savedYaml.repair_manually,
    sample.repairManually,
  );
  rendererAssert.equal(
    savedYaml.bathroom_count,
    sample.bathroomCount,
  );
  rendererAssert.equal(
    savedYaml.destroy_ship_work_mode,
    sample.destroyShipWorkMode,
  );
  rendererAssert.deepStrictEqual(
    savedYaml.destroy_ship_types,
    sample.destroyShipTypes,
  );
  rendererAssert.equal(
    savedYaml.remove_equipment_mode,
    sample.removeEquipmentMode,
  );
  rendererAssert.equal(savedYaml.plan_root, sample.planRoot);
  rendererAssert.deepStrictEqual(savedYaml.custom_unknown, {
    keep: true,
  });

  rendererAssert.deepStrictEqual(savedGui.automation, {
    expeditionInterval: sample.expeditionInterval,
    battleTimes: 8,
    autoDecisive: sample.autoDecisive,
    decisiveTemplateId: sample.decisiveTemplateId,
    autoLoot: sample.autoLoot,
    lootPlanSource: sample.lootPlanSource,
    lootPlanId: sample.lootPlanId,
    lootPlans: sample.lootPlans,
    lootStopCount: sample.lootStopCount,
  });
  rendererAssert.equal(savedGui.backend_port, sample.backendPort);
  rendererAssert.equal(
    savedGui.backend_startup_mode,
    sample.backendStartupMode,
  );
  rendererAssert.equal(
    savedGui.backend_repo_path,
    sample.backendRepoPath,
  );
  rendererAssert.equal(savedGui.ocr_gpu_mode, sample.ocrGpuMode);
  rendererAssert.equal(savedGui.cuda_path, sample.cudaPath);
  rendererAssert.equal(
    savedGui.save_backend_screenshots,
    sample.saveBackendScreenshots,
  );
  rendererAssert.equal(savedGui.python_path, sample.pythonPath);
  rendererAssert.equal(savedGui.gui_log_root, sample.guiLogRoot);
  rendererAssert.equal(savedGui.update_mode, sample.updateMode);
  rendererAssert.equal(savedGui.backend_update_mode, 'auto');
  rendererAssert.equal(
    savedGui.default_window_width,
    sample.defaultWindowWidth,
  );
  rendererAssert.equal(
    savedGui.default_window_height,
    sample.defaultWindowHeight,
  );
  rendererAssert.equal(
    savedGui.remember_window_bounds,
    sample.rememberWindowBounds,
  );
  rendererAssert.equal(savedGui.preserved_key, 'keep');
  rendererAssert.deepStrictEqual(savedGui.decisive_plan, {
    chapter: 5,
    use_quick_repair: false,
    level1: ['当前主力'],
    level2: ['当前替补'],
  });

  failLegacyDecisiveMigration = true;
  const failedNotices = await runWithAutoClosedAlert(
    () => controller.loadConfig(),
  );
  const yamlAfterFailedMigration = yaml.load(
    rendererFs.readFileSync(
      rendererPath.join(tempDirectory, 'usersettings.yaml'),
      'utf8',
    ),
  );
  rendererAssert.equal(
    yamlAfterFailedMigration.daily_automation.auto_decisive,
    true,
    '迁移失败时不得删除 auto_decisive',
  );
  rendererAssert.equal(
    yamlAfterFailedMigration.daily_automation
      .decisive_ticket_reserve,
    0,
    '迁移失败时不得删除 decisive_ticket_reserve',
  );
  rendererAssert.equal(
    yamlAfterFailedMigration.daily_automation
      .decisive_template_id,
    'builtin_decisive_6',
    '迁移失败时不得删除 decisive_template_id',
  );
  rendererAssert.equal(
    Object.hasOwn(guiSettings, 'legacy_decisive_automation'),
    false,
  );
  rendererAssert.match(
    failedNotices[0]?.title ?? '',
    /迁移失败/,
  );

  failLegacyDecisiveMigration = false;
  const successNotices = await runWithAutoClosedAlert(
    () => controller.loadConfig(),
  );
  const yamlAfterSuccessfulMigration = yaml.load(
    rendererFs.readFileSync(
      rendererPath.join(tempDirectory, 'usersettings.yaml'),
      'utf8',
    ),
  );
  for (const field of [
    'auto_decisive',
    'decisive_ticket_reserve',
    'decisive_template_id',
  ]) {
    rendererAssert.equal(
      Object.hasOwn(
        yamlAfterSuccessfulMigration.daily_automation,
        field,
      ),
      false,
      `迁移成功后未清理 ${field}`,
    );
  }
  const guiAfterSuccessfulMigration = JSON.parse(
    rendererFs.readFileSync(
      rendererPath.join(tempDirectory, 'gui_settings.json'),
      'utf8',
    ),
  );
  rendererAssert.deepStrictEqual(
    guiAfterSuccessfulMigration.legacy_decisive_automation,
    {
      auto_decisive: true,
      decisive_ticket_reserve: 0,
      decisive_template_id: 'builtin_decisive_6',
    },
  );
  rendererAssert.deepStrictEqual(
    guiAfterSuccessfulMigration.decisive_plan,
    savedGui.decisive_plan,
    '旧配置迁移不得覆盖当前决战计划',
  );
  rendererAssert.match(
    successNotices[0]?.message ?? '',
    /自动决战：开启/,
  );
  rendererAssert.match(
    successNotices[0]?.message ?? '',
    /决战票保留：0/,
  );
  rendererAssert.match(
    successNotices[0]?.message ?? '',
    /决战模板：builtin_decisive_6/,
  );
  rendererAssert.match(
    successNotices[0]?.message ?? '',
    /决战票保留仅无损保存，不参与执行轮数/,
  );
  rendererAssert.equal(legacyDecisiveMigrationCalls, 2);

  await controller.loadConfig();
  rendererAssert.equal(
    legacyDecisiveMigrationCalls,
    2,
    '迁移成功后再次启动不应重复迁移或提示',
  );

  rendererAssert.equal(
    localStorage.getItem('themeMode'),
    sample.themeMode,
  );
  rendererAssert.equal(
    localStorage.getItem('accentColor'),
    sample.accentColor,
  );
  rendererAssert.equal(
    localStorage.getItem('debugMode'),
    String(sample.debugMode),
  );
  rendererAssert.equal(
    localStorage.getItem('updateMode'),
    sample.updateMode,
  );

  const controlIds = Array.from(document.querySelectorAll(
    '[data-config-panel] input[id], '
      + '[data-config-panel] select[id], '
      + '[data-config-panel] textarea[id]',
  ))
    .filter(element => !element.closest('[aria-hidden="true"]'))
    .map(element => element.id);
  const expectedControlIds = [
    'cfg-emu-type',
    'cfg-emu-path',
    'cfg-emu-serial',
    'cfg-game-app',
    'cfg-auto-expedition',
    'cfg-auto-battle',
    'cfg-battle-type',
    'cfg-auto-exercise',
    'cfg-exercise-fleet',
    'cfg-auto-normal-fight',
    'cfg-auto-decisive',
    'cfg-decisive-template',
    'cfg-auto-loot',
    'cfg-loot-plan',
    'cfg-loot-stop-count',
    'cfg-log-level',
    'cfg-log-root',
    'cfg-gui-log-root',
    'cfg-debug-mode',
    'cfg-python-path',
    'cfg-backend-port',
    'cfg-save-backend-screenshots',
    'cfg-use-external-backend',
    'cfg-backend-repo-path',
    'cfg-window-width',
    'cfg-window-height',
    'cfg-remember-window-bounds',
    'cfg-update-mode',
    'cfg-backend-update-mode',
    'cfg-allow-test-updates',
    'cfg-theme-mode',
    'cfg-accent-color',
    'cfg-delay-min-range',
    'cfg-delay-min',
    'cfg-delay-max-range',
    'cfg-delay-max',
    'cfg-ocr-mirror',
    'cfg-ocr-gpu-mode',
    'cfg-cuda-path',
    'cfg-ocr-gpu',
    'cfg-enhanced-ship-ocr',
    'cfg-ocr-confidence-range',
    'cfg-ocr-confidence',
    'cfg-ship-name-aliases',
    'cfg-ship-name-corrections',
    'cfg-dock-full-destroy',
    'cfg-repair-manually',
    'cfg-bathroom-count',
    'cfg-destroy-ship-mode',
    'cfg-remove-equipment-mode',
    'cfg-plan-root',
  ];
  rendererAssert.deepStrictEqual(
    [...controlIds].sort(),
    [...expectedControlIds].sort(),
    '设置页出现未纳入测试的表单控件',
  );

  return {
    viewFields: Object.keys(collected).length,
    visibleControls: controlIds.length,
    yamlTopLevelFields: Object.keys(savedYaml).length,
    guiTopLevelFields: Object.keys(savedGui).length,
  };
}

async function main() {
  await app.whenReady();

  const testSession = session.fromPartition(
    `settings-persistence-test-${Date.now()}`,
  );
  testSession.webRequest.onBeforeRequest(
    {
      urls: ['file:///*'],
    },
    (details, callback) => {
      callback({
        cancel: details.url.endsWith('/dist/renderer.bundle.js'),
      });
    },
  );

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      session: testSession,
    },
  });
  await window.loadFile(
    path.join(projectRoot, 'src/view/index.html'),
  );

  const expression = `(${runRendererTest.toString()})(`
    + `${JSON.stringify(projectRoot)},`
    + `${JSON.stringify(temporaryDirectory)})`;
  const result = await window.webContents.executeJavaScript(expression);

  assert.equal(
    fs.existsSync(path.join(temporaryDirectory, 'usersettings.yaml')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(temporaryDirectory, 'gui_settings.json')),
    true,
  );
  console.log(`设置页隔离持久化测试通过: ${JSON.stringify(result)}`);

  window.destroy();
  await testSession.clearStorageData();
}

main()
  .then(() => {
    fs.rmSync(temporaryDirectory, {
      force: true,
      recursive: true,
    });
    app.exit(0);
  })
  .catch(error => {
    console.error(error);
    fs.rmSync(temporaryDirectory, {
      force: true,
      recursive: true,
    });
    app.exit(1);
  });
