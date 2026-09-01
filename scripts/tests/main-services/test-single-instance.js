/**
 * Electron 单实例启动门禁测试。
 *
 * 两个模拟进程共享同一把系统锁，次实例不得进入任何启动副作用。
 */
const { assert } = require('./test-context');
const {
  SingleInstanceService,
} = require('../../../dist/electron/services/SingleInstanceService.js');

function testSingleInstanceService() {
  let lockHeld = false;
  let primaryStarts = 0;
  let secondaryStarts = 0;
  const secondaryExitCodes = [];
  const listeners = new Map();

  const primary = new SingleInstanceService({
    requestSingleInstanceLock() {
      if (lockHeld) return false;
      lockHeld = true;
      return true;
    },
    exit() {
      throw new Error('主实例不应退出');
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
  });
  const primaryAcquired = primary.acquire();
  assert.equal(primaryAcquired, true);
  if (primaryAcquired) primaryStarts += 1;

  const secondary = new SingleInstanceService({
    requestSingleInstanceLock() {
      return false;
    },
    exit(exitCode) {
      secondaryExitCodes.push(exitCode);
    },
    on() {
      throw new Error('次实例不应注册生命周期事件');
    },
  });
  const secondaryAcquired = secondary.acquire();
  assert.equal(secondaryAcquired, false);
  if (secondaryAcquired) secondaryStarts += 1;

  assert.equal(primaryStarts, 1);
  assert.equal(secondaryStarts, 0);
  assert.deepEqual(secondaryExitCodes, [0]);

  const calls = [];
  primary.setMainWindowProvider(() => ({
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  }));
  listeners.get('second-instance')();
  assert.deepEqual(calls, ['restore', 'show', 'focus']);

  let updateNotices = 0;
  primary.setDuplicateLaunchHandler(() => {
    updateNotices += 1;
    return true;
  });
  listeners.get('second-instance')();
  assert.equal(updateNotices, 1);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);

  primary.setDuplicateLaunchHandler(() => false);
  primary.setMainWindowProvider(() => ({
    isDestroyed: () => true,
    isMinimized: () => false,
    restore: () => calls.push('destroyed-restore'),
    show: () => calls.push('destroyed-show'),
    focus: () => calls.push('destroyed-focus'),
  }));
  listeners.get('second-instance')();
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
}

module.exports = {
  testSingleInstanceService,
};
