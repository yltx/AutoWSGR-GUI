/**
 * Alpha 后端来源回归测试。
 *
 * 模拟安装包 resources 目录，验证运行时只读取个人仓库的固定提交，
 * 并确认安装后会清除环境标记以触发后端更新。
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
const resources = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-backend-distribution-'),
);

try {
  fs.copyFileSync(
    path.join(root, 'build', 'backend-distribution.json'),
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
  const result = JSON.parse(execFileSync(
    process.execPath,
    ['-e', script, resources, modulePath],
    { encoding: 'utf8' },
  ));

  assert.equal(result.distribution.id, 'alpha');
  assert.equal(
    result.distribution.repository,
    'ShiinaKuroko/AutoWSGR',
  );
  assert.equal(result.distribution.ref, 'ShiinaKuroko');
  assert.equal(result.distribution.forceUpdateOnInstall, true);
  assert.match(result.requirement, /ShiinaKuroko\/AutoWSGR/);

  const installer = fs.readFileSync(
    path.join(root, 'build', 'installer.nsh'),
    'utf8',
  );
  assert.match(installer, /Delete "\$INSTDIR\\\.env_ready"/);
  assert.match(installer, /!macro customCheckAppRunning/);
  assert.match(installer, /\/F \/T \/IM/);
  assert.match(installer, /\$R1 < 20/);
  assert.match(
    installer,
    /"\$INSTDIR\\adb\\adb\.exe" kill-server/,
    '覆盖安装前必须停止旧版内置 ADB server',
  );
  assert.match(
    installer,
    /Rename "\$INSTDIR\\python\\site-packages" "\$INSTDIR\.site-packages-update"/,
    '覆盖安装前必须临时保留已有后端依赖',
  );
  assert.match(
    installer,
    /Rename "\$INSTDIR\.site-packages-update" "\$INSTDIR\\python\\site-packages"/,
    '写入新前端后必须恢复已有后端依赖',
  );
  console.log('alpha backend distribution test passed');
} finally {
  fs.rmSync(resources, { recursive: true, force: true });
}
