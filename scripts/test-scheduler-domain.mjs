import assert from 'node:assert/strict';
import esbuild from 'esbuild';

const entries = [
  'src/model/scheduler/SchedulerTaskPolicy.ts',
  'src/model/scheduler/SchedulerRepairPolicy.ts',
  'src/model/scheduler/CronScheduler.ts',
  'src/controller/app/AutomaticDecisiveTask.ts',
  'src/controller/app/SchedulerBinder.ts',
  'src/model/scheduler/RepairManager.ts',
  'src/model/scheduler/Scheduler.ts',
];
const modules = await Promise.all(entries.map(async entry => {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.json': 'json' },
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}));
const taskPolicy = modules[0];
const repairPolicy = modules[1];
const cronModule = modules[2];
const automaticDecisive = modules[3];
const schedulerBinderModule = modules[4];
const repairModule = modules[5];
const schedulerModule = modules[6];

const task = taskPolicy.createSchedulerTask({
  id: 'task-1', name: 'test', type: 'normal_fight', request: { type: 'normal_fight' },
  priority: 10, times: 3, sortKey: 2,
});
const lower = { ...task, id: 'lower', priority: 0 };
const same = { ...task, id: 'same', sortKey: 3 };
assert.equal(taskPolicy.findPriorityInsertionIndex([lower, same], task), 1);
assert.equal(taskPolicy.findPriorityInsertionIndex([lower, same], task, true), 1);
const followUp = taskPolicy.buildFollowUpTask(task, 2, 'task-2');
assert.equal(followUp.logicalId, task.logicalId);
assert.equal(followUp.remainingTimes, 2);
assert.equal(followUp.retryCount, 0);
assert.equal(repairPolicy.calculateRepairWaitMs(new Map([['a', { repairEndTime: 110_000 }]]), 100_000), 15_000);
assert.equal(repairPolicy.calculateRepairWaitMs(new Map([['a', { repairEndTime: 0 }]]), 100_000), -1);

const values = new Map();
const storage = {
  get: key => values.get(key) ?? null,
  set: (key, value) => values.set(key, value),
  remove: key => values.delete(key),
};
const cronConfig = {
  autoExercise: false, exerciseFleetId: 1, autoBattle: false, battleType: '1-1', battleTimes: 1,
  autoNormalFight: false,
  autoDecisive: false, decisiveTemplateId: 'system_preset',
  autoLoot: false,
  lootPlanSource: 'system',
  lootPlanId: 'bettle-周常-9-2.yaml', lootStopCount: 0,
};
const cron = new cronModule.CronScheduler(cronConfig, storage);
cron.markBattleHandled();
const restoredCron = new cronModule.CronScheduler(cronConfig, storage);
restoredCron.start();
restoredCron.stop();
assert.ok(values.has('cron_lastBattleRun'));

const decisiveTriggers = [];
const decisiveCron = new cronModule.CronScheduler({
  ...cronConfig,
  autoDecisive: true,
}, storage);
decisiveCron.setCallbacks({
  onDecisiveDue: templateId => decisiveTriggers.push(templateId),
});
decisiveCron.start();
decisiveCron.stop();
assert.deepEqual(decisiveTriggers, ['system_preset']);
decisiveCron.start();
decisiveCron.stop();
assert.equal(
  decisiveTriggers.length,
  1,
  '同一天存在 pending 时不得重复触发自动决战',
);
decisiveCron.clearDecisivePending();
decisiveCron.start();
decisiveCron.stop();
assert.equal(
  decisiveTriggers.length,
  2,
  '任务入队前失败并清除 pending 后应允许重试',
);
decisiveCron.markDecisiveHandled();
assert.ok(values.has('cron_lastDecisiveRun'));

let restoredDecisiveTriggers = 0;
const restoredDecisiveCron = new cronModule.CronScheduler({
  ...cronConfig,
  autoDecisive: true,
}, storage);
restoredDecisiveCron.setCallbacks({
  onDecisiveDue: () => {
    restoredDecisiveTriggers += 1;
  },
});
restoredDecisiveCron.start();
restoredDecisiveCron.stop();
assert.equal(
  restoredDecisiveTriggers,
  0,
  '自动决战已处理日期必须跨实例持久化',
);

