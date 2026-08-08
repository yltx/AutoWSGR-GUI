/**
 * 旧 path-form 任务组迁移回归测试。
 *
 * 测试使用旧安装目录中实际保存过的 task_groups.json。
 * 第一步加载无版本号、只有 path 的旧任务组。
 * 第二步检查用户计划和系统计划都生成受管引用。
 * 第三步保存迁移后的 v4 数据。
 * 第四步把旧绝对路径视为已经删除。
 * 第五步通过正式队列加载函数执行一个旧任务。
 * 第六步确认执行只读取 managedSource 和 managedFile。
 * 第七步重新加载保存后的数据。
 * 第八步确认重载不会再次迁移或丢失字段。
 * 另外保留活动计划别名和 v2 中间格式的专项覆盖。
 * 任何旧路径读取都会让测试立即失败。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  AppPaths,
} = require('../dist/electron/services/AppPaths.js');
const {
  AtomicFileStore,
} = require('../dist/electron/services/AtomicFileStore.js');
const {
  UserDataMigrationService,
} = require('../dist/electron/services/UserDataMigrationService.js');
const { TaskGroupModel } = require('../dist/src/model/TaskGroupModel.js');
const { PlanModel } = require('../dist/src/model/PlanModel.js');
const {
  loadGroupToQueue,
} = require('../dist/src/controller/taskGroup/queueLoader.js');

const fixturePath = path.join(
  __dirname,
  'fixtures',
  'task-groups',
  'v1-path-form',
  'task_groups.json',
);
const executablePlanPath = path.join(
  __dirname,
  '..',
  'resource',
  'system_battle_plans',
  'bettle-周常-1-1.yaml',
);
const executablePlanContent = fs.readFileSync(executablePlanPath, 'utf8');
const weeklyPlans = [
  ['周常1章-1-2.yaml', 'bettle-周常-1-2-v1.yaml', 'user'],
  ['周常2章-2-1.yaml', 'bettle-周常-2-1.yaml', 'system'],
  ['周常3章-3-1.yaml', 'bettle-周常-3-1.yaml', 'system'],
  ['周常4章-4-1.yaml', 'bettle-周常-4-1.yaml', 'system'],
  ['周常5章-5-5.yaml', 'bettle-周常-5-5.yaml', 'system'],
  ['周常6章-6-4.yaml', 'bettle-周常-6-4.yaml', 'system'],
  ['周常7章-7-4.yaml', 'bettle-周常-7-4.yaml', 'system'],
  ['周常8章-8-2.yaml', 'bettle-周常-8-2.yaml', 'system'],
  ['周常9章-9-2.yaml', 'bettle-周常-9-2.yaml', 'system'],
  ['周常10章-10-1.yaml', 'bettle-周常-10-1.yaml', 'system'],
];
const activityPlans = [
  ['活动20260730-E1炸鱼.yaml', 'bettle-E1炸鱼.yaml'],
  ['活动20260730-E5夜战.yaml', 'bettle-E5夜战.yaml'],
  ['活动20260730-H1炸鱼.yaml', 'bettle-H1炸鱼.yaml'],
  ['活动20260730-H5夜战.yaml', 'bettle-H5夜战.yaml'],
];
const legacyWeeklyPlans = [
  ['周常1章-1-2.yaml', 'bettle-周常-1-2-v1.yaml', 1, 2],
  ['周常3章-3-3.yaml', 'bettle-周常-3-3-v1.yaml', 3, 3],
  ['周常6章-6-3.yaml', 'bettle-周常-6-3-v1.yaml', 6, 3],
];
const compatibilityPlanResources = [
  ['bettle-周常-1-2-v1.yaml', 1, 2],
  ['bettle-周常-3-3-v1.yaml', 3, 3],
  ['bettle-周常-6-3-v1.yaml', 6, 3],
  ['bettle-捞胖次-8-5.yaml', 8, 5],
  ['bettle-捞胖次-9-4-6SS.yaml', 9, 4],
];
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-task-group-v6-'),
);
let fixtureNumber = 0;

process.on('exit', () => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function migratePresetInventory(content) {
  fixtureNumber += 1;
  const root = path.join(temporaryRoot, String(fixtureNumber));
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
  const migrationResources = path.join(
    appPaths.resourceRoot(),
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
      'resource',
      'migrations',
      'v6',
      'system_battle_plans',
    ),
    migrationResources,
    { recursive: true },
  );
  fs.mkdirSync(userData, { recursive: true });
  const taskGroups = path.join(userData, 'task_groups.json');
  fs.writeFileSync(taskGroups, content, 'utf8');
  const migration = new UserDataMigrationService(
    appPaths,
    new AtomicFileStore(),
  );
  migration.migrationState.write({ version: 5, completed: [] });
  const result = migration.migratePresetInventory();
  assert.equal(result.failed, 0);
  assert.equal(migration.migrationState.read().version, 6);
  return {
    content: fs.readFileSync(taskGroups, 'utf8'),
    userPlanDir: appPaths.userBattlePlansDir(),
  };
}

function installBridge(initialContent) {
  const state = {
    stored: initialContent,
    saves: 0,
    managedReads: [],
    legacyReads: [],
  };
  global.window = {
    electronBridge: {
      readFile: async (file) => {
        if (file === 'task_groups.json') return state.stored;
        state.legacyReads.push(file);
        throw new Error(`不应读取已迁走的旧路径: ${file}`);
      },
      saveFile: async (_file, content) => {
        state.stored = content;
        state.saves += 1;
      },
      readManagedCombatPlan: async (source, file) => {
        state.managedReads.push({ source, file });
        const managedPath = path.join('C:\\managed-plans', source, file);
        return {
          success: true,
          content: executablePlanContent,
          path: managedPath,
          runtimePath: managedPath,
        };
      },
      readCombatPlanFile: async (file) => {
        state.legacyReads.push(file);
        return {
          success: false,
          error: `不应读取已迁走的旧路径: ${file}`,
        };
      },
    },
  };
  return state;
}

function assertManagedSystemPlan(item, legacyFile, managedFile) {
  assert.equal(item.path, `resource/builtin_plans/${legacyFile}`);
  assert.equal(item.managedSource, 'system');
  assert.equal(item.managedFile, managedFile);
  assert.equal(
    fs.existsSync(path.join(
      __dirname,
      '..',
      'resource',
      'system_battle_plans',
      managedFile,
    )),
    true,
    `迁移后的系统计划不存在: ${managedFile}`,
  );
}

function assertManagedUserPlan(
  item,
  legacyFile,
  managedFile,
  userPlanDir,
) {
  assert.equal(item.path, `resource/builtin_plans/${legacyFile}`);
  assert.equal(item.managedSource, 'user');
  assert.equal(item.managedFile, managedFile);
  assert.equal(
    fs.existsSync(path.join(userPlanDir, managedFile)),
    true,
    `淘汰计划没有升级为个人计划: ${managedFile}`,
  );
}

async function verifyRealLegacyFixtureLifecycle() {
  const legacyFixture = fs.readFileSync(fixturePath, 'utf8');
  const inventory = migratePresetInventory(legacyFixture);
  const state = installBridge(inventory.content);
  const model = new TaskGroupModel();

  await model.load();
  const migrated = JSON.parse(state.stored);
  assert.equal(migrated.version, 4);
  assert.equal(state.saves, 1);

  const defaultItem = migrated.groups[0].items[0];
  assert.equal(defaultItem.managedSource, 'user');
  assert.equal(defaultItem.managedFile, '9-4胖次6SS.yaml');
  assert.equal(
    defaultItem.path,
    'D:\\AutoWSGR-GUI\\plans\\9-4胖次6SS.yaml',
  );

  const weeklyItems = migrated.groups[1].items;
  weeklyPlans.forEach(([legacyFile, managedFile, source], index) => {
    if (source === 'user') {
      assertManagedUserPlan(
        weeklyItems[index],
        legacyFile,
        managedFile,
        inventory.userPlanDir,
      );
    } else {
      assertManagedSystemPlan(
        weeklyItems[index],
        legacyFile,
        managedFile,
      );
    }
  });
  assert.equal(weeklyItems[10].kind, 'template');
  assert.equal(weeklyItems[10].templateId, 'builtin_decisive_6');

  const trainingItem = migrated.groups[2].items[0];
  assert.equal(trainingItem.managedSource, 'user');
  assert.equal(trainingItem.managedFile, '9-3练级-min航速≤27.yaml');

  model.setActiveGroup('默认');
  await model.save();
  assert.equal(state.saves, 2);

  const scheduledTasks = [];
  let switchedPage = '';
  await loadGroupToQueue(
    model,
    { get: () => null },
    {
      scheduler: {
        addTask: (...args) => scheduledTasks.push(args),
      },
      getShipNameAliases: () => ({}),
      switchPage: (page) => {
        switchedPage = page;
      },
      renderMain: () => {},
    },
  );
  assert.deepEqual(state.managedReads, [{
    source: 'user',
    file: '9-4胖次6SS.yaml',
  }]);
  assert.deepEqual(state.legacyReads, []);
  assert.equal(scheduledTasks.length, 1);
  assert.equal(scheduledTasks[0][4], 500);
  assert.equal(switchedPage, 'main');

  const reloaded = new TaskGroupModel();
  await reloaded.load();
  const reloadedItem = reloaded.groups[0].items[0];
  assert.equal(reloadedItem.managedSource, 'user');
  assert.equal(reloadedItem.managedFile, '9-4胖次6SS.yaml');
  assert.equal(state.saves, 2);
}

async function verifyActivityAliases() {
  const legacy = JSON.stringify({
    activeGroup: '旧组',
    rootExtension: { preserved: true },
    groups: [{
      name: '旧组',
      groupExtension: 'keep',
      items: activityPlans.map(([legacyFile], index) => ({
        path: `resource/builtin_plans/${legacyFile}`,
        kind: 'plan',
        times: index + 1,
        label: `旧活动计划 ${index + 1}`,
        forceRetry: true,
        autoFleetFallback: true,
        itemExtension: { preserved: true },
      })),
    }],
  });
  const inventory = migratePresetInventory(legacy);
  const state = installBridge(inventory.content);
  const model = new TaskGroupModel();

  await model.load();
  const migrated = JSON.parse(state.stored);
  assert.equal(migrated.rootExtension.preserved, true);
  assert.equal(migrated.groups[0].groupExtension, 'keep');
  migrated.groups[0].items.forEach((item, index) => {
    const [legacyFile, managedFile] = activityPlans[index];
    assertManagedUserPlan(
      item,
      legacyFile,
      managedFile,
      inventory.userPlanDir,
    );
    assert.equal(item.itemExtension.preserved, true);
    assert.equal(item.forceRetry, true);
    assert.equal(item.autoFleetFallback, true);
  });
  assert.equal(state.saves, 1);
}

async function verifyLegacyWeeklyMapSemantics() {
  const legacy = JSON.stringify({
    activeGroup: '旧周常',
    groups: [{
      name: '旧周常',
      items: legacyWeeklyPlans.map(([legacyFile]) => ({
        path: `resource/builtin_plans/${legacyFile}`,
        kind: 'plan',
        times: 1,
        label: legacyFile,
      })),
    }],
  });
  const inventory = migratePresetInventory(legacy);
  const state = installBridge(inventory.content);
  const model = new TaskGroupModel();

  await model.load();
  const items = model.groups[0].items;
  legacyWeeklyPlans.forEach((
    [legacyFile, managedFile, chapter, map],
    index,
  ) => {
    assertManagedUserPlan(
      items[index],
      legacyFile,
      managedFile,
      inventory.userPlanDir,
    );
    const content = fs.readFileSync(path.join(
      inventory.userPlanDir,
      managedFile,
    ), 'utf8');
    const plan = yaml.load(content);
    assert.equal(plan.chapter, chapter);
    assert.equal(plan.map, map);
  });
  assert.equal(state.saves, 1);
}

function verifyCompatibilityPlanResources() {
  for (const [file, chapter, map] of compatibilityPlanResources) {
    const migrationFile = path.join(
      __dirname,
      '..',
      'resource',
      'migrations',
      'v6',
      'system_battle_plans',
      file,
    );
    const systemFile = path.join(
      __dirname,
      '..',
      'resource',
      'system_battle_plans',
      file,
    );
    assert.equal(fs.existsSync(systemFile), false);
    const content = fs.readFileSync(migrationFile, 'utf8');
    const model = PlanModel.fromYaml(content, migrationFile);
    assert.equal(model.data.chapter, chapter);
    assert.equal(model.data.map, map);

    const raw = yaml.load(content);
    for (const preset of raw.fleet_presets ?? []) {
      for (const slot of preset.ships ?? []) {
        if (!Array.isArray(slot?.candidates)) continue;
        assert.equal(
          slot.candidates.every(candidate => (
            candidate
            && typeof candidate === 'object'
            && typeof candidate.name === 'string'
            && candidate.name.length > 0
          )),
          true,
          `${file} 的 candidates 必须是带 name 的对象`,
        );
      }
    }
  }
}

async function verifyInterimVersion() {
  const inventory = migratePresetInventory(JSON.stringify({
    version: 2,
    activeGroup: '中间版本',
    groups: [{
      name: '中间版本',
      items: [{
        path: 'resource/system_battle_plans/E1炸鱼.yaml',
        managedSource: 'system',
        managedFile: 'E1炸鱼.yaml',
        kind: 'plan',
        times: 1,
        label: 'E1炸鱼',
      }],
    }],
  }));
  const state = installBridge(inventory.content);
  const model = new TaskGroupModel();

  await model.load();
  const migrated = JSON.parse(state.stored);
  assert.equal(migrated.version, 4);
  assert.equal(
    model.groups[0].items[0].managedFile,
    'bettle-E1炸鱼.yaml',
  );
  assert.equal(
    model.groups[0].items[0].managedSource,
    'user',
  );
  assert.equal(
    fs.existsSync(path.join(
      inventory.userPlanDir,
      'bettle-E1炸鱼.yaml',
    )),
    true,
  );
  assert.equal(state.saves, 1);
}

async function run() {
  await verifyRealLegacyFixtureLifecycle();
  await verifyActivityAliases();
  await verifyLegacyWeeklyMapSemantics();
  verifyCompatibilityPlanResources();
  await verifyInterimVersion();
  console.log('任务组加载、保存、执行、再次加载兼容测试通过');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
