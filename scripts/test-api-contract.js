const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PlanModel } = require('../dist/src/model/PlanModel.js');
const { TaskQueue } = require('../dist/src/model/scheduler/TaskQueue.js');
const {
  buildPlanQueueRequest,
} = require('../dist/src/controller/taskGroup/queueLoader.js');
const { ALL_SHIPS } = require('../dist/src/shared/shipCatalog.js');
const {
  FLEET_SHIP_TYPE_CODES,
  NATIVE_FLEET_SHIP_TYPE_CODES,
  NATIVE_FLEET_SHIP_TYPE_LABELS,
  normalizeFleetShipTypeCode,
  SHIP_TYPE_FILTER_ORDER,
  TYPE_LABELS,
} = require('../dist/src/shared/fleetShipTypes.js');

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

function runBackendFleetContract(cases) {
  const projectRoot = path.resolve(__dirname, '..');
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
  const helper = path.join(__dirname, 'backend-fleet-contract.py');

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
console.log('GUI/AutoWSGR API contract tests passed');
