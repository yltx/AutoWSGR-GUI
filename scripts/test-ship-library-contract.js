const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const {
  buildResourceEnvironment,
  SHIP_LIBRARY_ENV,
  STRENGTHEN_DATA_ENV,
  WSG_NCC_DATA_ENV,
  shipLibraryRoot,
  strengthenDataPath,
  wsgNccDataRoot,
  wsgNccPythonRoot,
  withResourcePythonBootstrap,
} = require(path.join(projectRoot, 'dist', 'electron', 'resourcePaths.js'));

const developmentRoot = path.join(projectRoot, 'dist', 'electron', '..', '..');
const packagedRoot = path.join(projectRoot, 'release-fixture', 'resources');
assert.equal(shipLibraryRoot(developmentRoot), path.join(projectRoot, 'resource', 'ship-library'));
assert.equal(shipLibraryRoot(packagedRoot), path.join(packagedRoot, 'resource', 'ship-library'));
assert.equal(strengthenDataPath(developmentRoot), path.join(projectRoot, 'resource', 'strengthen.json'));
assert.equal(strengthenDataPath(packagedRoot), path.join(packagedRoot, 'resource', 'strengthen.json'));
assert.equal(wsgNccDataRoot(developmentRoot), path.join(projectRoot, 'resource', 'wsg-ncc'));
assert.equal(wsgNccDataRoot(packagedRoot), path.join(packagedRoot, 'resource', 'wsg-ncc'));
assert.equal(wsgNccPythonRoot(developmentRoot), path.join(projectRoot, 'resource', 'wsg-ncc', 'python'));
assert.equal(wsgNccPythonRoot(packagedRoot), path.join(packagedRoot, 'resource', 'wsg-ncc', 'python'));

const existingPythonPaths = ['user-python-one', 'user-python-two'];
const baseEnv = {
  PATH: 'fixture-path',
  PYTHONPATH: existingPythonPaths.join(path.delimiter),
  KEEP_ME: 'yes',
};
const childEnv = buildResourceEnvironment(baseEnv, packagedRoot);
assert.notEqual(childEnv, baseEnv);
assert.equal(baseEnv[SHIP_LIBRARY_ENV], undefined);
assert.equal(childEnv.KEEP_ME, 'yes');
assert.equal(childEnv.PYTHONDONTWRITEBYTECODE, '1');
assert.deepEqual(
  childEnv.PYTHONPATH.split(path.delimiter),
  [wsgNccPythonRoot(packagedRoot), ...existingPythonPaths],
);
assert.equal(childEnv[SHIP_LIBRARY_ENV], path.join(packagedRoot, 'resource', 'ship-library'));
assert.equal(childEnv[STRENGTHEN_DATA_ENV], path.join(packagedRoot, 'resource', 'strengthen.json'));
assert.equal(childEnv[WSG_NCC_DATA_ENV], path.join(packagedRoot, 'resource', 'wsg-ncc'));
const childEnvWithoutPythonPath = buildResourceEnvironment({ KEEP_ME: 'yes' }, packagedRoot);
assert.equal(childEnvWithoutPythonPath.PYTHONPATH, wsgNccPythonRoot(packagedRoot));
const childEnvWithDuplicate = buildResourceEnvironment({
  PYTHONPATH: [wsgNccPythonRoot(packagedRoot), ...existingPythonPaths].join(path.delimiter),
}, packagedRoot);
assert.deepEqual(
  childEnvWithDuplicate.PYTHONPATH.split(path.delimiter),
  [wsgNccPythonRoot(packagedRoot), ...existingPythonPaths],
);
const resourceBootstrap = withResourcePythonBootstrap("print('backend')");
assert.match(resourceBootstrap, /PYTHONPATH/);
assert.match(resourceBootstrap, /import cascade_ncc as _gui_cascade_ncc/);
assert.match(resourceBootstrap, /AUTOWSGR_WSG_NCC_DATA/);
assert.match(resourceBootstrap, /is_relative_to\(_gui_expected_cascade_root\)/);
assert.ok(resourceBootstrap.endsWith("print('backend')"));

