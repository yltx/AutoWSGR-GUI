import assert from 'node:assert/strict';
import esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: ['src/utils/Logger.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  result.outputFiles[0].text,
).toString('base64')}`;
const { Logger } = await import(moduleUrl);

const writes = [];
const originalLog = console.log;
console.log = (...args) => writes.push(args);
try {
  Logger.logLevel('info', '[Combat] 战果: MVP=1 评价=SS 节点: A');
} finally {
  console.log = originalLog;
}

assert.equal(writes.length, 1);
assert.equal(writes[0][0], '[GUI]');
console.log('GUI log route tests passed');
