const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PlanModel } = require('../../dist/src/model/PlanModel.js');
const { TaskQueue } = require('../../dist/src/model/scheduler/TaskQueue.js');
const {
  buildPlanQueueRequest,
} = require('../../dist/src/controller/taskGroup/queueLoader.js');
const {
  initialSelectedNodesForNewPlan,
} = require('../../dist/src/controller/plan/selectedNodes.js');
const {
  executePresetFlow,
} = require('../../dist/src/controller/plan/presetFlow.js');
const {
  saveNodeEditorValues,
} = require('../../dist/src/controller/plan/nodeEditor.js');
const {
  CurrentFleetController,
} = require('../../dist/src/controller/app/CurrentFleetController.js');
const {
  buildAutomaticDecisivePlanRequest,
} = require('../../dist/src/controller/app/AutomaticDecisiveTask.js');
const {
  createShipArtwork,
} = require('../../dist/src/view/plan/ShipArtwork.js');
const { ALL_SHIPS } = require('../../dist/src/shared/shipCatalog.js');
const {
  findShipLibraryShip,
} = require('../../dist/src/shared/shipLibrary.js');
const {
  FLEET_SHIP_TYPE_CODES,
  NATIVE_FLEET_SHIP_TYPE_CODES,
  NATIVE_FLEET_SHIP_TYPE_LABELS,
  normalizeFleetShipTypeCode,
  SHIP_TYPE_FILTER_ORDER,
  TYPE_LABELS,
} = require('../../dist/src/shared/fleetShipTypes.js');
const { ApiClient } = require('../../dist/src/model/ApiClient.js');
const {
  OperationsController,
} = require('../../dist/src/controller/app/OperationsController.js');

const intensifyCalls = [];
const intensifyApi = new ApiClient(
  'http://test.invalid',
  {
    request: async (method, requestPath, body) => {
      intensifyCalls.push({ method, requestPath, body });
      return { success: true, data: { executable: false } };
    },
  },
  {},
);
const intensifyPolicy = {
  target_ship: '胡德',
  material_ship_types: ['DD'],
  max_materials: 4,
  protected_ships: ['海伦娜'],
};
const unlimitedIntensifyPolicy = {
  material_ship_types: ['DD'],
  max_materials: null,
  protected_ships: ['海伦娜'],
};

