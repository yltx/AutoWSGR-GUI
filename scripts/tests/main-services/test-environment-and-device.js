/**
 * Python、ADB 和 CUDA 环境服务测试。
 *
 * 复用同一隔离临时目录，不读取或修改真实用户数据。
 */
const context = require('./test-context');
const {
  assert,
  EventEmitter,
  fs,
  os,
  path,
  PassThrough,
  yaml,
  AppPaths,
  AtomicFileStore,
  GuiSettingsStore,
  SafePathService,
  SecureFileService,
  WindowService,
  UserDataMigrationService,
  LegacyPlanMigration,
  TeamPlanCodec,
  TeamPlanRepository,
  TeamPlanService,
  CombatPlanCodec,
  CombatPlanRepository,
  RuntimePlanService,
  PlanManagementService,
  ShipLibraryService,
  ShipLibraryUpdater,
  AdbService,
  CudaEnvironmentService,
  GuiConfigurationService,
  PythonEnvironmentService,
  temporaryDirectory,
} = context;
const {
  applyBackendRuntimeSettings,
  buildBackendBootstrap,
  buildBackendCapabilityProbe,
} = require(
  '../../../dist/electron/services/BackendRuntimeContract.js',
);
const {
  backendShipNamesPath,
  initPythonEnv,
} = require('../../../dist/electron/pythonEnv/index.js');

