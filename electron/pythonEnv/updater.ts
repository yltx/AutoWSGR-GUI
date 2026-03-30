/**
 * autowsgr 自动更新逻辑。
 * 使用依赖注入，不直接依赖 context 模块。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface AutoUpdateDeps {
  sendProgress: (msg: string) => void;
  getTempDir: () => string;
  appRoot: () => string;
  localSitePackages: () => string;
  pipEnv: () => NodeJS.ProcessEnv;
  ensurePip: (pythonCmd: string) => Promise<boolean>;
}

/** 检查 autowsgr 是否有 PyPI 更新，有则自动升级；返回最终的已安装版本 */
export async function autoUpdateAutowsgr(pythonCmd: string, deps: AutoUpdateDeps): Promise<string | null> {
  try {
    deps.sendProgress('正在检查 autowsgr 更新…');

    // 单次 Python 调用: 获取本地版本 + PyPI 最新版本
    const spFwd = deps.localSitePackages().replace(/\\/g, '\\\\');
    const checkScript = [
      'import json, sys',
      `sys.path.insert(0, r'${spFwd}')`,
      'result = {}',
      'try:',
      '    import autowsgr; result["local"] = autowsgr.__version__',
      'except: result["local"] = None',
      'try:',
      '    import urllib.request',
      '    data = json.loads(urllib.request.urlopen("https://pypi.org/pypi/autowsgr/json", timeout=10).read())',
      '    result["latest"] = data["info"]["version"]',
      'except: result["latest"] = None',
      'print(json.dumps(result))',
    ].join('\n');

    const scriptPath = path.join(deps.getTempDir(), 'autowsgr_update_check.py');
    fs.writeFileSync(scriptPath, checkScript, 'utf-8');

    const { stdout } = await execAsync(
      `"${pythonCmd}" "${scriptPath}"`,
      { windowsHide: true, timeout: 20000, env: deps.pipEnv() },
    );
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }

    const info = JSON.parse(stdout.trim());
    const localVer: string | null = info.local;
    const latestVer: string | null = info.latest;

    if (!latestVer) {
      deps.sendProgress('autowsgr 更新检查跳过（无法获取最新版本信息）');
      return localVer;
    }

    if (localVer === latestVer) {
      deps.sendProgress(`autowsgr ${localVer} 已是最新版 ✓`);
      return localVer;
    }

    // 有更新，自动升级
    deps.sendProgress(`发现 autowsgr 更新: ${localVer ?? '未安装'} → ${latestVer}，正在自动升级…`);
    const targetDir = deps.localSitePackages();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // 清理旧版 autowsgr 文件，避免 pip --target 的 dist-info 残留导致版本检测错误
    try {
      for (const entry of fs.readdirSync(targetDir)) {
        if (entry === 'autowsgr' || entry.startsWith('autowsgr-')) {
          fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
        }
      }
    } catch { /* ignore cleanup errors */ }

    // 确保 pip 可用
    if (!(await deps.ensurePip(pythonCmd))) {
      deps.sendProgress('WARNING pip 不可用，autowsgr 升级跳过');
      return localVer;
    }

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(pythonCmd, [
        '-m', 'pip', 'install',
        '--target', targetDir,
        '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
        '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
        'autowsgr',
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

    if (exitCode !== 0) {
      deps.sendProgress('WARNING autowsgr 升级失败，使用当前版本继续');
      return localVer;
    }

    // 升级后：单次 Python 调用验证版本 + 关键依赖
    const postScript = path.join(deps.getTempDir(), 'autowsgr_post_upgrade.py');
    fs.writeFileSync(postScript, [
      'import json, sys, site',
      `sys.path.insert(0, r'${spFwd}')`,
      `site.addsitedir(r'${spFwd}')`,
      'r = {"version": "unknown", "missing": []}',
      'try:',
      '    import autowsgr; r["version"] = autowsgr.__version__',
      'except: pass',
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
      try { fs.unlinkSync(postScript); } catch { /* ignore */ }
      const postResult = JSON.parse(postOut.trim());
      const actualVer: string = postResult.version;
      const missing: string[] = postResult.missing;

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
        const msg = actualVer === latestVer
          ? `autowsgr 已升级至 ${latestVer} ✓`
          : `autowsgr 已升级至 ${actualVer}（期望 ${latestVer}）`;
        deps.sendProgress(msg);
        return actualVer;
      }
    } catch {
      try { fs.unlinkSync(postScript); } catch { /* ignore */ }
    }

    deps.sendProgress(`autowsgr 已升级至 ${latestVer} ✓`);
    return latestVer;
  } catch {
    deps.sendProgress('autowsgr 更新检查跳过（网络不可用或超时）');
    return null;
  }
}
