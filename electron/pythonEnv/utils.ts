/**
 * 路径、环境工具函数与共享接口。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCtx } from './context';

const execAsync = promisify(exec);

// ════════════════════════════════════════
// 共享接口
// ════════════════════════════════════════

export interface EnvCheckResult {
  pythonCmd: string | null;
  pythonVersion: string | null;
  missingPackages: string[];
  allReady: boolean;
}

// ════════════════════════════════════════
// 路径工具
// ════════════════════════════════════════

/** 项目本地包目录 */
export function localSitePackages(): string {
  return path.join(getCtx().appRoot(), 'python', 'site-packages');
}

/** 生成在 Python 命令前插入 site-packages 路径的前缀代码 */
export function sysPathInsert(): string {
  // 使用 sys.path.insert 而非 PYTHONPATH 环境变量，因为：
  // 1. 嵌入式 Python 的 ._pth 会完全忽略 PYTHONPATH
  // 2. 避免 Windows 环境变量传递的各种边界问题
  const sp = localSitePackages().replace(/\\/g, '\\\\');
  return `import sys; sys.path.insert(0, r'${sp}'); `;
}

/** pip 命令的公共环境变量：确保项目目录的包优先于全局 */
export function pipEnv(): NodeJS.ProcessEnv {
  const localSite = localSitePackages();
  const existing = process.env.PYTHONPATH || '';
  return {
    ...process.env,
    PYTHONUSERBASE: path.join(getCtx().appRoot(), 'python'),
    PYTHONPATH: existing
      ? `${localSite}${path.delimiter}${existing}`
      : localSite,
  };
}

/** 判断是否使用本地便携版 Python */
export function isLocalPython(pythonCmd: string): boolean {
  return path.isAbsolute(pythonCmd) && pythonCmd.startsWith(getCtx().appRoot());
}

// ════════════════════════════════════════
// ._pth 配置
// ════════════════════════════════════════

/** 确保嵌入式 Python 的 ._pth 包含 site-packages（每次检查前都执行） */
export function ensurePthFile(): void {
  const pythonDir = path.join(getCtx().appRoot(), 'python');
  for (const pthName of ['python312._pth', 'python313._pth']) {
    const pthFile = path.join(pythonDir, pthName);
    if (!fs.existsSync(pthFile)) continue;
    let content = fs.readFileSync(pthFile, 'utf-8');
    let changed = false;
    // 去除可能的 BOM
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
      changed = true;
    }
    if (/^#\s*import site/m.test(content)) {
      content = content.replace(/^#\s*import site/m, 'import site');
      changed = true;
    }
    if (!content.includes('site-packages')) {
      content = content.trimEnd() + '\nsite-packages\n';
      changed = true;
    }
    if (changed) fs.writeFileSync(pthFile, content, 'utf-8');
  }
}

// ════════════════════════════════════════
// pip 管理
// ════════════════════════════════════════

/** 确保 pip 可用，缺失时自动安装 */
export async function ensurePip(pythonCmd: string): Promise<boolean> {
  const ctx = getCtx();
  try {
    await execAsync(`"${pythonCmd}" -m pip --version`, { windowsHide: true, timeout: 15000 });
    return true;
  } catch { /* pip not available */ }

  if (isLocalPython(pythonCmd)) ensurePthFile();

  ctx.sendProgress('pip 未就绪，正在安装…');
  const getPipPath = path.join(ctx.getTempDir(), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonCmd}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
    try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }
    ctx.sendProgress('pip 安装完成 ✓');
    return true;
  } catch {
    ctx.sendProgress('ERROR pip 安装失败');
    try { fs.unlinkSync(getPipPath); } catch { /* ignore */ }
    return false;
  }
}
