/**
 * Electron 主进程 IPC 契约测试。
 *
 * 测试流程：
 * 1. 加载不依赖 Electron 运行时的 IPC Adapter。
 * 2. 使用内存注册器收集 handle 和 on 通道。
 * 3. 拒绝 Adapter 之间的重复通道注册。
 * 4. 从 UpdaterIpc 源码收集三个更新通道。
 * 5. 从 preload 源码收集 invoke 和 sendSync 通道。
 * 6. 验证所有 sendSync 通道仍由 ipcMain.on 注册。
 * 7. 验证所有启用的 invoke 通道仍由 ipcMain.handle 注册。
 * 8. 验证主进程没有 preload 未暴露的额外业务通道。
 * 9. 测试不启动 Electron，也不访问真实用户数据。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  registerBackendIpc,
} = require('../../dist/electron/ipc/BackendIpc.js');
const {
  registerCombatPlanIpc,
} = require('../../dist/electron/ipc/CombatPlanIpc.js');
const {
  registerConfigurationIpc,
} = require('../../dist/electron/ipc/ConfigurationIpc.js');
const {
  registerDeviceIpc,
} = require('../../dist/electron/ipc/DeviceIpc.js');
const {
  registerDailyPlanIpc,
} = require('../../dist/electron/ipc/DailyPlanIpc.js');
const {
  registerEnvironmentIpc,
} = require('../../dist/electron/ipc/EnvironmentIpc.js');
const {
  registerFileIpc,
} = require('../../dist/electron/ipc/FileIpc.js');
const {
  registerMigrationConflictIpc,
} = require('../../dist/electron/ipc/MigrationConflictIpc.js');
const {
  registerShipLibraryIpc,
} = require('../../dist/electron/ipc/ShipLibraryIpc.js');
const {
  registerTeamPlanIpc,
} = require('../../dist/electron/ipc/TeamPlanIpc.js');

class MemoryIpcRegistrar {
  constructor() {
    this.handles = new Map();
    this.listeners = new Map();
  }

  handle(channel, listener) {
    assert.equal(
      this.handles.has(channel) || this.listeners.has(channel),
      false,
      `重复 IPC 通道: ${channel}`,
    );
    this.handles.set(channel, listener);
  }

  on(channel, listener) {
    assert.equal(
      this.handles.has(channel) || this.listeners.has(channel),
      false,
      `重复 IPC 通道: ${channel}`,
    );
    this.listeners.set(channel, listener);
    return this;
  }
}

/** 从 TypeScript 源码提取指定调用的字符串通道。 */
function sourceChannels(source, expression) {
  const channels = [];
  const pattern = new RegExp(
    `${expression}\\(\\s*['"]([^'"]+)['"]`,
    'g',
  );
  for (const match of source.matchAll(pattern)) {
    channels.push(match[1]);
  }
  return channels;
}

/** 返回排序后的集合差异。 */
function difference(left, right) {
  return [...left]
    .filter(value => !right.has(value))
    .sort();
}

const ipc = new MemoryIpcRegistrar();
registerFileIpc(ipc, {});
registerMigrationConflictIpc(ipc, {});
registerDeviceIpc(ipc, {});
registerDailyPlanIpc(ipc, {});
registerConfigurationIpc(ipc, {});
registerEnvironmentIpc(ipc, {});
registerTeamPlanIpc(ipc, {});
registerCombatPlanIpc(ipc, {});
registerShipLibraryIpc(ipc, {});
registerBackendIpc(ipc, {});

const projectRoot = path.resolve(__dirname, '..', '..');
const preloadSource = fs.readFileSync(
  path.join(projectRoot, 'electron', 'preload.ts'),
  'utf8',
);
const updaterSource = fs.readFileSync(
  path.join(projectRoot, 'electron', 'ipc', 'UpdaterIpc.ts'),
  'utf8',
);
const mainSource = fs.readFileSync(
  path.join(projectRoot, 'electron', 'main.ts'),
  'utf8',
);

const preloadInvoke = new Set(sourceChannels(
  preloadSource,
  'ipcRenderer\\.invoke',
));
const preloadSync = new Set(sourceChannels(
  preloadSource,
  'ipcRenderer\\.sendSync',
));
const updaterHandles = sourceChannels(
  updaterSource,
  'ipc\\.handle',
);
const mainHandles = new Set([
  ...ipc.handles.keys(),
  ...updaterHandles,
]);
const mainSync = new Set(ipc.listeners.keys());

