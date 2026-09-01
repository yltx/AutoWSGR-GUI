/**
 * Renderer architecture contracts.
 *
 * Controllers do not own browser UI details, Views do not reach into stateful
 * Model/IPC implementations, and the shared ship gallery releases resources.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const controllerRoot = path.join(root, 'src', 'controller');
const viewRoot = path.join(root, 'src', 'view');

function listTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(target);
      return entry.isFile() && entry.name.endsWith('.ts')
        ? [target]
        : [];
    });
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll('\\', '/');
}

function findViolations(files, rules, isAllowed = () => false) {
  const violations = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of rules) {
        if (rule.pattern.test(line) && !isAllowed(file, line, rule)) {
          violations.push(
            `${relative(file)}:${index + 1} `
            + `[${rule.name}] ${line.trim()}`,
          );
        }
      }
    }
  }
  return violations;
}

const controllerFiles = listTypeScriptFiles(controllerRoot);
const controllerViolations = findViolations(controllerFiles, [
  { name: 'DOM access', pattern: /\bdocument\s*\./ },
  {
    name: 'global Electron bridge',
    pattern: /\bwindow\s*\.\s*electronBridge\b/,
  },
  { name: 'direct browser storage', pattern: /\blocalStorage\s*\./ },
  {
    name: 'browser event ownership',
    pattern: /\bwindow\s*\.\s*(?:addEventListener|matchMedia)\b/,
  },
  {
    name: 'DOM implementation type',
    pattern: /\b(?:ResizeObserver|HTMLElement|HTMLButtonElement|HTMLInputElement|HTMLSelectElement)\b/,
  },
]);
assert.deepEqual(
  controllerViolations,
  [],
  `Controller boundary violations:\n${controllerViolations.join('\n')}`,
);

const navigationSource = fs.readFileSync(
  path.join(controllerRoot, 'app', 'NavigationController.ts'),
  'utf8',
);
assert.doesNotMatch(
  navigationSource,
  /\b(?:PlanController|FleetPlannerController)\b/,
  'NavigationController must depend on navigation capabilities, not concrete plan controllers',
);

const viewFiles = listTypeScriptFiles(viewRoot);
const viewViolations = findViolations(
  viewFiles,
  [
    {
      name: 'stateful Model import',
      pattern: /\b(?:from\s+|import\s*)['"][^'"]*\/model(?:\/|['"])/,
    },
    {
      name: 'ApiClient import',
      pattern: /\b(?:from\s+|import\s*)['"][^'"]*\/ApiClient(?:\.js)?['"]/,
    },
    {
      name: 'direct Adapter import',
      pattern: /\b(?:from\s+|import\s*)['"][^'"]*\/adapter(?:\/|['"])/,
    },
    {
      name: 'global Electron bridge',
      pattern: /\bwindow\s*\.\s*electronBridge\b/,
    },
    { name: 'direct browser storage', pattern: /\blocalStorage\s*\./ },
  ],
  (file, line, rule) => (
    rule.name === 'direct Adapter import'
    && relative(file) === 'src/view/theme.ts'
    && line.includes("'../adapter/StorageAdapter'")
  ),
);
assert.deepEqual(
  viewViolations,
  [],
  `View boundary violations:\n${viewViolations.join('\n')}`,
);

function assertDisposeDelegation(filePath, target) {
  const source = fs.readFileSync(path.join(root, filePath), 'utf8');
  assert.match(
    source,
    new RegExp(
      String.raw`dispose\(\): void\s*\{\s*this\.${target}\.dispose\(\);\s*\}`,
    ),
    `${filePath} must dispose ${target}`,
  );
}

assertDisposeDelegation('src/view/plan/FleetPlannerView.ts', 'galleryView');
assertDisposeDelegation('src/view/plan/DecisivePlanView.ts', 'galleryView');
assertDisposeDelegation(
  'src/controller/plan/FleetPlannerController.ts',
  'view',
);
assertDisposeDelegation(
  'src/controller/plan/DecisivePlanController.ts',
  'view',
);

const appControllerSource = fs.readFileSync(
  path.join(controllerRoot, 'app', 'AppController.ts'),
  'utf8',
);
assert.match(
  appControllerSource,
  /onBeforeUnload\s*=\s*\(\)\s*=>\s*\{[^}]*schedulerBinder\.dispose\(\)[^}]*fleetPlannerCtrl\.dispose\(\)[^}]*decisivePlanCtrl\.dispose\(\)[^}]*configView\.dispose\(\)/,
  'AppController unload handler must dispose gallery and config view owners',
);

assertDisposeDelegation('src/view/config/ConfigView.ts', 'intensifyShipAutocomplete');

const settingsControllerSource = fs.readFileSync(
  path.join(controllerRoot, 'app', 'SettingsController.ts'),
  'utf8',
);
assert.match(
  settingsControllerSource,
  /this\.api\.createIntensifySnapshotSession\(/,
  'SettingsController must own read-only intensify inventory scanning',
);
assert.match(
  settingsControllerSource,
  /this\.api\.intensifySnapshotPreview\(/,
  'SettingsController must own exact-occurrence snapshot preview orchestration',
);
assert.doesNotMatch(
  settingsControllerSource,
  /this\.api\.intensify\(/,
  'SettingsController must not call the irreversible intensify endpoint',
);
assert.match(
  appControllerSource,
  /private renderConfig\(\): void\s*\{\s*this\.settingsCtrl\.invalidateIntensifySession\(\);\s*this\.configCtrl\.renderConfig\(\);\s*\}/,
  'AppController must invalidate read-only intensify sessions before config rerenders',
);

const listenerSignals = [];
function fakeElement(overrides = {}) {
  return {
    checked: false,
    hidden: true,
    addEventListener(_type, _listener, options) {
      if (options?.signal) listenerSignals.push(options.signal);
    },
    contains() {
      return false;
    },
    ...overrides,
  };
}

const previousDocument = global.document;
const previousResizeObserver = global.ResizeObserver;
let observedElement = null;
let disconnectCount = 0;
let savedGalleryState = null;
global.document = fakeElement();
global.ResizeObserver = class {
  observe(element) {
    observedElement = element;
  }

  disconnect() {
    disconnectCount += 1;
  }
};

try {
  const {
    ShipGalleryView,
  } = require('../../dist/src/view/plan/ShipGalleryView.js');
  const galleryElement = fakeElement({
    scrollTop: 321,
    scrollLeft: 0,
  });
  const searchInput = fakeElement({ value: '' });
  const refitFilter = fakeElement();
  const sortDescending = fakeElement();
  const gallery = new ShipGalleryView({
    gallery: galleryElement,
    countLabel: fakeElement(),
    searchInput,
    filterButtons: [fakeElement()],
    filterCount: fakeElement(),
    filterPopover: fakeElement(),
    typeOptions: fakeElement(),
    countryOptions: fakeElement(),
    refitFilter,
    sortDescending,
    resetButton: fakeElement(),
    confirmButton: fakeElement(),
  }, {
    activeSlotDescription: () => 'test slot',
    isExcluded: () => false,
    assignShip: () => {},
    getGalleryState: () => ({
      searchText: 'U-47',
      groupFilter: null,
      typeFilters: ['ss'],
      countryFilters: ['de'],
      refitOnly: true,
      sortField: 'name',
      descending: true,
      scrollTop: 321,
      scrollLeft: 0,
      renderedShipCount: 36,
    }),
    setGalleryState: state => {
      savedGalleryState = state;
    },
  });

  assert.equal(observedElement, galleryElement);
  assert.equal(searchInput.value, 'U-47');
  assert.equal(refitFilter.checked, true);
  assert.equal(sortDescending.checked, true);
  assert.ok(listenerSignals.length > 0, 'gallery listeners must use AbortSignal');
  const signal = listenerSignals[0];
  assert.equal(
    listenerSignals.every(candidate => candidate === signal),
    true,
    'gallery listeners must share one lifecycle signal',
  );
  assert.equal(signal.aborted, false);

  gallery.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(disconnectCount, 1);
  assert.equal(savedGalleryState.searchText, 'U-47');
  assert.equal(savedGalleryState.scrollTop, 321);
  gallery.dispose();
  assert.equal(disconnectCount, 1, 'gallery disposal must be idempotent');
} finally {
  if (previousDocument === undefined) delete global.document;
  else global.document = previousDocument;
  if (previousResizeObserver === undefined) delete global.ResizeObserver;
  else global.ResizeObserver = previousResizeObserver;
}

console.log(
  'renderer architecture tests passed '
  + `(${controllerFiles.length} controllers, ${viewFiles.length} views)`,
);
