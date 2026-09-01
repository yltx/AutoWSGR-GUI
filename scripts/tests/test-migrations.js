/**
 * 迁移兼容测试统一入口。
 *
 * 主进程 userData 迁移、任务组往返和真实计划语料分别在隔离进程中验证，
 * 共用一次构建产物，避免同一迁移实现通过多个别名重复执行。
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  fs,
  temporaryDirectory,
} = require('./main-services/test-context');
const {
  testUserDataMigration,
} = require('./main-services/test-migration');

function runScript(fileName) {
  const scriptPath = path.join(__dirname, fileName);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.resolve(__dirname, '..', '..'),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${fileName} failed with exit code ${result.status}`);
  }
}

try {
  testUserDataMigration();
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

runScript('test-task-group-migration.js');
runScript('test-real-plan-import.js');
console.log('migration compatibility tests passed');