async function verifyIntensifyApiContract() {
  await intensifyApi.autoIntensify(unlimitedIntensifyPolicy);
  const operationCalls = [];
  const mainView = {
    onOperation: null,
    setOperationLoading: () => {},
    setOpsStatus: () => {},
    setOpsAvailability: () => {},
  };
  const operations = new OperationsController(
    {
      expeditionCheck: async () => ({ success: true }),
      rewardCollect: async () => ({ success: true }),
      buildCollect: async () => ({ success: true }),
      cook: async () => ({ success: true }),
      repairBath: async () => ({ success: true }),
      autoIntensify: async request => {
        operationCalls.push(request);
        return { success: true };
      },
    },
    mainView,
    {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    () => ({
      target_ship: '手动预览目标不应发送',
      material_ship_types: ['DD', 'CL'],
      max_materials: null,
      protected_ships: ['海伦娜'],
    }),
  );
  const completion = new Promise(resolve => {
    const originalSetOperationLoading = mainView.setOperationLoading;
    mainView.setOperationLoading = (operation, loading) => {
      originalSetOperationLoading(operation, loading);
      if (operation === 'intensify' && !loading) resolve();
    };
  });
  operations.bindOpsActions();
  mainView.onOperation('intensify');
  await completion;
  assert.deepEqual(operationCalls, [{
    material_ship_types: ['DD', 'CL'],
    max_materials: null,
    protected_ships: ['海伦娜'],
  }]);
  await intensifyApi.intensifyPreview(intensifyPolicy);
  await intensifyApi.createIntensifySnapshotSession();
  const busyIntensifyApi = new ApiClient(
    'http://test.invalid',
    {
      request: async () => ({ success: false }),
      requestWithStatus: async () => ({
        status: 409,
        data: { detail: '设备正由 api:expedition-check 使用' },
      }),
    },
    {},
  );
  await assert.rejects(
    () => busyIntensifyApi.createIntensifySnapshotSession(),
    /设备正由 api:expedition-check 使用/,
  );
  const snapshotPreviewRequest = {
    session_id: 'snapshot-session',
    selected_target_ref: 'target:revision:0:0:0:0.1000:0.2000',
    allowed_material_identities: ['萤火虫'],
    maximum_materials: null,
    selected_material_refs: ['material:revision:0:0:0:0.1000:0.2000'],
  };
  await intensifyApi.intensifySnapshotPreview(snapshotPreviewRequest);
  assert.deepEqual(intensifyCalls, [
    {
      method: 'POST',
      requestPath: '/api/intensify',
      body: unlimitedIntensifyPolicy,
    },
    {
      method: 'POST',
      requestPath: '/api/intensify/preview',
      body: intensifyPolicy,
    },
    {
      method: 'POST',
      requestPath: '/api/intensify/snapshot-sessions',
      body: undefined,
    },
    {
      method: 'POST',
      requestPath: '/api/intensify/snapshot-preview',
      body: snapshotPreviewRequest,
    },
  ]);
}

const shipLibraryFixtures = [
  {
    id: 1,
    name: 'U-47',
    search_name: 'U-47',
    variant: 'normal',
    rarity: 4,
    ship_type: 'SS',
    portraitUrl: 'normal.png',
    backgroundUrl: 'background.png',
    frameUrl: 'frame.png',
    typeIconUrl: 'type.png',
  },
  {
    id: 2,
    name: 'U-47·改',
    search_name: 'U-47',
    variant: 'refit',
    rarity: 5,
    ship_type: 'SS',
    portraitUrl: 'refit.png',
    backgroundUrl: 'background.png',
    frameUrl: 'frame.png',
    typeIconUrl: 'type.png',
  },
];
assert.equal(
  findShipLibraryShip(shipLibraryFixtures, {
    name: 'U-47·改',
    searchName: 'U-47',
  })?.id,
  2,
);
assert.equal(
  findShipLibraryShip(shipLibraryFixtures, {
    searchName: 'U-47',
  })?.id,
  1,
);
const decisivePlan = {
  chapter: 6,
  useQuickRepair: true,
  level1: ['U-47·改', '未收录舰船'],
  level2: ['U-47'],
};
const decisiveRequest = buildAutomaticDecisivePlanRequest(
  decisivePlan,
  shipLibraryFixtures,
);
assert.deepEqual(decisiveRequest.level1, ['U-47', '未收录舰船']);
assert.deepEqual(decisiveRequest.level2, ['U-47']);
assert.deepEqual(decisivePlan.level1, ['U-47·改', '未收录舰船']);
assert.equal(
  findShipLibraryShip(shipLibraryFixtures, {
    name: 'U-47·旧称',
    allowBaseNameFallback: true,
  })?.id,
  1,
);

function fakeDomElement(tagName) {
  return {
    tagName,
    className: '',
    dataset: {},
    children: [],
    append(...children) {
      this.children.push(...children);
    },
  };
}

function findElementByClass(element, className) {
  if (element.className.split(/\s+/).includes(className)) return element;
  for (const child of element.children) {
    const match = findElementByClass(child, className);
    if (match) return match;
  }
  return null;
}

const previousDocument = global.document;
global.document = {
  createElement: fakeDomElement,
};
try {
  const compactArtwork = createShipArtwork(shipLibraryFixtures[1], {
    shipTypeLabel: '潜艇',
    showNumber: false,
    showName: false,
  });
  assert.equal(compactArtwork.dataset.searchName, 'U-47');
  assert.equal(findElementByClass(
    compactArtwork,
    'fleet-ship-number',
  ), null);
  assert.equal(findElementByClass(
    compactArtwork,
    'fleet-ship-name',
  ), null);
  assert.ok(findElementByClass(
    compactArtwork,
    'fleet-ship-type-icon',
  ));

  const namedArtwork = createShipArtwork(shipLibraryFixtures[1], {
    displayName: 'U-47·改',
    nameStyle: 'plain',
  });
  assert.ok(
    findElementByClass(namedArtwork, 'fleet-ship-name')
      .className.split(/\s+/).includes('is-plain'),
  );
  assert.equal(
    findElementByClass(namedArtwork, 'fleet-ship-name-text').textContent,
    'U-47·改',
  );
} finally {
  if (previousDocument === undefined) {
    delete global.document;
  } else {
    global.document = previousDocument;
  }
}

function buildFleetContractCase(name, sourceYaml) {
  const contractPlan = PlanModel.fromYaml(sourceYaml, `${name}.yaml`);
  const contractRequest = {
    type: 'normal_fight',
    times: 1,
    plan: {
      chapter: contractPlan.data.chapter,
      map: contractPlan.data.map,
      fleet_id: 1,
    },
  };
  new TaskQueue().switchTaskPreset({
    request: contractRequest,
    fleetId: 1,
    fleetPresets: contractPlan.data.fleet_presets,
    currentPresetIndex: -1,
  }, 0);
  return {
    name,
    source_yaml: sourceYaml,
    gui_yaml: contractPlan.toYaml(),
    request: contractRequest,
  };
}

function buildPlanRequest(plan, fileName) {
  return buildPlanQueueRequest({}, plan, fileName).req;
}

function runBackendFleetContract(cases) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const backendRoot = path.resolve(
    process.env.AUTOWSGR_REPO
      || path.join(projectRoot, '..', 'AutoWSGR'),
  );
  const venvPython = process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python');
  const python = process.env.AUTOWSGR_PYTHON
    || (fs.existsSync(venvPython)
      ? venvPython
      : process.platform === 'win32' ? 'python' : 'python3');
  const helper = path.join(__dirname, '..', 'backend-fleet-contract.py');

  assert.equal(
    fs.existsSync(path.join(
      backendRoot,
      'autowsgr',
      'server',
      'schemas.py',
    )),
    true,
    `找不到本地 AutoWSGR 后端仓库: ${backendRoot}`,
  );
  const result = spawnSync(python, [helper, backendRoot], {
    cwd: backendRoot,
    input: JSON.stringify(cases),
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    [
      '本地 AutoWSGR 跨仓契约测试失败',
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'),
  );
  return JSON.parse(result.stdout);
}

const pureBackupNames = [
  'U-47',
  'U-81',
  'U-96',
  'U-505',
  'U-2540',
  'U-1405',
];
const pureBackupCandidates = pureBackupNames.map(name => ({ name }));
const pureBackupPreview = new CurrentFleetController().resolve({
  type: 'normal_fight',
  times: 1,
  plan: {
    fleet: pureBackupNames,
    fleet_rules: pureBackupNames.map(() => ({
      candidates: pureBackupCandidates,
    })),
  },
});
assert.deepEqual(
  pureBackupPreview.map(ship => ship.name),
  pureBackupNames,
);
const pureBackupRuleOnlyPreview = new CurrentFleetController().resolve({
  type: 'normal_fight',
  times: 1,
  plan: {
    fleet_rules: pureBackupNames.map(() => ({
      candidates: pureBackupCandidates,
    })),
  },
});
assert.deepEqual(
  pureBackupRuleOnlyPreview.map(ship => ship.name),
  pureBackupNames,
);
const exactVariantPreview = new CurrentFleetController().resolve({
  type: 'normal_fight',
  times: 1,
  plan: {
    fleet: ['巴尔的摩'],
    fleet_rules: [{
      name: '巴尔的摩·改',
      search_name: '巴尔的摩',
    }],
  },
});
assert.deepEqual(
  exactVariantPreview.map(ship => ship.name),
  ['巴尔的摩·改'],
);
assert.deepEqual(
  new CurrentFleetController().resolve({
    type: 'normal_fight',
    times: 1,
    plan: {},
  }),
  [],
);

const plan = PlanModel.fromYaml([
  'chapter: 1',
  'map: 1',
  'fleet_presets:',
  '  - name: 候选契约',
  '    ships:',
  '      - candidates:',
  '          - name: 胡德',
  '            ship_type: [bc]',
  '            min_level: 20',
  '          - name: 扶桑',
  '            ship_type: [bb]',
  '            max_level: 90',
  '      - name: 重庆',
  '        ship_type: [kp, cg, bg, bbg, asdg, aadg, ap]',
  '        candidates:',
  '          - name: 长春',
  '      - ship_type: [ss]',
  '        min_level: 100',
  '',
].join('\n'), 'candidate-only.yaml');

const request = {
  type: 'normal_fight',
  times: 2,
  plan: {
    chapter: plan.data.chapter,
    map: plan.data.map,
    fleet_id: 1,
    node_defaults: {
      formation: 4,
      night: true,
      long_missile_support: true,
      proceed_stop: [1, 2],
    },
  },
};

const task = {
  request,
  fleetId: 1,
  fleetPresets: plan.data.fleet_presets,
  currentPresetIndex: -1,
};
new TaskQueue().switchTaskPreset(task, 0);

const [candidateOnly, strictPrimary, anonymousFilter] =
  request.plan.fleet_rules;
assert.equal(
  Object.prototype.hasOwnProperty.call(candidateOnly, 'name'),
  false,
);
assert.deepEqual(candidateOnly.candidates, [
  { name: '胡德', ship_type: ['bc'], min_level: 20 },
  { name: '扶桑', ship_type: ['bb'], max_level: 90 },
]);
assert.equal(strictPrimary.name, '重庆');
assert.deepEqual(
  strictPrimary.ship_type,
  ['kp', 'cg', 'bg', 'bbg', 'asdg', 'aadg', 'ap'],
);
assert.deepEqual(strictPrimary.candidates, [{ name: '长春' }]);
assert.equal(typeof anonymousFilter.name, 'string');
assert.ok(anonymousFilter.name.length > 0);
assert.equal(anonymousFilter.search_name, anonymousFilter.name);
assert.deepEqual(anonymousFilter.ship_type, ['ss']);
assert.equal(anonymousFilter.min_level, 100);
assert.equal(
  Object.prototype.hasOwnProperty.call(request, 'fleet_id'),
  false,
);

const aliasPlan = PlanModel.fromYaml([
  'chapter: 4',
  'map: 1',
  'fleet_presets:',
  '  - name: 周常4-1',
  '    ships:',
  '      - name: 85工程',
  '',
].join('\n'), 'weekly-4-1.yaml');
const shipNameAliases = { 契卡洛夫: '85工程' };
const { req: aliasPlanRequest } = buildPlanQueueRequest(
  { fleetPresetIndex: 0 },
  aliasPlan,
  'weekly-4-1.yaml',
  shipNameAliases,
);
assert.deepEqual(aliasPlanRequest.plan.fleet_rules[0], {
  name: '85工程',
  search_name: '契卡洛夫',
});
assert.deepEqual(
  aliasPlanRequest.plan.selected_nodes,
  [],
  '旧计划的空节点白名单必须保持原有语义',
);
assert.deepEqual(
  initialSelectedNodesForNewPlan(),
  ['0'],
  '新建计划必须只开启起始节点',
);
const startOnlyPlan = PlanModel.fromYaml([
  'chapter: 1',
  'map: 1',
  'selected_nodes: ["0"]',
  '',
].join('\n'), 'start-only.yaml');
assert.throws(
  () => buildPlanQueueRequest({}, startOnlyPlan, 'start-only.yaml'),
  /请至少开启一个路线节点/,
  '只有起始节点的未完成计划不得进入战斗队列',
);

const nodeFormationPlan = PlanModel.fromYaml([
  'chapter: 7',
  'map: 4',
  'selected_nodes: [A, B]',
  'endpoint_nodes: [B]',
  'result: B',
  'node_defaults:',
  '  formation: 2',
  '  night: false',
  '  long_missile_support: false',
  '  proceed: true',
  'node_args:',
  '  A:',
  '    night: true',
  '    long_missile_support: true',
  '    proceed: true',
  '  B:',
  '    formation: 4',
  '    night: true',
  '    long_missile_support: true',
  '    proceed: true',
  '',
].join('\n'), 'node-formation.yaml');
const { req: nodeFormationRequest } = buildPlanQueueRequest(
  {},
  nodeFormationPlan,
  'node-formation.yaml',
);
assert.deepEqual(nodeFormationRequest.plan.selected_nodes, ['A', 'B', '0']);
assert.deepEqual(JSON.parse(JSON.stringify(nodeFormationRequest.plan.node_defaults)), {
  formation: 2,
  night: false,
  long_missile_support: false,
  proceed: true,
});
assert.deepEqual(JSON.parse(JSON.stringify(nodeFormationRequest.plan.node_args)), {
  A: {
    night: true,
    long_missile_support: true,
    proceed: true,
  },
  B: {
    formation: 4,
    night: true,
    long_missile_support: true,
    proceed: false,
  },
});

const weekly92File = 'bettle-周常-9-2.yaml';
const weekly92Yaml = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  'resource',
  'system_battle_plans',
  weekly92File,
), 'utf8');
const weekly92Plan = PlanModel.fromYaml(weekly92Yaml, weekly92File);
const legacySlPlan = PlanModel.fromYaml(
  weekly92Yaml.replaceAll('SL_when_detour_fails', 'sl_when_detour_fails'),
  `legacy-${weekly92File}`,
);
const weekly92Request = buildPlanRequest(weekly92Plan, weekly92File);
const legacySlRequest = buildPlanRequest(legacySlPlan, `legacy-${weekly92File}`);

