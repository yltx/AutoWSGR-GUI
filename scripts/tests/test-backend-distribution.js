/**
 * 稳定版后端来源与覆盖升级回归测试。
 *
 * 模拟安装包 resources 目录，验证运行时只读取 OpenWSGR 的固定提交，
 * 并通过 Windows PowerShell 5.1 直接验证旧数据保留/恢复和安装目录进程关闭契约。
 */
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const modulePath = path.join(
  root,
  'dist',
  'electron',
  'pythonEnv',
  'backendRequirement.js',
);
const helperPath = path.join(root, 'build', 'installer-helper.ps1');
const resources = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-backend-distribution-'),
);
const legacyItems = [
  'usersettings.yaml',
  'gui_settings.json',
  'task_groups.json',
  'plans',
  'templates',
  'resource\\user_battle_plans',
  'resource\\user_daily_plans',
  'resource\\user_team_plans',
];
const staleTemporaryName = (
  '.legacy.yaml.autowsgr-upgrade-' + '0'.repeat(32) + '.tmp'
);
const fixtureProcessIds = new Set();
const fixtureExecutablePaths = new Set();
const fixtureSentinelPaths = new Set();

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function installerMacro(installer, macroName) {
  const macro = new RegExp(
    '!macro\\s+' + escapeRegExp(macroName) +
      '(?:[ \\t]+[^\\r\\n]+)?\\r?\\n([\\s\\S]*?)!macroend',
  ).exec(installer)?.[1];
  assert.ok(macro, '安装器宏缺失: ' + macroName);
  return macro;
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, '源码段起点缺失: ' + startMarker);
  assert.notEqual(end, -1, '源码段终点缺失: ' + endMarker);
  return source.slice(start, end);
}

function nsisCodeLine(line) {
  const withoutComment = line.split(';', 1)[0].trim();
  return withoutComment.startsWith('#') ? '' : withoutComment;
}

function nsisCodeLines(source, fragment, message) {
  const matches = source
    .split(/\r?\n/)
    .map(nsisCodeLine)
    .filter((line) => line.includes(fragment));
  assert.ok(matches.length > 0, message + ': ' + fragment);
  return matches;
}

function assertNsisCommandOutsideUpdatedGuard(source, fragment, message) {
  const guards = [];
  let matches = 0;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = nsisCodeLine(rawLine);
    if (!line) {
      continue;
    }
    const conditional = /^\$\{If(?:Not)?\}\s+(.+)$/i.exec(line);
    if (conditional) {
      guards.push(/\$\{isUpdated\}/i.test(conditional[1]));
    }
    if (line.includes(fragment)) {
      matches++;
      assert.equal(guards.some(Boolean), false, message);
    }
    if (/^\$\{EndIf\}/i.test(line)) {
      assert.ok(guards.length > 0, 'NSIS LogicLib 条件栈不平衡');
      guards.pop();
    }
  }
  assert.equal(matches, 1, message + ': 调用次数必须为 1');
}

function windowsPowerShellExecutable() {
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  assert.equal(
    fs.existsSync(executable),
    true,
    'Windows PowerShell 5.1 缺失: ' + executable,
  );
  return executable;
}

function runInstallerHelper(action, namedParameters) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-Action',
    action,
  ];
  for (const [name, value] of Object.entries(namedParameters)) {
    if (value === undefined) {
      continue;
    }
    args.push('-' + name, String(value));
  }
  return spawnSync(windowsPowerShellExecutable(), args, {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runStopProcesses(
  installDirectory,
  excludedProcessId,
  gracefulExecutableName = 'AutoWSGR-GUI.exe',
  gracefulTimeoutSeconds = 0,
) {
  return runInstallerHelper('stop-processes', {
    InstallDirectory: installDirectory,
    ExcludedProcessId: excludedProcessId,
    GracefulExecutableName: gracefulExecutableName,
    GracefulTimeoutSeconds: gracefulTimeoutSeconds,
  });
}

function prepareUpgradeParameters(
  transactionRoot,
  target,
  scope,
  hkcuSource = '',
  hklmSource = '',
) {
  return {
    TransactionRoot: transactionRoot,
    Target: target,
    Scope: scope,
    HkcuSource: hkcuSource,
    HklmSource: hklmSource,
    ExcludedProcessId: process.pid,
    GracefulExecutableName: 'AutoWSGR-GUI.exe',
    GracefulTimeoutSeconds: 0,
  };
}

function commitUpgradeParameters(transactionRoot, target, scope) {
  return {
    TransactionRoot: transactionRoot,
    Target: target,
    Scope: scope,
  };
}

function rollbackUpgradeParameters(transactionRoot, target, scope) {
  return {
    TransactionRoot: transactionRoot,
    Target: target,
    Scope: scope,
  };
}

function runPrepareUpgrade(
  transactionRoot,
  target,
  scope,
  hkcuSource = '',
  hklmSource = '',
) {
  return runInstallerHelper('prepare-upgrade', prepareUpgradeParameters(
    transactionRoot,
    target,
    scope,
    hkcuSource,
    hklmSource,
  ));
}

function runCommitUpgrade(transactionRoot, target, scope) {
  return runInstallerHelper('commit-upgrade', commitUpgradeParameters(
    transactionRoot,
    target,
    scope,
  ));
}

function runRollbackUpgrade(transactionRoot, target, scope) {
  return runInstallerHelper('rollback-upgrade', rollbackUpgradeParameters(
    transactionRoot,
    target,
    scope,
  ));
}

function sleepSynchronously(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function isProcessRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  }
  catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    if (error?.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function waitForProcessState(processId, expectedRunning, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (isProcessRunning(processId) === expectedRunning) {
      return;
    }
    sleepSynchronously(50);
  }
  assert.equal(isProcessRunning(processId), expectedRunning, message);
}

function processIdsForExecutable(executablePath) {
  const environmentVariable = 'AUTOWSGR_INSTALLER_TEST_EXECUTABLE';
  const script = [
    '$target = [IO.Path]::GetFullPath(',
    "  [Environment]::GetEnvironmentVariable('" + environmentVariable + "', 'Process')",
    ')',
    'foreach ($entry in @(Get-CimInstance -ClassName Win32_Process)) {',
    '  if ([string]::IsNullOrWhiteSpace($entry.ExecutablePath)) { continue }',
    '  try { $candidate = [IO.Path]::GetFullPath($entry.ExecutablePath) }',
    '  catch { continue }',
    '  if ([string]::Equals(',
    '    $candidate, $target, [StringComparison]::OrdinalIgnoreCase',
    '  )) { $entry.ProcessId }',
    '}',
  ].join('\n');
  const result = spawnSync(
    windowsPowerShellExecutable(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        [environmentVariable]: executablePath,
      },
      windowsHide: true,
    },
  );
  assertHelperSucceeded(result, '无法按 executable path 查询测试进程');
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter(Number.isInteger);
}

function waitForExecutableProcessCount(executablePath, minimumCount, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (processIdsForExecutable(executablePath).length >= minimumCount) {
      return;
    }
    sleepSynchronously(100);
  }
  assert.ok(
    processIdsForExecutable(executablePath).length >= minimumCount,
    message,
  );
}

function copyPingFixture(targetPath) {
  const pingExecutable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'ping.exe',
  );
  assert.equal(fs.existsSync(pingExecutable), true, '系统 ping.exe 缺失');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(pingExecutable, targetPath);
  fixtureExecutablePaths.add(targetPath);
  return targetPath;
}

function copyAndSpawnPing(targetPath) {
  copyPingFixture(targetPath);
  const child = spawn(targetPath, ['-t', '127.0.0.1'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(typeof child.pid, 'number', '无法启动临时进程: ' + targetPath);
  fixtureProcessIds.add(child.pid);
  waitForProcessState(child.pid, true, '临时进程未启动: ' + targetPath);
  return child;
}

function waitForFile(filePath, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    sleepSynchronously(50);
  }
  assert.equal(fs.existsSync(filePath), true, message);
}

function terminateFixtureProcess(processId) {
  if (!Number.isInteger(processId) || !isProcessRunning(processId)) {
    return;
  }
  spawnSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(processId), '/T', '/F'],
    { encoding: 'utf8', windowsHide: true },
  );
}

function cleanupFixtureProcesses() {
  for (const sentinelPath of fixtureSentinelPaths) {
    fs.rmSync(sentinelPath, { force: true });
  }
  for (const processId of fixtureProcessIds) {
    terminateFixtureProcess(processId);
  }
  for (const executablePath of fixtureExecutablePaths) {
    if (!fs.existsSync(executablePath)) {
      continue;
    }
    try {
      for (const processId of processIdsForExecutable(executablePath)) {
        terminateFixtureProcess(processId);
      }
    }
    catch (error) {
      console.warn(
        '无法复查临时 executable path，已依靠记录 PID/进程树清理: ' +
          executablePath + ' (' + error.message + ')',
      );
    }
  }
}

function helperDiagnostics(result) {
  return [
    result.error?.message,
    result.stderr?.trim(),
    result.stdout?.trim(),
  ].filter(Boolean).join('\n');
}

function assertHelperStarted(result, message) {
  assert.equal(
    result.error,
    undefined,
    message + ': ' + helperDiagnostics(result),
  );
  assert.equal(
    typeof result.status,
    'number',
    message + ': helper 未返回退出码: ' + helperDiagnostics(result),
  );
}

function assertHelperSucceeded(result, message) {
  assertHelperStarted(result, message);
  assert.equal(
    result.status,
    0,
    message + ': ' + helperDiagnostics(result),
  );
}

function assertHelperFailed(result, message) {
  assertHelperStarted(result, message);
  assert.notEqual(
    result.status,
    0,
    message + ': helper 意外成功',
  );
}

