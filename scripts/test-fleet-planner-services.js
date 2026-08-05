const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerFleetPlannerIpc } = require(
  '../dist/electron/ipc/FleetPlannerIpc.js',
);
const { AppPaths } = require('../dist/electron/services/AppPaths.js');
const {
  AtomicFileStore,
} = require('../dist/electron/services/AtomicFileStore.js');
const {
  BundledShipLibraryService,
} = require(
  '../dist/electron/services/BundledShipLibraryService.js',
);
const {
  TeamPlanCodec,
} = require('../dist/electron/services/TeamPlanCodec.js');
const {
  TeamPlanRepository,
} = require('../dist/electron/services/TeamPlanRepository.js');
const {
  TeamPlanService,
} = require('../dist/electron/services/TeamPlanService.js');
const {
  NATIVE_FLEET_SHIP_TYPE_CODES,
} = require(
  '../dist/src/shared/nativeFleetShipTypes.generated.js',
);

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'autowsgr-fleet-planner-'),
);

function createAppPaths(projectRoot, userData) {
  return new AppPaths({
    moduleDirectory: path.join(projectRoot, 'dist', 'electron'),
    isPackaged: () => false,
    getPath: name => (
      name === 'exe'
        ? path.join(projectRoot, 'AutoWSGR.exe')
        : userData
    ),
    getResourcesPath: () => path.join(projectRoot, 'resources'),
  });
}

function testTeamPlanPersistence() {
  const projectRoot = path.join(temporaryDirectory, 'team-project');
  const userData = path.join(temporaryDirectory, 'team-user-data');
  const appPaths = createAppPaths(projectRoot, userData);
  const codec = new TeamPlanCodec();
  const repository = new TeamPlanRepository(
    appPaths,
    new AtomicFileStore(),
    codec,
  );
  const service = new TeamPlanService(codec, repository);
  repository.initializeSystemDirectory();
  repository.initializeUserDirectory();

  const normalized = codec.normalize({
    name: '测试编队',
    ships: [{
      name: '海伦娜',
      ship_type: ['CL'],
      min_level: 20,
      candidates: [{
        name: '重庆',
        ship_type: ['KP'],
        max_level: 100,
      }],
    }],
  });
  assert.deepEqual(normalized.ships[0].ship_type, ['cl']);
  assert.deepEqual(
    normalized.ships[0].candidates[0].ship_type,
    ['kp'],
  );

  for (const code of [...NATIVE_FLEET_SHIP_TYPE_CODES, 'ss_or_ssg']) {
    assert.deepEqual(codec.normalize({
      name: `舰种-${code}`,
      ships: [{ name: '测试舰', ship_type: [code] }],
    }).ships[0].ship_type, [code]);
  }
  for (const code of ['cgaa', 'cbg', 'ddg', 'ddgaa', 'cf']) {
    assert.throws(
      () => codec.normalize({
        name: '旧舰种',
        ships: [{ name: '测试舰', ship_type: [code] }],
      }),
      new RegExp(`不符合后端接口: ${code}`),
    );
  }

  const saved = service.save(normalized, false);
  assert.equal(saved.success, true);
  assert.equal(saved.file, 'team-测试编队.yaml');
  const listed = service.list();
  assert.equal(listed.errors.length, 0);
  assert.equal(listed.plans.length, 1);
  assert.deepEqual(
    repository.read(path.join(
      appPaths.userTeamPlansDir(),
      saved.file,
    )),
    normalized,
  );

  const duplicate = service.save(normalized, false);
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.exists, true);

  const renamed = service.save({
    ...normalized,
    name: '重命名编队',
  }, false, saved.file, 'user');
  assert.equal(renamed.success, true);
  assert.equal(
    fs.existsSync(path.join(
      appPaths.userTeamPlansDir(),
      saved.file,
    )),
    false,
  );
  const renamedPath = path.join(
    appPaths.userTeamPlansDir(),
    renamed.file,
  );
  assert.equal(service.loadSelected(renamedPath).success, true);
  assert.equal(
    service.loadSelected(path.join(temporaryDirectory, 'outside.yaml'))
      .success,
    false,
  );
}

