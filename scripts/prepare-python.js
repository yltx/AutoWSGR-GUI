/**
 * 下载并准备 Python 3.12 便携版，用于打包进 Electron 应用。
 * 运行: node scripts/prepare-python.js
 *
 * 最终产物: python/ 目录，包含完整的嵌入式 Python + pip，
 * 由 electron-builder 作为 extraFiles 打包到安装包中。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PYTHON_VERSION = '3.12.8';
const ROOT = path.join(__dirname, '..');
const PYTHON_DIR = path.join(ROOT, 'python');
const PYTHON_EXE = path.join(PYTHON_DIR, 'python.exe');
const TEMP_DIR = path.join(ROOT, '.tmp');

function run(cmd, opts = {}) {
  console.log(`  > ${cmd}`);
  execSync(cmd, { stdio: 'inherit', windowsHide: true, timeout: 600000, ...opts });
}

function ensureVCRedist() {
  console.log('[5/5] 检查 VC++ Redistributable…');
  const redistDir = path.join(ROOT, 'redist');
  const redistExe = path.join(redistDir, 'vc_redist.x64.exe');
  if (fs.existsSync(redistExe)) {
    console.log('✓ vc_redist.x64.exe 已就绪');
    return;
  }

  console.log('  下载 vc_redist.x64.exe…');
  if (!fs.existsSync(redistDir)) fs.mkdirSync(redistDir, { recursive: true });
  try {
    run(`curl.exe -L -o "${redistExe}" "https://aka.ms/vs/17/release/vc_redist.x64.exe"`);
    console.log('✓ vc_redist.x64.exe 下载完成');
  } catch {
    console.error('✗ vc_redist.x64.exe 下载失败，请手动下载到 redist/ 目录');
    console.error('  URL: https://aka.ms/vs/17/release/vc_redist.x64.exe');
    process.exit(1);
  }
}

async function main() {
  // 如果已有完整的 python.exe + pip，只跳过 Python 下载。
  if (fs.existsSync(PYTHON_EXE)) {
    try {
      execSync(`"${PYTHON_EXE}" -m pip --version`, { windowsHide: true });
      console.log(`✓ Python ${PYTHON_VERSION} 已就绪，跳过下载`);
      ensureVCRedist();
      return;
    } catch { /* pip missing, re-setup */ }
  }

  console.log(`[1/4] 下载 Python ${PYTHON_VERSION} 嵌入式包…`);
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const zipUrl = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
  const zipPath = path.join(TEMP_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`);

  // 如果 zip 已存在（手动下载），跳过下载步骤
  if (fs.existsSync(zipPath)) {
    console.log('  zip 已存在，跳过下载');
  } else {
    run(`curl.exe -L -o "${zipPath}" "${zipUrl}"`);
  }

  console.log('[2/4] 解压…');
  // 清理旧目录（保留 site-packages）
  if (fs.existsSync(PYTHON_DIR)) {
    // 保留 site-packages 目录
    const entries = fs.readdirSync(PYTHON_DIR);
    for (const entry of entries) {
      if (entry === 'site-packages') continue;
      const full = path.join(PYTHON_DIR, entry);
      fs.rmSync(full, { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(PYTHON_DIR, { recursive: true });
  }

  run(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${PYTHON_DIR}' -Force"`);

  console.log('[3/4] 配置 ._pth 文件并安装 pip…');
  const pthFile = path.join(PYTHON_DIR, `python312._pth`);
  if (fs.existsSync(pthFile)) {
    let content = fs.readFileSync(pthFile, 'utf-8');
    // 去除可能的 BOM
    content = content.replace(/^\uFEFF/, '');
    content = content.replace(/^#\s*import site/m, 'import site');
    if (!content.includes('site-packages')) {
      content = content.trimEnd() + '\nsite-packages\n';
    }
    fs.writeFileSync(pthFile, content, { encoding: 'utf-8' });
  }

  const getPipPath = path.join(TEMP_DIR, 'get-pip.py');
  run(`curl.exe -sSL -o "${getPipPath}" "https://bootstrap.pypa.io/get-pip.py"`);
  run(`"${PYTHON_EXE}" "${getPipPath}"`);

  console.log('[4/5] 清理临时文件…');
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  // 验证
  try {
    execSync(`"${PYTHON_EXE}" -m pip --version`, { windowsHide: true });
    console.log(`✓ Python ${PYTHON_VERSION} + pip 准备完成`);
  } catch (e) {
    console.error('✗ pip 验证失败');
    process.exit(1);
  }

  ensureVCRedist();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