const libraryRoot = shipLibraryRoot(projectRoot);
const manifestPath = path.join(libraryRoot, 'manifest.json');
assert.ok(fs.existsSync(manifestPath), 'canonical ship manifest is missing');
const strengthenPath = strengthenDataPath(projectRoot);
assert.ok(fs.existsSync(strengthenPath), 'canonical strengthen data is missing');
const strengthenData = JSON.parse(fs.readFileSync(strengthenPath, 'utf8'));
assert.ok(Array.isArray(strengthenData) && strengthenData.length > 0, 'strengthen data must be a non-empty array');
const canonicalStrengthenIds = new Set();
for (const record of strengthenData) {
  assert.equal(typeof record.id, 'number', 'strengthen record id must be numeric');
  assert.equal(typeof record.title, 'string', 'strengthen record title must be text');
  assert.equal(Number.isInteger(record.strengthenLevelUpExp), true, 'strengthen experience must be an integer');
  assert.ok(record.strengthenLevelUpExp > 0, 'strengthen experience must be positive');
  assert.deepEqual(Object.keys(record.strengthenSupply).sort(), ['airDef', 'atk', 'def', 'torpedo']);
  assert.deepEqual(Object.keys(record.strengthenMax).sort(), ['airDef', 'atk', 'def', 'torpedo']);

  const prefix = Math.floor(record.id / 1_000_000);
  assert.ok(prefix === 10 || prefix === 11, `unknown strengthen source id prefix: ${record.id}`);
  const canonicalId = (prefix - 10) * 1000 + Math.floor(record.id / 100) % 10_000;
  assert.equal(
    canonicalStrengthenIds.has(canonicalId),
    false,
    `duplicate canonical strengthen id: ${canonicalId}`,
  );
  canonicalStrengthenIds.add(canonicalId);
}

const wsgNccRoot = wsgNccDataRoot(projectRoot);
const wsgNccAssets = new Map([
  ['LICENSE', '17451f2f5d0bc57cd8911e26c2e0610c95d81ae36398278c464a89c63f737351'],
  ['codebooks/cascade.npz', '81f1b3fb027f79d85f42dca86dc237fab5e0b8fe6c2da5a7c8bc52ac10a5be4b'],
  ['gallery_meta.json', '503f58607c637b6fa727663d09527dd48b093fde2c4ed96370732507b916bbe4'],
  ['python/SHA256SUMS', 'b82027e0e883494fb01df6e1bd793101ed981f1642bbd0e230a554c22762aa3f'],
]);
for (const [relativePath, expectedSha256] of wsgNccAssets) {
  const assetPath = path.join(wsgNccRoot, ...relativePath.split('/'));
  assert.ok(fs.existsSync(assetPath), `missing bundled WSG-NCC asset: ${relativePath}`);
  assert.ok(fs.statSync(assetPath).size > 0, `empty bundled WSG-NCC asset: ${relativePath}`);
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex'),
    expectedSha256,
    `unexpected bundled WSG-NCC asset digest: ${relativePath}`,
  );
}
const wsgNccNotice = fs.readFileSync(path.join(wsgNccRoot, 'NOTICE.md'), 'utf8');
assert.match(wsgNccNotice, /https:\/\/github\.com\/CV-souryu\/WSG-NCC/);
assert.match(wsgNccNotice, /1739742a4aba63321b4ae67f590e899ac7dbefcb/);
assert.match(wsgNccNotice, /v2026\.08\.28/);
assert.match(wsgNccNotice, /939e0dcf8c45df4892638acce1c7ff6f4cd07c55/);
assert.match(wsgNccNotice, /b82027e0e883494fb01df6e1bd793101ed981f1642bbd0e230a554c22762aa3f/);
assert.match(wsgNccNotice, /redistributed under the bundled MIT license/i);
assert.match(wsgNccNotice, /explicitly authorized[^\n]*AutoWSGR-GUI maintainer/i);
assert.match(wsgNccNotice, /maintainer holds that authorization evidence outside this public repository/i);

