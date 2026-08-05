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

const execAsync = promisify(exec);

export interface AutoUpdateDeps {
  sendProgress: (msg: string) => void;
  getTempDir: () => string;
  appRoot: () => string;
  localSitePackages: () => string;
  pipEnv: () => NodeJS.ProcessEnv;
  ensurePip: (pythonCmd: string) => Promise<boolean>;
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
        ? '正在重新安装本包指定的个人分支后端…'
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

    const buildDepsCode = await new Promise<number>((resolve) => {
      const proc = spawn(pythonCmd, [
        '-m', 'pip', 'install',
        '--upgrade',
        '--target', targetDir,
        'hatchling',
        'hatch-vcs',
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
    if (buildDepsCode !== 0) {
      deps.sendProgress('WARNING GUI 兼容后端构建依赖安装失败');
      return failureVersion;
    }

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(
        pythonCmd,
        buildManagedAutowsgrUpdateArgs(targetDir, forceInstall),
        {
        cwd: deps.appRoot(),
        windowsHide: true,
        stdio: 'pipe',
        env: deps.pipEnv(),
        },
      );
      proc.stdout?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) { if (l.trim()) deps.sendProgress(l.trim()); } });
      proc.stderr?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) { if (l.trim()) deps.sendProgress(l.trim()); } });
      proc.on('close', (code) => resolve(code ?? 1));
      proc.on('error', () => resolve(1));
    });

    if (exitCode !== 0) {
      deps.sendProgress('WARNING autowsgr 升级失败，使用当前版本继续');
      return failureVersion;
    }

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
      "for m in ['fastapi', 'uvicorn']:",
      '    try: __import__(m)',
      '    except Exception: r["missing"].append(m)',
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
