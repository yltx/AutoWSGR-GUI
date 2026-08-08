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
} = require('../dist/electron/ipc/BackendIpc.js');
const {
  registerCombatPlanIpc,
} = require('../dist/electron/ipc/CombatPlanIpc.js');
const {
  registerConfigurationIpc,
} = require('../dist/electron/ipc/ConfigurationIpc.js');
const {
  registerDeviceIpc,
} = require('../dist/electron/ipc/DeviceIpc.js');
const {
  registerDailyPlanIpc,
} = require('../dist/electron/ipc/DailyPlanIpc.js');
const {
  registerEnvironmentIpc,
} = require('../dist/electron/ipc/EnvironmentIpc.js');
const {
  registerFileIpc,
} = require('../dist/electron/ipc/FileIpc.js');
const {
  registerMigrationConflictIpc,
} = require('../dist/electron/ipc/MigrationConflictIpc.js');
const {
  registerShipLibraryIpc,
} = require('../dist/electron/ipc/ShipLibraryIpc.js');
const {
  registerTeamPlanIpc,
} = require('../dist/electron/ipc/TeamPlanIpc.js');

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

const projectRoot = path.resolve(__dirname, '..');
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
assert.match(
  updaterSource,
  /autoUpdater\.autoDownload\s*=\s*context\.getUpdateMode\(\)\s*===\s*['"]auto['"]/,
  'GUI 更新检查必须由主进程根据当前模式控制自动下载',
);
assert.match(
  updaterSource,
  /autoUpdater\.on\(\s*['"]checking-for-update['"]/,
  'GUI 更新检查必须向渲染进程发送检查中状态',
);
assert.match(
  mainSource,
  /async function stopRuntimeResources[\s\S]*await stopBackend\(\)[\s\S]*await adbService\.stopServer\(\)/,
  'GUI 退出流程必须依次停止后端和 ADB server',
);
assert.match(
  mainSource,
  /app\.on\('before-quit'[\s\S]*stopRuntimeResources\(\)/,
  '无论后端是否仍在运行，GUI 退出前都必须清理运行资源',
);

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

/** 验证设置批量提交失败时恢复 usersettings.yaml。 */
function testSettingsCommitRollback() {
  const settingsIpc = new MemoryIpcRegistrar();
  let yamlContent = 'old: yaml\n';
  let guiSettingsWritten = false;
  let failGuiSettingsWrite = true;
  registerConfigurationIpc(settingsIpc, {
    configuration: {
      commitSettings: (_request, patch) => {
        assert.deepEqual(patch, {
          default_window_width: 1280,
          default_window_height: 720,
          remember_window_bounds: true,
        });
        if (failGuiSettingsWrite) {
          throw new Error('模拟 GUI JSON 写入失败');
        }
        guiSettingsWritten = true;
        return {
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
      },
    },
    secureFiles: {
      snapshot: () => ({
        exists: true,
        content: yamlContent,
      }),
      save: (_file, content) => {
        yamlContent = content;
      },
      restore: (_file, snapshot) => {
        yamlContent = snapshot.content;
      },
    },
    windows: {
      preparePreferences: preferences => ({
        preferences,
        settingsPatch: {
          default_window_width: preferences.defaultWidth,
          default_window_height: preferences.defaultHeight,
          remember_window_bounds: preferences.rememberBounds,
        },
      }),
    },
  });
  const handler = settingsIpc.handles.get('commit-gui-settings');
  const request = {
    updateMode: 'manual',
    backendPort: 8438,
    backendStartupMode: 'managed',
    backendRepoPath: null,
    ocrGpuMode: 'auto',
    cudaPath: null,
    saveBackendScreenshots: false,
    pythonPath: null,
    windowPreferences: {
      defaultWidth: 1280,
      defaultHeight: 720,
      rememberBounds: true,
    },
    automation: {},
    usersettingsYaml: 'new: yaml\n',
  };

  assert.throws(
    () => handler({}, request),
    /模拟 GUI JSON 写入失败/,
  );
  assert.equal(yamlContent, 'old: yaml\n');
  assert.equal(guiSettingsWritten, false);

  failGuiSettingsWrite = false;
  const result = handler({}, request);
  assert.equal(yamlContent, 'new: yaml\n');
  assert.equal(guiSettingsWritten, true);
  assert.equal(result.windowPreferences.rememberBounds, true);
}

async function main() {
  await testLocalCombatPlanImport();
  await testUserPlanExport();
  testSettingsCommitRollback();
}

main()
  .then(() => console.log('main IPC contract tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
