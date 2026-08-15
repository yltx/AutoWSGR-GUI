/**
 * GUI 更新策略和后端安全关闭测试。
 *
 * 覆盖稳定、Alpha、Beta、开发四类版本频道，确保无更新、检查失败和发现更新
 * 不会互相混淆。后端关闭测试验证系统停止接口一定先于进程终止调用。
 *
 * Windows 环境还会创建父子进程树：子进程独占锁定临时文件，父进程作为
 * 后端进程交给关闭服务。关闭完成后必须能立即删除锁文件，证明子进程和
 * 操作系统文件锁都已释放。
 */
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const {
  assert,
  AtomicFileStore,
  fs,
  path,
  temporaryDirectory,
  yaml,
} = require('./test-context');
const {
  classifyGuiUpdateCheck,
  resolveGuiReleasePolicy,
  resolveGuiUpdateSelectionPolicy,
  validateGuiUpdateCandidate,
} = require('../../../dist/electron/services/GuiUpdatePolicy.js');
const {
  requestBackendSystemStop,
  shutdownBackendProcess,
} = require(
  '../../../dist/electron/services/BackendShutdownService.js'
);
const {
  GuiUpdateInstaller,
} = require('../../../dist/electron/services/GuiUpdateInstaller.js');
const {
  GuiUpdateStateStore,
} = require('../../../dist/electron/services/GuiUpdateStateStore.js');

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await delay(50);
  }
  throw new Error(`等待文件超时: ${filePath}`);
}

