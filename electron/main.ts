/**
 * Electron 主进程。
 * 负责创建窗口、注册 IPC handler。
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import * as yaml from 'js-yaml';
import {
  initPythonEnv, clearPythonCache,
  isAllowedPythonVersion, findPython, checkEnvironment,
  checkForUpdates, installDependencies, installPortablePython,
  pullUpdates, ensurePip, localSitePackages, pipEnv,
} from './pythonEnv';
import { detectEmulator } from './emulatorDetect';
import { initBackend, getBackendProcess, startBackend, stopBackend, runSetupScript } from './backend';

const execAsync = promisify(exec);

/** GUI 设置文件路径（延迟到 app ready 后才有效，先用函数） */
function guiSettingsPath(): string {
  return path.join(appRoot(), 'gui_settings.json');
}

/** 读取 GUI 设置 */
function readGuiSettings(): Record<string, unknown> {
  try {
    const p = guiSettingsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

/** 写入 GUI 设置（合并） */
function writeGuiSettings(patch: Record<string, unknown>): void {
  const cur = readGuiSettings();
  Object.assign(cur, patch);
  fs.writeFileSync(guiSettingsPath(), JSON.stringify(cur, null, 2), 'utf-8');
}

/** 后端端口：环境变量 > gui_settings.json > 默认 8438 */
function getBackendPort(): number {
  if (process.env.AUTOWSGR_PORT) {
    return parseInt(process.env.AUTOWSGR_PORT, 10);
  }
  const settings = readGuiSettings();
  if (typeof settings.backend_port === 'number' && settings.backend_port > 0 && settings.backend_port < 65536) {
    return settings.backend_port;
  }
  return 8438;
}

const BACKEND_PORT = getBackendPort();

/** 用户配置的 Python 路径：gui_settings.json > null (自动检测) */
function getConfiguredPythonPath(): string | null {
  const settings = readGuiSettings();
  if (typeof settings.python_path === 'string' && settings.python_path.length > 0) {
    return settings.python_path;
  }
  return null;
}

function getUpdateMode(): 'auto' | 'manual' {
  const settings = readGuiSettings();
  return settings.update_mode === 'manual' ? 'manual' : 'auto';
}

type BackendStartupMode = 'managed' | 'external';
type OcrGpuMode = 'auto' | 'cpu' | 'cuda';

function getBackendStartupMode(): BackendStartupMode {
  const settings = readGuiSettings();
  return settings.backend_startup_mode === 'external' ? 'external' : 'managed';
}

function getBackendRepoPath(): string {
  const settings = readGuiSettings();
  if (typeof settings.backend_repo_path !== 'string') return '';
  return settings.backend_repo_path.trim();
}

function getOcrGpuMode(): OcrGpuMode {
  const settings = readGuiSettings();
  const value = typeof settings.ocr_gpu_mode === 'string' ? settings.ocr_gpu_mode : '';
  if (value === 'cpu' || value === 'cuda') return value;
  return 'auto';
}

function getCudaPath(): string {
  const settings = readGuiSettings();
  if (typeof settings.cuda_path !== 'string') return '';
  return settings.cuda_path.trim();
}

function normalizeCudaPath(candidate: string): string {
  const resolved = path.resolve(candidate.trim());
  if (findCudaRuntimeDll(resolved)) return resolved;
  return path.basename(resolved).toLowerCase() === 'bin' ? path.dirname(resolved) : resolved;
}

function findCudaRuntimeDll(directory: string): boolean {
  try {
    const names = fs.readdirSync(directory);
    return names.some(name => /^cudart64.*\.dll$/i.test(name))
      && names.some(name => /^cublas64.*\.dll$/i.test(name));
  } catch {
    return false;
  }
}

function validateCudaPath(candidate: string): { valid: boolean; path: string; version: string | null; kind?: 'toolkit' | 'runtime'; error?: string } {
  if (!candidate.trim()) return { valid: false, path: '', version: null, error: '路径为空' };
  const cudaRoot = normalizeCudaPath(candidate);
  if (!fs.existsSync(cudaRoot)) return { valid: false, path: cudaRoot, version: null, error: '目录不存在' };
  const binDir = path.join(cudaRoot, 'bin');
  const isToolkit = fs.existsSync(path.join(binDir, 'nvcc.exe'));
  const runtimeDir = findCudaRuntimeDll(cudaRoot)
    ? cudaRoot
    : findCudaRuntimeDll(binDir)
      ? binDir
      : null;
  if (!isToolkit && !runtimeDir) {
    return { valid: false, path: cudaRoot, version: null, error: '未找到 CUDA Toolkit（bin\\nvcc.exe）或 PyTorch CUDA Runtime DLL' };
  }

  let version: string | null = null;
  try {
    const versionJson = path.join(cudaRoot, 'version.json');
    if (fs.existsSync(versionJson)) {
      const raw = JSON.parse(fs.readFileSync(versionJson, 'utf-8').replace(/^\uFEFF/, '')) as Record<string, any>;
      version = raw.cuda?.version ?? raw.cuda_cudart?.version ?? null;
    }
  } catch { /* use directory name fallback */ }
  version ??= path.basename(cudaRoot).match(/v\d+(?:\.\d+)?/i)?.[0] ?? null;
  if (isToolkit) return { valid: true, path: cudaRoot, version, kind: 'toolkit' };

  let runtimeVersion: string | null = null;
  try {
    const cudart = fs.readdirSync(runtimeDir!).find(name => /^cudart64.*\.dll$/i.test(name));
    runtimeVersion = cudart?.match(/^cudart64[_-]?(\d+)/i)?.[1] ?? null;
    if (runtimeVersion?.length === 2) runtimeVersion = `${runtimeVersion[0]}.${runtimeVersion[1]}`;
    else if (runtimeVersion?.length === 3) runtimeVersion = `${runtimeVersion.slice(0, 2)}.${runtimeVersion[2]}`;
  } catch { /* version remains unknown */ }
  return { valid: true, path: runtimeDir!, version: runtimeVersion, kind: 'runtime' };
}

function getSaveBackendScreenshots(): boolean {
  const settings = readGuiSettings();
  return settings.save_backend_screenshots === true;
}

let mainWindow: BrowserWindow | null = null;

/** 是否处于打包后的生产模式 */
function isPackaged(): boolean {
  return app.isPackaged;
}

/**
 * 应用工作目录（外部可写文件：autowsgr/、usersettings.yaml 等）：
 * - 开发模式: 项目根目录
 * - 打包模式: exe 所在目录
 */
function appRoot(): string {
  if (isPackaged()) {
    return path.dirname(app.getPath('exe'));
  }
  return path.join(__dirname, '..', '..');
}

/** extraResources 目录 (resource/, plans/, setup.bat) */
function resourceRoot(): string {
  if (isPackaged()) {
    return process.resourcesPath;
  }
  return path.join(__dirname, '..', '..');
}

/** 将相对路径解析为绝对路径 */
function resolveAppPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  // resource/ 在打包后位于 extraResources（只读）
  if (filePath.startsWith('resource')) {
    return path.join(resourceRoot(), filePath);
  }
  // plans/ 及其他文件在 appRoot（可写，用户数据不会被覆盖安装覆盖）
  return path.join(appRoot(), filePath);
}

/**
 * 初始化用户方案目录：将 extraResources 中的默认方案
 * 复制到 appRoot/plans（不覆盖已有文件，保留用户自定义方案）。
 */
function initUserPlansDir(): void {
  const bundledDir = path.join(resourceRoot(), 'plans');
  const userDir = path.join(appRoot(), 'plans');
  if (!fs.existsSync(bundledDir)) return;
  copyDirNoOverwrite(bundledDir, userDir);
}

/** 递归复制目录，跳过已存在的文件 */
function copyDirNoOverwrite(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirNoOverwrite(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

interface ShipLibraryStatus {
  exists: boolean;
  path: string;
  generatedAt?: string;
  shipCount: number;
  assetCount: number;
  missingAssets: number;
  error?: string;
}

interface ShipLibraryUpdateResult {
  success: boolean;
  output?: string;
  generated_at?: string;
  ship_count?: number;
  asset_count?: number;
  added?: number;
  updated?: number;
  removed?: number;
  downloaded?: number;
  failed?: number;
  failures?: string[];
  error?: string;
}

interface ShipLibraryManifest {
  schemaVersion: number;
  generatedAt: string;
  labels: Record<string, unknown>;
  typeGroups: Record<string, unknown>;
  ships: Array<Record<string, unknown>>;
}

/** 当前可写的舰船资料库目录。 */
function shipLibraryDir(): string {
  if (isPackaged()) {
    return path.join(app.getPath('userData'), 'ship-library');
  }
  return path.join(resourceRoot(), 'resource', 'ship-library');
}

/** 打包后将内置资料库复制到用户目录，已有文件不覆盖。 */
function initUserShipLibraryDir(): void {
  if (!isPackaged()) return;
  const bundledDir = path.join(resourceRoot(), 'resource', 'ship-library');
  if (fs.existsSync(bundledDir)) {
    copyDirNoOverwrite(bundledDir, shipLibraryDir());
  }
}

const ALLOWED_FLEET_SHIP_TYPES = new Set([
  'dd',
  'cl',
  'ca',
  'cav',
  'clt',
  'bb',
  'bc',
  'bbv',
  'cv',
  'cvl',
  'av',
  'ss',
  'ssg',
  'cg',
  'cgaa',
  'ddg',
  'ddgaa',
  'bm',
  'cbg',
  'cf',
  'ss_or_ssg',
]);
const TEAM_FILE_PATTERN = /^team[-_][^\\/]+\.ya?ml$/i;

interface UserTeamShipRule {
  name: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
}

interface UserTeamPlanSlot {
  name?: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  candidates?: UserTeamShipRule[];
}

interface UserTeamPlan {
  file?: string;
  name: string;
  ships: UserTeamPlanSlot[];
}

/** 用户编队目录在开发模式下固定为 resource/user_team_plans。 */
function userTeamPlansDir(): string {
  return path.join(
    isPackaged() ? appRoot() : resourceRoot(),
    'resource',
    'user_team_plans',
  );
}

function initUserTeamPlansDir(): void {
  fs.mkdirSync(userTeamPlansDir(), { recursive: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${field} 必须是大于或等于 1 的整数`);
  }
  return Number(value);
}

function normalizeUserTeamShipTypes(
  raw: unknown,
  field: string,
): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const values = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${field} 必须是非空字符串列表`);
  }
  const result = values.map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${field} 必须是非空字符串列表`);
    }
    const shipType = value.trim().toLowerCase();
    if (!ALLOWED_FLEET_SHIP_TYPES.has(shipType)) {
      throw new Error(`${field} 不符合后端接口: ${shipType}`);
    }
    return shipType;
  });
  return [...new Set(result)];
}

/** 校验一艘主选或备选舰船自己的规则。 */
function normalizeUserTeamShipRule(
  raw: unknown,
  field: string,
): UserTeamShipRule {
  if (!isPlainObject(raw)) throw new Error(`${field} 必须是对象`);
  const allowedKeys = new Set([
    'name',
    'search_name',
    'ship_type',
    'min_level',
    'max_level',
  ]);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) {
    throw new Error(`${field} 包含后端不支持的字段`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error(`${field}.name 必须是非空字符串`);
  }

  const result: UserTeamShipRule = { name: raw.name.trim() };
  if (raw.search_name !== undefined) {
    if (typeof raw.search_name !== 'string' || !raw.search_name.trim()) {
      throw new Error(`${field}.search_name 必须是非空字符串`);
    }
    result.search_name = raw.search_name.trim();
  }
  const shipTypes = normalizeUserTeamShipTypes(
    raw.ship_type,
    `${field}.ship_type`,
  );
  if (shipTypes) result.ship_type = shipTypes;
  const minLevel = positiveInteger(raw.min_level, `${field}.min_level`);
  const maxLevel = positiveInteger(raw.max_level, `${field}.max_level`);
  if (minLevel !== undefined) result.min_level = minLevel;
  if (maxLevel !== undefined) result.max_level = maxLevel;
  if (
    minLevel !== undefined
    && maxLevel !== undefined
    && maxLevel < minLevel
  ) {
    throw new Error(`${field}.max_level 必须大于或等于 min_level`);
  }
  return result;
}

/** 校验单个位置；主选可以为空，但位置必须至少包含一艘主选或备选。 */
function normalizeUserTeamSlot(raw: unknown): UserTeamPlanSlot | null {
  if (raw === null) return null;
  if (!isPlainObject(raw)) throw new Error('ships 中的位置必须是对象');
  const allowedKeys = new Set([
    'name',
    'candidates',
    'search_name',
    'ship_type',
    'min_level',
    'max_level',
  ]);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) {
    throw new Error('位置包含后端不支持的字段');
  }
  if (raw.candidates !== undefined && !Array.isArray(raw.candidates)) {
    throw new Error('candidates 必须是列表');
  }

  const candidates = (raw.candidates ?? []).map(
    (candidate: unknown, index: number) => normalizeUserTeamShipRule(
      candidate,
      `candidates[${index}]`,
    ),
  );
  const hasPrimary = typeof raw.name === 'string' && Boolean(raw.name.trim());
  if (!hasPrimary) {
    if (
      raw.search_name !== undefined
      || raw.ship_type !== undefined
      || raw.min_level !== undefined
      || raw.max_level !== undefined
    ) {
      throw new Error('没有主选 name 时不能填写主选规则');
    }
    if (candidates.length === 0) {
      throw new Error('位置至少需要一艘主选或备选舰船');
    }
    return { candidates };
  }

  const { candidates: _ignored, ...primaryFields } = raw;
  const result: UserTeamPlanSlot = {
    ...normalizeUserTeamShipRule(primaryFields, '主选'),
  };
  if (candidates.length > 0) result.candidates = candidates;
  return result;
}

/** 校验独立编队文件：一个名称对应一支最多六个位置的舰队。 */
function normalizeUserTeamPlan(raw: unknown): UserTeamPlan {
  if (!isPlainObject(raw)) throw new Error('编队 YAML 根节点必须是对象');
  const allowedKeys = new Set(['name', 'ships']);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) {
    throw new Error('编队 YAML 包含不支持的根字段');
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error('name 不能为空');
  }
  if (!Array.isArray(raw.ships) || raw.ships.length < 1 || raw.ships.length > 6) {
    throw new Error('ships 必须包含 1 到 6 个位置');
  }
  const ships = raw.ships
    .map(normalizeUserTeamSlot)
    .filter((slot): slot is UserTeamPlanSlot => slot !== null);
  if (ships.length === 0) {
    throw new Error('ships 至少需要一个有效位置');
  }
  return { name: raw.name.trim(), ships };
}

/** 使用行内 YAML 表示列表或备选对象，避免备选较多时纵向膨胀。 */
function inlineYaml(value: unknown): string {
  return yaml.dump(value, {
    flowLevel: 0,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }).trim();
}

/** 主选分行输出；纯备选位置不写 name，单个备选保持在同一行。 */
function serializeUserTeamPlan(plan: UserTeamPlan): string {
  const lines = [
    `name: ${inlineYaml(plan.name)}`,
    'ships:',
  ];
  for (const slot of plan.ships) {
    if (slot.name !== undefined) {
      lines.push(`  - name: ${inlineYaml(slot.name)}`);
      if (slot.search_name !== undefined) {
        lines.push(`    search_name: ${inlineYaml(slot.search_name)}`);
      }
      if (slot.ship_type !== undefined) {
        lines.push(`    ship_type: ${inlineYaml(slot.ship_type)}`);
      }
      if (slot.min_level !== undefined) {
        lines.push(`    min_level: ${slot.min_level}`);
      }
      if (slot.max_level !== undefined) {
        lines.push(`    max_level: ${slot.max_level}`);
      }
    }
    if (slot.candidates?.length) {
      lines.push(slot.name === undefined ? '  - candidates:' : '    candidates:');
      for (const candidate of slot.candidates) {
        lines.push(`      - ${inlineYaml(candidate)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function teamFileName(name: string): string {
  const safeName = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  if (!safeName) throw new Error('编队预设名称不能用于文件名');
  return `team-${safeName}.yaml`;
}

function atomicWrite(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf-8');
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fs.renameSync(temporary, filePath);
  }
}

function readUserTeamPlan(filePath: string): UserTeamPlan {
  return normalizeUserTeamPlan(
    yaml.load(fs.readFileSync(filePath, 'utf-8')),
  );
}

function yamlFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(file => /\.ya?ml$/i.test(file))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

/** 只列出用户编队目录中命名和内容均合法的编队文件。 */
function listUserTeamPlans(): {
  plans: UserTeamPlan[];
  errors: string[];
} {
  const directory = userTeamPlansDir();
  const plans: UserTeamPlan[] = [];
  const errors: string[] = [];
  for (const file of yamlFiles(directory)) {
    if (!TEAM_FILE_PATTERN.test(file)) continue;
    try {
      const plan = readUserTeamPlan(path.join(directory, file));
      plans.push({ ...plan, file });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${file}: ${message}`);
    }
  }
  return { plans, errors };
}

/** 读取清单，为配置页提供当前资料库状态。 */
function getShipLibraryStatus(): ShipLibraryStatus {
  const directory = shipLibraryDir();
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      exists: false,
      path: directory,
      shipCount: 0,
      assetCount: 0,
      missingAssets: 0,
    };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      generated_at?: unknown;
      counts?: Record<string, unknown>;
    };
    const counts = manifest.counts ?? {};
    return {
      exists: true,
      path: directory,
      generatedAt: typeof manifest.generated_at === 'string' ? manifest.generated_at : undefined,
      shipCount: typeof counts.ships === 'number' ? counts.ships : 0,
      assetCount: typeof counts.assets === 'number' ? counts.assets : 0,
      missingAssets: typeof counts.missing_assets === 'number' ? counts.missing_assets : 0,
    };
  } catch (error) {
    return {
      exists: false,
      path: directory,
      shipCount: 0,
      assetCount: 0,
      missingAssets: 0,
      error: `资料库清单读取失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function shipAssetUrl(relativePath: unknown): string {
  if (typeof relativePath !== 'string' || !relativePath) return '';
  const root = path.resolve(shipLibraryDir());
  const absolutePath = path.resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) return '';
  return pathToFileURL(absolutePath).href;
}

/** 只向渲染进程提供舰队规划需要的清单字段和本地资源 URL。 */
function getShipLibraryManifest(): ShipLibraryManifest {
  const manifestPath = path.join(shipLibraryDir(), 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('舰船资料库尚未建立，请先在配置页更新舰船数据库');
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    schema_version?: unknown;
    generated_at?: unknown;
    labels?: unknown;
    type_groups?: unknown;
    ships?: unknown;
  };
  if (!Array.isArray(raw.ships)) {
    throw new Error('舰船资料库清单格式无效');
  }
  return {
    schemaVersion: typeof raw.schema_version === 'number' ? raw.schema_version : 0,
    generatedAt: typeof raw.generated_at === 'string' ? raw.generated_at : '',
    labels: raw.labels && typeof raw.labels === 'object'
      ? raw.labels as Record<string, unknown>
      : {},
    typeGroups: raw.type_groups && typeof raw.type_groups === 'object'
      ? raw.type_groups as Record<string, unknown>
      : {},
    ships: raw.ships.map((entry) => {
      const ship = entry && typeof entry === 'object'
        ? entry as Record<string, unknown>
        : {};
      return {
        ...ship,
        portraitUrl: shipAssetUrl(ship.portrait),
        backgroundUrl: shipAssetUrl(ship.background),
        frameUrl: shipAssetUrl(ship.frame),
        typeIconUrl: shipAssetUrl(ship.type_icon),
      };
    }),
  };
}

function shipLibraryUpdaterPath(): string {
  const root = isPackaged() ? resourceRoot() : appRoot();
  return path.join(root, 'tools', 'ship_library', 'update_ship_library.py');
}

function sendShipLibraryProgress(message: string): void {
  mainWindow?.webContents.send('ship-library-update-progress', { message });
}

function runPython(
  pythonCmd: string,
  args: string[],
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(pythonCmd, args, {
      cwd: appRoot(),
      windowsHide: true,
      env: pipEnv(),
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', (error) => {
      resolve({ code: 1, output: error.message });
    });
    child.once('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

function shipLibraryPythonBootstrap(): string {
  const sitePackages = localSitePackages()
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
  return [
    'import runpy, site, sys',
    `sp = r'${sitePackages}'`,
    'sys.path.insert(0, sp)',
    'site.addsitedir(sp)',
    'script = sys.argv.pop(1)',
    "runpy.run_path(script, run_name='__main__')",
  ].join('; ');
}

/** 确保更新器依赖安装在 GUI 自己的 Python 包目录中。 */
async function ensureShipLibraryUpdaterDependencies(
  pythonCmd: string,
): Promise<string | null> {
  const probe = await runPython(pythonCmd, [
    '-c',
    [
      'import site, sys',
      `sp = r'${localSitePackages().replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
      'sys.path.insert(0, sp)',
      'site.addsitedir(sp)',
      'import requests, bs4',
    ].join('; '),
  ]);
  if (probe.code === 0) return null;

  sendShipLibraryProgress('正在安装舰船数据库更新依赖…');
  if (!(await ensurePip(pythonCmd))) {
    return '舰船数据库更新依赖安装失败：当前 Python 无法使用 pip';
  }
  fs.mkdirSync(localSitePackages(), { recursive: true });
  const install = await runPython(pythonCmd, [
    '-m',
    'pip',
    'install',
    '--target',
    localSitePackages(),
    'requests',
    'beautifulsoup4',
  ]);
  if (install.code !== 0) {
    return `舰船数据库更新依赖安装失败: ${install.output.trim().slice(-500)}`;
  }
  return null;
}

/** 使用当前 GUI Python 环境执行增量更新，并解析脚本的机器可读结果。 */
async function runShipLibraryUpdate(): Promise<ShipLibraryUpdateResult> {
  const pythonCmd = await findPython();
  if (!pythonCmd) {
    return { success: false, error: '找不到可用的 Python 3.12 或 3.13' };
  }
  const updaterPath = shipLibraryUpdaterPath();
  if (!fs.existsSync(updaterPath)) {
    return { success: false, error: `找不到舰船资料库更新程序: ${updaterPath}` };
  }
  const dependencyError = await ensureShipLibraryUpdaterDependencies(pythonCmd);
  if (dependencyError) {
    return { success: false, error: dependencyError };
  }

  return new Promise((resolve) => {
    const child = spawn(
      pythonCmd,
      [
        '-c',
        shipLibraryPythonBootstrap(),
        updaterPath,
        '--output',
        shipLibraryDir(),
        '--workers',
        '8',
        '--force-assets',
      ],
      {
        cwd: appRoot(),
        windowsHide: true,
        env: pipEnv(),
      },
    );
    let stdoutBuffer = '';
    let stderr = '';
    let result: ShipLibraryUpdateResult | null = null;

    const handleLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (!line) return;
      if (line.startsWith('PROGRESS sources')) {
        sendShipLibraryProgress('正在获取舰R百科数据…');
      } else {
        const records = line.match(/^PROGRESS records parsed=(\d+)$/);
        const assets = line.match(
          /^PROGRESS assets (\d+)\/(\d+) downloaded=(\d+) failed=(\d+)$/,
        );
        if (records) {
          sendShipLibraryProgress(`已读取 ${records[1]} 艘舰船，正在检查本地资源…`);
        } else if (assets) {
          sendShipLibraryProgress(
            `正在检查资源 ${assets[1]}/${assets[2]}，已下载 ${assets[3]}，失败 ${assets[4]}`,
          );
        }
      }
      if (line.startsWith('RESULT_JSON=')) {
        try {
          result = JSON.parse(line.slice('RESULT_JSON='.length)) as ShipLibraryUpdateResult;
        } catch {
          result = { success: false, error: '更新程序返回了无效结果' };
        }
      }
    };

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      lines.forEach(handleLine);
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      resolve({ success: false, error: `更新程序启动失败: ${error.message}` });
    });
    child.once('close', (code) => {
      if (stdoutBuffer) handleLine(stdoutBuffer);
      resolve(result ?? {
        success: false,
        error: stderr.trim() || `更新程序异常退出（代码 ${code ?? 'unknown'}）`,
      });
    });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    icon: path.join(isPackaged() ? process.resourcesPath : path.join(__dirname, '..', '..'), 'resource', 'images', 'logo.png'),
  });

  const appDir = app.getAppPath();
  const htmlPath = path.join(appDir, 'src', 'view', 'index.html');

  // 根据 BACKEND_PORT 动态注入 CSP
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file: data:; connect-src 'self' http://localhost:${BACKEND_PORT} ws://localhost:${BACKEND_PORT}`
        ],
      },
    });
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const msg = `Page load failed!\nCode: ${errorCode}\nDesc: ${errorDescription}\nURL: ${validatedURL}\nPath: ${htmlPath}`;
    console.error('[Main]', msg);
    if (isPackaged()) {
      dialog.showMessageBox({ type: 'error', title: 'Load Error', message: msg });
    }
  });

  win.loadFile(htmlPath).catch(err => {
    console.error('[Main] loadFile failed:', err);
    if (isPackaged()) {
      dialog.showMessageBox({ type: 'error', title: 'loadFile Error', message: `${err.message}\nPath: ${htmlPath}` });
    }
  });

  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });
  return win;
}

// ════════════════════════════════════════
// IPC Handlers
// ════════════════════════════════════════

ipcMain.handle('open-directory-dialog', async (_event, title?: string) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: title || '选择文件夹',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-file-dialog', async (_event, filters: Electron.FileFilter[], defaultDir?: string) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    defaultPath: defaultDir || undefined,
    filters,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf-8');
  return { path: filePath, content };
});

ipcMain.handle('save-file', async (_event, filePath: string, content: string) => {
  const resolved = resolveAppPath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
});

ipcMain.handle('save-file-dialog', async (_event, defaultName: string, content: string, filters: Electron.FileFilter[]) => {
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,  // caller can pass full path (dir + filename)
    filters,
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return result.filePath;
});

ipcMain.handle('read-file', async (_event, filePath: string) => {
  const resolved = resolveAppPath(filePath);
  if (!fs.existsSync(resolved)) return '';
  return fs.readFileSync(resolved, 'utf-8');
});

ipcMain.handle('append-file', async (_event, filePath: string, content: string) => {
  const resolved = resolveAppPath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(resolved, content, 'utf-8');
});


ipcMain.handle('detect-emulator', async () => {
  return detectEmulator();
});

ipcMain.handle('check-adb-devices', async () => {
  const adbDir = path.join(appRoot(), 'adb');
  const adbExe = path.join(adbDir, 'adb.exe');
  const adbCmd = fs.existsSync(adbExe) ? adbExe : 'adb';
  try {
    const { stdout } = await execAsync(`"${adbCmd}" devices`, { windowsHide: true, timeout: 5000 });
    const lines = stdout.split('\n').slice(1); // skip header
    return lines
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => {
        const [serial, status] = l.split(/\s+/);
        return { serial, status: status || 'unknown' };
      });
  } catch {
    return [];
  }
});

ipcMain.on('get-app-version-sync', (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on('get-backend-port-sync', (event) => {
  event.returnValue = BACKEND_PORT;
});

ipcMain.on('get-backend-startup-mode-sync', (event) => {
  event.returnValue = getBackendStartupMode();
});

ipcMain.on('get-backend-repo-path-sync', (event) => {
  event.returnValue = getBackendRepoPath();
});

ipcMain.on('get-ocr-gpu-mode-sync', (event) => {
  event.returnValue = getOcrGpuMode();
});

ipcMain.on('get-cuda-path-sync', (event) => {
  event.returnValue = getCudaPath();
});

ipcMain.on('get-save-backend-screenshots-sync', (event) => {
  event.returnValue = getSaveBackendScreenshots();
});

ipcMain.handle('set-backend-port', (_event, port: number) => {
  // 防御性校验：仅在端口为有限数值且位于合法范围时才写入设置
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    return;
  }
  const normalizedPort = Math.trunc(port);
  if (normalizedPort < 1 || normalizedPort > 65535) {
    return;
  }
  writeGuiSettings({ backend_port: normalizedPort });
});

ipcMain.handle('set-backend-startup-mode', (_event, mode: BackendStartupMode) => {
  const normalized = mode === 'external' ? 'external' : 'managed';
  writeGuiSettings({ backend_startup_mode: normalized });
});

ipcMain.handle('set-backend-repo-path', (_event, repoPath: string | null) => {
  const normalized = typeof repoPath === 'string' ? repoPath.trim() : '';
  writeGuiSettings({ backend_repo_path: normalized });
});

ipcMain.handle('set-ocr-gpu-mode', (_event, mode: OcrGpuMode) => {
  const normalized: OcrGpuMode = mode === 'cpu' || mode === 'cuda' ? mode : 'auto';
  writeGuiSettings({ ocr_gpu_mode: normalized });
});

ipcMain.handle('set-cuda-path', (_event, cudaPath: string | null) => {
  const raw = typeof cudaPath === 'string' ? cudaPath.trim() : '';
  const normalized = raw ? normalizeCudaPath(raw) : '';
  writeGuiSettings({ cuda_path: normalized });
});

ipcMain.handle('validate-cuda-path', (_event, cudaPath: string) => {
  return validateCudaPath(cudaPath);
});

ipcMain.handle('set-save-backend-screenshots', (_event, enabled: boolean) => {
  writeGuiSettings({ save_backend_screenshots: enabled === true });
});

ipcMain.on('get-python-path-sync', (event) => {
  event.returnValue = getConfiguredPythonPath();
});

ipcMain.on('get-update-mode-sync', (event) => {
  event.returnValue = getUpdateMode();
});

ipcMain.handle('set-update-mode', (_event, mode: 'auto' | 'manual') => {
  const normalized = mode === 'manual' ? 'manual' : 'auto';
  writeGuiSettings({ update_mode: normalized });
});

ipcMain.handle('set-python-path', (_event, pythonPath: string | null) => {
  writeGuiSettings({ python_path: pythonPath ?? '' });
  clearPythonCache(); // 清除缓存，下次查找时使用新路径
});

ipcMain.handle('validate-python', async (_event, pythonPath: string) => {
  if (!pythonPath) return { valid: false, version: null, error: '路径为空' };
  if (!fs.existsSync(pythonPath)) return { valid: false, version: null, error: '文件不存在' };
  try {
    const { stdout } = await execAsync(`"${pythonPath}" --version`, { windowsHide: true, timeout: 10000 });
    const version = stdout.trim();
    if (!isAllowedPythonVersion(version)) {
      return { valid: false, version, error: `版本不兼容: ${version}（需要 3.12 或 3.13）` };
    }
    return { valid: true, version };
  } catch (e) {
    return { valid: false, version: null, error: `执行失败: ${e instanceof Error ? e.message : String(e)}` };
  }
});

ipcMain.handle('get-app-root', () => {
  return appRoot();
});

ipcMain.handle('resolve-app-path', (_event, filePath: string) => {
  return resolveAppPath(filePath);
});

ipcMain.handle('get-plans-dir', () => {
  return resolveAppPath('plans');
});

ipcMain.handle('list-plan-files', () => {
  const dir = resolveAppPath('plans');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.ya?ml$/i.test(f))
    .map(f => ({ name: f.replace(/\.ya?ml$/i, ''), file: f }));
});

ipcMain.handle('get-config-dir', () => {
  return appRoot();
});

ipcMain.handle('open-folder', async (_event, folderPath: string) => {
  if (fs.existsSync(folderPath)) {
    await shell.openPath(folderPath);
  }
});

ipcMain.handle('check-environment', async () => {
  return await checkEnvironment();
});

ipcMain.handle('get-ship-library-status', () => {
  return getShipLibraryStatus();
});

ipcMain.handle('get-ship-library-manifest', () => {
  return getShipLibraryManifest();
});

ipcMain.handle('save-user-team-plan', (
  _event,
  rawPlan: unknown,
  overwrite: boolean,
) => {
  try {
    const plan = normalizeUserTeamPlan(rawPlan);
    const file = teamFileName(plan.name);
    const filePath = path.join(userTeamPlansDir(), file);
    if (fs.existsSync(filePath) && overwrite !== true) {
      return {
        success: false,
        exists: true,
        file,
        error: '存在同名配置',
      };
    }
    const content = serializeUserTeamPlan(plan);
    atomicWrite(filePath, content);
    return { success: true, file, plan: { ...plan, file } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('pick-user-team-plan', async () => {
  const directory = userTeamPlansDir();
  const result = await dialog.showOpenDialog({
    title: '加载编队预设',
    defaultPath: directory,
    properties: ['openFile'],
    filters: [{ name: '编队 YAML', extensions: ['yaml', 'yml'] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = path.resolve(result.filePaths[0]);
  const file = path.basename(filePath);
  if (
    path.dirname(filePath).toLowerCase() !== path.resolve(directory).toLowerCase()
    || !TEAM_FILE_PATTERN.test(file)
  ) {
    return { success: false, error: '当前yaml格式不符合规则' };
  }
  try {
    const plan = readUserTeamPlan(filePath);
    return { success: true, file, plan: { ...plan, file } };
  } catch {
    return { success: false, error: '当前yaml格式不符合规则' };
  }
});

ipcMain.handle('list-user-team-plans', () => {
  return listUserTeamPlans();
});

let shipLibraryUpdateRunning = false;
ipcMain.handle('update-ship-library', async () => {
  if (shipLibraryUpdateRunning) {
    return { success: false, error: '舰船资料库正在更新，请稍候' };
  }
  shipLibraryUpdateRunning = true;
  try {
    return await runShipLibraryUpdate();
  } finally {
    shipLibraryUpdateRunning = false;
  }
});

/*
 * 测试期接口（后端源码更新）已停用，逻辑保留便于回滚恢复。
ipcMain.handle('check-updates', async () => {
  return await checkForUpdates();
});
*/

ipcMain.handle('install-deps', async () => {
  const pythonCmd = await findPython();
  if (!pythonCmd) return { success: false, output: '找不到 Python' };
  return installDependencies(pythonCmd);
});

ipcMain.handle('run-setup', async () => {
  return runSetupScript();
});

ipcMain.handle('install-portable-python', async () => {
  return installPortablePython();
});

/*
 * 测试期接口（后端源码更新）已停用，逻辑保留便于回滚恢复。
ipcMain.handle('pull-updates', async () => {
  return pullUpdates();
});
*/

ipcMain.handle('start-backend', async () => {
  if (getBackendProcess()) return { success: true, message: '后端已在运行' };
  await startBackend();
  return { success: true, message: '后端启动中' };
});

// ════════════════════════════════════════
// GUI 自动更新 (electron-updater)
// ════════════════════════════════════════

/** 初始化自动更新 */
function initAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    mainWindow?.webContents.send('update-status', {
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-status', { status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    mainWindow?.webContents.send('update-status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    mainWindow?.webContents.send('update-status', {
      status: 'downloaded',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err: Error) => {
    mainWindow?.webContents.send('update-status', {
      status: 'error',
      message: err.message,
    });
  });
}

ipcMain.handle('check-gui-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return result?.updateInfo ? { version: result.updateInfo.version } : null;
  } catch {
    return null;
  }
});

ipcMain.handle('download-gui-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('install-gui-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

/** 向渲染进程发送环境检查进度 */
function sendProgress(msg: string): void {
  mainWindow?.webContents.send('backend-log', msg);
}

// ════════════════════════════════════════
// App Lifecycle
// ════════════════════════════════════════

app.whenReady().then(() => {
  initPythonEnv({
    appRoot,
    sendProgress,
    getConfiguredPythonPath,
    getUpdateMode,
    getTempDir: () => app.getPath('temp'),
  });
  initBackend({
    appRoot,
    resourceRoot,
    BACKEND_PORT,
    getMainWindow: () => mainWindow,
  });
  initUserPlansDir();
  initUserShipLibraryDir();
  initUserTeamPlansDir();
  initAutoUpdater();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
