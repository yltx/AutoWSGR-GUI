/**
 * 通过依赖注入检查并更新 autowsgr。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { MANAGED_AUTOWSGR_REQUIREMENT } from './backendRequirement';
import {
  buildBackendRuntimeContractProbeLines,
} from './backendContractProbe';
import {
  BACKEND_RUNTIME_REQUIREMENTS,
  PYTHON_DEPENDENCY_SPECS,
  SHIP_LIBRARY_REQUIREMENTS,
} from './dependencies';

const execAsync = promisify(exec);
const BACKEND_BUILD_REQUIREMENTS = ['hatchling', 'hatch-vcs'];

export interface AutoUpdateDeps {
  sendProgress: (msg: string) => void;
  getTempDir: () => string;
  appRoot: () => string;
  localSitePackages: () => string;
  pipEnv: () => NodeJS.ProcessEnv;
  ensurePip: (pythonCmd: string) => Promise<boolean>;
}

/** 生成依赖安装参数，调用方只传入检查后确认需要处理的包。 */
export function buildBackendRuntimeInstallArgs(
  targetDir: string,
  requirements: readonly string[] = BACKEND_RUNTIME_REQUIREMENTS,
): string[] {
  return [
    '-m', 'pip', 'install',
    '--upgrade',
    '--target', targetDir,
    '--no-deps',
    '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
    '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
    ...requirements,
  ];
}

/** 元数据探测失败时才使用 pip 自身的完整依赖解析。 */
function buildRequirementFallbackArgs(
  targetDir: string,
  requirements: readonly string[],
): string[] {
  return [
    '-m', 'pip', 'install',
    '--upgrade',
    '--upgrade-strategy', 'only-if-needed',
    '--target', targetDir,
    '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
    '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
    ...requirements,
  ];
}

/** 生成依赖版本探测脚本，递归检查传递依赖和 extras。 */
export function buildRequirementProbeScript(
  targetDir: string,
  requirements: readonly string[],
  includeBackendRequirements = false,
): string {
  return [
    'import json, sys',
    'from importlib import metadata',
    'from pip._vendor.packaging.requirements import Requirement',
    `sys.path.insert(0, ${JSON.stringify(targetDir)})`,
    `roots = ${JSON.stringify(requirements)}`,
    ...(includeBackendRequirements
      ? [
          'try:',
          '    roots.extend(metadata.distribution("autowsgr").requires or [])',
          'except metadata.PackageNotFoundError:',
          '    pass',
        ]
      : []),
    'unsatisfied = []',
    'visited = set()',
    'def applies(requirement, active_extras):',
    '    if requirement.marker is None:',
    '        return True',
    '    environments = [{"extra": ""}]',
    '    environments.extend({"extra": extra} for extra in active_extras)',
    '    return any(requirement.marker.evaluate(env) for env in environments)',
    'def install_text(requirement):',
    '    extras = ""',
    '    if requirement.extras:',
    '        extras = "[" + ",".join(sorted(requirement.extras)) + "]"',
    '    if requirement.url:',
    '        return f"{requirement.name}{extras} @ {requirement.url}"',
    '    return f"{requirement.name}{extras}{requirement.specifier}"',
    'pending = [(raw, set()) for raw in roots]',
    'while pending:',
    '    raw, active_extras = pending.pop()',
    '    requirement = Requirement(raw)',
    '    if not applies(requirement, active_extras):',
    '        continue',
    '    key = (',
    '        requirement.name.lower(),',
    '        str(requirement.specifier),',
    '        requirement.url or "",',
    '        tuple(sorted(requirement.extras)),',
    '    )',
    '    if key in visited:',
    '        continue',
    '    visited.add(key)',
    '    try:',
    '        installed = metadata.distribution(requirement.name)',
    '    except metadata.PackageNotFoundError:',
    '        unsatisfied.append(install_text(requirement))',
    '        continue',
    '    if requirement.specifier and not requirement.specifier.contains(',
    '        installed.version, prereleases=True',
    '    ):',
    '        unsatisfied.append(install_text(requirement))',
    '        continue',
    '    for child in installed.requires or []:',
    '        pending.append((child, set(requirement.extras)))',
    'print(json.dumps(list(dict.fromkeys(unsatisfied))))',
  ].join('\n');
}