async function deleteLockedFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      fs.rmSync(filePath, { force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError ?? new Error(`无法删除文件: ${filePath}`);
}

function testGuiUpdatePolicy() {
  assert.deepEqual(resolveGuiReleasePolicy('2.0.3'), {
    channel: 'latest',
    stage: 'stable',
    allowPrerelease: false,
  });
  const alpha = resolveGuiReleasePolicy('2.0.3-alpha');
  assert.deepEqual(alpha, {
    channel: 'alpha',
    stage: 'prerelease',
    allowPrerelease: true,
  });
  assert.deepEqual(resolveGuiReleasePolicy('2.0.3-alpha.1'), alpha);
  assert.deepEqual(resolveGuiReleasePolicy('2.0.3-beta.2'), {
    channel: 'beta',
    stage: 'prerelease',
    allowPrerelease: true,
  });
  const development = resolveGuiReleasePolicy('2.0.3-dev');
  assert.deepEqual(development, {
    channel: 'dev',
    stage: 'development',
    allowPrerelease: true,
  });
  assert.deepEqual(
    resolveGuiReleasePolicy('2.0.3-dev.0'),
    development,
  );
  assert.throws(
    () => resolveGuiReleasePolicy('2.0.3-rc.1'),
    /不符合规范/,
  );

  assert.deepEqual(
    classifyGuiUpdateCheck(development, {
      isUpdateAvailable: false,
      updateInfo: { version: '2.0.3-dev.0' },
    }),
    { status: 'up-to-date' },
  );
  assert.deepEqual(
    classifyGuiUpdateCheck(development, null),
    {
      status: 'error',
      message: '当前运行环境未启用 GUI 自动更新',
    },
  );
  assert.deepEqual(
    classifyGuiUpdateCheck(development, {
      isUpdateAvailable: true,
      updateInfo: { version: '2.0.3-dev.1' },
    }),
    { status: 'available', version: '2.0.3-dev.1' },
  );
  assert.match(
    validateGuiUpdateCandidate(development, '2.0.3-beta.1'),
    /只允许 dev 频道/,
  );
  assert.equal(
    validateGuiUpdateCandidate(development, '2.0.3-dev.1'),
    null,
  );

  const stableOnly = resolveGuiUpdateSelectionPolicy('2.0.1', false);
  assert.equal(stableOnly.channel, 'latest');
  assert.equal(stableOnly.allowPrerelease, false);
  assert.deepEqual(stableOnly.acceptedChannels, ['latest']);
  assert.match(
    validateGuiUpdateCandidate(stableOnly, '2.0.2-alpha.1'),
    /只允许 latest 频道/,
  );

  const stableWithAlpha = resolveGuiUpdateSelectionPolicy('2.0.1', true);
  assert.equal(stableWithAlpha.channel, 'alpha');
  assert.equal(stableWithAlpha.allowPrerelease, true);
  assert.deepEqual(
    stableWithAlpha.acceptedChannels,
    ['latest', 'alpha'],
  );
  assert.equal(
    validateGuiUpdateCandidate(stableWithAlpha, '2.0.2-alpha.1'),
    null,
  );
  assert.equal(
    validateGuiUpdateCandidate(stableWithAlpha, '2.0.2'),
    null,
  );

  const alphaStableOnly = resolveGuiUpdateSelectionPolicy(
    '2.0.2-alpha.3',
    false,
  );
  assert.equal(alphaStableOnly.channel, 'latest');
  assert.deepEqual(alphaStableOnly.acceptedChannels, ['latest']);
  assert.equal(
    validateGuiUpdateCandidate(alphaStableOnly, '2.0.2'),
    null,
  );
  assert.match(
    validateGuiUpdateCandidate(alphaStableOnly, '2.0.3-alpha.1'),
    /只允许 latest 频道/,
  );

  const root = path.join(__dirname, '..', '..', '..');
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const packagePolicy = resolveGuiReleasePolicy(packageJson.version);
  assert.equal(packageJson.build.publish.owner, 'yltx');
  assert.equal(packageJson.build.publish.repo, 'AutoWSGR-GUI');
  assert.equal(
    require(path.join(root, 'build', 'electron-builder.release.cjs'))
      .publish.channel,
    packagePolicy.channel,
  );

  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const releaseWorkflow = yaml.load(workflow);
  assert.ok(releaseWorkflow.jobs.build);
  const releaseVersionStep = releaseWorkflow.jobs.build.steps.find(
    step => step.name === 'Verify checked-in release version',
  );
  assert.ok(releaseVersionStep?.run);
  assert.match(
    releaseVersionStep.run,
    /node -p .*package-lock\.json.*\.version/,
  );
  assert.match(
    releaseVersionStep.run,
    /node -p .*package-lock\.json.*packages\[''\]\.version/,
  );
  assert.doesNotMatch(
    releaseVersionStep.run,
    /Get-Content package-lock\.json\s*\|\s*ConvertFrom-Json/,
  );
  assert.match(workflow, /X\.Y\.Z-alpha\[\.N\]/);
  assert.match(
    workflow,
    /steps\.version\.outputs\.CHANNEL/,
  );
  assert.match(workflow, /AutoWSGR-GUI-Setup-/);
  assert.match(workflow, /Verify pinned stable backend/);
  assert.match(workflow, /manifest\.id -ne "stable"/);
  assert.match(workflow, /PRERELEASE/);
  assert.match(workflow, /Preflight release destinations/);
  assert.match(workflow, /releases\?per_page=100/);
  assert.doesNotMatch(workflow, /gh release view/);
  assert.match(workflow, /Publish verified Stable release/);
  assert.match(workflow, /draft: true/);
  assert.doesNotMatch(workflow, /LEGACY_RELEASE_TOKEN/);
  assert.doesNotMatch(workflow, /release\/alpha-compat/);
  assert.doesNotMatch(workflow, /ShiinaKuroko\/AutoWSGR-GUI/);
  assert.match(workflow, /Create GitHub Releases after all gates pass/);
  assert.match(workflow, /github\.event_name != 'workflow_dispatch'/);
  assert.doesNotMatch(workflow, /git ls-remote/);
  assert.doesNotMatch(workflow, /X\.Y\.Z-beta\.N/);
  assert.doesNotMatch(workflow, /X\.Y\.Z-dev\.N/);
  assert.match(workflow, /'latest', 'alpha'/);
}

async function testGuiUpdateStartupGateAndInstaller() {
  const root = path.join(temporaryDirectory, 'gui-update-state');
  const userRoot = path.join(root, 'user-data');
  const cacheRoot = path.join(root, 'wsgrgui-updater');
  const pendingRoot = path.join(cacheRoot, 'pending');
  const installerPath = path.join(
    pendingRoot,
    'AutoWSGR-GUI-Setup-2.0.9-alpha.exe',
  );
  const statePath = path.join(userRoot, '.gui-update-state.json');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(pendingRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });
  fs.writeFileSync(installerPath, 'verified installer');
  fs.writeFileSync(
    path.join(cacheRoot, 'current.blockmap'),
    'keep blockmap',
  );
  fs.writeFileSync(
    path.join(userRoot, 'gui_settings.json'),
    '{"keep":true}',
  );

  let now = Date.parse('2026-08-09T00:00:00.000Z');
  const runningPids = new Set();
  const states = new GuiUpdateStateStore(
    () => statePath,
    new AtomicFileStore(),
    {
      now: () => now,
      isProcessRunning: pid => runningPids.has(pid),
    },
  );
  const checksum = crypto
    .createHash('sha512')
    .update(fs.readFileSync(installerPath))
    .digest('base64');
  states.saveDownloaded({
    sourceVersion: '2.0.8-alpha',
    targetVersion: '2.0.9-alpha',
    downloadedFile: installerPath,
    sha512: checksum,
  });
  assert.equal(
    states.resolveStartup('2.0.8-alpha').action,
    'install',
  );

  const launches = [];
  const logs = [];
  const installer = new GuiUpdateInstaller(
    states,
    {
      info: message => logs.push(['info', message]),
      warn: message => logs.push(['warn', message]),
      error: message => logs.push(['error', message]),
      debug: message => logs.push(['debug', message]),
    },
    path.join(root, 'resources'),
    {
      fileExists: filePath => fs.existsSync(filePath),
      hashSha512: async filePath => crypto
        .createHash('sha512')
        .update(fs.readFileSync(filePath))
        .digest('base64'),
      launch: async (command, args) => {
        launches.push([command, args]);
        runningPids.add(24680);
        return 24680;
      },
      updaterCacheRoot: cacheRoot,
    },
  );
  const installing = await installer.launchPendingUpdate();
  assert.equal(installing.status, 'installing');
  assert.equal(installing.installerPid, 24680);
  assert.deepEqual(launches, [[
    installerPath,
    ['--updated', '/S', '--force-run'],
  ]]);
  assert.equal(
    states.resolveStartup('2.0.8-alpha').action,
    'wait',
  );

  const applied = states.resolveStartup('2.0.9-alpha');
  assert.equal(applied.action, 'cleanup');
  assert.equal(states.read(), null);
  assert.equal(installer.cleanupAppliedUpdate(applied.state), true);
  assert.equal(fs.existsSync(pendingRoot), false);
  assert.equal(
    fs.existsSync(path.join(cacheRoot, 'current.blockmap')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(userRoot, 'gui_settings.json')),
    true,
  );

  fs.mkdirSync(pendingRoot, { recursive: true });
  fs.writeFileSync(installerPath, 'corrupt installer');
  states.saveDownloaded({
    sourceVersion: '2.0.8-alpha',
    targetVersion: '2.0.9-alpha',
    downloadedFile: installerPath,
    sha512: checksum,
  });
  await assert.rejects(
    installer.launchPendingUpdate(),
    /校验失败/,
  );
  assert.equal(states.read(), null);
  assert.equal(fs.existsSync(pendingRoot), false);

  const unrelatedPendingRoot = path.join(
    root,
    'unrelated',
    'pending',
  );
  const unrelatedInstallerPath = path.join(
    unrelatedPendingRoot,
    'AutoWSGR-GUI-Setup-2.0.9-alpha.exe',
  );
  fs.mkdirSync(unrelatedPendingRoot, { recursive: true });
  fs.writeFileSync(unrelatedInstallerPath, 'corrupt installer');
  states.saveDownloaded({
    sourceVersion: '2.0.8-alpha',
    targetVersion: '2.0.9-alpha',
    downloadedFile: unrelatedInstallerPath,
    sha512: checksum,
  });
  await assert.rejects(
    installer.launchPendingUpdate(),
    /校验失败/,
  );
  assert.equal(states.read(), null);
  assert.equal(fs.existsSync(unrelatedPendingRoot), true);

  fs.mkdirSync(pendingRoot, { recursive: true });
  fs.writeFileSync(installerPath, 'verified installer');
  states.saveDownloaded({
    sourceVersion: '2.0.8-alpha',
    targetVersion: '2.0.9-alpha',
    downloadedFile: installerPath,
    sha512: checksum,
  });
  states.markInstalling();
  states.saveInstallerPid(13579);
  now += 31 * 60 * 1000;
  assert.equal(
    states.resolveStartup('2.0.8-alpha').action,
    'install',
  );
  assert.equal(states.read().status, 'downloaded');
  assert.ok(logs.length > 0);
}

