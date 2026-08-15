/**
 * 验证 electron-builder 的 Windows 发布目录。
 *
 * 检查目标：
 * 1. GUI 可执行文件和 app.asar 已生成。
 * 2. 内置 Python、ADB 和 VC++ 运行库存在。
 * 3. 地图、系统计划、迁移快照、模板和舰船库完整复制。
 * 4. 源资源与安装包资源的文件数量一致。
 * 5. 用户计划目录不会进入只读安装资源。
 * 6. AutoWSGR managed 模式固定到明确提交。
 * 7. 应用版本与更新频道元数据一致。
 * 8. NSIS 安装包和频道清单已生成。
 * 9. ASAR 只包含 Renderer bundle，不重复携带独立 Renderer 模块。
 *
 * 该脚本只读取产物，不修改 release 或用户数据。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..', '..');
const releaseRoot = path.join(root, 'release');
const sourceResources = path.join(root, 'resource');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const version = process.env.AUTOWSGR_RELEASE_VERSION || packageJson.version;
const channel = /^\d+\.\d+\.\d+$/.test(version)
  ? 'latest'
  : /^\d+\.\d+\.\d+-alpha(?:\.\d+)?$/.test(version)
    ? 'alpha'
    : null;
if (!channel) throw new Error(`不支持的发布版本: ${version}`);
const releaseDistribution = { id: channel };
const v6MigrationPlans = [
  'bettle-E1炸鱼.yaml',
  'bettle-E5夜战.yaml',
  'bettle-H1炸鱼.yaml',
  'bettle-H5夜战.yaml',
  'bettle-捞胖次-8-5.yaml',
  'bettle-捞胖次-9-4-6SS.yaml',
  'bettle-周常-1-2-v1.yaml',
  'bettle-周常-3-3-v1.yaml',
  'bettle-周常-6-3-v1.yaml',
];

function assertFile(filePath, label) {
  assert.equal(
    fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
    true,
    `${label} 缺失: ${path.relative(root, filePath)}`,
  );
}

function countFiles(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? countFiles(target) : 1;
  }
  return total;
}

function assertResourceDirectory(name, packagedResources) {
  const source = path.join(sourceResources, name);
  const packaged = path.join(packagedResources, name);
  const sourceCount = countFiles(source);
  const packagedCount = countFiles(packaged);
  assert.ok(sourceCount > 0, `源资源目录为空: resource/${name}`);
  assert.equal(
    packagedCount,
    sourceCount,
    `安装包资源数量不一致: resource/${name}`,
  );
}

function assertReleasePackage(distribution) {
  const releaseDirectory = path.join(releaseRoot, distribution.id);
  const unpacked = path.join(releaseDirectory, 'win-unpacked');
  const resources = path.join(unpacked, 'resources');
  const packagedResources = path.join(resources, 'resource');
  const artifactName = (
    `AutoWSGR-GUI-Setup-${version}.exe`
  );
  const label = `${distribution.id} 包`;

  assertFile(
    path.join(unpacked, 'AutoWSGR-GUI.exe'),
    `${label} GUI 可执行文件`,
  );
  const asarPath = path.join(resources, 'app.asar');
  assertFile(asarPath, `${label} GUI app.asar`);
  const asarFiles = asar.listPackage(asarPath)
    .map(file => file.replaceAll('\\', '/').replace(/^\/+/, ''));
  for (const file of [
    'dist/electron/main.js',
    'dist/electron/preload.js',
    'dist/renderer.bundle.js',
    'dist/src/shared/taskPreset.js',
    'src/view/index.html',
    'src/view/styles/styles.css',
  ]) {
    assert.equal(
      asarFiles.includes(file),
      true,
      `${label} ASAR 缺失: ${file}`,
    );
  }
  for (const directory of [
    'dist/src/adapter/',
    'dist/src/controller/',
    'dist/src/model/',
    'dist/src/types/',
    'dist/src/utils/',
    'dist/src/view/',
  ]) {
    assert.equal(
      asarFiles.some(file => file.startsWith(directory)),
      false,
      `${label} ASAR 不应重复包含 Renderer 模块: ${directory}`,
    );
  }

  assertFile(
    path.join(unpacked, 'python', 'python.exe'),
    `${label}内置 Python`,
  );
  assertFile(
    path.join(unpacked, 'python', 'python312._pth'),
    `${label} Python 路径配置`,
  );
  assertFile(
    path.join(unpacked, 'adb', 'adb.exe'),
    `${label}内置 ADB`,
  );
  assertFile(
    path.join(unpacked, 'redist', 'vc_redist.x64.exe'),
    `${label} VC++ 运行库`,
  );

  for (const directory of [
    'maps',
    'system_battle_plans',
    'system_team_plans',
    'system_daily_plans',
    'migrations/v6/system_battle_plans',
    'ship-library',
  ]) {
    assertResourceDirectory(directory, packagedResources);
  }

  for (const file of v6MigrationPlans) {
    assertFile(
      path.join(
        packagedResources,
        'migrations',
        'v6',
        'system_battle_plans',
        file,
      ),
      `${label} v6 迁移快照 ${file}`,
    );
  }

  for (const file of [
    'builtin_templates.json',
    'ship-library/manifest.json',
    'ship-library/labels.zh-CN.json',
    'ship-library/database/ships.sqlite3',
  ]) {
    assertFile(
      path.join(packagedResources, file),
      `${label}内置资源 ${file}`,
    );
  }

  for (const directory of [
    'user_battle_plans',
    'user_team_plans',
  ]) {
    assert.equal(
      fs.existsSync(path.join(packagedResources, directory)),
      false,
      `${label}不应打入用户可写目录: ${directory}`,
    );
  }

  const packagedBackendManifest = JSON.parse(fs.readFileSync(
    path.join(resources, 'backend-distribution.json'),
    'utf8',
  ));
  const expectedBackendManifest = JSON.parse(fs.readFileSync(
    path.join(root, 'build', 'backend-distribution.json'),
    'utf8',
  ));
  assert.deepEqual(
    packagedBackendManifest,
    expectedBackendManifest,
    `${label}后端发行清单不一致`,
  );
  for (const backendChannel of ['stable', 'alpha']) {
    const backend = packagedBackendManifest[backendChannel];
    assert.equal(
      backend?.id,
      backendChannel,
      `${label}${backendChannel} 后端频道不一致`,
    );
    assert.match(
      backend?.commit ?? '',
      /^[0-9a-f]{40}$/,
      `${label}${backendChannel} 后端必须固定到明确提交`,
    );
  }

  const appUpdate = yaml.load(fs.readFileSync(
    path.join(resources, 'app-update.yml'),
    'utf8',
  ));
  assert.equal(
    appUpdate.channel,
    channel,
    `${label} app-update.yml 频道不一致`,
  );

  const channelManifestPath = path.join(
    releaseDirectory,
    `${channel}.yml`,
  );
  assertFile(channelManifestPath, `${label} ${channel} 更新清单`);
  const channelManifest = yaml.load(fs.readFileSync(
    channelManifestPath,
    'utf8',
  ));
  assert.equal(
    channelManifest.path,
    artifactName,
    `${label}更新清单安装包名称不一致`,
  );
  assertFile(
    path.join(releaseDirectory, artifactName),
    `${label} NSIS 安装包`,
  );
  assertFile(
    path.join(releaseDirectory, `${artifactName}.blockmap`),
    `${label} NSIS blockmap`,
  );

  console.log(
    `${distribution.id} release package passed: `
    + `${version} (${channel})`,
  );
}

assertReleasePackage(releaseDistribution);