const endpointRoundTripPlan = PlanModel.fromYaml(
  nodeFormationPlan.toYaml(),
  'node-formation-round-trip.yaml',
);
assert.equal(endpointRoundTripPlan.data.node_args.B.proceed, false);
assert.equal(endpointRoundTripPlan.getNodeArgs('B').proceed, false);

const endpointEditorPlan = PlanModel.fromYaml([
  'chapter: 7',
  'map: 4',
  'selected_nodes: [A]',
  'node_defaults: {formation: 2, proceed: true}',
  '',
].join('\n'), 'node-editor-actions.yaml');
const endpointEditorSaved = saveNodeEditorValues(
  {
    collectNodeEditorValues: () => ({
      enabled: true,
      isEndpoint: true,
      result: 'S',
      formation: 4,
      night: true,
      longMissileSupport: true,
      proceed: true,
      detour: true,
      slWhenDetourFails: false,
      rulesText: '',
    }),
    hideNodeEditor: () => {},
  },
  endpointEditorPlan,
  'A',
);
assert.equal(endpointEditorSaved, true);
assert.deepEqual(endpointEditorPlan.data.endpoint_nodes, ['A']);
assert.equal(endpointEditorPlan.data.result, 'S');
assert.deepEqual(endpointEditorPlan.data.node_args.A, {
  formation: 4,
  night: true,
  long_missile_support: true,
  proceed: false,
  detour: true,
  SL_when_detour_fails: false,
  enemy_rules: undefined,
});
const endpointEditorRequest = buildPlanRequest(endpointEditorPlan, 'node-editor-actions.yaml');
assert.equal(
  endpointEditorRequest.plan.node_args.A.SL_when_detour_fails,
  false,
);

