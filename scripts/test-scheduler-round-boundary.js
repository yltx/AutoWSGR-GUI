const assert = require('assert/strict');
const path = require('path');

const storage = new Map();
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
  clear: () => storage.clear(),
};

const projectRoot = path.join(__dirname, '..');
const { Scheduler } = require(path.join(projectRoot, 'dist', 'src', 'model', 'scheduler', 'Scheduler.js'));
const { TaskPriority } = require(path.join(projectRoot, 'dist', 'src', 'types', 'scheduler.js'));

const flush = () => new Promise(resolve => setImmediate(resolve));

class FakeApi {
  constructor() {
    this.callbacks = {};
    this.started = [];
    this.calls = [];
    this.stopCalls = 0;
  }

  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }

  connectWebSockets() {}

  disconnectWebSockets() {}

  async taskStart(request) {
    this.started.push(request);
    this.calls.push(request.type);
    return { success: true, data: { task_id: `backend_${this.started.length}` } };
  }

  async taskStop() {
    this.stopCalls++;
    this.calls.push('taskStop');
    return { success: true };
  }

  async expeditionCheck() {
    this.calls.push('expedition');
    return { success: true };
  }

  async rewardCollect() {
    return { success: true };
  }

  async gameContext() {
    return { success: true, data: { fleets: [] } };
  }
}

function makeScheduler(api) {
  const scheduler = new Scheduler(api);
  scheduler.setAutoExpedition(false);
  scheduler.recoverAfterTimeout();
  return scheduler;
}

async function verifySingleRoundRequests() {
  const cases = [
    ['normal_fight', { type: 'normal_fight', times: 4, gap: 0 }],
    ['event_fight', { type: 'event_fight', times: 4, gap: 0, fleet_id: 1 }],
    ['campaign', { type: 'campaign', campaign_name: '困难潜艇', times: 4 }],
  ];

  for (const [type, request] of cases) {
    const api = new FakeApi();
    const scheduler = makeScheduler(api);
    scheduler.addTask(type, type, request, TaskPriority.USER_TASK, 2);

    assert.equal(scheduler.taskQueue[0].remainingTimes, 4, `${type} must preserve the legacy logical total`);
    assert.equal(scheduler.taskQueue[0].totalTimes, 4, `${type} must display the legacy logical total`);

    scheduler.startConsuming();
    await flush();
    assert.equal(api.started[0].times, 1, `${type} backend request must run one round`);

    api.callbacks.onTaskCompleted({ type: 'task_completed', task_id: 'backend_1', success: true });
    await flush();
    assert.equal(api.started[1].times, 1, `${type} follow-up request must run one round`);
  }

  const api = new FakeApi();
  const scheduler = makeScheduler(api);
  scheduler.addTask(
    'scheduler total',
    'normal_fight',
    { type: 'normal_fight', times: 2, gap: 0 },
    TaskPriority.USER_TASK,
    5,
  );
  assert.equal(scheduler.taskQueue[0].totalTimes, 5, 'scheduler total must win when it is larger');
}

async function verifyExpeditionRoundBoundary() {
  const api = new FakeApi();
  const scheduler = makeScheduler(api);
  scheduler.addTask(
    '十轮出击',
    'normal_fight',
    { type: 'normal_fight', times: 10, gap: 0 },
    TaskPriority.USER_TASK,
    1,
  );

  scheduler.startConsuming();
  await flush();
  assert.deepEqual(api.calls, ['normal_fight']);

  api.callbacks.onTaskCompleted({ type: 'task_completed', task_id: 'backend_1', success: true });
  await flush();
  assert.deepEqual(api.calls, ['normal_fight', 'normal_fight']);
  assert.equal(scheduler.currentRunningTask.remainingTimes, 9);

  scheduler.setAutoExpedition(true);
  scheduler.handleExpeditionTrigger();
  assert.equal(api.stopCalls, 0, 'queuing an expedition must not stop the active round');
  assert.equal(scheduler.taskQueue[0].type, 'expedition');

  api.callbacks.onTaskCompleted({ type: 'task_completed', task_id: 'backend_2', success: true });
  await flush();
  await flush();

  assert.deepEqual(api.calls, ['normal_fight', 'normal_fight', 'expedition', 'normal_fight']);
  assert.equal(api.stopCalls, 0, 'round-boundary expedition scheduling must never call taskStop');
  assert.equal(scheduler.currentRunningTask.remainingTimes, 8);
  assert.equal(api.started[2].times, 1);
  scheduler.setAutoExpedition(false);
}

(async () => {
  await verifySingleRoundRequests();
  await verifyExpeditionRoundBoundary();
  console.log('scheduler round-boundary contract verified');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