const pythonRoot = wsgNccPythonRoot(projectRoot);
const pythonManifest = fs.readFileSync(path.join(pythonRoot, 'SHA256SUMS'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((line) => {
    const match = line.match(/^([0-9a-f]{64})  (cascade_ncc\/[A-Za-z0-9_.]+\.py)$/);
    assert.ok(match, `invalid WSG-NCC Python integrity entry: ${line}`);
    return { hash: match[1], relativePath: match[2] };
  });
const expectedPythonFiles = [
  '__init__.py',
  '_constants.py',
  '_gpu.py',
  'cli.py',
  'codebook.py',
  'codebook_match.py',
  'gpu_preprocess.py',
  'gpu_sampler.py',
  'gpu_scorer.py',
  'primitives.py',
  'recognizer.py',
].map(file => `cascade_ncc/${file}`);
assert.deepEqual(
  pythonManifest.map(entry => entry.relativePath),
  expectedPythonFiles,
  'WSG-NCC Python integrity manifest file set changed',
);
const actualPythonFiles = fs.readdirSync(path.join(pythonRoot, 'cascade_ncc'))
  .filter(file => !file.startsWith('.'))
  .map(file => `cascade_ncc/${file}`)
  .sort();
assert.deepEqual(actualPythonFiles, [...expectedPythonFiles].sort());
for (const entry of pythonManifest) {
  const filePath = path.join(pythonRoot, ...entry.relativePath.split('/'));
  assert.ok(fs.statSync(filePath).size > 0, `empty bundled WSG-NCC Python file: ${entry.relativePath}`);
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    entry.hash,
    `unexpected bundled WSG-NCC Python digest: ${entry.relativePath}`,
  );
}
assert.doesNotMatch(
  wsgNccNotice,
  /\u2013|\u2014/,
  'WSG-NCC notice must use ASCII hyphens',
);
const galleryMetadata = JSON.parse(
  fs.readFileSync(path.join(wsgNccRoot, 'gallery_meta.json'), 'utf8'),
);
assert.equal(
  galleryMetadata && typeof galleryMetadata === 'object' && Array.isArray(galleryMetadata),
  false,
  'WSG-NCC gallery metadata must be an object',
);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.ships.length, 894);
assert.equal(manifest.counts.ships, 894);
assert.equal(manifest.counts.missing_assets, 0);

const canonicalShipIds = new Set(manifest.ships.map(ship => ship.id));
const strengthenCoverageExclusions = new Map([
  [8007, 'special variant: 提尔比茨（儿童节）'],
  [8009, 'special variant: 萝德尼'],
  [8111, 'special variant: 华盛顿（儿童节）'],
  [8116, 'special variant: 戈本'],
]);
assert.deepEqual(
  [...canonicalShipIds].filter(id => !canonicalStrengthenIds.has(id)).sort((left, right) => left - right),
  [...strengthenCoverageExclusions.keys()],
  'strengthen coverage gaps changed; do not invent data for unknown canonical ids',
);
assert.deepEqual(
  [...canonicalStrengthenIds].filter(id => !canonicalShipIds.has(id)),
  [],
  'strengthen data must not contain unknown canonical ship ids',
);
for (const [id, reason] of strengthenCoverageExclusions) {
  const ship = manifest.ships.find(candidate => candidate.id === id);
  assert.equal(ship?.variant, 'special', `strengthen exclusion is no longer special: ${id} (${reason})`);
}

for (const ship of manifest.ships) {
  for (const assetPath of [ship.portrait, ship.background, ship.frame, ship.type_icon]) {
    assert.equal(typeof assetPath, 'string', `ship ${ship.id} has an invalid asset path`);
    assert.ok(fs.existsSync(path.join(libraryRoot, assetPath)), `missing ship asset: ${assetPath}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const resourceEntry = packageJson.build.extraResources.find(entry => entry.from === 'resource');
assert.ok(resourceEntry, 'electron-builder must include the resource directory');
assert.equal(resourceEntry.to, 'resource');
assert.ok(
  resourceEntry.filter.includes('**/*'),
  'electron-builder must include resource contents',
);
assert.equal(
  resourceEntry.filter.some(pattern => pattern.includes('ship-library')),
  false,
  'electron-builder resource filters must not exclude the ship library',
);
assert.equal(
  resourceEntry.filter.some(pattern => pattern.includes('wsg-ncc')),
  false,
  'electron-builder resource filters must not exclude WSG-NCC runtime data',
);
assert.equal(
  resourceEntry.filter.includes('!**/__pycache__/**/*'),
  true,
  'electron-builder must exclude Python bytecode cache directories',
);
assert.equal(
  resourceEntry.filter.includes('!**/*.py[cod]'),
  true,
  'electron-builder must exclude Python bytecode files',
);
for (const excluded of ['builtin_plans', 'user_battle_plans', 'user_daily_plans', 'user_team_plans']) {
  assert.equal(
    resourceEntry.filter.includes(`!${excluded}/**/*`),
    true,
    `electron-builder must exclude legacy/user resource directory: ${excluded}`,
  );
}

console.log(`ship library contract verified: ${manifest.ships.length} ships at ${libraryRoot}`);