/** 返回真正缺失或版本不兼容的依赖，探测失败时返回 null。 */
async function findUnsatisfiedRequirements(
  pythonCmd: string,
  deps: AutoUpdateDeps,
  requirements: readonly string[],
  includeBackendRequirements = false,
): Promise<string[] | null> {
  const scriptPath = path.join(
    deps.getTempDir(),
    `autowsgr_requirement_probe_${Date.now()}.py`,
  );
  try {
    fs.writeFileSync(
      scriptPath,
      buildRequirementProbeScript(
        deps.localSitePackages(),
        requirements,
        includeBackendRequirements,
      ),
      'utf-8',
    );
    const { stdout } = await execAsync(
      `"${pythonCmd}" "${scriptPath}"`,
      { windowsHide: true, timeout: 30000, env: deps.pipEnv() },
    );
    const result: unknown = JSON.parse(stdout.trim());
    return Array.isArray(result)
      ? result.filter((item): item is string => typeof item === 'string')
      : null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* 忽略清理失败。 */ }
  }
}

/** 执行 pip 并将输出转发到安装日志。 */
async function runPip(
  pythonCmd: string,
  args: string[],
  deps: AutoUpdateDeps,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const proc = spawn(pythonCmd, args, {
      cwd: deps.appRoot(),
      windowsHide: true,
      stdio: 'pipe',
      env: deps.pipEnv(),
    });
    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) deps.sendProgress(line.trim());
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) deps.sendProgress(line.trim());
      }
    });
    proc.on('close', code => resolve(code ?? 1));
    proc.on('error', () => resolve(1));
  });
}

type RequirementEnsureResult = 'ready' | 'probe-failed' | 'install-failed';

/** 分轮补齐依赖，每轮只安装探测器确认不满足的包。 */
async function ensureRequirements(
  pythonCmd: string,
  deps: AutoUpdateDeps,
  requirements: readonly string[],
  includeBackendRequirements = false,
): Promise<RequirementEnsureResult> {
  const targetDir = deps.localSitePackages();
  for (let round = 0; round < 16; round += 1) {
    const missing = await findUnsatisfiedRequirements(
      pythonCmd,
      deps,
      requirements,
      includeBackendRequirements,
    );
    if (missing === null) return 'probe-failed';
    if (missing.length === 0) return 'ready';

    deps.sendProgress(`正在安装必要依赖: ${missing.join(', ')}`);
    const code = await runPip(
      pythonCmd,
      buildBackendRuntimeInstallArgs(targetDir, missing),
      deps,
    );
    if (code !== 0) return 'install-failed';
  }
  return 'install-failed';
}

/** 生成 managed 后端更新参数，确保自动更新不会改装 PyPI 裸包。 */
export function buildManagedAutowsgrUpdateArgs(
  targetDir: string,
  forceInstall = false,
): string[] {
  return [
    '-m', 'pip', 'install',
    '--upgrade',
    ...(forceInstall ? ['--force-reinstall'] : []),
    '--target', targetDir,
    '--no-build-isolation',
    '--no-deps',
    '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
    '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
    MANAGED_AUTOWSGR_REQUIREMENT,
  ];
}

/** 依赖元数据无法读取时，回退给 pip 做一次完整兼容性解析。 */
function buildManagedDependencyRepairArgs(targetDir: string): string[] {
  return [
    '-m', 'pip', 'install',
    '--upgrade',
    '--upgrade-strategy', 'only-if-needed',
    '--target', targetDir,
    '--no-build-isolation',
    '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
    '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
    MANAGED_AUTOWSGR_REQUIREMENT,
  ];
}

