/**
 * 使用仓内计划、主库和旧 GUI 的真实 YAML 验证本地导入能力。
 *
 * 默认只写临时目录；传入 --real 后会先备份，再写入真实 Electron userData。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  AppPaths,
} = require('../../dist/electron/services/AppPaths.js');
const {
  AtomicFileStore,
} = require('../../dist/electron/services/AtomicFileStore.js');
const {
  CombatPlanCodec,
} = require('../../dist/electron/services/CombatPlanCodec.js');
const {
  CombatPlanRepository,
} = require('../../dist/electron/services/CombatPlanRepository.js');
const {
  GuiSettingsStore,
} = require('../../dist/electron/services/GuiSettingsStore.js');
const {
  PlanExportService,
} = require('../../dist/electron/services/PlanExportService.js');
const {
  PlanManagementService,
} = require('../../dist/electron/services/PlanManagementService.js');
const {
  RuntimePlanService,
} = require('../../dist/electron/services/RuntimePlanService.js');
const {
  TaskPresetCodec,
} = require('../../dist/src/shared/taskPreset.js');
const {
  TeamPlanCodec,
} = require('../../dist/electron/services/TeamPlanCodec.js');
const {
  TeamPlanRepository,
} = require('../../dist/electron/services/TeamPlanRepository.js');

const projectRoot = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const autoWsgrRoot = process.env.AUTOWSGR_REPO
  ? path.resolve(process.env.AUTOWSGR_REPO)
  : path.join(workspaceRoot, 'AutoWSGR');
const corpusRoots = [
  {
    group: '当前GUI系统计划',
    directory: path.join(projectRoot, 'resource', 'system_battle_plans'),
    required: true,
  },
  {
    group: 'GUI迁移兼容计划',
    directory: path.join(
      projectRoot,
      'resource',
      'migrations',
      'v6',
      'system_battle_plans',
    ),
    required: true,
  },
  {
    group: '主库计划',
    directory: path.join(
      autoWsgrRoot,
      'autowsgr',
      'data',
      'plan',
    ),
  },
  {
    group: '旧GUI用户计划',
    directory: path.join(workspaceRoot, 'AutoWSGR-GUI-old', 'plans'),
  },
  {
    group: '旧GUI内置计划',
    directory: path.join(
      workspaceRoot,
      'AutoWSGR-GUI-old',
      'resources',
      'resource',
      'builtin_plans',
    ),
  },
  {
    group: '旧GUI内置后端计划',
    directory: path.join(
      workspaceRoot,
      'AutoWSGR-GUI-old',
      'python',
      'site-packages',
      'autowsgr',
      'data',
      'plan',
    ),
  },
];

function yamlFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(candidate);
    return /\.ya?ml$/i.test(entry.name) ? [candidate] : [];
  });
}

function corpus() {
  return corpusRoots.flatMap(root => {
    const files = yamlFiles(root.directory);
    if (root.required && files.length === 0) {
      throw new Error(`必需的计划语料为空: ${root.directory}`);
    }
    return files.map(file => ({
      group: root.group,
      file,
      relativePath: path.relative(root.directory, file),
    }));
  });
}

function createServices(userData, tempRoot) {
  const appPaths = new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => name === 'exe'
      ? path.join(projectRoot, 'AutoWSGR-GUI.exe')
      : userData,
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
  const atomicFiles = new AtomicFileStore();
  const teamCodec = new TeamPlanCodec();
  const teamRepository = new TeamPlanRepository(
    appPaths,
    atomicFiles,
    teamCodec,
  );
  const combatRepository = new CombatPlanRepository(appPaths, atomicFiles);
  const combatCodec = new CombatPlanCodec(teamCodec, teamRepository);
  const runtimePlans = new RuntimePlanService(
    combatCodec,
    combatRepository,
    atomicFiles,
    {
      getTempDirectory: () => tempRoot,
      processId: process.pid,
    },
  );
  const management = new PlanManagementService(
    combatCodec,
    combatRepository,
    runtimePlans,
    teamRepository,
    new GuiSettingsStore(
      () => path.join(userData, 'gui_settings.json'),
      atomicFiles,
    ),
    new TaskPresetCodec(),
  );
  return {
    appPaths,
    combatRepository,
    management,
    teamRepository,
    exports: new PlanExportService(
      combatRepository,
      teamRepository,
      atomicFiles,
      combatCodec,
    ),
  };
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fieldDifferences(source, output, currentPath = '$') {
  const missing = [];
  const normalized = [];
  if (Array.isArray(source)) {
    if (!Array.isArray(output)) {
      missing.push(currentPath);
      return { missing, normalized };
    }
    source.forEach((value, index) => {
      if (typeof value !== 'object' || value === null) return;
      const result = fieldDifferences(
        value,
        output[index],
        `${currentPath}[${index}]`,
      );
      missing.push(...result.missing);
      normalized.push(...result.normalized);
    });
    return { missing, normalized };
  }
  if (!isObject(source)) return { missing, normalized };
  if (!isObject(output)) {
    missing.push(currentPath);
    return { missing, normalized };
  }

  Object.entries(source).forEach(([key, value]) => {
    const fieldPath = `${currentPath}.${key}`;
    if (key === 'priority' && !Object.hasOwn(output, key)) {
      normalized.push(`${fieldPath} -> name/candidates`);
      return;
    }
    if (!Object.hasOwn(output, key)) {
      missing.push(fieldPath);
      return;
    }
    const result = fieldDifferences(value, output[key], fieldPath);
    missing.push(...result.missing);
    normalized.push(...result.normalized);
  });
  return { missing, normalized };
}

function validateOne(entry, index) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `autowsgr-real-plan-${index}-`),
  );
  try {
    const services = createServices(
      path.join(root, 'userData'),
      path.join(root, 'temp'),
    );
    const sourceHash = hashFile(entry.file);
    const imported = services.management.importLocal(entry.file);
    if (!imported.success) {
      throw new Error(imported.error || '导入失败');
    }
    const managed = services.management.readManaged('user', imported.file);
    if (!managed.success || typeof managed.content !== 'string') {
      throw new Error(managed.error || '受管读取失败');
    }
    const sourceRoot = yaml.load(fs.readFileSync(entry.file, 'utf8'));
    const managedRoot = yaml.load(managed.content);
    const differences = fieldDifferences(sourceRoot, managedRoot);
    return {
      ...entry,
      kind: imported.kind,
      importedFile: imported.file,
      teamFiles: imported.teamFiles ?? [],
      sourceUnchanged: hashFile(entry.file) === sourceHash,
      missingFields: [...new Set(differences.missing)],
      normalizedFields: [...new Set(differences.normalized)],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function backupRealPlans(userData) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(userData, 'import_backups', stamp);
  for (const directory of ['user_battle_plans', 'user_team_plans']) {
    const source = path.join(userData, directory);
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(backupRoot, directory), {
        recursive: true,
      });
    }
  }
  return backupRoot;
}

function fileNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(file => /\.ya?ml$/i.test(file))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

async function importReal(entries, validationRecords, userData) {
  const backupRoot = backupRealPlans(userData);
  const services = createServices(
    userData,
    path.join(os.tmpdir(), 'AutoWSGR-GUI-real-import'),
  );
  const writes = [];
  for (const entry of entries) {
    const result = services.management.importLocal(entry.file, true);
    if (!result.success) {
      throw new Error(`${entry.group}/${entry.relativePath}: ${result.error}`);
    }
    writes.push({
      group: entry.group,
      source: entry.relativePath,
      kind: result.kind,
      importedFile: result.file,
      teamFiles: result.teamFiles ?? [],
    });
  }

  const battleFiles = fileNames(services.appPaths.userBattlePlansDir());
  const teamFiles = fileNames(services.appPaths.userTeamPlansDir());
  const selections = [
    ...battleFiles.map(file => ({ kind: 'battle', file })),
    ...teamFiles.map(file => ({ kind: 'team', file })),
  ];
  const archive = await services.exports.createArchive(selections);
  const exportDirectory = path.join(userData, 'exports');
  fs.mkdirSync(exportDirectory, { recursive: true });
  const exportPath = path.join(
    exportDirectory,
    `real-plan-corpus-${services.exports.archiveFileName()}`,
  );
  services.exports.writeArchive(exportPath, archive);

  const report = {
    generatedAt: new Date().toISOString(),
    userData,
    backupRoot,
    exportPath,
    corpusCount: entries.length,
    importedCount: writes.length,
    finalBattleFileCount: battleFiles.length,
    finalTeamFileCount: teamFiles.length,
    overwrittenBattleNames: duplicateNames(
      writes.map(item => item.importedFile),
    ),
    overwrittenTeamNames: duplicateNames(
      writes.flatMap(item => item.teamFiles),
    ),
    battleFiles,
    teamFiles,
    writes,
    validationRecords,
  };
  const reportPath = path.join(userData, 'real-plan-import-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { reportPath, ...report };
}

function duplicateNames(names) {
  const counts = new Map();
  names.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1));
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }));
}

async function main() {
  const entries = corpus();
  const records = [];
  const failures = [];
  entries.forEach((entry, index) => {
    try {
      records.push(validateOne(entry, index));
    } catch (error) {
      failures.push({
        group: entry.group,
        source: entry.relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const summary = {
    corpus: Object.fromEntries(corpusRoots.map(root => [
      root.group,
      entries.filter(entry => entry.group === root.group).length,
    ])),
    total: entries.length,
    passed: records.length,
    failed: failures.length,
    sourceChanged: records.filter(item => !item.sourceUnchanged).length,
    filesWithMissingFields: records.filter(
      item => item.missingFields.length > 0,
    ).length,
    failures,
  };
  if (failures.length > 0) {
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  const real = process.argv.includes('--real')
    ? await importReal(
      entries,
      records,
      path.join(process.env.APPDATA, 'wsgrgui'),
    )
    : null;
  console.log(JSON.stringify({
    ...summary,
    real: real && {
      reportPath: real.reportPath,
      backupRoot: real.backupRoot,
      exportPath: real.exportPath,
      importedCount: real.importedCount,
      finalBattleFileCount: real.finalBattleFileCount,
      finalTeamFileCount: real.finalTeamFileCount,
      overwrittenBattleNameCount: real.overwrittenBattleNames.length,
      overwrittenTeamNameCount: real.overwrittenTeamNames.length,
    },
  }, null, 2));
}

void main();