for (const { source, times, expected } of [
  {
    source: 'user',
    times: 10,
    expected: [['U-47'], ['未收录舰名'], ['U-47']],
  },
  {
    source: 'system',
    times: 1,
    expected: [['U-47·改'], ['未收录舰名'], ['U-47·改']],
  },
]) {
  let queuedDecisiveTask = null;
  executePresetFlow(
    {
      collectPresetFormValues: () => ({
        times,
        chapter: 6,
        level1: ['U-47·改'],
        level2: ['未收录舰名'],
        flagshipPriority: ['U-47·改'],
        useQuickRepair: true,
      }),
      hidePresetDetail: () => {},
    },
    {
      scheduler: {
        addTask: (...args) => {
          queuedDecisiveTask = args;
        },
      },
      switchPage: () => {},
      renderMain: () => {},
    },
    {
      currentPreset: { task_type: 'decisive' },
      currentPresetFilePath: `decisive-${source}.yaml`,
      currentPresetSource: source,
    },
    shipLibraryFixtures,
  );
  assert.equal(queuedDecisiveTask[4], times);
  assert.deepEqual([
    queuedDecisiveTask[2].level1,
    queuedDecisiveTask[2].level2,
    queuedDecisiveTask[2].flagship_priority,
  ], expected);
}