/** 确保 managed 环境使用 GUI 明确支持的后端版本。 */
export async function autoUpdateAutowsgr(
  pythonCmd: string,
  deps: AutoUpdateDeps,
  forceInstall = false,
): Promise<string | null> {
  try {
    deps.sendProgress(
      forceInstall
        ? '正在强制更新个人分支 autowsgr…'
        : '正在检查 autowsgr 更新…',
    );

    // 单次 Python 调用检查本地版本、活动资源和 GUI 运行契约。
    const spFwd = deps.localSitePackages().replace(/\\/g, '\\\\');
    const checkScript = [
      'import json, sys',
      `sys.path.insert(0, r'${spFwd}')`,
      'result = {}',
      'try:',
      '    import autowsgr',
      '    from pathlib import Path',
      '    result["local"] = autowsgr.__version__',
      '    root = Path(autowsgr.__file__).resolve().parent',
      '    result["event20260730"] = (root / "data" / "map" / "event" / "20260730").is_dir()',
      'except:',
      '    result["local"] = None',
      '    result["event20260730"] = False',
      ...buildBackendRuntimeContractProbeLines(),
      'try:',
      '    _verify_gui_runtime_contract()',
      '    result["runtime_contract"] = True',
      'except Exception:',
      '    result["runtime_contract"] = False',
      'print(json.dumps(result))',
    ].join('\n');

    const scriptPath = path.join(deps.getTempDir(), 'autowsgr_update_check.py');
    fs.writeFileSync(scriptPath, checkScript, 'utf-8');

    const { stdout } = await execAsync(
      `"${pythonCmd}" "${scriptPath}"`,
      { windowsHide: true, timeout: 20000, env: deps.pipEnv() },
    );
    try { fs.unlinkSync(scriptPath); } catch { /* 忽略清理失败。 */ }

    const info = JSON.parse(stdout.trim());
    const localVer: string | null = info.local;
    const supportsLatestEvent = info.event20260730 === true;
    const supportsRuntimeContract = info.runtime_contract === true;

    if (
      !forceInstall
      &&
      localVer
      && supportsLatestEvent
      && supportsRuntimeContract
    ) {
      deps.sendProgress(`autowsgr ${localVer} 与 GUI 运行契约兼容 ✓`);
      return localVer;
    }

    const incompatibilities = [
      ...(!localVer ? ['未安装'] : []),
      ...(!supportsLatestEvent ? ['缺少 20260730 活动资源'] : []),
      ...(!supportsRuntimeContract ? ['缺少 GUI 运行契约'] : []),
    ];
    deps.sendProgress(
      forceInstall
        ? '正在重新安装本包指定的固定后端提交…'
        : `当前 autowsgr ${incompatibilities.join('、')}，正在安装 GUI 兼容版本…`,
    );
    const failureVersion = forceInstall ? null : localVer;
    const targetDir = deps.localSitePackages();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // 确保 pip 可用。
    if (!(await deps.ensurePip(pythonCmd))) {
      deps.sendProgress('WARNING pip 不可用，autowsgr 升级跳过');
      return failureVersion;
    }

    deps.sendProgress('正在检查后端构建依赖…');
    const buildRequirementState = await ensureRequirements(
      pythonCmd,
      deps,
      BACKEND_BUILD_REQUIREMENTS,
    );
    if (buildRequirementState === 'probe-failed') {
      const buildDepsCode = await runPip(
        pythonCmd,
        buildRequirementFallbackArgs(targetDir, BACKEND_BUILD_REQUIREMENTS),
        deps,
      );
      if (buildDepsCode !== 0) {
        deps.sendProgress('WARNING GUI 兼容后端构建依赖安装失败');
        return failureVersion;
      }
    } else if (buildRequirementState === 'install-failed') {
      deps.sendProgress('WARNING GUI 兼容后端构建依赖安装失败');
      return failureVersion;
    }
    deps.sendProgress('后端构建依赖已满足版本要求 ✓');

    const exitCode = await runPip(
      pythonCmd,
      buildManagedAutowsgrUpdateArgs(targetDir, forceInstall),
      deps,
    );

    if (exitCode !== 0) {
      deps.sendProgress('WARNING autowsgr 升级失败，使用当前版本继续');
      return failureVersion;
    }

    deps.sendProgress('正在核对后端依赖版本…');
    const runtimeRoots = [
      ...SHIP_LIBRARY_REQUIREMENTS,
      ...BACKEND_RUNTIME_REQUIREMENTS,
    ];
    const runtimeRequirementState = await ensureRequirements(
      pythonCmd,
      deps,
      runtimeRoots,
      true,
    );
    if (runtimeRequirementState === 'probe-failed') {
      const runtimeDepsCode = await runPip(
        pythonCmd,
        buildManagedDependencyRepairArgs(targetDir),
        deps,
      );
      if (runtimeDepsCode !== 0) {
        deps.sendProgress('WARNING 后端运行依赖安装失败');
        return failureVersion;
      }
    } else if (runtimeRequirementState === 'install-failed') {
      deps.sendProgress('WARNING 后端运行依赖安装失败');
      return failureVersion;
    }
    deps.sendProgress('后端运行依赖已满足版本要求 ✓');

    // 升级后一次性验证版本和关键依赖。
    const postScript = path.join(deps.getTempDir(), 'autowsgr_post_upgrade.py');
    fs.writeFileSync(postScript, [
      'import json, sys, site',
      `sys.path.insert(0, r'${spFwd}')`,
      `site.addsitedir(r'${spFwd}')`,
      'r = {"version": "unknown", "missing": []}',
      'try:',
      '    import autowsgr',
      '    from pathlib import Path',
      '    r["version"] = autowsgr.__version__',
      '    root = Path(autowsgr.__file__).resolve().parent',
      '    r["event20260730"] = (root / "data" / "map" / "event" / "20260730").is_dir()',
      'except: pass',
      ...buildBackendRuntimeContractProbeLines(),
      'try:',
      '    _verify_gui_runtime_contract()',
      '    r["runtime_contract"] = True',
      'except Exception:',
      '    r["runtime_contract"] = False',
      `checks = ${JSON.stringify(
        PYTHON_DEPENDENCY_SPECS.map(
          dependency => [dependency.importName, dependency.packageName],
        ),
      )}`,
      'for mod, package in checks:',
      '    try: __import__(mod)',
      '    except Exception: r["missing"].append(package)',
      'print(json.dumps(r))',
    ].join('\n'), 'utf-8');

    try {
      const { stdout: postOut } = await execAsync(
        `"${pythonCmd}" "${postScript}"`,
        { windowsHide: true, timeout: 15000, env: deps.pipEnv() },
      );
      try { fs.unlinkSync(postScript); } catch { /* 忽略清理失败。 */ }
      const postResult = JSON.parse(postOut.trim());
      const actualVer: string = postResult.version;
      const missing: string[] = postResult.missing;
      const eventReady = postResult.event20260730 === true;
      const runtimeContractReady = postResult.runtime_contract === true;

      if (!eventReady) {
        deps.sendProgress('WARNING GUI 兼容后端安装后仍缺少 20260730 活动资源');
        return failureVersion;
      }
      if (!runtimeContractReady) {
        deps.sendProgress('WARNING GUI 兼容后端安装后仍不支持运行契约');
        return failureVersion;
      }

      if (missing.length > 0) {
        deps.sendProgress(`升级后缺少依赖: ${missing.join(', ')}，正在补装…`);
        const fixCode = await new Promise<number>((resolve) => {
          const proc = spawn(pythonCmd, [
            '-m', 'pip', 'install',
            '--target', targetDir,
            '--force-reinstall', '--no-deps',
            '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
            '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
            ...missing,
          ], {
            cwd: deps.appRoot(),
            windowsHide: true,
            stdio: 'pipe',
            env: deps.pipEnv(),
          });
          proc.stdout?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) { if (l.trim()) deps.sendProgress(l.trim()); } });
          proc.stderr?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) { if (l.trim()) deps.sendProgress(l.trim()); } });
          proc.on('close', (code) => resolve(code ?? 1));
          proc.on('error', () => resolve(1));
        });

        if (fixCode !== 0) {
          await new Promise<void>((resolve) => {
            const proc = spawn(pythonCmd, [
              '-m', 'pip', 'install',
              '--target', targetDir,
              '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
              '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
              ...missing,
            ], {
              cwd: deps.appRoot(),
              windowsHide: true,
              stdio: 'pipe',
              env: deps.pipEnv(),
            });
            proc.stdout?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) { if (l.trim()) deps.sendProgress(l.trim()); } });
            proc.stderr?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) { if (l.trim()) deps.sendProgress(l.trim()); } });
            proc.on('close', () => resolve());
            proc.on('error', () => resolve());
          });
        }
        deps.sendProgress(`依赖补装完成 ✓`);
      }

      if (actualVer !== 'unknown') {
        deps.sendProgress(
          `autowsgr ${actualVer} GUI 兼容版本已安装 ✓`,
        );
        return actualVer;
      }
    } catch {
      try { fs.unlinkSync(postScript); } catch { /* 忽略清理失败。 */ }
    }

    deps.sendProgress('WARNING 无法验证 GUI 兼容后端安装结果');
    return failureVersion;
  } catch {
    deps.sendProgress('autowsgr 更新检查跳过（环境不可用或检查超时）');
    return null;
  }
}