async function testSystemStopRequest() {
  let receivedPath = '';
  let receivedMethod = '';
  let shouldFail = false;
  const server = http.createServer((request, response) => {
    receivedPath = request.url ?? '';
    receivedMethod = request.method ?? '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(
      shouldFail
        ? { success: false, error: '运行中任务停止超时' }
        : { success: true },
    ));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await requestBackendSystemStop(address.port, 1000);
    assert.equal(receivedPath, '/api/system/stop');
    assert.equal(receivedMethod, 'POST');
    shouldFail = true;
    await assert.rejects(
      requestBackendSystemStop(address.port, 1000),
      /运行中任务停止超时/,
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testRunningTaskStopsBeforeUpdateInstall() {
  const events = [];
  const fakeProcess = {
    exitCode: null,
    signalCode: null,
    pid: 12345,
  };
  await shutdownBackendProcess(
    fakeProcess,
    {
      backendPort: 14433,
      terminateTimeoutMs: 10,
      forceTerminateTimeoutMs: 100,
    },
    {
      platform: 'win32',
      requestSystemStop: async () => {
        events.push('system-stop');
      },
      terminateProcessTree: async (_process, force) => {
        events.push(force ? 'force-tree' : 'terminate-tree');
        fakeProcess.exitCode = 0;
      },
      waitForProcessClose: async () => {
        events.push('wait-close');
        return true;
      },
    },
  );
  events.push('quit-install');
  assert.deepEqual(events, [
    'system-stop',
    'terminate-tree',
    'wait-close',
    'quit-install',
  ]);
}

async function testForceShutdownWaitsForClose() {
  const events = [];
  const fakeProcess = {
    exitCode: null,
    signalCode: null,
    pid: 12346,
  };
  let waitCount = 0;
  await shutdownBackendProcess(
    fakeProcess,
    {
      backendPort: 14433,
      terminateTimeoutMs: 10,
      forceTerminateTimeoutMs: 10,
    },
    {
      platform: 'win32',
      requestSystemStop: async () => {
        events.push('system-stop');
        throw new Error('模拟运行中任务停止超时');
      },
      terminateProcessTree: async (_process, force) => {
        events.push(force ? 'force-tree' : 'terminate-tree');
      },
      waitForProcessClose: async () => {
        waitCount += 1;
        events.push(`wait-${waitCount}`);
        return waitCount === 2;
      },
      warn: message => events.push(`warning:${message}`),
    },
  );
  assert.deepEqual(
    events.filter(event => !event.startsWith('warning:')),
    [
      'system-stop',
      'terminate-tree',
      'wait-1',
      'force-tree',
      'wait-2',
    ],
  );
}

async function testUnclosedProcessBlocksUpdateInstall() {
  const fakeProcess = {
    exitCode: null,
    signalCode: null,
    pid: 12347,
  };
  let installed = false;
  await assert.rejects(
    shutdownBackendProcess(
      fakeProcess,
      {
        backendPort: 14433,
        terminateTimeoutMs: 10,
        forceTerminateTimeoutMs: 10,
      },
      {
        platform: 'win32',
        requestSystemStop: async () => {},
        terminateProcessTree: async () => {},
        waitForProcessClose: async () => false,
        warn: () => {},
      },
    ).then(() => {
      installed = true;
    }),
    /无法确认后端进程树已经退出/,
  );
  assert.equal(installed, false);
}

async function testWindowsProcessTreeAndFileLock() {
  if (process.platform !== 'win32') return;

  const testDirectory = path.join(
    temporaryDirectory,
    'backend-shutdown-windows',
  );
  fs.mkdirSync(testDirectory, { recursive: true });
  const lockFile = path.join(testDirectory, 'backend.lock');
  const childReady = path.join(testDirectory, 'child-ready.txt');
  const parentScript = path.join(testDirectory, 'parent.js');
  const lockScript = path.join(testDirectory, 'lock.ps1');

  fs.writeFileSync(lockScript, [
    'param([string]$LockPath, [string]$ReadyPath)',
    '$stream = [System.IO.File]::Open(',
    '  $LockPath,',
    '  [System.IO.FileMode]::OpenOrCreate,',
    '  [System.IO.FileAccess]::ReadWrite,',
    '  [System.IO.FileShare]::None',
    ')',
    'try {',
    '  [System.IO.File]::WriteAllText($ReadyPath, $PID.ToString())',
    '  while ($true) { Start-Sleep -Milliseconds 100 }',
    '} finally {',
    '  $stream.Dispose()',
    '}',
  ].join('\r\n'));
  fs.writeFileSync(parentScript, [
    "const { spawn } = require('node:child_process');",
    'const child = spawn(',
    "  'powershell.exe',",
    '  [',
    "    '-NoProfile',",
    "    '-NonInteractive',",
    "    '-ExecutionPolicy',",
    "    'Bypass',",
    "    '-File',",
    '    process.argv[2],',
    '    process.argv[3],',
    '    process.argv[4],',
    '  ],',
    "  { windowsHide: true, stdio: 'ignore' },",
    ');',
    "child.on('error', error => { throw error; });",
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  const parentProcess = spawn(
    process.execPath,
    [parentScript, lockScript, lockFile, childReady],
    {
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  try {
    await waitForFile(childReady);
    assert.throws(() => fs.rmSync(lockFile), /EPERM|EBUSY|UNKNOWN/);

    await shutdownBackendProcess(
      parentProcess,
      {
        backendPort: 14433,
        terminateTimeoutMs: 200,
        forceTerminateTimeoutMs: 5000,
      },
      {
        requestSystemStop: async () => {},
        warn: () => {},
      },
    );
    assert.notEqual(parentProcess.exitCode, null);
    await deleteLockedFile(lockFile);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    if (parentProcess.exitCode === null) {
      try {
        execFileSync(
          'taskkill.exe',
          ['/PID', String(parentProcess.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
      } catch {
        // 测试进程已经退出。
      }
    }
  }
}

async function testUpdaterAndBackendShutdown() {
  testGuiUpdatePolicy();
  await testGuiUpdateStartupGateAndInstaller();
  await testSystemStopRequest();
  await testRunningTaskStopsBeforeUpdateInstall();
  await testForceShutdownWaitsForClose();
  await testUnclosedProcessBlocksUpdateInstall();
  await testWindowsProcessTreeAndFileLock();
}

module.exports = {
  testUpdaterAndBackendShutdown,
};