function writeFixtureFiles(basePath, files) {
  for (const [relativePath, content] of files) {
    const target = path.join(basePath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

function writeFixtureDirectories(basePath, directories) {
  for (const relativePath of directories) {
    fs.mkdirSync(path.join(basePath, relativePath), { recursive: true });
  }
}

function assertFixtureFiles(basePath, files) {
  for (const [relativePath, content] of files) {
    assert.equal(
      fs.readFileSync(path.join(basePath, relativePath), 'utf8'),
      content,
      '文件内容不匹配: ' + relativePath,
    );
  }
}

function assertFixtureDirectories(basePath, directories) {
  for (const relativePath of directories) {
    assert.equal(
      fs.statSync(path.join(basePath, relativePath)).isDirectory(),
      true,
      '目录缺失: ' + relativePath,
    );
  }
}

function normalizedRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function snapshotTreeWithoutRuntime(rootPath) {
  return (snapshotTree(rootPath) ?? []).filter((entry) => (
    entry[1] !== 'python/site-packages' &&
    !entry[1].startsWith('python/site-packages/')
  ));
}

function snapshotTree(rootPath) {
  if (!fs.existsSync(rootPath)) {
    return null;
  }

  const entries = [];
  function visit(currentPath, relativePath) {
    const stat = fs.lstatSync(currentPath);
    const normalized = normalizedRelative(relativePath);
    if (stat.isSymbolicLink()) {
      entries.push(['link', normalized, fs.readlinkSync(currentPath)]);
      return;
    }
    if (stat.isDirectory()) {
      if (relativePath) {
        entries.push(['directory', normalized]);
      }
      for (const child of fs.readdirSync(currentPath).sort()) {
        visit(path.join(currentPath, child), path.join(relativePath, child));
      }
      return;
    }
    entries.push([
      'file',
      normalized,
      fs.readFileSync(currentPath).toString('base64'),
    ]);
  }

  visit(rootPath, '');
  return entries;
}

function transactionDirectories(transactionRoot) {
  const transactionsRoot = path.join(transactionRoot, 'transactions');
  if (!fs.existsSync(transactionsRoot)) {
    return [];
  }
  return fs.readdirSync(transactionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(transactionsRoot, entry.name))
    .sort();
}

function readTransactionManifest(transactionDirectory) {
  return JSON.parse(fs.readFileSync(
    path.join(transactionDirectory, 'transaction.json'),
    'utf8',
  ));
}

function readTransactionManifests(transactionRoot) {
  return transactionDirectories(transactionRoot).map((directory) => ({
    directory,
    manifest: readTransactionManifest(directory),
  }));
}

function assertManifestContract(manifest, transactionDirectory) {
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ['schemaVersion', 'scope', 'sources', 'state', 'target', 'transactionId'],
    'transaction.json 顶层字段必须匹配 schemaVersion=2 契约',
  );
  assert.equal(manifest.schemaVersion, 2);
  assert.match(manifest.transactionId, /^[0-9a-f]{32}$/);
  assert.equal(path.basename(transactionDirectory), manifest.transactionId);
  assert.ok(
    ['prepared', 'preserved', 'restoring', 'restored', 'complete']
      .includes(manifest.state),
    '未知安装事务状态: ' + manifest.state,
  );
  assert.ok(
    ['current-user', 'all-users'].includes(manifest.scope),
    '未知安装事务范围: ' + manifest.scope,
  );
  assert.equal(path.isAbsolute(manifest.target), true, '事务目标必须是绝对路径');
  assert.equal(Array.isArray(manifest.sources), true, 'sources 必须是数组');
  for (const source of manifest.sources) {
    assert.deepEqual(
      Object.keys(source).sort(),
      [
        'backupRelative',
        'digest',
        'entryCount',
        'hives',
        'path',
        'runtimeArtifact',
      ],
      '事务 source 字段不匹配',
    );
    assert.equal(Array.isArray(source.hives), true);
    assert.ok(source.hives.length > 0, '事务 source 必须绑定至少一个 hive');
    for (const hive of source.hives) {
      assert.ok(['HKCU', 'HKLM'].includes(hive), '未知 registry hive: ' + hive);
    }
    assert.equal(path.isAbsolute(source.path), true, '事务源必须是绝对路径');
    assert.equal(Number.isInteger(source.entryCount), true);
    assert.ok(source.entryCount >= 0);
    assert.match(source.digest, /^[0-9A-F]{64}$/);
    const backupPath = path.resolve(transactionDirectory, source.backupRelative);
    const relative = path.relative(transactionDirectory, backupPath);
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'backupRelative 必须严格位于事务目录内',
    );
    if (source.runtimeArtifact !== null) {
      assert.deepEqual(
        Object.keys(source.runtimeArtifact).sort(),
        ['digest', 'entryCount', 'relativePath', 'stagingPath'],
        'runtimeArtifact 字段不匹配',
      );
      assert.equal(source.runtimeArtifact.relativePath, 'python\\site-packages');
      assert.equal(path.isAbsolute(source.runtimeArtifact.stagingPath), true);
      assert.equal(Number.isInteger(source.runtimeArtifact.entryCount), true);
      assert.ok(source.runtimeArtifact.entryCount >= 0);
      assert.match(source.runtimeArtifact.digest, /^[0-9A-F]{64}$/);
      assert.equal(
        path.parse(source.runtimeArtifact.stagingPath).root.toLowerCase(),
        path.parse(source.path).root.toLowerCase(),
        'runtime staging 必须和旧 source 位于同一卷',
      );
      const relativeToSource = path.relative(
        source.path,
        source.runtimeArtifact.stagingPath,
      );
      assert.ok(
        relativeToSource.startsWith('..') && !path.isAbsolute(relativeToSource),
        'runtime staging 必须位于旧安装目录外',
      );
    }
  }
}

function singleTransaction(transactionRoot, message) {
  const transactions = readTransactionManifests(transactionRoot);
  assert.equal(transactions.length, 1, message);
  assertManifestContract(transactions[0].manifest, transactions[0].directory);
  return transactions[0];
}

function sourceForHive(manifest, hive) {
  const sources = manifest.sources.filter((source) => source.hives.includes(hive));
  assert.equal(sources.length, 1, '事务缺少唯一 ' + hive + ' source');
  return sources[0];
}

function assertTransactionBackup(transaction, source, files, directories = []) {
  const backupPath = path.resolve(transaction.directory, source.backupRelative);
  assertFixtureFiles(backupPath, files);
  assertFixtureDirectories(backupPath, directories);
  assertPreservedMarker(backupPath);
  return backupPath;
}

function assertFailureLeavesTreesUnchanged(
  action,
  namedParameters,
  roots,
  message,
) {
  const before = roots.map(snapshotTree);
  const result = runInstallerHelper(action, namedParameters);
  assertHelperFailed(result, message);
  roots.forEach((rootPath, index) => {
    assert.deepEqual(
      snapshotTree(rootPath),
      before[index],
      message + ' 后不应修改: ' + rootPath,
    );
  });
  return result;
}

function assertPreservedMarker(backupPath) {
  const markerPath = path.join(backupPath, '.preserved');
  const marker = fs.lstatSync(markerPath);
  assert.equal(marker.isFile(), true, '.preserved 必须是普通文件');
  assert.equal(marker.isSymbolicLink(), false, '.preserved 不得是 reparse point');
  assert.equal(marker.size, 0, '.preserved 必须是零字节文件');
}

function assertMarkerUnchanged(markerPath, expectedMtime) {
  const marker = fs.lstatSync(markerPath);
  assert.equal(marker.isFile(), true, '.preserved 必须继续是普通文件');
  assert.equal(marker.isSymbolicLink(), false, '.preserved 不得变成 reparse point');
  assert.equal(marker.size, 0, '.preserved 必须继续是零字节文件');
  assert.equal(marker.mtimeMs, expectedMtime, '后续 preserve 不得重写 marker');
}

function assertNoNestedPlans(rootPath) {
  assert.equal(
    fs.existsSync(path.join(rootPath, 'plans', 'plans')),
    false,
    '不得生成 plans\\plans',
  );
}

function fixturePath(parent, name) {
  const result = path.join(parent, name);
  fs.mkdirSync(result, { recursive: true });
  return result;
}

function createDirectoryJunction(targetPath, junctionPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  fs.symlinkSync(targetPath, junctionPath, 'junction');
}

function isJunctionUnavailable(error) {
  return ['EACCES', 'ENOTSUP', 'EPERM', 'UNKNOWN'].includes(error?.code);
}

let junctionsAvailable = true;
const junctionProbeRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-junction-probe-'),
);
try {
  createDirectoryJunction(
    path.join(junctionProbeRoot, 'target'),
    path.join(junctionProbeRoot, 'link'),
  );
}
catch (error) {
  if (!isJunctionUnavailable(error)) {
    throw error;
  }
  junctionsAvailable = false;
}
finally {
  fs.rmSync(junctionProbeRoot, { recursive: true, force: true });
}

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

  assert.equal(result.distribution.id, 'stable');
  assert.equal(
    result.distribution.repository,
    'OpenWSGR/AutoWSGR',
  );
  assert.equal(result.distribution.ref, 'main');
  assert.equal(result.distribution.forceUpdateOnInstall, true);
  assert.match(result.requirement, /OpenWSGR\/AutoWSGR/);

  const installer = fs.readFileSync(
    path.join(root, 'build', 'installer.nsh'),
    'utf8',
  );
  const customInstallerPath = path.join(root, 'build', 'installer.nsi');
  const packageMetadata = JSON.parse(fs.readFileSync(
    path.join(root, 'package.json'),
    'utf8',
  ));
  const releaseBuilderConfig = fs.readFileSync(
    path.join(root, 'build', 'electron-builder.release.cjs'),
    'utf8',
  );
  const helper = fs.readFileSync(helperPath, 'utf8');
  const extractHelperMacro = installerMacro(installer, 'ExtractInstallerHelper');
  const customInitMacro = installerMacro(installer, 'customInit');
  const customPageAfterChangeDirMacro = installerMacro(
    installer,
    'customPageAfterChangeDir',
  );
  const upgradeTransactionMacro = installerMacro(
    installer,
    'InstallerUpgradeTransaction',
  );
  const commitUpgradeTransactionMacro = installerMacro(
    installer,
    'CommitInstallerUpgradeTransaction',
  );
  const rollbackUpgradeTransactionMacro = installerMacro(
    installer,
    'RollbackInstallerUpgradeTransaction',
  );
  const uninstallResultMacro = installerMacro(
    installer,
    'HandleInstallerUninstallResult',
  );
  const customInstallMacro = installerMacro(installer, 'customInstall');
  const stopProcessesMacro = installerMacro(
    installer,
    'StopDirectoryProcesses',
  );
  const checkRunningMacro = installerMacro(installer, 'customCheckAppRunning');
  const installerTemplate = fs.readFileSync(
    path.join(
      root,
      'node_modules',
      'app-builder-lib',
      'templates',
      'nsis',
      'installer.nsi',
    ),
    'utf8',
  );
  const installSectionTemplate = fs.readFileSync(
    path.join(
      root,
      'node_modules',
      'app-builder-lib',
      'templates',
      'nsis',
      'installSection.nsh',
    ),
    'utf8',
  );
  const installUtilTemplate = fs.readFileSync(
    path.join(
      root,
      'node_modules',
      'app-builder-lib',
      'templates',
      'nsis',
      'include',
      'installUtil.nsh',
    ),
    'utf8',
  );
  const multiUserTemplate = fs.readFileSync(
    path.join(
      root,
      'node_modules',
      'app-builder-lib',
      'templates',
      'nsis',
      'multiUser.nsh',
    ),
    'utf8',
  );
  const stopProcessFunction = sourceSection(
    helper,
    'function Get-InstallDirectoryProcesses',
    'function Invoke-StopProcesses',
  );
  const gracefulStopFunctions = sourceSection(
    helper,
    'function Request-GracefulProcessExit',
    'function Invoke-StopProcesses',
  );
  const stopProcessImplementation = sourceSection(
    helper,
    'function Invoke-StopProcesses',
    'try {\n    switch ($Action)',
  );

  assert.match(installer, /Delete "\$INSTDIR\\\.env_ready"/);
  assert.match(installer, /!macro customCheckAppRunning/);
  assert.doesNotMatch(installer, /site-packages-update/);
  assert.doesNotMatch(installer, /python\\Lib\\site-packages/);
  assert.doesNotMatch(
    installer,
    /RMDir \/r "\$INSTDIR\\python\\site-packages"/,
    '主动卸载不能使用不支持超长路径的 NSIS 递归删除',
  );
  assert.match(
    installer,
    /-Action remove-managed-runtime -InstallDirectory "\$INSTDIR"/,
    '主动卸载必须通过安全 helper 删除 GUI 管理的后端目录',
  );
  assert.match(
    installer,
    /\$LOCALAPPDATA\\AutoWSGR-GUI\\legacy-upgrade/,
    '旧用户数据暂存目录必须位于安装目录之外',
  );
  assert.match(installer, /无法安全保留旧安装数据/);
  assert.match(installer, /事务备份仍保留/);

  assert.match(
    installerTemplate,
    /\$\{if\} \$hasPerMachineInstallation == "1"[\s\S]*?\$\{andIf\} \$\{Silent\}[\s\S]*?UAC_RunElevated/,
    'electron-builder 静默 auto-updater 路径必须由 UAC inner 完成安装',
  );
  assert.match(
    installSectionTemplate,
    /\$\{ifNot\} \$\{UAC_IsInnerInstance\}[\s\S]*?!insertmacro CHECK_APP_RUNNING[\s\S]*?!insertmacro uninstallOldVersion SHELL_CONTEXT[\s\S]*?uninstallOldVersion HKEY_CURRENT_USER/,
    '事实基线：assisted installer 只在外层检查，之后可能卸载当前和 HKCU 两个旧源',
  );
  assert.match(
    multiUserTemplate,
    /ReadRegStr \$perUserInstallationFolder HKCU[^\r\n]*InstallLocation/,
    '事实基线：per-user 旧源来自 HKCU InstallLocation',
  );
  assert.match(
    multiUserTemplate,
    /ReadRegStr \$perMachineInstallationFolder HKLM[^\r\n]*InstallLocation/,
    '事实基线：per-machine 旧源来自 HKLM InstallLocation',
  );
  assert.match(
    multiUserTemplate,
    /!insertmacro GetDParameter \$R0[\s\S]*?StrCpy \$INSTDIR \$R0/,
    '事实基线：/D= 可以把最终 $INSTDIR 改到不同于注册表旧源的目录',
  );
  assert.match(
    installUtilTemplate,
    /readReg \$installationDir "\$rootKey"[\s\S]*?StrCpy \$0 "\$0 --updated"[\s\S]*?_\?=\$installationDir/,
    '事实基线：旧卸载器按注册表源运行且总是收到 --updated',
  );

  assert.equal(
    fs.existsSync(customInstallerPath),
    false,
    '不得用自定义 installer.nsi 绕过 electron-builder 的卸载器构建和签名流程',
  );
  assert.equal(
    packageMetadata.build.nsis.include,
    'build/installer.nsh',
    '默认 NSIS 配置必须只通过 installer.nsh include 扩展',
  );
  assert.equal(
    Object.hasOwn(packageMetadata.build.nsis, 'script'),
    false,
    '默认 NSIS 配置不得覆盖 electron-builder installer.nsi',
  );
  assert.match(
    releaseBuilderConfig,
    /include:\s*['"]build\/installer\.nsh['"]/,
    '稳定版配置必须继续 include installer.nsh',
  );
  assert.doesNotMatch(
    releaseBuilderConfig,
    /\bscript\s*:/,
    '稳定版配置不得覆盖 electron-builder installer.nsi',
  );
  assert.match(
    installSectionTemplate,
    /!insertmacro uninstallOldVersion SHELL_CONTEXT/,
    '事实基线：installSection.nsh 负责运行旧卸载器',
  );
  assert.match(
    customInitMacro,
    /StrCpy \$InstallerPowerShellPath "\$SYSDIR\\WindowsPowerShell\\v1\.0\\powershell\.exe"/,
    'installer 必须使用显式 System32 Windows PowerShell 5.1 路径',
  );
  assert.match(
    customInitMacro,
    /\$\{If\} \$\{Silent\}[\s\S]*?\$\{If\} \$hasPerMachineInstallation == "1"[\s\S]*?\$\{AndIfNot\} \$\{UAC_IsAdmin\}[\s\S]*?\$\{Else\}[\s\S]*?!insertmacro InstallerUpgradeTransaction RetryPrepareLegacyUpgradeInit[\s\S]*?\$\{EndIf\}[\s\S]*?\$\{EndIf\}/,
    '静默 per-machine 非管理员 outer 必须跳过 prepare，交给实际 UAC 安装 owner',
  );
  assert.match(
    customPageAfterChangeDirMacro,
    /Page custom AutoWsgrPrepareUpgradePage[\s\S]*?Function AutoWsgrPrepareUpgradePage[\s\S]*?!ifdef allowToChangeInstallationDirectory[\s\S]*?Call instFilesPre[\s\S]*?!endif[\s\S]*?!insertmacro InstallerUpgradeTransaction RetryPrepareLegacyUpgradePage[\s\S]*?Abort[\s\S]*?FunctionEnd/,
    '交互安装必须在最终目录规范化后、进入 install Section 前由无 UI 页面 owner prepare',
  );
  assert.match(
    installer,
    /!ifndef BUILD_UNINSTALLER\r?\n!macro customInit[\s\S]*?!macro customPageAfterChangeDir[\s\S]*?!macroend\r?\n!endif/,
    'installer-only 初始化和事务页面不得编入卸载器',
  );
  assertNsisCommandOutsideUpdatedGuard(
    customInstallMacro,
    '!insertmacro CommitInstallerUpgradeTransaction',
    'commit-upgrade 不得受当前 installer 的 --updated 参数控制',
  );

  const prepareCommands = nsisCodeLines(
    upgradeTransactionMacro,
    '-Action prepare-upgrade',
    'InstallerUpgradeTransaction 必须调用 prepare-upgrade',
  );
  assert.equal(prepareCommands.length, 2, 'prepare-upgrade 必须分别覆盖 current-user/all-users');
  for (const prepareCommand of prepareCommands) {
    for (const argument of [
      '-TransactionRoot "$LegacyUpgradeRoot"',
      '-Target "$LegacyUpgradeTarget"',
      '-Scope "$LegacyUpgradeScope"',
      '-HkcuSource "$LegacyUpgradeHkcuSource"',
      '-ExcludedProcessId "$0"',
      '-GracefulExecutableName "${APP_EXECUTABLE_FILENAME}"',
      '-GracefulTimeoutSeconds 20',
    ]) {
      assert.ok(prepareCommand.includes(argument), 'prepare-upgrade 缺少参数: ' + argument);
    }
    assert.equal(prepareCommand.includes('--updated'), false);
  }
  assert.equal(
    prepareCommands.filter(
      (command) => command.includes('-HklmSource "$LegacyUpgradeHklmSource"'),
    ).length,
    1,
    '只有 all-users prepare 命令应传入 HKLM source',
  );
  assert.doesNotMatch(upgradeTransactionMacro, /\$\{isUpdated\}/);
  assert.match(
    upgradeTransactionMacro,
    /\$\{RETRY_LABEL\}:[\s\S]*?\$\{If\} \$R2 != 0[\s\S]*?MessageBox MB_RETRYCANCEL\|MB_ICONSTOP\s*\\\r?\n\s*"[^"]+" \/SD IDCANCEL\s*\\\r?\n\s*IDRETRY \$\{RETRY_LABEL\}[\s\S]*?SetErrorLevel 1[\s\S]*?Quit/,
    'prepare-upgrade 非零时必须在旧卸载器前 fail closed 并允许重试',
  );
  assert.match(
    upgradeTransactionMacro,
    /"\$InstallerPowerShellPath"[\s\S]*?-Action prepare-upgrade/,
    'prepare-upgrade 必须使用 installer 自有的 PowerShell 路径',
  );

  const commitCommands = nsisCodeLines(
    commitUpgradeTransactionMacro,
    '-Action commit-upgrade',
    'CommitInstallerUpgradeTransaction 必须调用 commit-upgrade',
  );
  assert.equal(commitCommands.length, 1, 'commit-upgrade 必须按 manifest 身份提交唯一事务');
  for (const commitCommand of commitCommands) {
    for (const argument of [
      '-TransactionRoot "$LegacyUpgradeRoot"',
      '-Target "$LegacyUpgradeTarget"',
      '-Scope "$LegacyUpgradeScope"',
    ]) {
      assert.ok(commitCommand.includes(argument), 'commit-upgrade 缺少参数: ' + argument);
    }
    assert.equal(commitCommand.includes('-HkcuSource'), false);
    assert.equal(commitCommand.includes('-HklmSource'), false);
    assert.equal(commitCommand.includes('--updated'), false);
  }
  assert.doesNotMatch(commitUpgradeTransactionMacro, /\$\{isUpdated\}/);
  assert.match(
    commitUpgradeTransactionMacro,
    /\$\{If\} \$R2 != 0[\s\S]*?MessageBox MB_OK\|MB_ICONSTOP\s*\\\r?\n\s*"[^"]+" \/SD IDOK[\s\S]*?SetErrorLevel 1[\s\S]*?Quit/,
    'commit-upgrade 非零时必须保留事务并 fail closed',
  );
  assert.match(
    commitUpgradeTransactionMacro,
    /"\$InstallerPowerShellPath"[\s\S]*?-Action commit-upgrade/,
    'commit-upgrade 必须使用 installer 自有的 PowerShell 路径',
  );
  assert.match(
    rollbackUpgradeTransactionMacro,
    /-Action rollback-upgrade[\s\S]*?-TransactionRoot "\$LegacyUpgradeRoot"[\s\S]*?-Target "\$LegacyUpgradeTarget"[\s\S]*?-Scope "\$LegacyUpgradeScope"/,
    'rollback-upgrade 必须只按 manifest 基础身份回滚',
  );
  assert.match(
    uninstallResultMacro,
    /IfErrors 0 [^\r\n]+[\s\S]*?!insertmacro RollbackInstallerUpgradeTransaction[\s\S]*?SetErrorLevel 2[\s\S]*?Quit/,
    '旧卸载器无法启动时必须回滚并立即终止安装',
  );
  assert.match(
    uninstallResultMacro,
    /\$\{If\} \$R0 != 0[\s\S]*?!insertmacro RollbackInstallerUpgradeTransaction[\s\S]*?SetErrorLevel 2[\s\S]*?Quit/,
    '旧卸载器非零退出时必须回滚并立即终止安装',
  );
  assert.doesNotMatch(
    uninstallResultMacro,
    /!insertmacro RollbackInstallerUpgradeTransaction[\s\S]*?\bReturn\b/,
    '旧卸载器失败回滚后不得 Return 到安装文件写入流程',
  );
  assert.match(
    installer,
    /!macro customUnInstallCheck\r?\n\s*!insertmacro HandleInstallerUninstallResult ShellContext[\s\S]*?!macro customUnInstallCheckCurrentUser\r?\n\s*!insertmacro HandleInstallerUninstallResult CurrentUser/,
    'SHELL_CONTEXT 和 HKCU 两条旧卸载链必须共用失败回滚语义',
  );

  assert.match(
    extractHelperMacro,
    /File "?\/oname=\$PLUGINSDIR\\autowsgr-installer-helper\.ps1"? "\$\{PROJECT_DIR\}\\build\\installer-helper\.ps1"/,
    '安装器必须把 helper 嵌入 $PLUGINSDIR',
  );
  assert.match(
    customInitMacro,
    /!insertmacro ExtractInstallerHelper/,
    'installer-only customInit 必须在 UAC inner 进程中提取 helper',
  );
  assert.match(
    installer,
    /!ifndef BUILD_UNINSTALLER\r?\n!macro customInit[\s\S]*?!insertmacro ExtractInstallerHelper[\s\S]*?!macro customPageAfterChangeDir[\s\S]*?!macroend\r?\n!endif/,
    'installer 初始化和事务页面必须被 BUILD_UNINSTALLER 排除',
  );
  assert.match(
    checkRunningMacro,
    /!ifdef BUILD_UNINSTALLER[\s\S]*?!insertmacro ExtractInstallerHelper[\s\S]*?!endif/,
    '卸载器必须在进程检查前提取 helper',
  );
  assert.match(
    checkRunningMacro,
    /RetryCloseApp:[\s\S]*?!insertmacro StopDirectoryProcesses "\$INSTDIR" RetryCloseApp/,
    '进程检查必须统一委托给精确路径 helper',
  );
  assert.doesNotMatch(
    checkRunningMacro,
    /FIND_PROCESS|taskkill\.exe|\/IM\b/,
    '不得继续使用目录前缀探测或全局映像名终止',
  );
  assert.match(
    stopProcessesMacro,
    /Push \$0[\s\S]*?Kernel32::GetCurrentProcessId\(\)i\.r0/,
    '必须取得当前 installer/uninstaller PID',
  );
  assert.match(
    stopProcessesMacro,
    /-File "\$PLUGINSDIR\\autowsgr-installer-helper\.ps1" -Action stop-processes -InstallDirectory "\$\{INSTALL_DIRECTORY\}" -ExcludedProcessId "\$0" -GracefulExecutableName "\$\{APP_EXECUTABLE_FILENAME\}" -GracefulTimeoutSeconds 20/,
    'helper 必须接收安装目录、排除 PID 和 20 秒精确 GUI 退出窗口',
  );
  assert.match(
    stopProcessesMacro,
    /Pop \$R2\s+Pop \$0\s+\$\{If\} \$R2 != 0[\s\S]*?IDRETRY \$\{RETRY_LABEL\}[\s\S]*?Quit/,
    '必须恢复 NSIS 寄存器，并在 helper 非零时失败关闭且允许重试',
  );
  assert.doesNotMatch(
    stopProcessesMacro,
    /-Command|\/IM\b/i,
    '不得退回名称式或内联脚本终止进程',
  );
  for (const macro of [upgradeTransactionMacro, commitUpgradeTransactionMacro]) {
    assert.doesNotMatch(macro, /-Command/);
    assert.doesNotMatch(macro, /SetEnvironmentVariable|GetEnvironmentVariable/);
  }
  for (const relativePath of legacyItems) {
    assert.match(
      helper,
      new RegExp(escapeRegExp("'" + relativePath + "'")),
      'helper 白名单缺失: ' + relativePath,
    );
  }
  assert.doesNotMatch(
    helper,
    /\bMove-Item\b[\s\S]*?Legacy source/,
    '保留流程不得移动旧安装目录中的源数据',
  );
  assert.match(helper, /Get-FileHash -Algorithm SHA256/);
  assert.match(helper, /\.autowsgr-upgrade-/);
  assert.match(helper, /FileAttributes\]::ReparsePoint/);
  assert.match(
    helper,
    /'preserve',[\s\S]*?'restore',[\s\S]*?'stop-processes',[\s\S]*?'prepare-upgrade',[\s\S]*?'commit-upgrade',[\s\S]*?'rollback-upgrade'/,
    'helper action 白名单必须包含进程、旧数据和事务动作',
  );
  assert.match(
    stopProcessFunction,
    /Get-CimInstance -ClassName Win32_Process -ErrorAction Stop/,
    '进程枚举失败必须作为 helper 失败传播',
  );
  assert.match(
    stopProcessFunction,
    /\$_.ProcessId -ne \$ExcludedId/,
    '进程选择前必须排除当前 installer/uninstaller PID',
  );
  assert.match(
    stopProcessFunction,
    /IsNullOrWhiteSpace\(\$_.ExecutablePath\)/,
    'ExecutablePath 不可读的进程不得按名称猜测',
  );
  assert.match(
    helper,
    /\$installRoot\.TrimEnd\(\$rootSeparators\)[\s\S]*?\$pathRoot\.TrimEnd\(\$rootSeparators\)[\s\S]*?Installation directory must not be a drive root/,
    'stop-processes 必须在枚举前拒绝磁盘根目录',
  );
  assert.match(
    stopProcessFunction,
    /\[IO\.Path\]::GetFullPath\([\s\S]*?ExecutablePath/,
    '候选进程路径必须 canonicalize',
  );
  assert.match(
    stopProcessFunction,
    /Test-IsSameOrDescendant \$executable \$InstallRoot/,
    '候选进程必须通过严格安装目录 containment 判断',
  );
  assert.doesNotMatch(
    stopProcessFunction,
    /\.(?:Name|ProcessName)\b|Get-Process\s+-Name|python(?:\.exe)?|adb(?:\.exe)?/i,
    'ExecutablePath 不可读时不得按进程名或特定程序名猜测终止',
  );
  assert.match(
    gracefulStopFunctions,
    /taskkill\.exe[\s\S]*?'\/PID ' \+ \[string\]\$Process\.ProcessId/,
    'GUI 正常退出请求必须只使用已经按路径选中的 PID',
  );
  assert.doesNotMatch(
    gracefulStopFunctions,
    /\/IM\b|\/F\b/,
    'GUI 正常退出请求不得按名称终止或直接强杀',
  );
  assert.match(
    gracefulStopFunctions,
    /Get-InstallDirectoryProcesses \$InstallRoot \$ExcludedId[\s\S]*?ExpectedExecutable[\s\S]*?Start-Sleep -Milliseconds 250/,
    '正常退出等待必须持续复查同一安装目录内的精确 GUI 路径',
  );
  assert.match(
    stopProcessImplementation,
    /Get-ContainedPath \$installRoot \$GracefulName[\s\S]*?\[string\]::Equals\([\s\S]*?\$gracefulExecutable[\s\S]*?Request-GracefulProcessExit/,
    '只有精确 $InstallDirectory\\GUI.exe 才能进入正常退出阶段',
  );
  assert.match(
    stopProcessImplementation,
    /Get-CanonicalRoot \([\s\S]*?'Installation directory' \$false[\s\S]*?Installation directory must not be a drive root[\s\S]*?if \(-not \[IO\.Directory\]::Exists\(\$installRoot\)\) \{\s*return/,
    'fresh install 的不存在目录必须安全 no-op，且仍拒绝磁盘根目录',
  );
  assert.match(
    stopProcessImplementation,
    /Stop-Process -Id \$process\.ProcessId -Force -ErrorAction Stop[\s\S]*?for \(\$attempt = 0; \$attempt -lt 8; \$attempt\+\+\)[\s\S]*?\$emptyChecks -ge 2[\s\S]*?Processes are still running inside the installation directory/,
    '停止失败或最终复查仍有残留时必须返回非零',
  );

  const transactionFixture = fixturePath(resources, '升级事务 空格路径');
  const schemaOneRoot = path.join(transactionFixture, 'schema 1 只读拒绝');
  const schemaOneTransactionId = '11111111111111111111111111111111';
  const schemaOneDirectory = path.join(
    schemaOneRoot,
    'transactions',
    schemaOneTransactionId,
  );
  const schemaOneSource = fixturePath(transactionFixture, 'schema 1 旧源');
  const schemaOneTarget = path.join(transactionFixture, 'schema 1 目标');
  writeFixtureFiles(schemaOneSource, new Map([
    ['usersettings.yaml', 'schema one source\n'],
  ]));
  writeFixtureFiles(schemaOneDirectory, new Map([
    ['transaction.json', JSON.stringify({
      schemaVersion: 1,
      transactionId: schemaOneTransactionId,
      state: 'preserved',
      target: path.resolve(schemaOneTarget),
      scope: 'current-user',
      sources: [],
    })],
    ['sources/hkcu/.preserved', ''],
  ]));
  for (const [action, parameters] of [
    [
      'prepare-upgrade',
      prepareUpgradeParameters(
        schemaOneRoot,
        schemaOneTarget,
        'current-user',
        schemaOneSource,
        '',
      ),
    ],
    [
      'commit-upgrade',
      commitUpgradeParameters(schemaOneRoot, schemaOneTarget, 'current-user'),
    ],
    [
      'rollback-upgrade',
      rollbackUpgradeParameters(schemaOneRoot, schemaOneTarget, 'current-user'),
    ],
  ]) {
    const rejection = assertFailureLeavesTreesUnchanged(
      action,
      parameters,
      [schemaOneRoot, schemaOneSource, schemaOneTarget],
      'schema 1 preserved 事务必须只读拒绝 ' + action,
    );
    assert.match(
      helperDiagnostics(rejection),
      /Unsupported upgrade transaction schema/,
      'schema 1 必须返回明确的不支持契约错误',
    );
  }

  for (const [name, scope, hives] of [
    ['空 hive', 'current-user', []],
    ['current-user 绑定 HKLM', 'current-user', ['HKLM']],
  ]) {
    const malformedRoot = path.join(transactionFixture, '非法 manifest ' + name);
    const malformedId = name === '空 hive'
      ? '22222222222222222222222222222222'
      : '33333333333333333333333333333333';
    const malformedDirectory = path.join(
      malformedRoot,
      'transactions',
      malformedId,
    );
    const malformedSource = fixturePath(
      transactionFixture,
      '非法 manifest source ' + name,
    );
    const malformedTarget = path.join(
      transactionFixture,
      '非法 manifest target ' + name,
    );
    writeFixtureFiles(malformedSource, new Map([
      ['usersettings.yaml', name + '\n'],
    ]));
    writeFixtureFiles(malformedDirectory, new Map([
      ['transaction.json', JSON.stringify({
        schemaVersion: 2,
        transactionId: malformedId,
        state: 'preserved',
        target: path.resolve(malformedTarget),
        scope,
        sources: [{
          hives,
          path: path.resolve(malformedSource),
          backupRelative: 'sources\\invalid',
          entryCount: 0,
          digest: '0'.repeat(64),
          runtimeArtifact: null,
        }],
      })],
    ]));
    assertFailureLeavesTreesUnchanged(
      'commit-upgrade',
      commitUpgradeParameters(malformedRoot, malformedTarget, scope),
      [malformedRoot, malformedSource, malformedTarget],
      name + ' 必须在 manifest 校验阶段 fail closed',
    );
  }
  const dualTransactionRoot = path.join(transactionFixture, '双源 事务根');
  const dualTarget = path.join(transactionFixture, '通过 D 参数选择的新 目标');
  const hkcuSource = fixturePath(transactionFixture, 'HKCU 旧 安装');
  const hklmSource = fixturePath(transactionFixture, 'HKLM 旧 安装');
  const hkcuFiles = new Map([
    ['usersettings.yaml', '共享设置: 一致\n'],
    ['plans/current-user.yaml', 'chapter: 1\nmap: 1\n'],
  ]);
  const hklmFiles = new Map([
    ['usersettings.yaml', '共享设置: 一致\n'],
    ['templates/all-users.json', '{"name":"机器模板"}\n'],
  ]);
  const hkcuDirectories = ['plans/current-user-empty'];
  const hklmDirectories = ['templates/all-users-empty'];
  writeFixtureFiles(hkcuSource, hkcuFiles);
  writeFixtureFiles(hklmSource, hklmFiles);
  writeFixtureDirectories(hkcuSource, hkcuDirectories);
  writeFixtureDirectories(hklmSource, hklmDirectories);
  const runtimeFiles = new Map([
    ['autowsgr/__init__.py', '__version__ = "legacy"\n'],
    ['dependency/data.bin', 'legacy dependency\n'],
  ]);
  const runtimeDirectories = ['empty-package'];
  const hkcuRuntime = path.join(hkcuSource, 'python', 'site-packages');
  writeFixtureFiles(hkcuRuntime, runtimeFiles);
  writeFixtureDirectories(hkcuRuntime, runtimeDirectories);
  const hkcuBeforePrepare = snapshotTree(hkcuSource);
  const hklmBeforePrepare = snapshotTree(hklmSource);

  assertHelperSucceeded(
    runPrepareUpgrade(
      dualTransactionRoot,
      dualTarget,
      'all-users',
      hkcuSource,
      hklmSource,
    ),
    '无 --updated 的 /D= 双源覆盖 prepare-upgrade 失败',
  );
  const dualTransaction = singleTransaction(
    dualTransactionRoot,
    '首次 prepare 必须只建立一个事务',
  );
  assert.equal(dualTransaction.manifest.state, 'preserved');
  assert.equal(dualTransaction.manifest.target, path.resolve(dualTarget));
  assert.equal(dualTransaction.manifest.scope, 'all-users');
  assert.deepEqual(
    snapshotTreeWithoutRuntime(hkcuSource),
    hkcuBeforePrepare.filter((entry) => (
      entry[1] !== 'python/site-packages' &&
      !entry[1].startsWith('python/site-packages/')
    )),
  );
  assert.deepEqual(snapshotTree(hklmSource), hklmBeforePrepare);
  const hkcuManifestSource = sourceForHive(dualTransaction.manifest, 'HKCU');
  const hklmManifestSource = sourceForHive(dualTransaction.manifest, 'HKLM');
  assert.notEqual(
    hkcuManifestSource.backupRelative,
    hklmManifestSource.backupRelative,
    'HKCU/HKLM 必须使用独立备份目录',
  );
  assert.equal(hkcuManifestSource.path, path.resolve(hkcuSource));
  assert.equal(hklmManifestSource.path, path.resolve(hklmSource));
  assert.ok(hkcuManifestSource.entryCount > 0);
  assert.ok(hklmManifestSource.entryCount > 0);
  assert.ok(hkcuManifestSource.runtimeArtifact);
  assert.equal(hklmManifestSource.runtimeArtifact, null);
  assert.equal(fs.existsSync(hkcuRuntime), false, 'prepare 必须移出旧 runtime');
  assertFixtureFiles(
    hkcuManifestSource.runtimeArtifact.stagingPath,
    runtimeFiles,
  );
  assertFixtureDirectories(
    hkcuManifestSource.runtimeArtifact.stagingPath,
    runtimeDirectories,
  );
  assertTransactionBackup(
    dualTransaction,
    hkcuManifestSource,
    hkcuFiles,
    hkcuDirectories,
  );
  assertTransactionBackup(
    dualTransaction,
    hklmManifestSource,
    hklmFiles,
    hklmDirectories,
  );

  const transactionBeforeRetry = snapshotTree(dualTransactionRoot);
  assertHelperSucceeded(
    runPrepareUpgrade(
      dualTransactionRoot,
      dualTarget,
      'all-users',
      hkcuSource,
      hklmSource,
    ),
    '相同身份 prepare-upgrade 重试失败',
  );
  assert.deepEqual(
    snapshotTree(dualTransactionRoot),
    transactionBeforeRetry,
    '相同身份 prepare 重试不得改写 manifest 或备份',
  );

  const differentHkcuSource = fixturePath(
    transactionFixture,
    '不同身份 HKCU 旧 安装',
  );
  writeFixtureFiles(differentHkcuSource, hkcuFiles);
  writeFixtureDirectories(differentHkcuSource, hkcuDirectories);
  writeFixtureFiles(
    path.join(differentHkcuSource, 'python', 'site-packages'),
    runtimeFiles,
  );
  writeFixtureDirectories(
    path.join(differentHkcuSource, 'python', 'site-packages'),
    runtimeDirectories,
  );
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      dualTransactionRoot,
      dualTarget,
      'all-users',
      differentHkcuSource,
      hklmSource,
    ),
    [
      dualTransactionRoot,
      hkcuSource,
      hklmSource,
      differentHkcuSource,
      dualTarget,
    ],
    'preserved 事务重入必须拒绝不同 live source 身份',
  );

  const tamperedStagingTransaction = singleTransaction(
    dualTransactionRoot,
    '篡改 staging 前事务数不得改变',
  );
  const tamperedRuntimeSource = sourceForHive(
    tamperedStagingTransaction.manifest,
    'HKCU',
  );
  const originalStagingPath = tamperedRuntimeSource.runtimeArtifact.stagingPath;
  const unrelatedStagingPath = fixturePath(
    transactionFixture,
    '同卷但不属于事务的 runtime',
  );
  writeFixtureFiles(unrelatedStagingPath, runtimeFiles);
  writeFixtureDirectories(unrelatedStagingPath, runtimeDirectories);
  tamperedRuntimeSource.runtimeArtifact.stagingPath = unrelatedStagingPath;
  fs.writeFileSync(
    path.join(tamperedStagingTransaction.directory, 'transaction.json'),
    JSON.stringify(tamperedStagingTransaction.manifest),
    'utf8',
  );
  assertFailureLeavesTreesUnchanged(
    'commit-upgrade',
    commitUpgradeParameters(dualTransactionRoot, dualTarget, 'all-users'),
    [dualTransactionRoot, hkcuSource, hklmSource, unrelatedStagingPath, dualTarget],
    'manifest stagingPath 不得指向同卷任意目录',
  );
  tamperedRuntimeSource.runtimeArtifact.stagingPath = originalStagingPath;
  fs.writeFileSync(
    path.join(tamperedStagingTransaction.directory, 'transaction.json'),
    JSON.stringify(tamperedStagingTransaction.manifest),
    'utf8',
  );

  assertHelperSucceeded(
    runRollbackUpgrade(dualTransactionRoot, dualTarget, 'all-users'),
    '旧卸载器失败后的 runtime rollback 失败',
  );
  const rolledBackDualTransaction = singleTransaction(
    dualTransactionRoot,
    'rollback 后事务数不得改变',
  );
  assert.equal(rolledBackDualTransaction.manifest.state, 'prepared');
  assertFixtureFiles(hkcuRuntime, runtimeFiles);
  assertFixtureDirectories(hkcuRuntime, runtimeDirectories);
  assert.equal(
    fs.existsSync(hkcuManifestSource.runtimeArtifact.stagingPath),
    false,
    'rollback 后 staging 必须消失',
  );
  assertHelperSucceeded(
    runPrepareUpgrade(
      dualTransactionRoot,
      dualTarget,
      'all-users',
      hkcuSource,
      hklmSource,
    ),
    'rollback 后相同事务必须可以重新 prepare',
  );

  const sharedSourceRoot = path.join(transactionFixture, '同路径双 hive 事务根');
  const sharedSource = fixturePath(transactionFixture, '同路径双 hive 旧安装');
  const sharedTarget = path.join(transactionFixture, '同路径双 hive 目标');
  writeFixtureFiles(sharedSource, hkcuFiles);
  writeFixtureFiles(
    path.join(sharedSource, 'python', 'site-packages'),
    runtimeFiles,
  );
  assertHelperSucceeded(
    runPrepareUpgrade(
      sharedSourceRoot,
      sharedTarget,
      'all-users',
      sharedSource,
      sharedSource,
    ),
    '同路径 HKCU/HKLM 首次 prepare 失败',
  );
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      sharedSourceRoot,
      sharedTarget,
      'all-users',
      sharedSource,
      '',
    ),
    [sharedSourceRoot, sharedSource, sharedTarget],
    '同路径 HKCU/HKLM 重入缺少一个 hive 必须 fail closed',
  );

  const mismatchedTarget = path.join(transactionFixture, '不同 目标');
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      dualTransactionRoot,
      mismatchedTarget,
      'all-users',
      hkcuSource,
      hklmSource,
    ),
    [dualTransactionRoot, hkcuSource, hklmSource, mismatchedTarget],
    '未完成事务 target 身份不匹配必须 fail closed',
  );
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      dualTransactionRoot,
      dualTarget,
      'current-user',
      hkcuSource,
      '',
    ),
    [dualTransactionRoot, hkcuSource, hklmSource, dualTarget],
    '未完成事务 scope/source 身份不匹配必须 fail closed',
  );
  assertFailureLeavesTreesUnchanged(
    'commit-upgrade',
    commitUpgradeParameters(
      dualTransactionRoot,
      mismatchedTarget,
      'all-users',
    ),
    [dualTransactionRoot, hkcuSource, hklmSource, mismatchedTarget],
    'commit-upgrade 身份不匹配必须 fail closed',
  );
  assertFailureLeavesTreesUnchanged(
    'commit-upgrade',
    {
      ...commitUpgradeParameters(
        dualTransactionRoot,
        dualTarget,
        'all-users',
      ),
      HkcuSource: hkcuSource,
    },
    [dualTransactionRoot, hkcuSource, hklmSource, dualTarget],
    'commit-upgrade 必须拒绝重新传入 live source 身份',
  );

  assertHelperSucceeded(
    runCommitUpgrade(
      dualTransactionRoot,
      dualTarget,
      'all-users',
    ),
    '双源 commit-upgrade 失败',
  );
  const completedDualTransaction = singleTransaction(
    dualTransactionRoot,
    'commit 后事务数不得改变',
  );
  assert.equal(completedDualTransaction.manifest.state, 'complete');
  assertFixtureFiles(dualTarget, new Map([...hkcuFiles, ...hklmFiles]));
  assertFixtureDirectories(
    dualTarget,
    [...hkcuDirectories, ...hklmDirectories],
  );
  assertNoNestedPlans(dualTarget);
  assertFixtureFiles(
    path.join(dualTarget, 'python', 'site-packages'),
    runtimeFiles,
  );
  assertFixtureDirectories(
    path.join(dualTarget, 'python', 'site-packages'),
    runtimeDirectories,
  );
  const completedDualBeforeRetry = snapshotTree(dualTransactionRoot);
  const dualTargetBeforeRetry = snapshotTree(dualTarget);
  assertHelperSucceeded(
    runCommitUpgrade(
      dualTransactionRoot,
      dualTarget,
      'all-users',
    ),
    'complete 事务重复 commit 必须幂等成功',
  );
  assert.deepEqual(snapshotTree(dualTransactionRoot), completedDualBeforeRetry);
  assert.deepEqual(snapshotTree(dualTarget), dualTargetBeforeRetry);
  assertFailureLeavesTreesUnchanged(
    'commit-upgrade',
    commitUpgradeParameters(
      dualTransactionRoot,
      path.join(transactionFixture, 'complete 不匹配目标'),
      'all-users',
    ),
    [dualTransactionRoot, dualTarget],
    'complete 事务重复 commit 必须拒绝不匹配 target',
  );
  assertFailureLeavesTreesUnchanged(
    'commit-upgrade',
    commitUpgradeParameters(dualTransactionRoot, dualTarget, 'current-user'),
    [dualTransactionRoot, dualTarget],
    'complete 事务重复 commit 必须拒绝不匹配 scope',
  );

  const freshTarget = path.join(transactionFixture, 'fresh 新 目标');
  assertHelperSucceeded(
    runPrepareUpgrade(
      dualTransactionRoot,
      freshTarget,
      'current-user',
      '',
      '',
    ),
    'fresh prepare-upgrade 不得吸收历史 complete 事务',
  );
  const afterFreshPrepare = readTransactionManifests(dualTransactionRoot);
  assert.equal(afterFreshPrepare.length, 2);
  const freshTransaction = afterFreshPrepare.find(
    ({ manifest }) => manifest.target === path.resolve(freshTarget),
  );
  assert.ok(freshTransaction, 'fresh install 必须建立独立空源事务');
  assertManifestContract(freshTransaction.manifest, freshTransaction.directory);
  assert.equal(freshTransaction.manifest.state, 'preserved');
  assert.deepEqual(freshTransaction.manifest.sources, []);
  assert.deepEqual(
    afterFreshPrepare.find(
      ({ manifest }) => manifest.transactionId === completedDualTransaction.manifest.transactionId,
    ).manifest,
    completedDualTransaction.manifest,
    'fresh install 不得修改或吸收历史 complete 事务',
  );
  assertHelperSucceeded(
    runCommitUpgrade(
      dualTransactionRoot,
      freshTarget,
      'current-user',
    ),
    'fresh 空源事务 commit 失败',
  );
  const completedFresh = readTransactionManifests(dualTransactionRoot).find(
    ({ manifest }) => manifest.transactionId === freshTransaction.manifest.transactionId,
  );
  assert.equal(completedFresh.manifest.state, 'complete');
  assert.equal(fs.existsSync(freshTarget), false, '空源 commit 不得创建目标目录');

  const conflictRoot = path.join(transactionFixture, '双源 内容冲突 事务根');
  const conflictHkcu = fixturePath(transactionFixture, '内容冲突 HKCU');
  const conflictHklm = fixturePath(transactionFixture, '内容冲突 HKLM');
  const conflictTarget = path.join(transactionFixture, '内容冲突 目标');
  writeFixtureFiles(conflictHkcu, new Map([
    ['usersettings.yaml', 'HKCU value\n'],
  ]));
  writeFixtureFiles(conflictHklm, new Map([
    ['usersettings.yaml', 'HKLM value\n'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      conflictRoot,
      conflictTarget,
      'all-users',
      conflictHkcu,
      conflictHklm,
    ),
    [conflictRoot, conflictHkcu, conflictHklm, conflictTarget],
    '双源相同相对路径内容冲突必须零写入 fail closed',
  );

  const runtimeConflictRoot = path.join(transactionFixture, '双源 runtime 冲突 事务根');
  const runtimeConflictHkcu = fixturePath(transactionFixture, 'runtime 冲突 HKCU');
  const runtimeConflictHklm = fixturePath(transactionFixture, 'runtime 冲突 HKLM');
  const runtimeConflictTarget = path.join(transactionFixture, 'runtime 冲突 目标');
  writeFixtureFiles(
    path.join(runtimeConflictHkcu, 'python', 'site-packages'),
    new Map([['a.py', 'a\n']]),
  );
  writeFixtureFiles(
    path.join(runtimeConflictHklm, 'python', 'site-packages'),
    new Map([['b.py', 'b\n']]),
  );
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      runtimeConflictRoot,
      runtimeConflictTarget,
      'all-users',
      runtimeConflictHkcu,
      runtimeConflictHklm,
    ),
    [
      runtimeConflictRoot,
      runtimeConflictHkcu,
      runtimeConflictHklm,
      runtimeConflictTarget,
    ],
    'HKCU/HKLM 不同源都含 runtime 时必须零写入 fail closed',
  );

  const typeConflictRoot = path.join(transactionFixture, '双源 类型冲突 事务根');
  const typeConflictHkcu = fixturePath(transactionFixture, '类型冲突 HKCU');
  const typeConflictHklm = fixturePath(transactionFixture, '类型冲突 HKLM');
  const typeConflictTarget = path.join(transactionFixture, '类型冲突 目标');
  writeFixtureFiles(typeConflictHkcu, new Map([
    ['usersettings.yaml', 'file\n'],
  ]));
  writeFixtureDirectories(typeConflictHklm, ['usersettings.yaml']);
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      typeConflictRoot,
      typeConflictTarget,
      'all-users',
      typeConflictHkcu,
      typeConflictHklm,
    ),
    [typeConflictRoot, typeConflictHkcu, typeConflictHklm, typeConflictTarget],
    '双源相同相对路径类型冲突必须零写入 fail closed',
  );

  const incompleteFreshRoot = path.join(transactionFixture, 'fresh 未完成历史 事务根');
  const incompleteSource = fixturePath(transactionFixture, '未完成历史 HKCU');
  const incompleteTarget = path.join(transactionFixture, '未完成历史 目标');
  writeFixtureFiles(incompleteSource, new Map([
    ['task_groups.json', '{"groups":[]}\n'],
  ]));
  assertHelperSucceeded(
    runPrepareUpgrade(
      incompleteFreshRoot,
      incompleteTarget,
      'current-user',
      incompleteSource,
      '',
    ),
    '未完成历史 fixture prepare 失败',
  );
  const incompleteBeforeRetry = snapshotTree(incompleteFreshRoot);
  assertHelperSucceeded(
    runPrepareUpgrade(
      incompleteFreshRoot,
      incompleteTarget,
      'current-user',
      incompleteSource,
      '',
    ),
    '单 HKCU 同身份 prepare-upgrade 重试失败',
  );
  assert.deepEqual(
    snapshotTree(incompleteFreshRoot),
    incompleteBeforeRetry,
    '单 HKCU 同身份 prepare 重试不得改写 manifest 或备份',
  );
  const incompleteBeforeFresh = snapshotTree(incompleteFreshRoot);
  const unrelatedFreshTarget = path.join(transactionFixture, '不匹配 fresh 目标');
  assertFailureLeavesTreesUnchanged(
    'prepare-upgrade',
    prepareUpgradeParameters(
      incompleteFreshRoot,
      unrelatedFreshTarget,
      'current-user',
      '',
      '',
    ),
    [
      incompleteFreshRoot,
      incompleteSource,
      incompleteTarget,
      unrelatedFreshTarget,
    ],
    'fresh sources 为空时遇到不匹配未完成历史必须 fail closed',
  );
  assert.deepEqual(snapshotTree(incompleteFreshRoot), incompleteBeforeFresh);

  const processFixture = fixturePath(resources, '进程关闭 空格路径');
  const missingInstallDirectory = path.join(
    processFixture,
    '尚未创建的新安装目录',
  );
  assert.equal(
    fs.existsSync(missingInstallDirectory),
    false,
    'fresh install fixture 必须从不存在的安装目录开始',
  );
  assertHelperSucceeded(
    runStopProcesses(missingInstallDirectory, process.pid),
    '全新安装选择尚不存在的目录时必须成功 no-op',
  );
  assert.equal(
    fs.existsSync(missingInstallDirectory),
    false,
    '进程检查不得创建 fresh install 目标目录',
  );
  const installDirectory = fixturePath(processFixture, 'foo');
  const siblingDirectory = fixturePath(processFixture, 'foobar');
  const outsideDirectory = fixturePath(processFixture, '目录外 同名进程');
  const insidePython = copyAndSpawnPing(path.join(
    installDirectory,
    'python',
    'python.exe',
  ));
  const insideAdb = copyAndSpawnPing(path.join(
    installDirectory,
    'adb',
    'adb.exe',
  ));
  const insideGui = copyAndSpawnPing(path.join(
    installDirectory,
    'AutoWSGR-GUI.exe',
  ));
  const excludedInstaller = copyAndSpawnPing(path.join(
    installDirectory,
    'installer-fixture.exe',
  ));
  const siblingPython = copyAndSpawnPing(path.join(
    siblingDirectory,
    'python',
    'python.exe',
  ));
  const siblingGui = copyAndSpawnPing(path.join(
    siblingDirectory,
    'AutoWSGR-GUI.exe',
  ));
  const outsideAdb = copyAndSpawnPing(path.join(
    outsideDirectory,
    'adb.exe',
  ));

  const stopContained = runStopProcesses(
    installDirectory,
    excludedInstaller.pid,
    'AutoWSGR-GUI.exe',
    2,
  );
  assertHelperSucceeded(
    stopContained,
    '安装目录内进程的精确关闭失败',
  );
  waitForProcessState(
    insidePython.pid,
    false,
    '安装目录内 python.exe 必须被停止',
  );
  waitForProcessState(
    insideAdb.pid,
    false,
    '安装目录内 adb.exe 必须被停止',
  );
  waitForProcessState(
    insideGui.pid,
    false,
    '安装目录根部的精确 GUI 可执行文件必须被请求退出或强制停止',
  );
  assert.equal(
    isProcessRunning(excludedInstaller.pid),
    true,
    'ExcludedProcessId 对应 installer/uninstaller 必须保留',
  );
  assert.equal(
    isProcessRunning(siblingPython.pid),
    true,
    'foo 的 helper 不得停止 sibling-prefix foobar 中的 python.exe',
  );
  assert.equal(
    isProcessRunning(siblingGui.pid),
    true,
    'foo 的 helper 不得停止 sibling-prefix foobar 中的同名 GUI',
  );
  assert.equal(
    isProcessRunning(outsideAdb.pid),
    true,
    '不得停止安装目录外的同名 adb.exe',
  );
  assertHelperSucceeded(
    runStopProcesses(installDirectory, excludedInstaller.pid),
    '无剩余候选时重复 stop-processes 必须幂等成功',
  );

  const reparseInstallTarget = fixturePath(
    processFixture,
    '真实安装目录',
  );
  const reparseInstallRoot = path.join(processFixture, '链接安装目录');
  if (junctionsAvailable) {
    createDirectoryJunction(reparseInstallTarget, reparseInstallRoot);
    assertHelperFailed(
      runStopProcesses(reparseInstallRoot, process.pid),
      '安装根为 reparse point 时必须 fail closed',
    );

    const realInstallAncestor = fixturePath(
      processFixture,
      '真实安装祖先',
    );
    const nestedRealInstall = fixturePath(realInstallAncestor, 'app');
    const linkedInstallAncestor = path.join(processFixture, '链接安装祖先');
    createDirectoryJunction(realInstallAncestor, linkedInstallAncestor);
    assertHelperFailed(
      runStopProcesses(path.join(linkedInstallAncestor, 'app'), process.pid),
      '安装根任意祖先为 reparse point 时必须 fail closed',
    );
    assert.equal(
      fs.statSync(nestedRealInstall).isDirectory(),
      true,
      'reparse fail closed 不得修改真实安装目录',
    );
  }

  const residualDirectory = fixturePath(processFixture, '残留复查');
  const residualExecutable = copyPingFixture(path.join(
    residualDirectory,
    'python',
    'python.exe',
  ));
  const watchdogReady = path.join(processFixture, 'watchdog.ready');
  const watchdogStop = path.join(processFixture, 'watchdog.stop');
  fixtureSentinelPaths.add(watchdogReady);
  fixtureSentinelPaths.add(watchdogStop);
  const watchdogExecutableVariable = 'AUTOWSGR_WATCHDOG_EXECUTABLE';
  const watchdogReadyVariable = 'AUTOWSGR_WATCHDOG_READY';
  const watchdogStopVariable = 'AUTOWSGR_WATCHDOG_STOP';
  const watchdogScript = [
    '$executable = [Environment]::GetEnvironmentVariable(',
    "  '" + watchdogExecutableVariable + "', 'Process'",
    ')',
    '$ready = [Environment]::GetEnvironmentVariable(',
    "  '" + watchdogReadyVariable + "', 'Process'",
    ')',
    '$stop = [Environment]::GetEnvironmentVariable(',
    "  '" + watchdogStopVariable + "', 'Process'",
    ')',
    'Set-Content -LiteralPath $ready -Value ready -NoNewline',
    'while (-not (Test-Path -LiteralPath $stop)) {',
    '  $active = @(',
    '    Get-CimInstance -ClassName Win32_Process | Where-Object {',
    '      $_.ExecutablePath -and',
    '      [string]::Equals(',
    '        [IO.Path]::GetFullPath($_.ExecutablePath),',
    '        [IO.Path]::GetFullPath($executable),',
    '        [StringComparison]::OrdinalIgnoreCase',
    '      )',
    '    }',
    '  )',
    '  if ($active.Count -eq 0) {',
    "    Start-Process -FilePath $executable -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden",
    '  }',
    '}',
  ].join('\n');
  const watchdog = spawn(
    windowsPowerShellExecutable(),
    ['-NoProfile', '-NonInteractive', '-Command', watchdogScript],
    {
      env: {
        ...process.env,
        [watchdogExecutableVariable]: residualExecutable,
        [watchdogReadyVariable]: watchdogReady,
        [watchdogStopVariable]: watchdogStop,
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  assert.equal(typeof watchdog.pid, 'number', '无法启动受控残留 watchdog');
  fixtureProcessIds.add(watchdog.pid);
  waitForFile(watchdogReady, '受控残留 watchdog 未就绪');
  waitForExecutableProcessCount(
    residualExecutable,
    1,
    'watchdog 未启动安装目录内候选进程',
  );
  const residualStop = runStopProcesses(residualDirectory, process.pid);
  assertHelperFailed(
    residualStop,
    '最终复查仍有安装目录进程时必须返回非零',
  );
  assert.match(
    helperDiagnostics(residualStop),
    /still running|Cannot stop|process/i,
    '停止不完整的失败必须提供进程上下文',
  );
  fs.writeFileSync(watchdogStop, 'stop', 'utf8');
  waitForProcessState(watchdog.pid, false, '受控残留 watchdog 未退出');
  for (const processId of processIdsForExecutable(residualExecutable)) {
    terminateFixtureProcess(processId);
  }

  const installerFixture = fixturePath(resources, '安装器 空格路径');
  const legacySource = fixturePath(installerFixture, '旧 安装目录');
  const legacyBackup = fixturePath(installerFixture, '升级 备份');
  const restoredTarget = fixturePath(installerFixture, '新 安装目录');
  const legacyFiles = new Map([
    ['usersettings.yaml', '设置: 中文路径\n'],
    ['gui_settings.json', '{"window":"旧 设置"}\n'],
    ['task_groups.json', '{"groups":["旧 队列"]}\n'],
    ['plans/legacy-plan.yaml', 'chapter: 1\nmap: 1\n'],
    ['plans/中文 子目录/second-plan.yaml', 'chapter: 3\nmap: 2\n'],
    ['templates/legacy-template.json', '{"name":"旧 模板"}\n'],
    ['resource/user_battle_plans/legacy-battle.yaml', 'chapter: 2\nmap: 1\n'],
    ['resource/user_daily_plans/legacy-daily.yaml', 'task_type: campaign\n'],
    ['resource/user_team_plans/legacy-team.yaml', 'name: 旧 编队\nships: []\n'],
  ]);
  const legacyDirectories = [
    'plans/空 计划目录',
    'templates/空 模板目录',
    'resource/user_battle_plans/空 战斗目录',
    'resource/user_daily_plans/空 日常目录',
    'resource/user_team_plans/空 编队目录',
  ];
  writeFixtureFiles(legacySource, legacyFiles);
  writeFixtureDirectories(legacySource, legacyDirectories);
  writeFixtureFiles(legacySource, new Map([
    ['logs/未知根项.log', 'source unknown\n'],
  ]));
  writeFixtureFiles(legacyBackup, new Map([
    ['plans/legacy-plan.yaml', legacyFiles.get('plans/legacy-plan.yaml')],
    ['unknown-root.keep', 'backup unknown\n'],
    ['unknown-root/' + staleTemporaryName, 'must remain\n'],
    ['plans/' + staleTemporaryName, 'stale partial copy\n'],
  ]));

  const sourceBeforePreserve = snapshotTree(legacySource);
  const preserve = runInstallerHelper('preserve', {
    Source: legacySource,
    Backup: legacyBackup,
  });
  assertHelperSucceeded(
    preserve,
    '含空格/中文路径、8 类数据和空目录的保留失败',
  );
  assert.deepEqual(
    snapshotTree(legacySource),
    sourceBeforePreserve,
    '保留过程不得删除或修改源数据',
  );
  assertPreservedMarker(legacyBackup);
  assertFixtureFiles(legacyBackup, legacyFiles);
  assertFixtureDirectories(legacyBackup, legacyDirectories);
  assert.equal(
    fs.existsSync(path.join(legacyBackup, 'plans', staleTemporaryName)),
    false,
    'preserve 重试必须清理白名单内的 helper 临时文件',
  );
  assert.equal(
    fs.readFileSync(
      path.join(legacyBackup, 'unknown-root', staleTemporaryName),
      'utf8',
    ),
    'must remain\n',
    'helper 不得清理未知根项中的文件',
  );
  assert.equal(
    fs.existsSync(path.join(legacyBackup, 'logs', '未知根项.log')),
    false,
    '源目录未知根项不得进入备份',
  );
  assertNoNestedPlans(legacyBackup);

  fs.mkdirSync(path.join(restoredTarget, 'plans'), { recursive: true });
  writeFixtureFiles(restoredTarget, new Map([
    ['templates/' + staleTemporaryName, 'stale restore copy\n'],
    ['unknown-target.keep', 'target unknown\n'],
  ]));
  const restore = runInstallerHelper('restore', {
    Backup: legacyBackup,
    Target: restoredTarget,
  });
  assertHelperSucceeded(
    restore,
    '含空格/中文路径、8 类数据和空目录的恢复失败',
  );
  assertFixtureFiles(restoredTarget, legacyFiles);
  assertFixtureDirectories(restoredTarget, legacyDirectories);
  assert.equal(
    fs.existsSync(path.join(restoredTarget, 'templates', staleTemporaryName)),
    false,
    'restore 重试必须清理目标白名单内的 helper 临时文件',
  );
  assert.equal(
    fs.readFileSync(path.join(restoredTarget, 'unknown-target.keep'), 'utf8'),
    'target unknown\n',
    '恢复不得修改未知目标根项',
  );
  assert.equal(
    fs.existsSync(path.join(restoredTarget, 'unknown-root.keep')),
    false,
    '备份中的未知根项不得恢复到目标',
  );
  assertNoNestedPlans(restoredTarget);

  const markerPath = path.join(legacyBackup, '.preserved');
  const fixedMarkerTime = new Date('2020-01-02T03:04:05.000Z');
  fs.utimesSync(markerPath, fixedMarkerTime, fixedMarkerTime);
  const markerMtime = fs.statSync(markerPath).mtimeMs;
  const repeatedPreserve = runInstallerHelper('preserve', {
    Source: legacySource,
    Backup: legacyBackup,
  });
  assertHelperSucceeded(repeatedPreserve, '重复 preserve 相同快照失败');
  assertMarkerUnchanged(markerPath, markerMtime);
  const repeatedRestore = runInstallerHelper('restore', {
    Backup: legacyBackup,
    Target: restoredTarget,
  });
  assertHelperSucceeded(repeatedRestore, '重复 restore 相同快照失败');
  assertFixtureFiles(restoredTarget, legacyFiles);
  assertNoNestedPlans(restoredTarget);

  const growthSource = fixturePath(installerFixture, '后续升级 部分源');
  const growthFiles = new Map([
    ['usersettings.yaml', legacyFiles.get('usersettings.yaml')],
    ['plans/新增 计划.yaml', 'chapter: 9\nmap: 9\n'],
  ]);
  const growthDirectories = ['templates/后续新增空目录'];
  writeFixtureFiles(growthSource, growthFiles);
  writeFixtureDirectories(growthSource, growthDirectories);
  const growthSourceBefore = snapshotTree(growthSource);
  const growCompletedSnapshot = runInstallerHelper('preserve', {
    Source: growthSource,
    Backup: legacyBackup,
  });
  assertHelperSucceeded(
    growCompletedSnapshot,
    '已完成快照必须允许补充新项目并保留旧项目',
  );
  assert.deepEqual(
    snapshotTree(growthSource),
    growthSourceBefore,
    '增长完成快照时不得修改部分恢复源',
  );
  assertMarkerUnchanged(markerPath, markerMtime);
  const expandedFiles = new Map([...legacyFiles, ...growthFiles]);
  const expandedDirectories = [...legacyDirectories, ...growthDirectories];
  assertFixtureFiles(legacyBackup, expandedFiles);
  assertFixtureDirectories(legacyBackup, expandedDirectories);
  assert.equal(
    fs.readFileSync(path.join(legacyBackup, 'unknown-root.keep'), 'utf8'),
    'backup unknown\n',
    '快照增长不得删除未知根项',
  );
  assertNoNestedPlans(legacyBackup);

  const partialRestoreTarget = fixturePath(
    installerFixture,
    '部分恢复 后重试',
  );
  writeFixtureFiles(partialRestoreTarget, new Map([
    ['usersettings.yaml', expandedFiles.get('usersettings.yaml')],
    ['plans/legacy-plan.yaml', expandedFiles.get('plans/legacy-plan.yaml')],
    [
      'resource/user_daily_plans/legacy-daily.yaml',
      expandedFiles.get('resource/user_daily_plans/legacy-daily.yaml'),
    ],
    ['unknown-partial.keep', 'keep me\n'],
  ]));
  const retriedRestore = runInstallerHelper('restore', {
    Backup: legacyBackup,
    Target: partialRestoreTarget,
  });
  assertHelperSucceeded(retriedRestore, '部分 restore 后重试失败');
  assertFixtureFiles(partialRestoreTarget, expandedFiles);
  assertFixtureDirectories(partialRestoreTarget, expandedDirectories);
  assert.equal(
    fs.readFileSync(
      path.join(partialRestoreTarget, 'unknown-partial.keep'),
      'utf8',
    ),
    'keep me\n',
    '部分 restore 重试不得删除未知根项',
  );
  const secondRetriedRestore = runInstallerHelper('restore', {
    Backup: legacyBackup,
    Target: partialRestoreTarget,
  });
  assertHelperSucceeded(secondRetriedRestore, '部分 restore 完成后重复执行失败');
  assertFixtureFiles(partialRestoreTarget, expandedFiles);
  assertNoNestedPlans(partialRestoreTarget);

  const emptyCase = fixturePath(installerFixture, '合法 空快照');
  const emptySource = fixturePath(emptyCase, '空 源');
  const emptyBackup = path.join(emptyCase, '空 备份');
  const emptyTarget = path.join(emptyCase, '空 目标');
  writeFixtureFiles(emptySource, new Map([
    ['logs/not-legacy.log', 'ignore me\n'],
  ]));
  const emptySourceBefore = snapshotTree(emptySource);
  assertHelperSucceeded(
    runInstallerHelper('preserve', {
      Source: emptySource,
      Backup: emptyBackup,
    }),
    '8 类数据全缺失时应创建合法空快照',
  );
  assert.deepEqual(snapshotTree(emptySource), emptySourceBefore);
  assertPreservedMarker(emptyBackup);
  assert.deepEqual(
    fs.readdirSync(emptyBackup).sort(),
    ['.preserved'],
    '空快照只能包含完成 marker',
  );
  assertHelperSucceeded(
    runInstallerHelper('restore', {
      Backup: emptyBackup,
      Target: emptyTarget,
    }),
    '合法空快照恢复失败',
  );
  assert.ok(
    snapshotTree(emptyTarget) === null || snapshotTree(emptyTarget).length === 0,
    '空快照不得产生迁移数据',
  );

  const missingMarkerCase = fixturePath(installerFixture, '缺少 marker');
  const missingMarkerBackup = fixturePath(missingMarkerCase, 'backup');
  const missingMarkerTarget = fixturePath(missingMarkerCase, 'target');
  writeFixtureFiles(missingMarkerBackup, new Map([
    ['usersettings.yaml', 'backup data\n'],
  ]));
  writeFixtureFiles(missingMarkerTarget, new Map([
    ['unknown.keep', 'target data\n'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: missingMarkerBackup, Target: missingMarkerTarget },
    [missingMarkerBackup, missingMarkerTarget],
    '缺少 .preserved 的备份必须拒绝恢复',
  );

  const nonEmptyMarkerCase = fixturePath(installerFixture, '非零 marker');
  const nonEmptyMarkerSource = fixturePath(nonEmptyMarkerCase, 'source');
  const nonEmptyMarkerBackup = fixturePath(nonEmptyMarkerCase, 'backup');
  const nonEmptyMarkerTarget = fixturePath(nonEmptyMarkerCase, 'target');
  writeFixtureFiles(nonEmptyMarkerSource, new Map([
    ['usersettings.yaml', 'same data\n'],
  ]));
  writeFixtureFiles(nonEmptyMarkerBackup, new Map([
    ['usersettings.yaml', 'same data\n'],
    ['.preserved', 'not empty'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: nonEmptyMarkerSource, Backup: nonEmptyMarkerBackup },
    [nonEmptyMarkerSource, nonEmptyMarkerBackup],
    '非零字节 .preserved 必须拒绝 preserve',
  );
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: nonEmptyMarkerBackup, Target: nonEmptyMarkerTarget },
    [nonEmptyMarkerBackup, nonEmptyMarkerTarget],
    '非零字节 .preserved 必须拒绝 restore',
  );

  const directoryMarkerCase = fixturePath(installerFixture, '目录 marker');
  const directoryMarkerBackup = fixturePath(directoryMarkerCase, 'backup');
  const directoryMarkerTarget = path.join(directoryMarkerCase, 'target');
  writeFixtureFiles(directoryMarkerBackup, new Map([
    ['usersettings.yaml', 'backup data\n'],
  ]));
  fs.mkdirSync(path.join(directoryMarkerBackup, '.preserved'));
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: directoryMarkerBackup, Target: directoryMarkerTarget },
    [directoryMarkerBackup, directoryMarkerTarget],
    '目录形式 .preserved 必须拒绝恢复',
  );

  const incompleteStaleCase = fixturePath(
    installerFixture,
    '未完成快照 stale 数据',
  );
  const incompleteStaleSource = fixturePath(incompleteStaleCase, 'source');
  const incompleteStaleBackup = fixturePath(incompleteStaleCase, 'backup');
  writeFixtureFiles(incompleteStaleSource, new Map([
    ['usersettings.yaml', 'source only\n'],
  ]));
  writeFixtureFiles(incompleteStaleBackup, new Map([
    ['gui_settings.json', '{"backup":"stale"}\n'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: incompleteStaleSource, Backup: incompleteStaleBackup },
    [incompleteStaleSource, incompleteStaleBackup],
    '无 marker 时备份不得包含源中不存在的 stale 项',
  );

  const preserveContentCase = fixturePath(installerFixture, 'preserve 内容冲突');
  const preserveContentSource = fixturePath(preserveContentCase, 'source');
  const preserveContentBackup = fixturePath(preserveContentCase, 'backup');
  writeFixtureFiles(preserveContentSource, new Map([
    ['gui_settings.json', '{"new":"must not copy"}\n'],
    ['usersettings.yaml', 'source content\n'],
  ]));
  writeFixtureFiles(preserveContentBackup, new Map([
    ['usersettings.yaml', 'backup conflict\n'],
    ['.preserved', ''],
  ]));
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: preserveContentSource, Backup: preserveContentBackup },
    [preserveContentSource, preserveContentBackup],
    'preserve 内容冲突必须全量预检后零写入',
  );

  const preserveTypeCase = fixturePath(installerFixture, 'preserve 类型冲突');
  const preserveTypeSource = fixturePath(preserveTypeCase, 'source');
  const preserveTypeBackup = fixturePath(preserveTypeCase, 'backup');
  writeFixtureFiles(preserveTypeSource, new Map([
    ['gui_settings.json', '{"new":"must not copy"}\n'],
    ['usersettings.yaml', 'source file\n'],
  ]));
  writeFixtureDirectories(preserveTypeBackup, ['usersettings.yaml']);
  writeFixtureFiles(preserveTypeBackup, new Map([['.preserved', '']]));
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: preserveTypeSource, Backup: preserveTypeBackup },
    [preserveTypeSource, preserveTypeBackup],
    'preserve 文件/目录类型冲突必须全量预检后零写入',
  );

  const preserveParentCase = fixturePath(installerFixture, 'preserve 父路径冲突');
  const preserveParentSource = fixturePath(preserveParentCase, 'source');
  const preserveParentBackup = fixturePath(preserveParentCase, 'backup');
  writeFixtureFiles(preserveParentSource, new Map([
    ['gui_settings.json', '{"new":"must not copy"}\n'],
    ['resource/user_team_plans/team.yaml', 'ships: []\n'],
  ]));
  writeFixtureFiles(preserveParentBackup, new Map([
    ['resource', 'not a directory\n'],
    ['.preserved', ''],
  ]));
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: preserveParentSource, Backup: preserveParentBackup },
    [preserveParentSource, preserveParentBackup],
    'preserve 父路径冲突必须全量预检后零写入',
  );

  const restoreContentCase = fixturePath(installerFixture, 'restore 内容冲突');
  const restoreContentBackup = fixturePath(restoreContentCase, 'backup');
  const restoreContentTarget = fixturePath(restoreContentCase, 'target');
  writeFixtureFiles(restoreContentBackup, new Map([
    ['gui_settings.json', '{"new":"must not copy"}\n'],
    ['usersettings.yaml', 'backup content\n'],
    ['.preserved', ''],
  ]));
  writeFixtureFiles(restoreContentTarget, new Map([
    ['usersettings.yaml', 'target conflict\n'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: restoreContentBackup, Target: restoreContentTarget },
    [restoreContentBackup, restoreContentTarget],
    'restore 内容冲突必须全量预检后零写入',
  );

  const restoreTypeCase = fixturePath(installerFixture, 'restore 类型冲突');
  const restoreTypeBackup = fixturePath(restoreTypeCase, 'backup');
  const restoreTypeTarget = fixturePath(restoreTypeCase, 'target');
  writeFixtureFiles(restoreTypeBackup, new Map([
    ['gui_settings.json', '{"new":"must not copy"}\n'],
    ['usersettings.yaml', 'backup file\n'],
    ['.preserved', ''],
  ]));
  writeFixtureDirectories(restoreTypeTarget, ['usersettings.yaml']);
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: restoreTypeBackup, Target: restoreTypeTarget },
    [restoreTypeBackup, restoreTypeTarget],
    'restore 文件/目录类型冲突必须全量预检后零写入',
  );

  const restoreParentCase = fixturePath(installerFixture, 'restore 父路径冲突');
  const restoreParentBackup = fixturePath(restoreParentCase, 'backup');
  const restoreParentTarget = fixturePath(restoreParentCase, 'target');
  writeFixtureFiles(restoreParentBackup, new Map([
    ['gui_settings.json', '{"new":"must not copy"}\n'],
    ['resource/user_team_plans/team.yaml', 'ships: []\n'],
    ['.preserved', ''],
  ]));
  writeFixtureFiles(restoreParentTarget, new Map([
    ['resource', 'not a directory\n'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: restoreParentBackup, Target: restoreParentTarget },
    [restoreParentBackup, restoreParentTarget],
    'restore 父路径冲突必须全量预检后零写入',
  );

  const overlapCase = fixturePath(installerFixture, '根目录重叠');
  const equalRoot = fixturePath(overlapCase, 'equal');
  writeFixtureFiles(equalRoot, new Map([
    ['usersettings.yaml', 'equal root\n'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: equalRoot, Backup: equalRoot },
    [equalRoot],
    'preserve 的 Source 与 Backup 相等时必须拒绝',
  );

  const sourceContainsBackup = fixturePath(overlapCase, 'source-parent');
  writeFixtureFiles(sourceContainsBackup, new Map([
    ['usersettings.yaml', 'source parent\n'],
  ]));
  const nestedBackup = path.join(sourceContainsBackup, 'nested-backup');
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: sourceContainsBackup, Backup: nestedBackup },
    [sourceContainsBackup, nestedBackup],
    'Backup 位于 Source 内时必须拒绝',
  );

  const backupContainsSource = fixturePath(overlapCase, 'backup-parent');
  const nestedSource = fixturePath(backupContainsSource, 'nested-source');
  writeFixtureFiles(nestedSource, new Map([
    ['usersettings.yaml', 'nested source\n'],
  ]));
  assertFailureLeavesTreesUnchanged(
    'preserve',
    { Source: nestedSource, Backup: backupContainsSource },
    [backupContainsSource],
    'Source 位于 Backup 内时必须拒绝',
  );

  const restoreBackupParent = fixturePath(overlapCase, 'restore-backup-parent');
  writeFixtureFiles(restoreBackupParent, new Map([
    ['usersettings.yaml', 'restore backup\n'],
    ['.preserved', ''],
  ]));
  const nestedTarget = path.join(restoreBackupParent, 'nested-target');
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: restoreBackupParent, Target: nestedTarget },
    [restoreBackupParent, nestedTarget],
    'Target 位于 Backup 内时必须拒绝',
  );

  const restoreTargetParent = fixturePath(overlapCase, 'restore-target-parent');
  const nestedRestoreBackup = fixturePath(
    restoreTargetParent,
    'nested-backup',
  );
  writeFixtureFiles(nestedRestoreBackup, new Map([
    ['usersettings.yaml', 'restore backup\n'],
    ['.preserved', ''],
  ]));
  assertFailureLeavesTreesUnchanged(
    'restore',
    { Backup: nestedRestoreBackup, Target: restoreTargetParent },
    [restoreTargetParent],
    'Backup 位于 Target 内时必须拒绝',
  );

  const siblingCase = fixturePath(installerFixture, 'sibling-prefix');
  const siblingSource = fixturePath(siblingCase, 'foo');
  const siblingBackup = path.join(siblingCase, 'foobar');
  const siblingTarget = path.join(siblingCase, 'foobaz');
  writeFixtureFiles(siblingSource, new Map([
    ['usersettings.yaml', 'sibling prefix is safe\n'],
  ]));
  assertHelperSucceeded(
    runInstallerHelper('preserve', {
      Source: siblingSource,
      Backup: siblingBackup,
    }),
    'foo 与 foobar 是独立 sibling，不得误判为包含关系',
  );
  assertHelperSucceeded(
    runInstallerHelper('restore', {
      Backup: siblingBackup,
      Target: siblingTarget,
    }),
    'foobar 与 foobaz 是独立 sibling，不得误判为包含关系',
  );
  assert.equal(
    fs.readFileSync(path.join(siblingTarget, 'usersettings.yaml'), 'utf8'),
    'sibling prefix is safe\n',
  );

  const reparseCase = fixturePath(installerFixture, 'reparse point');
  const reparseProbeTarget = fixturePath(reparseCase, 'probe-target');
  const reparseProbeLink = path.join(reparseCase, 'probe-link');
  if (junctionsAvailable) {
    createDirectoryJunction(reparseProbeTarget, reparseProbeLink);
  }
  else {
    assert.match(
      helper,
      /FileAttributes\]::ReparsePoint/,
      '无法创建 junction 时至少必须保留 reparse point 静态防线',
    );
    console.warn(
      'reparse 动态测试已跳过：当前环境无法创建目录 junction',
    );
  }

  if (junctionsAvailable) {
    const markerReparseBackup = fixturePath(
      reparseCase,
      'marker-reparse-backup',
    );
    const markerReparseTarget = path.join(
      reparseCase,
      'marker-reparse-target',
    );
    const markerReparseDestination = fixturePath(
      reparseCase,
      'marker-reparse-destination',
    );
    writeFixtureFiles(markerReparseBackup, new Map([
      ['usersettings.yaml', 'marker reparse\n'],
    ]));
    createDirectoryJunction(
      markerReparseDestination,
      path.join(markerReparseBackup, '.preserved'),
    );
    assertFailureLeavesTreesUnchanged(
      'restore',
      { Backup: markerReparseBackup, Target: markerReparseTarget },
      [
        markerReparseBackup,
        markerReparseTarget,
        markerReparseDestination,
      ],
      '.preserved 是 reparse point 时必须 fail closed',
    );

    const realRootSource = fixturePath(reparseCase, 'real-root-source');
    writeFixtureFiles(realRootSource, new Map([
      ['usersettings.yaml', 'root reparse\n'],
    ]));
    const linkedRootSource = path.join(reparseCase, 'linked-root-source');
    createDirectoryJunction(realRootSource, linkedRootSource);
    const rootReparseBackup = path.join(reparseCase, 'root-reparse-backup');
    assertFailureLeavesTreesUnchanged(
      'preserve',
      { Source: linkedRootSource, Backup: rootReparseBackup },
      [realRootSource, rootReparseBackup],
      'reparse root 必须 fail closed',
    );

    const realAncestor = fixturePath(reparseCase, 'real-ancestor');
    const realAncestorChild = fixturePath(realAncestor, 'child-source');
    writeFixtureFiles(realAncestorChild, new Map([
      ['usersettings.yaml', 'ancestor reparse\n'],
    ]));
    const linkedAncestor = path.join(reparseCase, 'linked-ancestor');
    createDirectoryJunction(realAncestor, linkedAncestor);
    const sourceBelowReparse = path.join(linkedAncestor, 'child-source');
    const ancestorReparseBackup = path.join(
      reparseCase,
      'ancestor-reparse-backup',
    );
    assertFailureLeavesTreesUnchanged(
      'preserve',
      { Source: sourceBelowReparse, Backup: ancestorReparseBackup },
      [realAncestor, ancestorReparseBackup],
      '根的任意祖先包含 reparse point 时必须 fail closed',
    );

    const descendantSource = fixturePath(reparseCase, 'descendant-source');
    const descendantTarget = fixturePath(reparseCase, 'descendant-target');
    writeFixtureFiles(descendantTarget, new Map([
      ['outside.yaml', 'must not traverse\n'],
    ]));
    fs.mkdirSync(path.join(descendantSource, 'plans'), { recursive: true });
    createDirectoryJunction(
      descendantTarget,
      path.join(descendantSource, 'plans', 'linked'),
    );
    const descendantBackup = path.join(
      reparseCase,
      'descendant-reparse-backup',
    );
    assertFailureLeavesTreesUnchanged(
      'preserve',
      { Source: descendantSource, Backup: descendantBackup },
      [descendantSource, descendantTarget, descendantBackup],
      '白名单后代包含 reparse point 时必须 fail closed',
    );

    const restoreReparseBackup = fixturePath(
      reparseCase,
      'restore-reparse-backup',
    );
    const restoreReparseTarget = fixturePath(
      reparseCase,
      'restore-reparse-target',
    );
    writeFixtureFiles(restoreReparseBackup, new Map([
      ['plans/linked/plan.yaml', 'do not copy through link\n'],
      ['.preserved', ''],
    ]));
    fs.mkdirSync(path.join(restoreReparseTarget, 'plans'), { recursive: true });
    createDirectoryJunction(
      descendantTarget,
      path.join(restoreReparseTarget, 'plans', 'linked'),
    );
    assertFailureLeavesTreesUnchanged(
      'restore',
      { Backup: restoreReparseBackup, Target: restoreReparseTarget },
      [restoreReparseBackup, restoreReparseTarget, descendantTarget],
      'restore 目标后代包含 reparse point 时必须 fail closed',
    );
  }

  assert.match(installer, /!macro customUnInstall/);
  assert.match(
    installer,
    /\$\{ifNot\} \$\{isUpdated\}/,
    '覆盖升级调用旧卸载器时不能删除后端依赖',
  );
  const activeUninstall = installerMacro(installer, 'customUnInstall');
  assert.match(
    activeUninstall,
    /\$\{ifNot\} \$\{isUpdated\}[\s\S]*-Action remove-managed-runtime -InstallDirectory "\$INSTDIR"[\s\S]*Pop \$R2[\s\S]*\$\{If\} \$R2 != 0[\s\S]*SetErrorLevel 1[\s\S]*Quit[\s\S]*\$\{EndIf\}[\s\S]*\$\{endIf\}/,
    '主动卸载 helper 必须仅在非升级路径运行，并将失败映射为非零退出',
  );
  assert.equal(
    helper.includes("[IO.Directory]::Delete('\\\\?\\' + $runtimeItem.FullName, $true)"),
    true,
    'helper 必须使用 Win32 extended path 递归删除受管运行时',
  );
  const longPathInstall = path.join(resources, 'long-path-uninstall');
  let longPathLeaf = path.join(longPathInstall, 'python', 'site-packages');
  for (let index = 0; index < 24; index += 1) {
    longPathLeaf = path.join(longPathLeaf, `license-segment-${index}`);
  }
  assert.equal(
    path.join(longPathLeaf, 'LICENSE.txt').length > 260,
    true,
    'fixture 必须覆盖 Windows 经典 MAX_PATH 边界',
  );
  fs.mkdirSync(longPathLeaf, { recursive: true });
  fs.writeFileSync(path.join(longPathLeaf, 'LICENSE.txt'), 'license\n');
  const removeManagedRuntime = runInstallerHelper('remove-managed-runtime', {
    InstallDirectory: longPathInstall,
  });
  assert.equal(
    removeManagedRuntime.status,
    0,
    removeManagedRuntime.stderr || removeManagedRuntime.stdout,
  );
  assert.equal(
    fs.existsSync(path.join(longPathInstall, 'python', 'site-packages')),
    false,
    '主动卸载 helper 必须删除超过 MAX_PATH 的受管运行时树',
  );
  if (junctionsAvailable) {
    const reparseInstall = path.join(resources, 'reparse-uninstall');
    const reparseRuntime = path.join(
      reparseInstall,
      'python',
      'site-packages',
    );
    const reparseTarget = path.join(resources, 'reparse-uninstall-target');
    fs.mkdirSync(reparseRuntime, { recursive: true });
    createDirectoryJunction(
      reparseTarget,
      path.join(reparseRuntime, 'linked'),
    );
    const removeReparseRuntime = runInstallerHelper(
      'remove-managed-runtime',
      { InstallDirectory: reparseInstall },
    );
    assert.notEqual(
      removeReparseRuntime.status,
      0,
      '受管运行时包含 reparse point 时必须 fail closed',
    );
    assert.equal(
      fs.existsSync(reparseRuntime),
      true,
      'reparse point 校验失败不得删除受管运行时',
    );
  }
  const missingInstall = runInstallerHelper('remove-managed-runtime', {
    InstallDirectory: path.join(resources, 'missing-install-root'),
  });
  assert.notEqual(
    missingInstall.status,
    0,
    '不存在的安装根目录必须 fail closed',
  );
  assert.match(
    installer,
    /\$\{If\} \$\{isUpdated\}[\s\S]*\$\{FileExists\} "\$newDesktopLink"[\s\S]*addDesktopLink "false"[\s\S]*\$\{FileExists\} "\$newStartMenuLink"[\s\S]*addStartMenuLink "false"/,
    '覆盖升级必须刷新已有快捷方式',
  );
  console.log('stable backend distribution test passed');
}
finally {
  cleanupFixtureProcesses();
  fs.rmSync(resources, { recursive: true, force: true });
}
