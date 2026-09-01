const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..', '..');
const readPaths = [];

global.window = {
  electronBridge: {
    readFile: async (relativePath) => {
      readPaths.push(relativePath);
      return fs.promises.readFile(path.join(root, relativePath), 'utf8');
    },
  },
};
global.document = {
  createElement: () => ({
    value: '',
    textContent: '',
    title: '',
    dataset: {},
  }),
};

async function loadModules() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/model/MapDataLoader.ts';",
        "export { PlanModel } from './src/model/PlanModel.ts';",
        "export { PlanPreviewView } from './src/view/plan/PlanPreviewView.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'event-map-test-entry.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const testModule = { exports: {} };
  const execute = new Function(
    'require',
    'module',
    'exports',
    result.outputFiles[0].text,
  );
  execute(require, testModule, testModule.exports);
  return testModule.exports;
}

async function main() {
  const {
    loadEventMapCatalog,
    loadEventMapData,
    loadMapData,
    PlanModel,
    PlanPreviewView,
  } = await loadModules();

  const catalog = await loadEventMapCatalog();
  const event = catalog.find(entry => entry.event === '20260730');
  assert.ok(event);
  assert.deepEqual(event.chapters.E, [
    '1a',
    '2a',
    '3a',
    '3b',
    '4a',
    '4b',
    '5a',
    '6a',
    '6b',
  ]);
  assert.equal(event.chapters.E.includes('1b'), false);
  assert.equal(
    event.files.E['1a'],
    '激斗漩涡-Ex-1-α.json',
  );
  assert.equal(
    event.files.H['3b'],
    '激斗漩涡H-Ex-3-β.json',
  );

  const view = Object.create(PlanPreviewView.prototype);
  view.eventMapCatalog = catalog;
  view.chapterSelect = {
    value: '',
    options: [{ value: '1', dataset: {} }],
    querySelectorAll() {
      return this.options.filter(option => option.dataset.eventMap);
    },
    appendChild(option) {
      this.options.push(option);
    },
  };
  view.mapSelect = {
    disabled: false,
    value: '',
    options: [],
    replaceChildren(...options) {
      this.options = options;
      this.value = options[0]?.value ?? '';
    },
  };
  view.renderEventChapterOptions({
    event: '20260730',
    chapter: 'E',
    map: '1a',
  });
  const eventChapterOptions = view.chapterSelect.options
    .filter(option => option.dataset.eventMap)
    .map(option => option.value);
  assert.deepEqual(
    eventChapterOptions.slice(0, 2),
    ['event:20260730:E', 'event:20260730:H'],
  );
  assert.equal(eventChapterOptions.includes('event:20260212:E'), true);
  view.updateMapOptions('event:20260730:E');
  assert.equal(view.mapSelect.value, '1a');
  assert.equal(
    view.mapSelect.options.some(option => option.value === '1'),
    false,
  );
  view.updateMapOptions('event:20260730:E', '1a');
  assert.deepEqual(
    view.mapSelect.options.map(option => option.value),
    event.chapters.E,
  );
  let mapChange;
  view.onMapChange = (chapter, map) => {
    mapChange = { chapter, map };
  };
  view.chapterSelect.value = 'event:20260730:E';
  view.mapSelect.value = '3b';
  view.emitMapChange();
  assert.deepEqual(mapChange, {
    chapter: 'event:20260730:E',
    map: '3b',
  });

  let readStart = readPaths.length;
  const map1a = await loadEventMapData('20260730', 'E', '1a');
  assert.ok(map1a);
  assert.ok(map1a['0']);
  assert.equal(Object.hasOwn(map1a, 'α'), false);
  assert.deepEqual(map1a['0'].next, ['A', 'B', 'C']);
  assert.deepEqual(
    readPaths.slice(readStart),
    ['resource/maps/event/20260730/激斗漩涡-Ex-1-α.json'],
  );

  const map3b = await loadEventMapData('20260730', 'H', '3b');
  assert.ok(map3b);
  assert.ok(map3b['0']);
  assert.equal(Object.hasOwn(map3b, 'β'), false);

  readStart = readPaths.length;
  assert.equal(await loadEventMapData('20260730', 'E', '1'), null);
  assert.deepEqual(readPaths.slice(readStart), []);

  readStart = readPaths.length;
  const historicalEventMap = await loadEventMapData(
    '20260212',
    'E',
    1,
  );
  assert.ok(historicalEventMap);
  assert.deepEqual(
    readPaths.slice(readStart),
    ['resource/maps/event/20260212/E-1.json'],
  );

  readStart = readPaths.length;
  const normalMap = await loadMapData(1, 1);
  assert.ok(normalMap);
  assert.equal(readPaths[readStart], 'resource/maps/normal/1-1.json');

  const plan = PlanModel.fromYaml([
    "event: '20260730'",
    'chapter: E',
    'map: 1a',
    'selected_nodes: [B]',
    '',
  ].join('\n'), 'event-plan.yaml');
  const roundTrip = yaml.load(plan.toYaml());
  assert.equal(roundTrip.event, '20260730');
  assert.equal(roundTrip.chapter, 'E');
  assert.equal(roundTrip.map, '1a');
  assert.equal(plan.mapName, 'E-Ex-1-α');

  const betaPlan = PlanModel.create('H', '3b', ['0', 'A'], '20260730');
  const betaRoundTrip = yaml.load(betaPlan.toYaml());
  assert.equal(betaRoundTrip.event, '20260730');
  assert.equal(betaRoundTrip.chapter, 'H');
  assert.equal(betaRoundTrip.map, '3b');
  assert.equal(betaPlan.mapName, 'H-Ex-3-β');

  const legacyPlan = PlanModel.create('E', 1, ['0'], '20200101');
  assert.equal(legacyPlan.mapName, 'E-Ex-1');
  console.log('event map loader and plan round-trip tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
