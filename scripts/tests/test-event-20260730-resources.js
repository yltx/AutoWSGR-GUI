const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..', '..');
const expectedMaps = [
  '1a',
  '2a',
  '3a',
  '3b',
  '4a',
  '4b',
  '5a',
  '6a',
  '6b',
];

function canonicalEventMapFile(chapter, map) {
  const match = map.match(/^(\d+)([ab])$/);
  assert.ok(match, `invalid 20260730 map code: ${map}`);
  const entrance = match[2] === 'b' ? 'β' : 'α';
  const hard = chapter === 'H' ? 'H' : '';
  return `激斗漩涡${hard}-Ex-${match[1]}-${entrance}.json`;
}

const planFiles = [
  'bettle-E1炸鱼.yaml',
  'bettle-E5夜战.yaml',
  'bettle-H1炸鱼.yaml',
  'bettle-H5夜战.yaml',
];
const expected = new Map([
  ['bettle-E1炸鱼.yaml', {
    event: '20260730',
    chapter: 'E',
    map: '1a',
    selected_nodes: ['B'],
    node_defaults: { proceed: false, formation: 5 },
  }],
  ['bettle-E5夜战.yaml', {
    event: '20260730',
    chapter: 'E',
    map: '5a',
    selected_nodes: ['A', 'B', 'C', 'D', 'F'],
    node_defaults: { night: true, proceed: true, formation: 4 },
    node_args: {
      C: { proceed: false },
      D: { proceed: false },
      F: { proceed: false },
    },
  }],
  ['bettle-H1炸鱼.yaml', {
    event: '20260730',
    chapter: 'H',
    map: '1a',
    selected_nodes: ['B'],
    node_defaults: { proceed: false, formation: 5 },
  }],
  ['bettle-H5夜战.yaml', {
    event: '20260730',
    chapter: 'H',
    map: '5a',
    selected_nodes: ['A', 'B', 'C', 'D', 'F'],
    node_defaults: { night: true, proceed: true, formation: 4 },
    node_args: {
      C: { proceed: false },
      D: { proceed: false },
      F: { proceed: false },
    },
  }],
]);

for (const file of planFiles) {
  const systemPath = path.join(
    root,
    'resource',
    'system_battle_plans',
    file,
  );
  const migrationPath = path.join(
    root,
    'resource',
    'migrations',
    'v6',
    'system_battle_plans',
    file,
  );
  assert.equal(
    fs.existsSync(systemPath),
    false,
    `obsolete activity plan must not remain a system preset: ${file}`,
  );
  assert.equal(
    fs.existsSync(migrationPath),
    true,
    `missing v6 activity migration resource: ${file}`,
  );
  const plan = yaml.load(fs.readFileSync(migrationPath, 'utf8'));
  assert.deepEqual(plan, expected.get(file));
}

const templates = JSON.parse(fs.readFileSync(
  path.join(root, 'resource', 'builtin_templates.json'),
  'utf8',
));
const template = templates.find(item => item.id === 'builtin_event_20260730');
assert.equal(
  template,
  undefined,
  'retired activity plans must not remain in the builtin template list',
);

const eventMapRoot = path.join(root, 'resource', 'maps', 'event');
const catalog = JSON.parse(fs.readFileSync(
  path.join(eventMapRoot, 'index.json'),
  'utf8',
));
assert.equal(catalog.schema_version, 2);
const event = catalog.events.find(item => item.event === '20260730');
assert.ok(event, 'missing 20260730 event map catalog');
assert.deepEqual(event.chapters.E, expectedMaps);
assert.deepEqual(event.chapters.H, expectedMaps);
assert.equal(event.chapters.E.includes('1b'), false);
assert.equal(event.chapters.H.includes('1b'), false);

for (const chapter of ['E', 'H']) {
  for (const map of expectedMaps) {
    const file = canonicalEventMapFile(chapter, map);
    assert.equal(event.files[chapter][map], file);
    const mapPath = path.join(
      eventMapRoot,
      '20260730',
      file,
    );
    assert.equal(fs.existsSync(mapPath), true, `missing event map: ${mapPath}`);
    const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const entrance = map.endsWith('b') ? 'β' : 'α';
    assert.ok(mapData[entrance], `${chapter}-${map} missing ${entrance} entrance`);
  }
}

assert.equal(
  fs.existsSync(path.join(eventMapRoot, '20260730', 'E-1a.json')),
  false,
  'legacy activity map aliases must be removed',
);
assert.equal(
  fs.existsSync(path.join(eventMapRoot, '20260212', 'E-1.json')),
  true,
  'historical AutoWSGR activity maps must remain available',
);
assert.equal(
  fs.existsSync(path.join(root, 'resource', 'maps', 'normal', '1-1.json')),
  true,
  'normal maps must follow the AutoWSGR directory contract',
);
assert.deepEqual(
  fs.readdirSync(path.join(root, 'resource', 'maps'), {
    withFileTypes: true,
  })
    .filter(entry => entry.isFile())
    .map(entry => entry.name),
  [],
  'map files must be stored in AutoWSGR category directories',
);

const decisiveData = yaml.load(fs.readFileSync(
  path.join(root, 'resource', 'maps', 'decisive_battle', 'enemy_spec.yaml'),
  'utf8',
));
assert.ok(
  decisiveData?.key_points && decisiveData?.map_end && decisiveData?.enemy,
  'decisive battle data must keep the AutoWSGR schema',
);

console.log('20260730 activity resources test passed');