const automationValues = new Map();
const automationStorage = {
  get: key => automationValues.get(key) ?? null,
  set: (key, value) => automationValues.set(key, value),
  remove: key => automationValues.delete(key),
};
const automationTriggers = {
  exercise: [],
  campaign: [],
  normalFight: 0,
  decisive: [],
  loot: [],
};
const automationCron = new cronModule.CronScheduler({
  ...cronConfig,
  autoExercise: true,
  exerciseFleetId: 3,
  autoBattle: true,
  battleType: '困难航母',
  battleTimes: 4,
  autoNormalFight: true,
  autoDecisive: true,
  autoLoot: true,
  lootPlanSource: 'user',
  lootPlanId: 'bettle-old-9-2ADGHM速刷胖次.yaml',
  lootStopCount: 21,
}, automationStorage);
automationCron.setCallbacks({
  onExerciseDue: fleetId => automationTriggers.exercise.push(fleetId),
  onCampaignDue: (name, times) => {
    automationTriggers.campaign.push([name, times]);
  },
  onNormalFightDue: () => {
    automationTriggers.normalFight += 1;
  },
  onDecisiveDue: templateId => {
    automationTriggers.decisive.push(templateId);
  },
  onLootDue: (source, planId, stopCount) => {
    automationTriggers.loot.push([source, planId, stopCount]);
  },
});
automationCron.start();
automationCron.stop();
assert.deepEqual(automationTriggers, {
  exercise: [3],
  campaign: [['困难航母', 4]],
  normalFight: 1,
  decisive: ['system_preset'],
  loot: [[
    'user',
    'bettle-old-9-2ADGHM速刷胖次.yaml',
    21,
  ]],
});
automationCron.markExerciseCompleted();
automationCron.markBattleHandled();
automationCron.markNormalFightHandled();
automationCron.markDecisiveHandled();
automationCron.markLootHandled();

const restoredAutomationTriggers = [];
const restoredAutomationCron = new cronModule.CronScheduler({
  ...cronConfig,
  autoExercise: true,
  autoBattle: true,
  autoNormalFight: true,
  autoDecisive: true,
  autoLoot: true,
}, automationStorage);
restoredAutomationCron.setCallbacks({
  onExerciseDue: () => restoredAutomationTriggers.push('exercise'),
  onCampaignDue: () => restoredAutomationTriggers.push('campaign'),
  onNormalFightDue: () => restoredAutomationTriggers.push('normal'),
  onDecisiveDue: () => restoredAutomationTriggers.push('decisive'),
  onLootDue: () => restoredAutomationTriggers.push('loot'),
});
restoredAutomationCron.start();
restoredAutomationCron.stop();
assert.deepEqual(
  restoredAutomationTriggers,
  [],
  '已处理的日常自动任务不得在同一天跨实例重复触发',
);

const userDecisiveRequest =
  automaticDecisive.buildAutomaticDecisivePlanRequest(
    {
      chapter: 5,
      useQuickRepair: false,
      level1: [' 当前主力 ', ''],
      level2: ['当前替补'],
    },
  );
assert.deepEqual(userDecisiveRequest, {
  type: 'decisive',
  chapter: 5,
  decisive_rounds: 1,
  use_quick_repair: false,
  level1: ['当前主力'],
  level2: ['当前替补'],
});

const presetDecisiveRequest =
  automaticDecisive.buildAutomaticDecisivePresetRequest(
    {
      id: 'custom-decisive',
      name: '自定义决战',
      type: 'decisive',
      chapter: 4,
      level1: ['模板主力'],
      level2: ['模板替补'],
      flagship_priority: ['旗舰优先'],
      use_quick_repair: true,
    },
  );
assert.deepEqual(presetDecisiveRequest, {
  type: 'decisive',
  chapter: 4,
  decisive_rounds: 1,
  use_quick_repair: true,
  level1: ['模板主力'],
  level2: ['模板替补'],
  flagship_priority: ['旗舰优先'],
});