const rotatedAliasRequest = {
  type: 'normal_fight',
  times: 1,
  plan: {},
};
new TaskQueue(() => shipNameAliases).switchTaskPreset({
  request: rotatedAliasRequest,
  fleetId: 1,
  fleetPresets: aliasPlan.data.fleet_presets,
  currentPresetIndex: -1,
}, 0);
assert.deepEqual(rotatedAliasRequest.plan.fleet_rules[0], {
  name: '85工程',
  search_name: '契卡洛夫',
});

assert.equal(request.plan.node_defaults.long_missile_support, true);
assert.deepEqual(request.plan.node_defaults.proceed_stop, [1, 2]);
assert.equal(TYPE_LABELS.kp, '导巡');
assert.equal(TYPE_LABELS.cg, '防巡');
assert.deepEqual(
  new Set(NATIVE_FLEET_SHIP_TYPE_CODES),
  new Set(Object.keys(NATIVE_FLEET_SHIP_TYPE_LABELS)),
);
assert.deepEqual(
  new Set(SHIP_TYPE_FILTER_ORDER),
  new Set(NATIVE_FLEET_SHIP_TYPE_CODES),
);
assert.deepEqual(
  new Set(FLEET_SHIP_TYPE_CODES),
  new Set([...NATIVE_FLEET_SHIP_TYPE_CODES, 'ss_or_ssg']),
);
const nativeShipTypes = new Set(NATIVE_FLEET_SHIP_TYPE_CODES);
assert.ok(ALL_SHIPS.length >= 875);
for (const ship of ALL_SHIPS) {
  assert.equal(
    nativeShipTypes.has(ship.ship_type),
    true,
    `${ship.name} 使用了非 canonical 舰种 ${ship.ship_type}`,
  );
}
for (const shipType of ['cg', 'bg', 'asdg', 'kp']) {
  assert.equal(normalizeFleetShipTypeCode(shipType), shipType);
}
for (const shipType of ['cgaa', 'cbg', 'ddg', 'ddgaa', 'cf']) {
  assert.equal(normalizeFleetShipTypeCode(shipType), null);
}

