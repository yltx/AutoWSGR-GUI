/**
 * Python 环境一致性回归测试。
 *
 * 测试流程：
 * 1. 在系统临时目录创建隔离应用根目录。
 * 2. 创建最小 external AutoWSGR 仓库结构。
 * 3. 注入可切换的 Python 环境上下文。
 * 4. 验证 managed 模式使用 GUI site-packages。
 * 5. 验证 managed pip 参数包含 --target。
 * 6. 切换到 external 仓库和外部解释器。
 * 7. 验证 external pip 参数不包含 --target。
 * 8. 验证 external 安装目标是所选解释器自身环境。
 * 9. 验证 external 运行环境移除 GUI site-packages。
 * 10. 验证用户的其他 PYTHONPATH 条目仍然保留。
 * 11. 验证 CUDA 环境叠加后不会重新混入 GUI 包目录。
 * 12. 验证 external 仓库包目录会归一化到仓库根目录。
 * 13. 验证 external + 内置 Python 继续使用 GUI 包目录。
 * 14. 验证无效 external 仓库会明确失败。
 * 15. 测试结束后恢复环境变量并删除全部临时文件。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  initPythonEnv,
} = require('../../dist/electron/pythonEnv/context.js');
const {
  buildPythonProcessEnv,
  resolvePythonEnvironment,
} = require('../../dist/electron/pythonEnv/environment.js');
const {
  buildBackendRuntimeEnvironment,
  resolveConfiguredCudaRoot,
} = require('../../dist/electron/pythonEnv/cuda.js');
const {
  buildDependencyInstallPlan,
} = require('../../dist/electron/pythonEnv/installer.js');
const {
  BACKEND_DISTRIBUTION,
  FORCE_MANAGED_AUTOWSGR_UPDATE_ON_INSTALL,
  MANAGED_AUTOWSGR_COMMIT,
  MANAGED_AUTOWSGR_REQUIREMENT,
} = require('../../dist/electron/pythonEnv/backendRequirement.js');
const {
  buildBackendRuntimeInstallArgs,
  buildManagedAutowsgrUpdateArgs,
  buildRequirementProbeScript,
} = require('../../dist/electron/pythonEnv/updater.js');
const {
  buildBackendRuntimeContractProbeLines,
} = require('../../dist/electron/pythonEnv/backendContractProbe.js');
const {
  applyBackendRuntimeSettings,
  buildBackendBootstrap,
  buildBackendCapabilityProbe,
  selectBackendOcrGpuMode,
} = require(
  '../../dist/electron/services/BackendRuntimeContract.js',
);

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-python-environment-'),
);
const appRoot = path.join(temporaryDirectory, 'app');
const repoRoot = path.join(temporaryDirectory, 'external-repo');
const packageRoot = path.join(repoRoot, 'autowsgr');
const serverRoot = path.join(packageRoot, 'server');
const localPython = path.join(appRoot, 'python', 'python.exe');
const externalPython = path.join(
  temporaryDirectory,
  'external-venv',
  'Scripts',
  'python.exe',
);
const localSite = path.join(appRoot, 'python', 'site-packages');
const externalPackages = path.join(
  temporaryDirectory,
  'external-venv',
  'Lib',
  'site-packages',
);
const state = {
  mode: 'managed',
  repoPath: repoRoot,
  configuredPythonPath: null,
};
const previousRepoOverride = process.env.AUTOWSGR_BACKEND_REPO;

fs.mkdirSync(serverRoot, { recursive: true });
fs.mkdirSync(path.dirname(localPython), { recursive: true });
fs.mkdirSync(path.dirname(externalPython), { recursive: true });
fs.writeFileSync(path.join(packageRoot, '__init__.py'), '', 'utf8');
fs.writeFileSync(path.join(serverRoot, 'main.py'), '', 'utf8');

initPythonEnv({
  appRoot: () => appRoot,
  sendProgress: () => {},
  getConfiguredPythonPath: () => state.configuredPythonPath,
  getUpdateMode: () => 'manual',
  getBackendStartupMode: () => state.mode,
  getBackendRepoPath: () => state.repoPath,
  getTempDir: () => temporaryDirectory,
});

try {
  delete process.env.AUTOWSGR_BACKEND_REPO;

  const managed = resolvePythonEnvironment(localPython);
  assert.equal(managed.startupMode, 'managed');
  assert.equal(managed.pythonSource, 'bundled');
  assert.equal(managed.backendRoot, null);
  assert.equal(managed.useLocalSite, true);
  assert.equal(managed.installTarget, localSite);
  const managedPlan = buildDependencyInstallPlan(managed, 'autowsgr');
  assert.equal(managedPlan.backendArgs.includes('--target'), true);
  assert.equal(managedPlan.backendArgs.includes(localSite), true);
  assert.equal(managedPlan.toolArgs.includes('--target'), true);
  assert.equal(managedPlan.toolArgs.includes(localSite), true);
  assert.equal(
    managedPlan.toolArgs.includes('requests>=2.32.5'),
    true,
  );
  assert.equal(
    managedPlan.toolArgs.includes('beautifulsoup4>=4.12.0'),
    true,
  );
  assert.equal(
    managedPlan.toolArgs.includes('maafw>=5.12.3,<6.0'),
    true,
  );
  assert.equal(
    MANAGED_AUTOWSGR_COMMIT,
    '77f34b7b30d18f7b86cf736bdd5cf17ae35d5f78',
  );
  assert.equal(BACKEND_DISTRIBUTION.id, 'stable');
  assert.equal(BACKEND_DISTRIBUTION.ref, 'ShiinaKuroko');
  assert.equal(FORCE_MANAGED_AUTOWSGR_UPDATE_ON_INSTALL, true);
  assert.equal(
    MANAGED_AUTOWSGR_REQUIREMENT.endsWith(
      `${MANAGED_AUTOWSGR_COMMIT}.zip`,
    ),
    true,
  );
  const managedUpdateArgs = buildManagedAutowsgrUpdateArgs(localSite);
  assert.equal(managedUpdateArgs.at(-1), MANAGED_AUTOWSGR_REQUIREMENT);
  assert.equal(managedUpdateArgs.includes('autowsgr'), false);
  assert.equal(managedUpdateArgs.includes(localSite), true);
  assert.equal(managedUpdateArgs.includes('--no-deps'), true);
  const runtimeInstallArgs = buildBackendRuntimeInstallArgs(localSite);
  assert.equal(
    runtimeInstallArgs.includes('maafw>=5.12.3,<6.0'),
    true,
  );
  assert.equal(runtimeInstallArgs.includes(localSite), true);
  assert.equal(runtimeInstallArgs.includes('--no-deps'), true);
  assert.equal(runtimeInstallArgs.includes('--upgrade'), true);
  const requirementProbe = buildRequirementProbeScript(
    localSite,
    ['maafw>=5.12.3,<6.0'],
    true,
  );
  assert.match(requirementProbe, /metadata\.distribution/);
  assert.match(requirementProbe, /specifier\.contains/);
  assert.match(requirementProbe, /roots\.extend/);
  const forcedUpdateArgs = buildManagedAutowsgrUpdateArgs(
    localSite,
    true,
  );
  assert.equal(forcedUpdateArgs.includes('--force-reinstall'), true);
  const contractProbeLines = buildBackendRuntimeContractProbeLines();
  assert.equal(
    contractProbeLines.some(
      line => line.includes('unittest.mock'),
    ),
    true,
  );
  assert.equal(
    contractProbeLines.some(
      line => line.includes("_save_values != [True, False]"),
    ),
    true,
  );
  assert.equal(
    contractProbeLines.some(
      line => line.includes("_ocr_values != [True, False]"),
    ),
    true,
  );

  state.mode = 'external';
  state.configuredPythonPath = externalPython;
  const external = resolvePythonEnvironment(externalPython);
  assert.equal(external.startupMode, 'external');
  assert.equal(external.pythonSource, 'configured');
  assert.equal(external.backendRoot, repoRoot);
  assert.equal(external.useLocalSite, false);
  assert.equal(external.installTarget, null);
  assert.notEqual(external.identity, managed.identity);

  state.configuredPythonPath = null;
  const system = resolvePythonEnvironment(externalPython);
  assert.equal(system.startupMode, 'external');
  assert.equal(system.pythonSource, 'system');

  const externalPlan = buildDependencyInstallPlan(external, repoRoot);
  assert.equal(externalPlan.buildArgs.includes('--target'), false);
  assert.equal(externalPlan.toolArgs.includes('--target'), false);
  assert.equal(externalPlan.backendArgs.includes('--target'), false);
  assert.equal(externalPlan.backendArgs.at(-1), repoRoot);

  const baseEnv = {
    PATH: 'base-path',
    PYTHONPATH: [localSite, externalPackages].join(path.delimiter),
    PYTHONUSERBASE: path.join(appRoot, 'python'),
  };
  const installEnv = buildPythonProcessEnv(external, baseEnv);
  assert.equal(installEnv.PYTHONPATH, externalPackages);
  assert.equal(installEnv.PYTHONUSERBASE, undefined);

  const runtimeEnv = buildBackendRuntimeEnvironment(
    external,
    null,
    baseEnv,
  );
  assert.equal(runtimeEnv.PYTHONPATH, externalPackages);
  assert.equal(runtimeEnv.PYTHONUSERBASE, undefined);

  const cudaRoot = path.join(temporaryDirectory, 'cuda', 'v12.8');
  const cudaBin = path.join(cudaRoot, 'bin');
  fs.mkdirSync(cudaBin, { recursive: true });
  fs.writeFileSync(path.join(cudaBin, 'nvcc.exe'), '', 'utf8');
  fs.writeFileSync(
    path.join(cudaRoot, 'version.json'),
    JSON.stringify({ cuda: { version: '12.8.0' } }),
    'utf8',
  );
  const configuredCudaRoot = resolveConfiguredCudaRoot(cudaRoot);
  assert.equal(configuredCudaRoot, cudaRoot);
  const cudaRuntimeEnv = buildBackendRuntimeEnvironment(
    external,
    configuredCudaRoot,
    baseEnv,
  );
  assert.equal(cudaRuntimeEnv.PYTHONPATH, externalPackages);
  assert.equal(
    cudaRuntimeEnv.PATH.split(path.delimiter)[0],
    cudaBin,
  );

  state.repoPath = packageRoot;
  const packageDirectoryInput = resolvePythonEnvironment(externalPython);
  assert.equal(packageDirectoryInput.backendRoot, repoRoot);

  state.repoPath = repoRoot;
  const externalWithLocalPython = resolvePythonEnvironment(localPython);
  assert.equal(externalWithLocalPython.useLocalSite, true);
  assert.equal(externalWithLocalPython.installTarget, localSite);

  const settingsEnv = applyBackendRuntimeSettings(
    cudaRuntimeEnv,
    {
      ocrGpuMode: 'cuda',
      saveImages: true,
    },
  );
  assert.equal(settingsEnv.AUTOWSGR_OCR_GPU_MODE, 'cuda');
  assert.equal(settingsEnv.AUTOWSGR_SAVE_IMAGES, 'true');
  assert.equal(selectBackendOcrGpuMode('auto', true), 'cuda');
  assert.equal(selectBackendOcrGpuMode('auto', false), 'cpu');
  assert.equal(selectBackendOcrGpuMode('cpu', true), 'cpu');
  assert.throws(
    () => selectBackendOcrGpuMode('cuda', false),
    /未检测到可用 CUDA/,
  );

  const capabilityProbe = buildBackendCapabilityProbe(external);
  assert.match(capabilityProbe, /AUTOWSGR_SAVE_IMAGES/);
  assert.match(capabilityProbe, /AUTOWSGR_OCR_GPU_MODE/);
  assert.match(capabilityProbe, /autowsgr\.server\.main/);
  assert.match(capabilityProbe, /GUI 后端来源错误/);
  assert.match(capabilityProbe, /gui-runtime-env-v1/);
  assert.match(capabilityProbe, /unittest\.mock/);
  assert.match(capabilityProbe, /iscoroutinefunction/);

  const bootstrap = buildBackendBootstrap(external, 16710);
  assert.match(bootstrap, /AUTOWSGR_SAVE_IMAGES/);
  assert.match(bootstrap, /AUTOWSGR_OCR_GPU_MODE/);
  assert.match(bootstrap, /port=16710/);
  assert.doesNotMatch(bootstrap, /__func__/);
  assert.doesNotMatch(bootstrap, /_image_dir/);
  assert.doesNotMatch(bootstrap, /_patched_/);

  state.repoPath = path.join(temporaryDirectory, 'missing-repo');
  assert.throws(
    () => resolvePythonEnvironment(externalPython),
    /external 后端仓库路径不存在/,
  );

  console.log('python environment tests passed');
} finally {
  if (previousRepoOverride === undefined) {
    delete process.env.AUTOWSGR_BACKEND_REPO;
  } else {
    process.env.AUTOWSGR_BACKEND_REPO = previousRepoOverride;
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