const repairData = JSON.stringify([{ key: 'ship', name: 'Ship', startTime: Date.now(), repairEndTime: Date.now() + 60_000, requestSent: true }]);
storage.set('autowsgr_bathing_ships', repairData);
const repair = new repairModule.RepairManager({}, storage);
assert.equal(repair.getBathingShips().size, 1);
assert.equal(repair.getBathingShips().get('ship').name, 'Ship');

globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};

let cronCallbacks = {};
let schedulerCallbacks = {};
let decisiveTemplate = {
  id: 'builtin_decisive_6',
  name: '决战',
  type: 'decisive',
  chapter: 6,
  level1: ['系统主力'],
  level2: ['系统替补'],
  use_quick_repair: true,
};
const decisiveQueueCalls = [];
let decisivePlanReads = 0;
let decisiveStartCalls = 0;
let decisivePendingClears = 0;
let decisiveHandledCalls = 0;
let normalFightPendingClears = 0;
let normalFightHandledCalls = 0;
let lootPendingClears = 0;
let lootHandledCalls = 0;
let binderRunningTask = null;
const managedPlanReads = [];
let managedPlanWrites = 0;
const expeditionTimerUpdates = [];
const managedLootYaml = [
  'chapter: 9',
  'map: 2',
  'selected_nodes: [A]',
  'fleet_id: 3',
  'gap: 4',
  'stop_condition:',
  '  loot_count_ge: 48',
  '  ship_count_ge: 7',
  '',
].join('\n');
globalThis.window = {
  electronBridge: {
    getDecisivePlanSettings: async () => {
      decisivePlanReads += 1;
      return {
        chapter: 5,
        useQuickRepair: false,
        level1: ['当前主力'],
        level2: ['当前替补'],
      };
    },
    readManagedCombatPlan: async (source, file) => {
      managedPlanReads.push([source, file]);
      return {
        success: true,
        path: `managed://${source}/${file}`,
        runtimePath: `runtime://${source}/${file}`,
        content: managedLootYaml,
      };
    },
    saveFile: async () => {
      managedPlanWrites += 1;
    },
  },
};
const binder = new schedulerBinderModule.SchedulerBinder({
  scheduler: {
    setCallbacks: callbacks => {
      schedulerCallbacks = callbacks;
    },
    addTask: (...args) => {
      decisiveQueueCalls.push(args);
      return 'automatic-decisive-task';
    },
    startConsuming: () => {
      decisiveStartCalls += 1;
    },
    get currentRunningTask() {
      return binderRunningTask;
    },
    taskQueue: [],
    waitingTaskList: [],
  },
  cronScheduler: {
    setCallbacks: callbacks => {
      cronCallbacks = callbacks;
    },
    clearDecisivePending: () => {
      decisivePendingClears += 1;
    },
    markDecisiveHandled: () => {
      decisiveHandledCalls += 1;
    },
    clearNormalFightPending: () => {
      normalFightPendingClears += 1;
    },
    markNormalFightHandled: () => {
      normalFightHandledCalls += 1;
    },
    clearLootPending: () => {
      lootPendingClears += 1;
    },
    markLootHandled: () => {
      lootHandledCalls += 1;
    },
  },
  api: {},
  templateModel: {
    get: () => decisiveTemplate,
  },
  configModel: {
    current: {
      daily_automation: {
        normal_fight_tasks: [],
      },
    },
  },
  renderMain: () => {},
  updateOpsAvailability: () => {},
  updateExpeditionTimer: text => {
    expeditionTimerUpdates.push(text);
  },
});
binder.bindCronCallbacks();
binder.bindSchedulerCallbacks();
cronCallbacks.onDecisiveDue('user_plan');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(decisiveQueueCalls.length, 1);
assert.deepEqual(decisiveQueueCalls[0].slice(0, 6), [
  '自动决战·用户计划',
  'decisive',
  {
    type: 'decisive',
    chapter: 5,
    decisive_rounds: 1,
    use_quick_repair: false,
    level1: ['当前主力'],
    level2: ['当前替补'],
  },
  20,
  1,
]);
assert.equal(decisivePlanReads, 1);
assert.equal(decisiveStartCalls, 1);
schedulerCallbacks.onLogicalTaskCompleted(
  'automatic-decisive-task',
  false,
);
assert.equal(
  decisiveHandledCalls,
  1,
  '自动决战实际任务结束后，无论结果均应标记当天已处理',
);

