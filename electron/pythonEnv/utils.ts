/**
 * 路径、环境工具函数与共享接口。
 */
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCtx } from './context';

const execAsync = promisify(exec);

const CERT_ENV_KEYS: Array<keyof NodeJS.ProcessEnv> = [
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'PIP_CERT',
  'CURL_CA_BUNDLE',
];

const certFileCache = new Map<string, string | null>();

// 共享接口

export interface EnvCheckResult {
  pythonCmd: string | null;
  pythonVersion: string | null;
  missingPackages: string[];
  allReady: boolean;
}

// 路径工具

/** 返回项目本地包目录。 */
export function localSitePackages(): string {
  return path.join(getCtx().appRoot(), 'python', 'site-packages');
}

/** 构造优先使用项目包目录的 pip 环境。 */
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

function isExistingFile(filePath: string | undefined): filePath is string {
  return !!filePath && fs.existsSync(filePath);
}

function pickExistingCertFromEnv(): string | null {
  for (const key of CERT_ENV_KEYS) {
    const value = process.env[key];
    if (isExistingFile(value)) return value;
  }
  return null;
}

function scriptPathForProbe(): string {
  const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return path.join(getCtx().getTempDir(), `autowsgr_cert_probe_${token}.py`);
}

async function probePythonCertFile(pythonCmd: string): Promise<string | null> {
  const cached = certFileCache.get(pythonCmd);
  if (cached !== undefined) return cached;

  const scriptPath = scriptPathForProbe();
  const scriptContent = [
    'import json, os, ssl',
    'candidates = []',
    'for k in ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_CERT", "CURL_CA_BUNDLE"]:',
    '    p = os.environ.get(k)',
    '    if p: candidates.append(p)',
    'try:',
    '    dv = ssl.get_default_verify_paths()',
    '    for p in [dv.cafile, dv.openssl_cafile]:',
    '        if p: candidates.append(p)',
    'except Exception:',
    '    pass',
    'try:',
    '    import certifi',
    '    candidates.append(certifi.where())',
    'except Exception:',
    '    pass',
    'try:',
    '    import pip._vendor.certifi as pip_certifi',
    '    candidates.append(pip_certifi.where())',
    'except Exception:',
    '    pass',
    'resolved = None',
    'for p in candidates:',
    '    if p and os.path.exists(p):',
    '        resolved = p',
    '        break',
    'print(json.dumps({"cert_file": resolved}))',
  ].join('\n');

  try {
    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
    const { stdout } = await execAsync(`"${pythonCmd}" "${scriptPath}"`, {
      windowsHide: true,
      timeout: 12000,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    const parsed = JSON.parse(stdout.trim()) as { cert_file?: unknown };
    const certFile = typeof parsed.cert_file === 'string' ? parsed.cert_file.trim() : '';
    if (isExistingFile(certFile)) {
      certFileCache.set(pythonCmd, certFile);
      return certFile;
    }
  } catch {
    // 探测失败时由调用方继续使用原环境。
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* 忽略清理失败。 */ }
  }

  certFileCache.set(pythonCmd, null);
  return null;
}

/** 沿用或探测证书，并补齐 Python TLS 环境变量。 */
export async function ensureSslCertForPython(pythonCmd: string): Promise<string | null> {
  const existing = pickExistingCertFromEnv();
  const certFile = existing || await probePythonCertFile(pythonCmd);
  if (!certFile) return null;

  if (!isExistingFile(process.env.SSL_CERT_FILE)) process.env.SSL_CERT_FILE = certFile;
  if (!isExistingFile(process.env.REQUESTS_CA_BUNDLE)) process.env.REQUESTS_CA_BUNDLE = certFile;
  if (!isExistingFile(process.env.PIP_CERT)) process.env.PIP_CERT = certFile;
  if (!isExistingFile(process.env.CURL_CA_BUNDLE)) process.env.CURL_CA_BUNDLE = certFile;

  return certFile;
}

/** 判断是否使用本地便携版 Python。 */
export function isLocalPython(pythonCmd: string): boolean {
  if (!path.isAbsolute(pythonCmd)) return false;
  const pythonRoot = path.resolve(getCtx().appRoot(), 'python');
  const relative = path.relative(pythonRoot, path.resolve(pythonCmd));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

// ._pth 配置

/** 确保嵌入式 Python 的 ._pth 包含 site-packages。 */
export function ensurePthFile(): void {
  const pythonDir = path.join(getCtx().appRoot(), 'python');
  for (const pthName of ['python312._pth', 'python313._pth']) {
    const pthFile = path.join(pythonDir, pthName);
    if (!fs.existsSync(pthFile)) continue;
    let content = fs.readFileSync(pthFile, 'utf-8');
    let changed = false;
    // 去除可能存在的 BOM。
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

// pip 管理

/** 确保 pip 可用，缺失时自动安装。 */
export async function ensurePip(pythonCmd: string): Promise<boolean> {
  const ctx = getCtx();
  try {
    await execAsync(`"${pythonCmd}" -m pip --version`, { windowsHide: true, timeout: 15000 });
    return true;
  } catch { /* pip 不可用时继续安装。 */ }

  if (isLocalPython(pythonCmd)) ensurePthFile();

  ctx.sendProgress('pip 未就绪，正在安装…');
  const getPipPath = path.join(ctx.getTempDir(), 'get-pip.py');
  try {
    await execAsync(`curl -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`, { windowsHide: true, timeout: 60000 });
    await execAsync(`"${pythonCmd}" "${getPipPath}"`, { windowsHide: true, timeout: 120000 });
    try { fs.unlinkSync(getPipPath); } catch { /* 忽略清理失败。 */ }
    ctx.sendProgress('pip 安装完成 ✓');
    return true;
  } catch {
    ctx.sendProgress('ERROR pip 安装失败');
    try { fs.unlinkSync(getPipPath); } catch { /* 忽略清理失败。 */ }
    return false;
  }
}
