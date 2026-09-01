const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const exporter = path.join(
  projectRoot,
  'tools',
  'ship_library',
  'native_fleet_types.py',
);
const outputPath = path.join(
  projectRoot,
  'src',
  'shared',
  'nativeFleetShipTypes.generated.ts',
);

function exportContract() {
  const candidates = [
    process.env.AUTOWSGR_PYTHON,
    path.join(projectRoot, 'python', 'python.exe'),
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter(Boolean);

  const failures = [];
  for (const python of candidates) {
    const result = spawnSync(python, [exporter], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      windowsHide: true,
    });
    if (result.status === 0) {
      return JSON.parse(result.stdout.trim());
    }
    failures.push(`${python}: ${(result.stderr || result.error || '').toString().trim()}`);
  }
  throw new Error(
    `无法从 autowsgr_native 导出舰种契约:\n${failures.join('\n')}`,
  );
}

function renderContract(contract) {
  if (
    contract.schema_version !== 1
    || contract.source !== 'autowsgr_native.vessel_type.VesselType'
    || !Array.isArray(contract.ship_types)
  ) {
    throw new Error('native 舰种契约格式无效');
  }
  const entries = contract.ship_types.map(({ code, label }) => {
    if (typeof code !== 'string' || typeof label !== 'string') {
      throw new Error('native 舰种契约包含无效条目');
    }
    return `  ${JSON.stringify(code)}: ${JSON.stringify(label)},`;
  });
  return [
    '/** 保存由 autowsgr_native 生成的舰种代码，供前端漂移检查。 */',
    '/* 此文件由 scripts/sync-fleet-ship-types.js 生成，禁止手工修改。 */',
    'export const NATIVE_FLEET_SHIP_TYPE_LABELS: Readonly<',
    '  Record<string, string>',
    '> = Object.freeze({',
    ...entries,
    '});',
    '',
    'export const NATIVE_FLEET_SHIP_TYPE_CODES: readonly string[] =',
    '  Object.freeze(Object.keys(NATIVE_FLEET_SHIP_TYPE_LABELS));',
    '',
  ].join('\n');
}

const expected = renderContract(exportContract());
const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  const actual = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, 'utf8')
    : '';
  if (actual !== expected) {
    throw new Error(
      'GUI 舰种生成文件与 autowsgr_native 不一致，请运行 npm run sync:fleet-types',
    );
  }
  console.log('native fleet ship type contract is up to date');
} else {
  fs.writeFileSync(outputPath, expected, 'utf8');
  console.log(`updated ${path.relative(projectRoot, outputPath)}`);
}