assert.deepEqual(
  difference(preloadSync, mainSync),
  [],
  'preload 存在未注册的同步通道',
);
assert.deepEqual(
  difference(mainSync, preloadSync),
  [],
  '主进程存在 preload 未暴露的同步通道',
);
assert.deepEqual(
  difference(preloadInvoke, mainHandles),
  [],
  'preload 异步通道与主进程注册不一致',
);
assert.deepEqual(
  difference(mainHandles, preloadInvoke),
  [],
  '主进程存在 preload 未暴露的异步通道',
);
assert.equal(
  preloadInvoke.has('resolve-app-path'),
  false,
  '不得向 renderer 暴露通用路径解析 IPC',
);
assert.match(
  updaterSource,
  /autoUpdater\.autoDownload\s*=\s*false/,
  '发现更新后必须先由用户确认，禁止直接自动下载',
);
assert.match(
  updaterSource,
  /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/,
  '普通退出不得自动安装 GUI 更新',
);
assert.match(
  updaterSource,
  /autoUpdater\.channel\s*=\s*updatePolicy\.channel;\s*autoUpdater\.allowDowngrade\s*=\s*false;/,
  '每次切换更新频道后必须重新禁止降级',
);
assert.match(
  updaterSource,
  /autoUpdater\.setFeedURL\(\{[\s\S]*owner:\s*updatePolicy\.repository\.owner,[\s\S]*repo:\s*updatePolicy\.repository\.repo,[\s\S]*channel:\s*updatePolicy\.channel,/,
  '预览版和稳定版频道必须同时切换到各自的 GitHub 更新源',
);
assert.doesNotMatch(
  updaterSource,
  /autoUpdater\.autoInstallOnAppQuit\s*=\s*true/,
  '任何更新分支都不得重新开启退出安装',
);
assert.match(
  updaterSource,
  /context\.chooseDownload\(version\)[\s\S]*choice === ['"]later['"][\s\S]*beginDownload\(version\)/,
  '发现更新后必须支持现在后台下载和稍后提醒',
);
assert.match(
  updaterSource,
  /updateStates\.saveDownloaded\([\s\S]*offerRestart\(info\.version\)/,
  '下载校验完成后必须持久化并询问重启时间',
);
assert.doesNotMatch(
  updaterSource,
  /quitAndInstall|download-progress/,
  '不得直接关闭 GUI 安装或向页面转发两轮下载进度',
);
assert.match(
  updaterSource,
  /autoUpdater\.on\(\s*['"]checking-for-update['"]/,
  'GUI 更新检查必须向渲染进程发送检查中状态',
);
assert.match(
  mainSource,
  /buttons:\s*\[['"]现在更新['"],\s*['"]稍后['"]\]/,
  '发现更新后必须让用户决定是否后台下载',
);
assert.match(
  mainSource,
  /buttons:\s*\[['"]立即重启['"],\s*['"]下次启动['"]\]/,
  '下载完成后必须让用户选择立即重启或下次启动',
);
assert.match(
  mainSource,
  /installDownloadedUpdate:[\s\S]*await stopRuntimeResources\(\)[\s\S]*await guiUpdateInstaller\.launchPendingUpdate\(\)[\s\S]*app\.quit\(\)/,
  '立即重启必须先停止运行资源，再静默启动安装器',
);
assert.match(
  mainSource,
  /handleStartupUpdate[\s\S]*app\.whenReady\(\)\.then[\s\S]*if \(await handleStartupUpdate\(\)\) return;[\s\S]*windowService\.createWindow\(\)/,
  '下次启动必须在创建主窗口前处理待安装更新',
);
assert.match(
  mainSource,
  /message:\s*['"]后台正在更新，请稍后['"]/,
  '安装期间重复启动必须显示系统提示',
);
assert.match(
  mainSource,
  /async function stopRuntimeResources[\s\S]*await stopBackend\(\)[\s\S]*await adbService\.stopServer\(\)/,
  'GUI 退出流程必须依次停止后端和 GUI 内置 ADB server',
);
assert.match(
  mainSource,
  /app\.on\('before-quit'[\s\S]*stopRuntimeResources\(\)/,
  '无论后端是否仍在运行，GUI 退出前都必须清理运行资源',
);

/** 验证 ADB 查询失败时保留空列表兼容行为并记录原因。 */
async function testAdbDeviceQueryFailure() {
  const deviceIpc = new MemoryIpcRegistrar();
  const queryError = new Error('模拟 ADB 查询失败');
  const warnings = [];
  registerDeviceIpc(deviceIpc, {
    adb: {
      listDevices: async () => {
        throw queryError;
      },
    },
  });
  const handler = deviceIpc.handles.get('check-adb-devices');
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.deepEqual(await handler({}), []);
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '[ADB] 设备查询失败:');
  assert.equal(warnings[0][1], queryError);
}

/** 验证本地计划导入取消、冲突拒绝和确认覆盖流程。 */
async function testLocalCombatPlanImport() {
  const importIpc = new MemoryIpcRegistrar();
  const importCalls = [];
  let selectionCanceled = true;
  let confirmationResponse = 0;
  registerCombatPlanIpc(importIpc, {
    dialog: {
      showOpenDialog: async () => ({
        canceled: selectionCanceled,
        filePaths: selectionCanceled ? [] : ['C:\\plans\\legacy.yaml'],
      }),
      showMessageBox: async (options) => {
        assert.equal(options.title, '覆盖用户配置');
        assert.equal(options.detail, '地图：bettle-legacy.yaml\n舰队：旧舰队');
        return { response: confirmationResponse };
      },
    },
    plans: {
      importLocal: (filePath, overwrite) => {
        importCalls.push([filePath, overwrite]);
        return overwrite
          ? { success: true, file: 'bettle-legacy.yaml' }
          : {
            success: false,
            exists: true,
            conflicts: [
              '地图：bettle-legacy.yaml',
              '舰队：旧舰队',
            ],
          };
      },
    },
  });
  const importHandler = importIpc.handles.get(
    'import-local-combat-plan',
  );

  assert.deepEqual(
    await importHandler({}),
    { success: false, canceled: true },
  );
  assert.deepEqual(importCalls, []);

  selectionCanceled = false;
  assert.deepEqual(
    await importHandler({}),
    { success: false, canceled: true },
  );
  assert.deepEqual(importCalls, [
    ['C:\\plans\\legacy.yaml', false],
  ]);

  confirmationResponse = 1;
  assert.deepEqual(
    await importHandler({}),
    { success: true, file: 'bettle-legacy.yaml' },
  );
  assert.deepEqual(importCalls, [
    ['C:\\plans\\legacy.yaml', false],
    ['C:\\plans\\legacy.yaml', false],
    ['C:\\plans\\legacy.yaml', true],
  ]);
}

/** 验证批量导出取消、默认文件名和 ZIP 写入流程。 */
async function testUserPlanExport() {
  const exportIpc = new MemoryIpcRegistrar();
  const createCalls = [];
  const writeCalls = [];
  let selectionCanceled = true;
  registerCombatPlanIpc(exportIpc, {
    dialog: {
      showSaveDialog: async (options) => {
        assert.equal(options.title, '批量导出用户配置');
        assert.match(options.defaultPath, /^\d{4}-\d{2}-\d{2}-plans\.zip$/);
        assert.deepEqual(options.filters, [{
          name: 'ZIP 压缩包',
          extensions: ['zip'],
        }]);
        return {
          canceled: selectionCanceled,
          filePath: selectionCanceled
            ? undefined
            : 'C:\\exports\\2026-08-04-plans.zip',
        };
      },
    },
    planExports: {
      createArchive: async selections => {
        createCalls.push(selections);
        return { content: Buffer.from('zip'), count: selections.length };
      },
      archiveFileName: () => '2026-08-04-plans.zip',
      writeArchive: (filePath, archive) => {
        writeCalls.push([filePath, archive.count]);
      },
    },
  });
  const handler = exportIpc.handles.get('export-user-plans');
  const selections = [
    { kind: 'battle', file: 'bettle-test.yaml' },
    { kind: 'team', file: 'team-test.yaml' },
  ];

  assert.deepEqual(
    await handler({}, selections),
    { success: false, canceled: true },
  );
  assert.deepEqual(writeCalls, []);

  selectionCanceled = false;
  assert.deepEqual(
    await handler({}, selections),
    {
      success: true,
      path: 'C:\\exports\\2026-08-04-plans.zip',
      count: 2,
    },
  );
  assert.deepEqual(createCalls, [selections, selections]);
  assert.deepEqual(writeCalls, [[
    'C:\\exports\\2026-08-04-plans.zip',
    2,
  ]]);
}

/** 验证设置提交 IPC 只委托跨文件事务服务。 */
function testSettingsCommitDelegation() {
  const settingsIpc = new MemoryIpcRegistrar();
  let receivedRequest = null;
  const expected = {
    automation: { battleTimes: 3 },
    windowPreferences: { rememberBounds: true },
  };
  registerConfigurationIpc(settingsIpc, {
    configuration: {},
    settingsCommit: {
      commitAtomic: (request) => {
        receivedRequest = request;
        return expected;
      },
    },
  });
  const handler = settingsIpc.handles.get('commit-gui-settings');
  const request = {
    usersettingsYaml: 'new: yaml\n',
  };

  assert.equal(handler({}, request), expected);
  assert.equal(receivedRequest, request);
}

async function main() {
  await testAdbDeviceQueryFailure();
  await testLocalCombatPlanImport();
  await testUserPlanExport();
  testSettingsCommitDelegation();
}

main()
  .then(() => console.log('main IPC contract tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