verifyIntensifyApiContract().then(() => {
const crossRepoCases = [
  buildFleetContractCase('structured-candidate-only', [
    'chapter: 1',
    'map: 1',
    'fleet_presets:',
    '  - name: 结构化纯候选',
    '    ships:',
    '      - candidates:',
    '          - name: 胡德',
    '            ship_type: [bc]',
    '            min_level: 20',
    '          - name: 扶桑',
    '            ship_type: [bb]',
    '            max_level: 90',
    '      - candidates:',
    '          - name: 胡德',
    '',
  ].join('\n')),
  buildFleetContractCase('legacy-string-candidate-only', [
    'chapter: 1',
    'map: 1',
    'fleet_presets:',
    '  - name: 旧字符串纯候选',
    '    ships:',
    '      - search_name: 契卡洛夫',
    '        ship_type: [cv]',
    '        min_level: 90',
    '        max_level: 110',
    '        candidates: [85工程, 岛风]',
    '      - candidates: [胡德, 扶桑]',
    '      - candidates: [胡德]',
    '',
  ].join('\n')),
  buildFleetContractCase('mixed-candidate-only', [
    'chapter: 1',
    'map: 1',
    'fleet_presets:',
    '  - name: 混合纯候选',
    '    ships:',
    '      - search_name: 大凤',
    '        ship_type: [cv]',
    '        min_level: 80',
    '        max_level: 100',
    '        candidates:',
    '          - 大凤·改',
    '          - name: 岛风',
    '            search_name: 岛风',
    '            ship_type: [dd]',
    '            min_level: 20',
    '            max_level: 30',
    '',
  ].join('\n')),
  buildFleetContractCase('strict-primary', [
    'chapter: 1',
    'map: 1',
    'fleet_presets:',
    '  - name: 严格主选',
    '    ships:',
    '      - name: 胡德',
    '        search_name: 胡德',
    '        ship_type: [bc]',
    '        min_level: 20',
    '        candidates:',
    '          - name: 扶桑',
    '            ship_type: [bb]',
    '            max_level: 90',
    '',
  ].join('\n')),
  buildFleetContractCase('relaxed-primary-and-candidate', [
    'chapter: 1',
    'map: 1',
    'fleet_presets:',
    '  - name: 宽泛规则',
    '    ships:',
    '      - name: 重庆',
    '        search_name: 重庆',
    '        ship_type: [kp]',
    '        relaxed: true',
    '        candidates:',
    '          - 长春',
    '          - name: 昆西',
    '            ship_type: [cl]',
    '            relaxed: true',
    '',
  ].join('\n')),
];

const legacyApiRules = crossRepoCases[1].request.plan.fleet_rules;
assert.equal(legacyApiRules.length, 3);
for (const rule of legacyApiRules) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(rule, 'name'),
    false,
  );
}
assert.equal(
  Object.prototype.hasOwnProperty.call(legacyApiRules[0], 'search_name'),
  false,
);
assert.deepEqual(
  legacyApiRules[0].candidates.map(rule => ({
    name: rule.name,
    search_name: rule.search_name,
    ship_type: rule.ship_type,
    min_level: rule.min_level,
    max_level: rule.max_level,
  })),
  [
    {
      name: '85工程',
      search_name: '契卡洛夫',
      ship_type: ['cv'],
      min_level: 90,
      max_level: 110,
    },
    {
      name: '岛风',
      search_name: '契卡洛夫',
      ship_type: ['cv'],
      min_level: 90,
      max_level: 110,
    },
  ],
);
const mixedApiRule = crossRepoCases[2].request.plan.fleet_rules[0];
assert.equal(
  Object.prototype.hasOwnProperty.call(mixedApiRule, 'name'),
  false,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(mixedApiRule, 'search_name'),
  false,
);
assert.deepEqual(mixedApiRule.candidates, [
  {
    name: '大凤·改',
    search_name: '大凤',
    ship_type: ['cv'],
    min_level: 80,
    max_level: 100,
  },
  {
    name: '岛风',
    search_name: '岛风',
    ship_type: ['dd'],
    min_level: 20,
    max_level: 30,
  },
]);