cronCallbacks.onDecisiveDue('system_preset');
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(decisiveQueueCalls[1].slice(0, 6), [
  '自动决战·系统预设',
  'decisive',
  {
    type: 'decisive',
    chapter: 6,
    decisive_rounds: 1,
    use_quick_repair: true,
    level1: ['系统主力'],
    level2: ['系统替补'],
  },
  20,
  1,
]);
assert.equal(
  decisivePlanReads,
  1,
  '系统预设不得读取或混入用户决战计划',
);
schedulerCallbacks.onLogicalTaskCanceled(
  'automatic-decisive-task',
  'queue_cleared',
);
assert.equal(
  decisiveHandledCalls,
  2,
  '用户清空自动任务后应结算父任务，避免同日立即重复加入',
);

cronCallbacks.onDecisiveDue('system_preset');
await new Promise(resolve => setTimeout(resolve, 0));
schedulerCallbacks.onLogicalTaskCanceled(
  'automatic-decisive-task',
  'system_stopped',
);
assert.equal(
  decisivePendingClears,
  1,
  '系统停止只释放 pending，重启后仍应允许自动任务再次触发',
);

decisiveTemplate = undefined;
cronCallbacks.onDecisiveDue('system_preset');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(decisiveQueueCalls.length, 3);
assert.equal(
  decisivePendingClears,
  2,
  '自动决战入队前失败必须清除 pending',
);

cronCallbacks.onLootDue(
  'user',
  'bettle-用户胖次测试.yaml',
  23,
);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(managedPlanReads, [[
  'user',
  'bettle-用户胖次测试.yaml',
]]);
assert.equal(
  managedPlanWrites,
  0,
  '自动胖次只能读取受管 YAML，不得修改原文件',
);
assert.equal(decisiveQueueCalls.length, 4);
const automaticLootCall = decisiveQueueCalls[3];
assert.deepEqual(automaticLootCall.slice(0, 6), [
  '自动刷胖次·9-2',
  'normal_fight',
  {
    type: 'normal_fight',
    plan_id: 'runtime://user/bettle-用户胖次测试.yaml',
    times: 1,
    gap: 4,
    plan: {
      selected_nodes: ['A', '0'],
      node_defaults: {},
      node_args: {},
      fleet_id: 3,
    },
  },
  20,
  99,
  { loot_count_ge: 23 },
]);
assert.equal(
  Object.hasOwn(automaticLootCall[5], 'ship_count_ge'),
  false,
  '自动胖次默认不得启用舰船掉落停止检测',
);
schedulerCallbacks.onLogicalTaskCompleted(
  'automatic-decisive-task',
  true,
);
assert.equal(lootHandledCalls, 1);
assert.equal(lootPendingClears, 0);

binder.pendingNormalFightTaskIds.add('normal-parent-cleared');
schedulerCallbacks.onLogicalTaskCanceled(
  'normal-parent-cleared',
  'queue_cleared',
);
assert.equal(
  normalFightHandledCalls,
  1,
  '用户清空无限自动出征后，cron 不得保留 pending 或立即重新加入',
);

binder.pendingNormalFightTaskIds.add('normal-parent-system-stop');
schedulerCallbacks.onLogicalTaskCanceled(
  'normal-parent-system-stop',
  'system_stopped',
);
assert.equal(
  normalFightPendingClears,
  1,
  '系统停止无限自动出征后应释放 cron pending，允许重启后重试',
);
binderRunningTask = {
  id: 'running-round',
  logicalId: 'running-parent',
  type: 'normal_fight',
};
schedulerCallbacks.onProgressUpdate(
  'running-round',
  { current: 2, total: 5, node: null },
);
schedulerCallbacks.onLogicalTaskCanceled(
  'other-queued-parent',
  'removed',
);
assert.equal(
  binder.runtimeState.currentProgress,
  '2/5',
  '取消其他排队任务不得清空当前运行任务的进度',
);
binder.handleBackendRuntimeLog('[UI] 战利品数量: 3/10');
binder.handleBackendRuntimeLog('[UI] 舰船数量: 2/8');
assert.equal(binder.runtimeState.trackedLoot, '3/10');
assert.equal(binder.runtimeState.trackedShip, '2/8');
schedulerCallbacks.onExpeditionTimerTick(65);
assert.deepEqual(expeditionTimerUpdates, ['01:05']);
assert.equal(binder.runtimeState.expeditionTimerText, '01:05');