/** 验证 managed 和 external 模式使用各自后端的舰名库。 */
function testBackendShipNamesPath() {
  const appRoot = path.join(temporaryDirectory, 'python-environment');
  const externalRoot = path.join(temporaryDirectory, 'external-backend');
  fs.mkdirSync(
    path.join(externalRoot, 'autowsgr', 'server'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(externalRoot, 'autowsgr', 'server', 'main.py'),
    '',
  );

  let startupMode = 'managed';
  initPythonEnv({
    appRoot: () => appRoot,
    sendProgress: () => {},
    getConfiguredPythonPath: () => null,
    getUpdateMode: () => 'manual',
    allowTestUpdates: () => true,
    getBackendStartupMode: () => startupMode,
    getBackendRepoPath: () => externalRoot,
    getTempDir: () => temporaryDirectory,
  });

  assert.equal(
    backendShipNamesPath('python.exe'),
    path.join(
      appRoot,
      'python',
      'site-packages',
      'autowsgr',
      'data',
      'shipnames.yaml',
    ),
  );

  startupMode = 'external';
  assert.equal(
    backendShipNamesPath('python.exe'),
    path.join(
      externalRoot,
      'autowsgr',
      'data',
      'shipnames.yaml',
    ),
  );
  startupMode = 'managed';
}

/** 验证 Python 校验、检查和安装入口的原有返回语义。 */
async function testPythonEnvironmentService() {
  const state = {
    exists: false,
    version: 'Python 3.13.5',
    allowed: true,
    pythonPath: null,
    versionError: null,
  };
  const calls = {
    check: 0,
    install: [],
    portable: 0,
  };
  const service = new PythonEnvironmentService({
    fileExists: () => state.exists,
    readVersion: async () => {
      if (state.versionError) throw state.versionError;
      return state.version;
    },
    isAllowedVersion: () => state.allowed,
    findPython: async () => state.pythonPath,
    checkEnvironment: async () => {
      calls.check += 1;
      return { ready: true, pythonCmd: 'python.exe' };
    },
    installDependencies: async pythonPath => {
      calls.install.push(pythonPath);
      return { success: true, output: 'installed' };
    },
    installPortablePython: async () => {
      calls.portable += 1;
      return { success: true };
    },
  });

  assert.deepEqual(await service.validate(''), {
    valid: false,
    version: null,
    error: '路径为空',
  });
  assert.deepEqual(await service.validate('missing.exe'), {
    valid: false,
    version: null,
    error: '文件不存在',
  });

  state.exists = true;
  assert.deepEqual(await service.validate('python.exe'), {
    valid: true,
    version: 'Python 3.13.5',
  });
  state.allowed = false;
  assert.deepEqual(await service.validate('python.exe'), {
    valid: false,
    version: 'Python 3.13.5',
    error: '版本不兼容: Python 3.13.5（需要 3.12 或 3.13）',
  });
  state.versionError = new Error('cannot execute');
  assert.deepEqual(await service.validate('python.exe'), {
    valid: false,
    version: null,
    error: '执行失败: cannot execute',
  });

  assert.deepEqual(await service.check(), {
    ready: true,
    pythonCmd: 'python.exe',
  });
  assert.equal(calls.check, 1);

  assert.deepEqual(await service.installDependencies(), {
    success: false,
    output: '找不到 Python',
  });
  state.pythonPath = 'C:\\Python313\\python.exe';
  assert.deepEqual(await service.installDependencies(), {
    success: true,
    output: 'installed',
  });
  assert.deepEqual(calls.install, ['C:\\Python313\\python.exe']);

  assert.deepEqual(await service.installPortablePython(), {
    success: true,
  });
  assert.equal(calls.portable, 1);
}

/** 验证 ADB 命令参数、设备解析和状态确认保持不变。 */
async function testAdbService() {
  const projectRoot = path.join(temporaryDirectory, 'adb-project');
  const userData = path.join(temporaryDirectory, 'adb-user-data');
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const responses = [];
  const calls = [];
  const service = new AdbService(appPaths, {
    execute: async (executable, args, options) => {
      calls.push({ executable, args, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });

  assert.equal(service.executable(), 'adb');
  assert.equal(
    await service.stopServer(),
    false,
    '没有内置 ADB 时不得调用系统 adb kill-server',
  );
  assert.equal(calls.length, 0);
  const bundledAdb = path.join(projectRoot, 'adb', 'adb.exe');
  fs.mkdirSync(path.dirname(bundledAdb), { recursive: true });
  fs.writeFileSync(bundledAdb, 'adb', 'utf8');
  assert.equal(service.executable(), bundledAdb);

  responses.push({
    stdout: [
      'List of devices attached',
      '127.0.0.1:16384\tdevice',
      'emulator-5554',
      '',
    ].join('\r\n'),
    stderr: '',
  });
  assert.deepEqual(await service.listDevices(), [
    { serial: '127.0.0.1:16384', status: 'device' },
    { serial: 'emulator-5554', status: 'unknown' },
  ]);
  assert.deepEqual(calls[0], {
    executable: bundledAdb,
    args: ['devices'],
    options: {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
    },
  });

  assert.deepEqual(
    await service.runDeviceCommand('connect', 'bad address!'),
    {
      success: false,
      serial: 'bad address!',
      status: 'invalid',
      message: 'ADB 地址格式不正确',
    },
  );
  assert.equal(calls.length, 1);

  responses.push(
    { stdout: 'connected', stderr: '' },
    {
      stdout: [
        'List of devices attached',
        '127.0.0.1:16384\tdevice',
        '',
      ].join('\n'),
      stderr: '',
    },
  );
  assert.deepEqual(
    await service.runDeviceCommand(
      'connect',
      ' 127.0.0.1:16384 ',
    ),
    {
      success: true,
      serial: '127.0.0.1:16384',
      status: 'device',
      message: 'connected',
    },
  );
  assert.deepEqual(calls[1].args, [
    'connect',
    '127.0.0.1:16384',
  ]);
  assert.equal(calls[1].options.timeout, 10000);

  responses.push(
    { stdout: '', stderr: '' },
    {
      stdout: 'List of devices attached\n',
      stderr: '',
    },
  );
  assert.deepEqual(
    await service.runDeviceCommand(
      'disconnect',
      '127.0.0.1:16384',
    ),
    {
      success: true,
      serial: '127.0.0.1:16384',
      status: 'disconnected',
      message: '操作成功',
    },
  );

  const commandError = new Error('command failed');
  commandError.stdout = 'stdout details';
  commandError.stderr = 'stderr details';
  responses.push(commandError);
  assert.deepEqual(
    await service.runDeviceCommand(
      'connect',
      '127.0.0.1:16384',
    ),
    {
      success: false,
      serial: '127.0.0.1:16384',
      status: 'error',
      message: 'stderr details',
    },
  );

  responses.push({ stdout: '', stderr: '' });
  assert.equal(
    await service.stopServer(),
    false,
    '系统 ADB 运行时不得关闭 server',
  );
  assert.equal(calls.at(-1).executable, 'powershell.exe');
  assert.match(calls.at(-1).args.at(-1), /Get-CimInstance Win32_Process/);
  assert.match(calls.at(-1).args.at(-1), /adb-project[\\/]adb[\\/]adb\.exe/);

  responses.push(
    { stdout: '1', stderr: '' },
    { stdout: '', stderr: '' },
  );
  assert.equal(
    await service.stopServer(),
    true,
    '只有 GUI 目录内置 ADB 运行时才允许关闭 server',
  );
  assert.deepEqual(calls.at(-1), {
    executable: bundledAdb,
    args: ['kill-server'],
    options: {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
    },
  });
}

/** 验证 CUDA 路径说明和实际 PyTorch 检测保持既有语义。 */
async function testCudaEnvironmentService() {
  const cudaRoot = path.join(
    temporaryDirectory,
    'cuda',
    'CUDA-v12.4',
  );
  const cudaBin = path.join(cudaRoot, 'bin');
  const runtimeDirectory = path.join(
    temporaryDirectory,
    'cuda-runtime',
  );
  const invalidDirectory = path.join(
    temporaryDirectory,
    'cuda-invalid',
  );
  fs.mkdirSync(cudaBin, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.mkdirSync(invalidDirectory, { recursive: true });
  fs.writeFileSync(path.join(cudaBin, 'nvcc.exe'), 'nvcc', 'utf8');
  fs.writeFileSync(
    path.join(cudaRoot, 'version.json'),
    JSON.stringify({ cuda: { version: '12.4' } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runtimeDirectory, 'cudart64_121.dll'),
    'cudart',
    'utf8',
  );
  fs.writeFileSync(
    path.join(runtimeDirectory, 'cublas64_12.dll'),
    'cublas',
    'utf8',
  );
  const contractEnvironment = {
    pythonCmd: 'python.exe',
    startupMode: 'external',
    backendRoot: temporaryDirectory,
    localSite: path.join(temporaryDirectory, 'site-packages'),
    useLocalSite: false,
    installTarget: null,
    identity: 'external:test',
  };
  const runtimeSettings = applyBackendRuntimeSettings(
    { PYTHONPATH: 'shared-python-path' },
    { ocrGpuMode: 'cpu', saveImages: false },
  );
  assert.equal(runtimeSettings.PYTHONPATH, 'shared-python-path');
  assert.equal(runtimeSettings.AUTOWSGR_OCR_GPU_MODE, 'cpu');
  assert.equal(runtimeSettings.AUTOWSGR_SAVE_IMAGES, 'false');
  const capabilityProbe = buildBackendCapabilityProbe(
    contractEnvironment,
  );
  assert.match(capabilityProbe, /gui-runtime-env-v1/);
  assert.match(capabilityProbe, /AUTOWSGR_SAVE_IMAGES/);
  assert.match(capabilityProbe, /AUTOWSGR_OCR_GPU_MODE/);
  const backendBootstrap = buildBackendBootstrap(
    contractEnvironment,
    16710,
  );
  assert.match(backendBootstrap, /port=16710/);
  assert.doesNotMatch(backendBootstrap, /__func__|_patched_|_image_dir/);

  let findPythonCalls = 0;
  const noPython = new CudaEnvironmentService({
    findPython: async () => {
      findPythonCalls += 1;
      return null;
    },
    buildRuntimeEnvironment: () => {
      throw new Error('must not build runtime environment');
    },
    execute: async () => {
      throw new Error('must not execute');
    },
  });
  assert.deepEqual(noPython.validatePath(''), {
    valid: false,
    path: '',
    version: null,
    error: '路径为空',
  });
  const missingDirectory = path.join(
    temporaryDirectory,
    'missing-cuda',
  );
  assert.deepEqual(noPython.validatePath(missingDirectory), {
    valid: false,
    path: path.resolve(missingDirectory),
    version: null,
    error: '目录不存在',
  });
  assert.deepEqual(noPython.validatePath(invalidDirectory), {
    valid: false,
    path: path.resolve(invalidDirectory),
    version: null,
    error: '未找到 CUDA Toolkit（bin\\nvcc.exe）或 PyTorch CUDA Runtime DLL',
  });
  assert.equal(noPython.normalizePath(cudaBin), cudaRoot);
  assert.deepEqual(noPython.validatePath(cudaRoot), {
    valid: true,
    path: cudaRoot,
    version: '12.4',
    kind: 'toolkit',
  });
  assert.deepEqual(noPython.validatePath(runtimeDirectory), {
    valid: true,
    path: runtimeDirectory,
    version: '12.1',
    kind: 'runtime',
  });
  assert.deepEqual(await noPython.detect(cudaRoot), {
    valid: false,
    path: cudaRoot,
    version: '12.4',
    kind: 'toolkit',
    error: '未找到可用的 Python 3.12 或 3.13',
  });
  assert.equal(findPythonCalls, 1);
  assert.deepEqual(await noPython.detect(invalidDirectory), {
    valid: false,
    path: invalidDirectory,
    version: null,
    error: '未找到 CUDA Toolkit（bin\\nvcc.exe）或 PyTorch CUDA Runtime DLL',
  });
  assert.equal(findPythonCalls, 1);

  let commandCall = null;
  const runtimeEnvironmentCalls = [];
  const buildRuntimeEnvironment = (
    pythonCommand,
    configuredCudaRoot,
  ) => {
    runtimeEnvironmentCalls.push({
      pythonCommand,
      configuredCudaRoot,
    });
    const cudaDirectory = configuredCudaRoot
      ? (
          fs.existsSync(path.join(configuredCudaRoot, 'bin'))
            ? path.join(configuredCudaRoot, 'bin')
            : configuredCudaRoot
        )
      : null;
    return {
      PATH: [
        ...(cudaDirectory ? [cudaDirectory] : []),
        'base-path',
      ].join(path.delimiter),
      PYTHONPATH: 'shared-python-path',
      PYTHONUSERBASE: 'shared-python-user-base',
      ...(configuredCudaRoot
        ? {
            CUDA_PATH: configuredCudaRoot,
            CUDA_HOME: configuredCudaRoot,
          }
        : {}),
    };
  };
  const detected = new CudaEnvironmentService({
    findPython: async () => 'python.exe',
    buildRuntimeEnvironment,
    execute: async (executable, args, options) => {
      commandCall = { executable, args, options };
      return {
        stdout: [
          'diagnostic',
          JSON.stringify({
            available: true,
            torch_version: '2.5.1',
            cuda_version: '12.4',
            device: 'Test GPU',
          }),
        ].join('\n'),
      };
    },
  });
  assert.deepEqual(await detected.detect(cudaRoot), {
    valid: true,
    path: cudaRoot,
    version: '12.4',
    kind: 'toolkit',
    torchVersion: '2.5.1',
    device: 'Test GPU',
  });
  assert.equal(commandCall.executable, 'python.exe');
  assert.equal(commandCall.args[0], '-c');
  assert.match(commandCall.args[1], /torch\.cuda\.is_available/);
  assert.equal(commandCall.options.windowsHide, true);
  assert.equal(commandCall.options.timeout, 20000);
  assert.equal(commandCall.options.encoding, 'utf8');
  assert.equal(commandCall.options.env.CUDA_PATH, cudaRoot);
  assert.equal(commandCall.options.env.CUDA_HOME, cudaRoot);
  assert.equal(
    commandCall.options.env.PYTHONPATH,
    'shared-python-path',
  );
  assert.equal(
    commandCall.options.env.PYTHONUSERBASE,
    'shared-python-user-base',
  );
  assert.equal(
    commandCall.options.env.PATH.split(path.delimiter)[0],
    cudaBin,
  );
  assert.deepEqual(runtimeEnvironmentCalls[0], {
    pythonCommand: 'python.exe',
    configuredCudaRoot: cudaRoot,
  });

  const unavailable = new CudaEnvironmentService({
    findPython: async () => 'python.exe',
    buildRuntimeEnvironment,
    execute: async () => ({
      stdout: JSON.stringify({
        available: false,
        torch_version: '2.5.1',
        cuda_version: null,
      }),
    }),
  });
  assert.deepEqual(await unavailable.detect(''), {
    valid: false,
    path: '',
    version: null,
    kind: undefined,
    torchVersion: '2.5.1',
    device: null,
    error: 'PyTorch 2.5.1 未检测到可用 CUDA',
  });

  const importFailure = new CudaEnvironmentService({
    findPython: async () => 'python.exe',
    buildRuntimeEnvironment,
    execute: async () => ({
      stdout: JSON.stringify({
        available: false,
        error: 'No module named torch',
      }),
    }),
  });
  assert.deepEqual(await importFailure.detect(''), {
    valid: false,
    path: '',
    version: null,
    kind: undefined,
    torchVersion: null,
    device: null,
    error: 'PyTorch 检测失败：No module named torch',
  });

  const executionFailure = new CudaEnvironmentService({
    findPython: async () => 'python.exe',
    buildRuntimeEnvironment,
    execute: async () => {
      throw new Error('execution failed');
    },
  });
  assert.deepEqual(await executionFailure.detect(runtimeDirectory), {
    valid: false,
    path: runtimeDirectory,
    version: '12.1',
    kind: 'runtime',
    error: '硬件检测失败：execution failed',
  });
}

module.exports = {
  testBackendShipNamesPath,
  testPythonEnvironmentService,
  testAdbService,
  testCudaEnvironmentService,
};
