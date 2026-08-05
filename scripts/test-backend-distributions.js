/**
 * 双发行包后端来源回归测试。
 *
 * 分别模拟 personal/public 包的 resources 目录，验证运行时读取到的仓库、
 * 提交和安装强制更新策略与打包配置一致。
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(
  root,
  'dist',
  'electron',
  'pythonEnv',
  'backendRequirement.js',
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-backend-distributions-'),
);

function loadDistribution(name) {
  const resources = path.join(temporaryDirectory, name);
  fs.mkdirSync(resources, { recursive: true });
  fs.copyFileSync(
    path.join(root, 'build', 'backend-distributions', `${name}.json`),
    path.join(resources, 'backend-distribution.json'),
  );
  const script = [
    "Object.defineProperty(process, 'resourcesPath', {",
    '  value: process.argv[1],',
    '});',
    'const requirement = require(process.argv[2]);',
    'process.stdout.write(JSON.stringify({',
    '  distribution: requirement.BACKEND_DISTRIBUTION,',
    '  requirement: requirement.MANAGED_AUTOWSGR_REQUIREMENT,',
    '}));',
  ].join('\n');
  return JSON.parse(execFileSync(
    process.execPath,
    ['-e', script, resources, modulePath],
    { encoding: 'utf8' },
  ));
}

try {
  const personal = loadDistribution('personal');
  assert.equal(personal.distribution.id, 'personal');
  assert.equal(
    personal.distribution.repository,
    'ShiinaKuroko/AutoWSGR',
  );
  assert.equal(personal.distribution.ref, 'ShiinaKuroko');
  assert.equal(personal.distribution.forceUpdateOnInstall, true);
  assert.match(personal.requirement, /ShiinaKuroko\/AutoWSGR/);

  const publicDistribution = loadDistribution('public');
  assert.equal(publicDistribution.distribution.id, 'public');
  assert.equal(
    publicDistribution.distribution.repository,
    'OpenWSGR/AutoWSGR',
  );
  assert.equal(publicDistribution.distribution.ref, 'main');
  assert.equal(
    publicDistribution.distribution.forceUpdateOnInstall,
    false,
  );
  assert.match(publicDistribution.requirement, /OpenWSGR\/AutoWSGR/);

  const personalInstaller = fs.readFileSync(
    path.join(root, 'build', 'installer-personal.nsh'),
    'utf8',
  );
  const publicInstaller = fs.readFileSync(
    path.join(root, 'build', 'installer.nsh'),
    'utf8',
  );
  assert.match(personalInstaller, /Delete "\$INSTDIR\\\.env_ready"/);
  assert.doesNotMatch(publicInstaller, /\.env_ready/);
  console.log('backend distribution tests passed');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
