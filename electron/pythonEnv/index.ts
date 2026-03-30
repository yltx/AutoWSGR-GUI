/**
 * Barrel re-exports — 保持外部导入路径 './pythonEnv' 不变。
 */

// context
export { type PythonEnvContext, initPythonEnv, clearPythonCache } from './context';

// finder
export { isAllowedPythonVersion, findPython, findPythonSync } from './finder';

// utils
export { type EnvCheckResult, sysPathInsert, ensurePthFile, pipEnv, localSitePackages, ensurePip } from './utils';

// envCheck
export { checkEnvironment } from './envCheck';

// installer
export { installPortablePython, checkForUpdates, installDependencies, pullUpdates } from './installer';

// updater (DI 接口，供外部直接调用时使用)
export { type AutoUpdateDeps, autoUpdateAutowsgr } from './updater';