function testAtomicFailurePreservesTarget() {
  const target = path.join(temporaryDirectory, 'atomic.yaml');
  fs.writeFileSync(target, 'old-content', 'utf8');
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === target) {
      const error = new Error('simulated replacement failure');
      error.code = 'EXDEV';
      throw error;
    }
    return originalRename(source, destination);
  };
  try {
    assert.throws(
      () => new AtomicFileStore().write(target, 'new-content'),
      { code: 'EXDEV' },
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-content');
  assert.deepEqual(
    fs.readdirSync(temporaryDirectory).filter(
      name => name.startsWith('atomic.yaml.') && name.endsWith('.tmp'),
    ),
    [],
  );
}

function writeManifest(libraryRoot, shipType) {
  fs.mkdirSync(path.join(libraryRoot, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(libraryRoot, 'assets', 'portrait.png'),
    'portrait',
  );
  fs.writeFileSync(
    path.join(libraryRoot, 'assets', 'type.png'),
    'type',
  );
  fs.writeFileSync(
    path.join(libraryRoot, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      generated_at: '2026-08-05T00:00:00Z',
      labels: {
        ship_types: { kp: '导巡' },
      },
      type_groups: {
        size_classes: { medium: ['kp'] },
      },
      ships: [{
        id: 1,
        name: '测试舰',
        search_name: '测试舰',
        variant: 'normal',
        rarity: 5,
        ship_type: shipType,
        size_class: 'medium',
        role_class: 'escort',
        country: 'CN',
        portrait: 'assets/portrait.png',
        background: '../outside.png',
        frame: 'asset-link/outside.png',
        type_icon: 'assets/type.png',
      }],
    }),
    'utf8',
  );
}

function testBundledShipLibrary() {
  const projectRoot = path.join(temporaryDirectory, 'library-project');
  const userData = path.join(temporaryDirectory, 'library-user-data');
  const libraryRoot = path.join(
    projectRoot,
    'resource',
    'ship-library',
  );
  const outsideRoot = path.join(temporaryDirectory, 'outside-assets');
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, 'outside.png'), 'outside');
  writeManifest(libraryRoot, 'KP');
  fs.symlinkSync(
    outsideRoot,
    path.join(libraryRoot, 'asset-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const service = new BundledShipLibraryService(
    createAppPaths(projectRoot, userData),
  );
  const manifest = service.getManifest();
  assert.equal(manifest.ships[0].ship_type, 'kp');
  assert.match(manifest.ships[0].portraitUrl, /^file:/);
  assert.equal(manifest.ships[0].backgroundUrl, '');
  assert.equal(manifest.ships[0].frameUrl, '');
  assert.match(manifest.ships[0].typeIconUrl, /^file:/);

  writeManifest(libraryRoot, 'ddg');
  assert.throws(
    () => service.getManifest(),
    /非规范舰种: ddg/,
  );

  const realLibrary = new BundledShipLibraryService(
    createAppPaths(process.cwd(), userData),
  ).getManifest();
  assert.equal(realLibrary.ships.length, 894);
  assert.deepEqual(
    [...new Set(realLibrary.ships.map(ship => ship.ship_type))].sort(),
    [...NATIVE_FLEET_SHIP_TYPE_CODES].sort(),
  );
  assert.equal(
    realLibrary.ships.every(ship => (
      ship.portraitUrl
      && ship.backgroundUrl
      && ship.frameUrl
      && ship.typeIconUrl
    )),
    true,
  );
}

async function testNarrowIpcContract() {
  const handlers = new Map();
  const calls = [];
  registerFleetPlannerIpc({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    shipLibrary: {
      getManifest() {
        calls.push(['manifest']);
        return { marker: 'manifest' };
      },
    },
    teamPlans: {
      save(...args) {
        calls.push(['save', ...args]);
        return { success: true };
      },
      list() {
        calls.push(['list']);
        return { plans: [], errors: [] };
      },
    },
  });

  assert.deepEqual([...handlers.keys()].sort(), [
    'fleet-planner:get-ship-library',
    'fleet-planner:list-team-plans',
    'fleet-planner:save-team-plan',
  ]);
  assert.deepEqual(
    await handlers.get('fleet-planner:get-ship-library')({}),
    { marker: 'manifest' },
  );
  assert.deepEqual(
    await handlers.get('fleet-planner:save-team-plan')(
      {},
      { name: 'IPC 编队' },
      true,
      'team-old.yaml',
      'user',
    ),
    { success: true },
  );
  assert.deepEqual(
    await handlers.get('fleet-planner:list-team-plans')({}),
    { plans: [], errors: [] },
  );
  assert.deepEqual(calls, [
    ['manifest'],
    [
      'save',
      { name: 'IPC 编队' },
      true,
      'team-old.yaml',
      'user',
    ],
    ['list'],
  ]);
}

async function main() {
  try {
    testTeamPlanPersistence();
    testAtomicFailurePreservesTarget();
    testBundledShipLibrary();
    await testNarrowIpcContract();
    console.log('fleet planner service tests passed');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