binderRunningTask = {
  id: 'exercise-round',
  logicalId: 'exercise-parent',
  type: 'exercise',
};
binder.handleBackendRuntimeLog('开始演习流程');
binder.handleBackendRuntimeLog('正在挑战对手 1');
binder.handleBackendRuntimeLog('正在挑战对手 1');
assert.equal(
  binder.runtimeState.currentProgress,
  '1/5',
  '同一轮演习的重复日志不得重复增加进度',
);
binderRunningTask = null;
binder.dispose();

function createSchedulerApi(overrides = {}) {
  let callbacks = {};
  return {
    setCallbacks(next) {
      callbacks = next;
    },
    get callbacks() {
      return callbacks;
    },
    systemStart: async () => ({ success: true }),
    systemStop: async () => ({ success: true }),
    connectWebSockets() {},
    disconnectWebSockets() {},
    expeditionCheck: async () => ({ success: true }),
    taskStart: async () => ({
      success: true,
      data: { task_id: 'backend-task-1', status: 'running' },
    }),
    taskStop: async () => ({ success: true }),
    taskStatus: async () => ({
      success: true,
      data: {
        task_id: 'backend-task-1',
        status: 'running',
        progress: null,
        result: null,
      },
    }),
    ...overrides,
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 无限任务每轮使用新物理 ID，但父 logicalId 必须稳定。
let gapTaskStarts = 0;
const gapApi = createSchedulerApi({
  taskStart: async () => {
    gapTaskStarts += 1;
    return {
      success: true,
      data: {
        task_id: `gap-backend-${gapTaskStarts}`,
        status: 'running',
      },
    };
  },
});
const gapScheduler = new schedulerModule.Scheduler(gapApi);
gapScheduler.setAutoExpedition(false);
const gapRoundEvents = [];
const gapLogicalEvents = [];
const gapCanceledEvents = [];
gapScheduler.setCallbacks({
  onTaskCompleted: taskId => gapRoundEvents.push(taskId),
  onLogicalTaskCompleted: logicalId => {
    gapLogicalEvents.push(logicalId);
  },
  onLogicalTaskCanceled: (logicalId, reason) => {
    gapCanceledEvents.push([logicalId, reason]);
  },
});
assert.equal(await gapScheduler.start(), true);
const gapParentId = gapScheduler.addTask(
  '无限间隔测试',
  'normal_fight',
  { type: 'normal_fight', gap: 0.08 },
  10,
  Number.POSITIVE_INFINITY,
);
gapScheduler.startConsuming();
await wait(0);
gapApi.callbacks.onTaskCompleted({
  type: 'task_completed',
  success: true,
  result: null,
  error: null,
});
await wait(0);
assert.deepEqual(gapRoundEvents, [gapParentId]);
assert.deepEqual(
  gapLogicalEvents,
  [],
  '无限任务单轮完成不得报告整个父任务完成',
);
assert.equal(gapScheduler.currentRunningTask, null);
assert.equal(gapScheduler.taskQueue.length, 0);
assert.equal(gapScheduler.waitingTaskList.length, 1);
assert.equal(gapScheduler.waitingTaskList[0].reason, 'gap');
assert.notEqual(gapScheduler.waitingTaskList[0].task.id, gapParentId);
assert.equal(
  gapScheduler.waitingTaskList[0].task.logicalId,
  gapParentId,
);
assert.equal(gapScheduler.status, 'idle');
const gapFollowUpId = gapScheduler.waitingTaskList[0].task.id;
assert.equal(gapScheduler.removeTask(gapFollowUpId), true);
assert.deepEqual(
  gapCanceledEvents,
  [[gapParentId, 'removed']],
  '删除 gap 等待项必须取消其父任务',
);
await wait(100);
assert.equal(
  gapTaskStarts,
  1,
  '被删除的 gap 等待项不得在计时结束后重新启动',
);
await gapScheduler.stop();

// 启动失败后的重试倒计时同样必须可见、可删除。
const retryApi = createSchedulerApi({
  taskStart: async () => ({
    success: false,
    error: '模拟启动失败',
  }),
});
const retryScheduler = new schedulerModule.Scheduler(retryApi);
retryScheduler.setAutoExpedition(false);
const retryCanceledEvents = [];
retryScheduler.setCallbacks({
  onLogicalTaskCanceled: (logicalId, reason) => {
    retryCanceledEvents.push([logicalId, reason]);
  },
});
assert.equal(await retryScheduler.start(), true);
const retryParentId = retryScheduler.addTask(
  '失败重试等待测试',
  'normal_fight',
  { type: 'normal_fight' },
);
retryScheduler.startConsuming();
await wait(0);
assert.equal(retryScheduler.waitingTaskList.length, 1);
assert.equal(retryScheduler.waitingTaskList[0].reason, 'retry');
assert.equal(
  retryScheduler.waitingTaskList[0].task.logicalId,
  retryParentId,
);
const retryWaitingId =
  retryScheduler.waitingTaskList[0].task.id;
assert.equal(retryScheduler.removeTask(retryWaitingId), true);
assert.deepEqual(
  retryCanceledEvents,
  [[retryParentId, 'removed']],
  '删除失败重试等待项必须取消其父任务',
);
await retryScheduler.stop();

// 清空和系统停止必须给每个父任务发送明确的取消原因。
const clearApi = createSchedulerApi();
const clearScheduler = new schedulerModule.Scheduler(clearApi);
clearScheduler.setAutoExpedition(false);
const clearCanceledEvents = [];
clearScheduler.setCallbacks({
  onLogicalTaskCanceled: (logicalId, reason) => {
    clearCanceledEvents.push([logicalId, reason]);
  },
});
assert.equal(await clearScheduler.start(), true);
const clearIdA = clearScheduler.addTask(
  '清空测试 A',
  'normal_fight',
  { type: 'normal_fight' },
);
const clearIdB = clearScheduler.addTask(
  '清空测试 B',
  'normal_fight',
  { type: 'normal_fight' },
);
clearScheduler.clearQueue();
assert.deepEqual(clearCanceledEvents, [
  [clearIdA, 'queue_cleared'],
  [clearIdB, 'queue_cleared'],
]);
const stopId = clearScheduler.addTask(
  '系统停止测试',
  'normal_fight',
  { type: 'normal_fight' },
);
await clearScheduler.stop();
assert.deepEqual(
  clearCanceledEvents.at(-1),
  [stopId, 'system_stopped'],
);

// 实时停止条件结束父任务，不复用手动暂停的重新入队语义。
let conditionStopCalls = 0;
const conditionApi = createSchedulerApi({
  taskStop: async () => {
    conditionStopCalls += 1;
    return { success: true };
  },
});
const conditionScheduler = new schedulerModule.Scheduler(conditionApi);
conditionScheduler.setAutoExpedition(false);
const conditionRoundEvents = [];
const conditionLogicalEvents = [];
conditionScheduler.setCallbacks({
  onTaskCompleted: taskId => conditionRoundEvents.push(taskId),
  onLogicalTaskCompleted: (logicalId, success) => {
    conditionLogicalEvents.push([logicalId, success]);
  },
});
assert.equal(await conditionScheduler.start(), true);
const conditionParentId = conditionScheduler.addTask(
  '实时停止条件测试',
  'normal_fight',
  { type: 'normal_fight' },
  10,
  Number.POSITIVE_INFINITY,
  { loot_count_ge: 5 },
);
conditionScheduler.startConsuming();
await wait(0);
conditionScheduler.processBackendLog('[UI] 战利品数量: 5/5');
await wait(0);
assert.equal(conditionStopCalls, 1);
assert.equal(conditionScheduler.status, 'stopping');
conditionApi.callbacks.onTaskCompleted({
  type: 'task_completed',
  success: false,
  result: null,
  error: null,
});
await wait(0);
assert.deepEqual(
  conditionRoundEvents,
  [],
  '被停止条件中断的物理轮次不得伪报为单轮完成',
);
assert.deepEqual(
  conditionLogicalEvents,
  [[conditionParentId, true]],
);
assert.equal(conditionScheduler.currentRunningTask, null);
assert.equal(conditionScheduler.taskQueue.length, 0);
assert.equal(conditionScheduler.waitingTaskList.length, 0);
assert.equal(conditionScheduler.status, 'idle');
await conditionScheduler.stop();

let expeditionChecks = 0;
const expeditionApi = createSchedulerApi({
  expeditionCheck: async () => {
    expeditionChecks += 1;
    return { success: true };
  },
});
const expeditionScheduler = new schedulerModule.Scheduler(expeditionApi);
expeditionScheduler.setAutoExpedition(true);
expeditionScheduler.setExpeditionInterval(1);
assert.equal(await expeditionScheduler.start(), true);
assert.equal(
  expeditionChecks,
  1,
  '系统启动后应立即执行一次远征检查',
);
expeditionScheduler.handleExpeditionTrigger();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(
  expeditionChecks,
  2,
  '远征定时器触发后应通过 EXPEDITION 任务执行检查',
);
expeditionScheduler.setAutoExpedition(false);

async function createRunningScheduler(api) {
  const scheduler = new schedulerModule.Scheduler(api);
  scheduler.setAutoExpedition(false);
  assert.equal(await scheduler.start(), true);
  const taskId = scheduler.addTask(
    '停止测试',
    'normal_fight',
    { type: 'normal_fight' },
    10,
    1,
  );
  scheduler.startConsuming();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(scheduler.currentRunningTask?.id, taskId);
  return { scheduler, taskId };
}

let workerRunning = true;
const stopApi = createSchedulerApi({
  taskStatus: async () => ({
    success: true,
    data: {
      task_id: workerRunning ? 'backend-task-1' : null,
      status: workerRunning ? 'running' : 'stopped',
      progress: null,
      result: null,
    },
  }),
});
const { scheduler: stoppingScheduler, taskId: stoppedTaskId } =
  await createRunningScheduler(stopApi);
let stopSettled = false;
const stopPromise = stoppingScheduler.stopRunning().finally(() => {
  stopSettled = true;
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(stopSettled, false);
assert.equal(stoppingScheduler.status, 'stopping');
assert.equal(stoppingScheduler.currentRunningTask?.id, stoppedTaskId);
assert.equal(stoppingScheduler.taskQueue.length, 0);

workerRunning = false;
await stopPromise;
assert.equal(stoppingScheduler.status, 'idle');
assert.equal(stoppingScheduler.currentRunningTask, null);
assert.equal(stoppingScheduler.taskQueue.length, 1);
assert.equal(stoppingScheduler.taskQueue[0].id, stoppedTaskId);
assert.equal(stoppingScheduler.taskQueue[0].backendTaskId, undefined);

const wsStopApi = createSchedulerApi();
const { scheduler: wsStoppingScheduler, taskId: wsStoppedTaskId } =
  await createRunningScheduler(wsStopApi);
const wsStopPromise = wsStoppingScheduler.stopRunning();
await new Promise(resolve => setTimeout(resolve, 20));
wsStopApi.callbacks.onTaskCompleted({
  type: 'task_completed',
  success: false,
  result: null,
  error: null,
});
await wsStopPromise;
assert.equal(wsStoppingScheduler.status, 'idle');
assert.equal(wsStoppingScheduler.currentRunningTask, null);
assert.equal(wsStoppingScheduler.taskQueue.length, 1);
assert.equal(wsStoppingScheduler.taskQueue[0].id, wsStoppedTaskId);

const failedStopApi = createSchedulerApi({
  taskStop: async () => ({ success: false, error: '拒绝停止' }),
});
const { scheduler: failedStopScheduler, taskId: failedTaskId } =
  await createRunningScheduler(failedStopApi);
await assert.rejects(
  failedStopScheduler.stopRunning(),
  /拒绝停止/,
);
assert.equal(failedStopScheduler.status, 'running');
assert.equal(failedStopScheduler.currentRunningTask?.id, failedTaskId);
assert.equal(failedStopScheduler.taskQueue.length, 0);

console.log('scheduler domain tests passed');