const backendContracts = runBackendFleetContract(crossRepoCases);
assert.equal(backendContracts.length, crossRepoCases.length);
for (const contract of backendContracts) {
  assert.deepEqual(
    contract.api,
    contract.source_yaml,
    `${contract.name}: GUI API 与后端原始 YAML 语义不一致`,
  );
  assert.deepEqual(
    contract.gui_yaml,
    contract.source_yaml,
    `${contract.name}: GUI 保存 YAML 改变了后端语义`,
  );
}
for (const contract of backendContracts.slice(0, 3)) {
  for (const slot of contract.api) {
    assert.equal(slot.primary, null);
  }
}
assert.equal(backendContracts[3].api[0].primary.name, '胡德');
assert.equal(backendContracts[3].api[0].primary.search_name, '胡德');
assert.equal(backendContracts[3].api[0].primary.min_level, 20);
assert.deepEqual(
  backendContracts[3].api[0].candidates.map(rule => rule.name),
  ['扶桑'],
);
assert.deepEqual(
  backendContracts[1].api[1].candidates.map(rule => rule.name),
  ['胡德', '扶桑'],
);
assert.deepEqual(
  backendContracts[1].api[2].candidates.map(rule => rule.name),
  ['胡德'],
);
const relaxedApiRule = crossRepoCases[4].request.plan.fleet_rules[0];
assert.equal(relaxedApiRule.relaxed, true);
assert.equal(relaxedApiRule.candidates[0].relaxed, undefined);
assert.equal(relaxedApiRule.candidates[1].relaxed, true);
assert.equal(backendContracts[4].api[0].primary.relaxed, true);
assert.equal(backendContracts[4].api[0].candidates[0].relaxed, false);
assert.equal(backendContracts[4].api[0].candidates[1].relaxed, true);
const backendNodeContracts = runBackendFleetContract([
  ['generated-node-editor', endpointEditorRequest],
  ['legacy-lowercase-sl', legacySlRequest],
  ['system-weekly-9-2', weekly92Request],
].map(([name, request]) => ({
  name,
  node_contract: true,
  request,
})));
assert.equal(backendNodeContracts.length, 3);
const backendNodeContractsByName = Object.fromEntries(
  backendNodeContracts.map(contract => [contract.name, contract]),
);
assert.equal(
  backendNodeContractsByName['generated-node-editor']
    .node_decisions.nodes.A,
  false,
);
for (const name of ['legacy-lowercase-sl', 'system-weekly-9-2']) {
  const decisions = backendNodeContractsByName[name].node_decisions;
  assert.equal(decisions.default, true);
  assert.equal(
    Object.values(decisions.nodes).every(value => value === true),
    true,
  );
}
console.log('GUI/AutoWSGR API contract tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
