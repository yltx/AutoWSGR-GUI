import assert from 'node:assert/strict';
import esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: ['src/model/statistics/DailySortieStats.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${
  Buffer.from(result.outputFiles[0].text).toString('base64')
}`;
const { DailySortieStats } = await import(moduleUrl);

const values = new Map();
const storage = {
  get: key => values.get(key) ?? null,
  set: (key, value) => values.set(key, value),
  remove: key => values.delete(key),
};

const start = new Date(2026, 7, 4, 12, 0, 0).getTime();
let now = start;
const stats = new DailySortieStats(storage, () => now);

const battleLogs = [
  '[Combat] 战果: MVP=1 评价=SS 节点: A',
  '[Combat] 战果: MVP=2 评价=S 节点: B',
  '[Combat] 战果: MVP=1 评价=A 节点: C',
  '[Combat] 战果: MVP=4 评价=B 节点: D',
  '[Combat] 战果: MVP=3 评价=C 节点: E',
  '[Combat] 战果: MVP=5 评价=D 节点: F',
];
for (const log of battleLogs) {
  assert.equal(stats.consume(log, now), true);
  now += 10;
}

// WebSocket 和 stdout 紧接着传入同一日志时只统计一次。
const duplicateBattle = battleLogs[0];
assert.equal(stats.consume(duplicateBattle, now), false);
now += 1_300;
assert.equal(stats.consume(duplicateBattle, now), true);

now += 10;
assert.equal(
  stats.consume('[UI] 修理位置: [1, 3] (策略: moderate)', now),
  true,
);
assert.equal(
  stats.consume('[UI] 修理位置: [1, 3] (策略: moderate)', now + 50),
  false,
);

now += 100;
assert.equal(
  stats.consume('[OPS] 浴室修理派单成功 (120s, 本轮已派 1 艘)', now),
  true,
);
now += 100;
stats.consume('[UI] 战利品数量: 12/50', now);
now += 100;
stats.consume('[UI] 舰船数量: 27/500', now);

now += 100;
stats.consume('[Combat] 获得舰船: 昆西', now);
let snapshot = stats.getSnapshot(now);
assert.equal(snapshot.shipCount, 28);
assert.deepEqual(snapshot.shipDrops, [{ name: '昆西', count: 1 }]);
assert.deepEqual(snapshot.dropNotice, {
  shipName: '昆西',
  dailyIndex: 28,
  visibleUntil: now + 60_000,
});
const firstQuincyNotice = snapshot.dropNotice;

now += 2_000;
stats.consume('[Combat] 获得舰船: 海伦娜', now);
assert.deepEqual(
  stats.getSnapshot(now).dropNotice,
  firstQuincyNotice,
  '其他舰船不得触发或延长昆西彩蛋',
);
now += 2_000;
stats.consume('[Combat] 获得舰船: 昆西', now);
const latestDropAt = now;
now += 100;
stats.consume('[UI] 远征收取: 2 支', now);

snapshot = stats.getSnapshot(now);
assert.equal(snapshot.battleCount, 7);
assert.deepEqual(snapshot.grades, {
  SS: 2,
  S: 1,
  A: 1,
  B: 1,
  C: 1,
  D: 1,
});
assert.equal(snapshot.quickRepairCount, 2);
assert.equal(snapshot.bathRepairCount, 1);
assert.equal(snapshot.lootCount, 12);
assert.equal(snapshot.lootLimit, 50);
assert.equal(snapshot.shipCount, 30);
assert.equal(snapshot.shipLimit, 500);
assert.equal(snapshot.expeditionCount, 2);
assert.deepEqual(snapshot.shipDrops, [
  { name: '昆西', count: 2 },
  { name: '海伦娜', count: 1 },
]);
assert.deepEqual(snapshot.dropNotice, {
  shipName: '昆西',
  dailyIndex: 30,
  visibleUntil: latestDropAt + 60_000,
});

// 重启恢复累计值，但旧掉落提示不重复出现。
const restored = new DailySortieStats(storage, () => now);
const restoredSnapshot = restored.getSnapshot(now);
assert.equal(restoredSnapshot.battleCount, 7);
assert.equal(restoredSnapshot.shipCount, 30);
assert.equal(restoredSnapshot.dropNotice, null);

// 当前会话中的提示满 60 秒后消失。
assert.equal(
  stats.getSnapshot(latestDropAt + 60_001).dropNotice,
  null,
);

// 跨到本地时间下一天后，所有每日数据归零。
const nextDay = new Date(2026, 7, 5, 0, 0, 1).getTime();
const nextDaySnapshot = restored.getSnapshot(nextDay);
assert.equal(nextDaySnapshot.battleCount, 0);
assert.equal(nextDaySnapshot.quickRepairCount, 0);
assert.equal(nextDaySnapshot.bathRepairCount, 0);
assert.equal(nextDaySnapshot.lootCount, 0);
assert.equal(nextDaySnapshot.shipCount, 0);
assert.equal(nextDaySnapshot.expeditionCount, 0);
assert.deepEqual(nextDaySnapshot.shipDrops, []);

// 非昆西掉落正常计数，但不得单独触发 LED 彩蛋。
const nonQuincyDropAt = nextDay + 100;
assert.equal(
  restored.consume('[Combat] 获得舰船: 海伦娜', nonQuincyDropAt),
  true,
);
const nonQuincySnapshot = restored.getSnapshot(nonQuincyDropAt);
assert.equal(nonQuincySnapshot.shipCount, 1);
assert.deepEqual(nonQuincySnapshot.shipDrops, [
  { name: '海伦娜', count: 1 },
]);
assert.equal(nonQuincySnapshot.dropNotice, null);

console.log('daily sortie stats tests passed');
