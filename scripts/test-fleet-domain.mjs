import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const result = esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/model/fleet/FleetDraft.ts';",
      "export * from './src/model/fleet/FleetDraftEditor.ts';",
      "export * from './src/adapter/FleetPlannerDtoAdapter.ts';",
    ].join('\n'),
    loader: 'ts',
    resolveDir: process.cwd(),
    sourcefile: 'fleet-domain-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const testModule = { exports: {} };
new Function(
  'require',
  'module',
  'exports',
  result.outputFiles[0].text,
)(require, testModule, testModule.exports);

const {
  applyFleetDraftEdit,
  createFleetCandidateDraft,
  createFleetDraft,
  fleetDraftFromTeamPlan,
  fleetDraftToTeamPlan,
  isFleetSlotEmpty,
  moveFleetPrimary,
  toFleetShipLibrary,
  toFleetTeamPlan,
  toUserTeamPlanDto,
} = testModule.exports;

const testShip = (id, name, shipType = 'dd') => ({
  id,
  name,
  searchName: name,
  variant: 'normal',
  rarity: 5,
  shipType,
  sizeClass: 'small',
  roleClass: 'escort',
  country: 'CN',
  portraitUrl: '',
  backgroundUrl: '',
  frameUrl: '',
  typeIconUrl: '',
});

const draft = createFleetDraft();
assert.equal(draft.slots.length, 6);
assert.equal(draft.slots.every(isFleetSlotEmpty), true);

const primary = testShip(1, '主选舰', 'cl');
const assignedPrimary = applyFleetDraftEdit(draft, {
  type: 'assign-ship',
  selection: {
    group: 'formation',
    position: 0,
    candidateIndex: 0,
  },
  ship: primary,
});
assert.equal(assignedPrimary.changed, true);
assert.equal(draft.slots[0].primary, primary);
assert.deepEqual(draft.slots[0].shipTypes, ['cl']);

const backup = testShip(2, '备选舰', 'dd');
const assignedBackup = applyFleetDraftEdit(draft, {
  type: 'assign-ship',
  selection: {
    group: 'backup',
    position: 0,
    candidateIndex: 0,
  },
  ship: backup,
});
assert.equal(assignedBackup.changed, true);
assert.equal(draft.slots[0].candidates[0].ship, backup);
assert.deepEqual(draft.slots[0].candidates[0].shipTypes, ['dd']);

draft.slots[0].candidates[0].levelEnabled = true;
draft.slots[0].candidates[0].minLevel = 40;
assert.equal(applyFleetDraftEdit(draft, {
  type: 'copy-backups',
  sourcePosition: 0,
  targetPosition: 1,
}).changed, true);
assert.equal(draft.slots[1].candidates[0].ship, backup);
assert.equal(draft.slots[1].candidates[0].minLevel, 40);
assert.notEqual(
  draft.slots[1].candidates[0],
  draft.slots[0].candidates[0],
);

const secondPrimary = testShip(3, '第二主选', 'ca');
draft.slots[1].primary = secondPrimary;
draft.slots[1].shipTypes = ['ca'];
moveFleetPrimary(draft.slots, 0, 1, 'position');
assert.equal(draft.slots[0].primary, secondPrimary);
assert.equal(draft.slots[0].candidates[0].ship, backup);
assert.equal(draft.slots[1].primary, primary);

const plan = fleetDraftToTeamPlan(draft, '  测试编队  ');
assert.equal(plan.name, '测试编队');
assert.equal(plan.ships.length, 2);
assert.deepEqual(plan.ships[0], {
  name: '第二主选',
  shipTypes: ['ca'],
  candidates: [{
    name: '备选舰',
    shipTypes: ['dd'],
    minLevel: 40,
  }],
});

const restored = fleetDraftFromTeamPlan(
  {
    ...plan,
    file: 'team-测试编队.yaml',
    source: 'user',
  },
  [primary, backup, secondPrimary],
);
assert.equal(restored.slots.length, 6);
assert.equal(restored.slots[0].primary.name, '第二主选');
assert.equal(restored.slots[0].candidates[0].ship.name, '备选舰');
assert.deepEqual(
  fleetDraftToTeamPlan(restored, restored.name),
  plan,
);

const candidateOnly = createFleetDraft();
candidateOnly.slots[0].candidates[0] = createFleetCandidateDraft(
  backup,
);
candidateOnly.slots[0].shipTypes = ['dd'];
assert.deepEqual(
  fleetDraftToTeamPlan(candidateOnly, '纯备选').ships[0],
  {
    shipTypes: ['dd'],
    candidates: [{ name: '备选舰' }],
  },
);

const planDto = toUserTeamPlanDto(plan);
assert.deepEqual(planDto.ships[0], {
  name: '第二主选',
  search_name: undefined,
  ship_type: ['ca'],
  min_level: undefined,
  max_level: undefined,
  candidates: [{
    name: '备选舰',
    search_name: undefined,
    ship_type: ['dd'],
    min_level: 40,
    max_level: undefined,
  }],
});
const roundTripPlan = toFleetTeamPlan(planDto);
assert.equal(roundTripPlan.ships[0].name, plan.ships[0].name);
assert.deepEqual(
  roundTripPlan.ships[0].shipTypes,
  plan.ships[0].shipTypes,
);
assert.equal(
  roundTripPlan.ships[0].candidates[0].name,
  plan.ships[0].candidates[0].name,
);
assert.deepEqual(
  roundTripPlan.ships[0].candidates[0].shipTypes,
  plan.ships[0].candidates[0].shipTypes,
);
assert.equal(roundTripPlan.ships[0].candidates[0].minLevel, 40);

const extendedDto = {
  name: '扩展字段编队',
  backend_metadata: { owner: 'test' },
  ships: [{
    name: '主选舰',
    custom_slot_rule: 'keep-slot',
    candidates: [{
      name: '备选舰',
      custom_candidate_rule: 'keep-candidate',
    }],
  }],
};
const extendedDraft = fleetDraftFromTeamPlan(
  toFleetTeamPlan(extendedDto),
  [primary, backup],
);
const extendedRoundTrip = toUserTeamPlanDto(
  fleetDraftToTeamPlan(extendedDraft, extendedDraft.name),
);
assert.deepEqual(extendedRoundTrip.backend_metadata, { owner: 'test' });
assert.equal(extendedRoundTrip.ships[0].custom_slot_rule, 'keep-slot');
assert.equal(
  extendedRoundTrip.ships[0].candidates[0].custom_candidate_rule,
  'keep-candidate',
);

const library = toFleetShipLibrary({
  schemaVersion: 1,
  generatedAt: '2026-08-05T00:00:00Z',
  labels: {
    ship_types: { kp: '导巡' },
    size_classes: { medium: '中型' },
    role_classes: { escort: '护航' },
    countries: { CN: '中国' },
    variants: { normal: '通常' },
  },
  typeGroups: {
    size_classes: { medium: ['kp'] },
    role_classes: { escort: ['kp'] },
  },
  ships: [{
    id: 1,
    name: '测试舰',
    search_name: '测试舰',
    variant: 'normal',
    rarity: 5,
    ship_type: 'kp',
    size_class: 'medium',
    role_class: 'escort',
    country: 'CN',
    portraitUrl: 'portrait.webp',
    backgroundUrl: 'background.webp',
    frameUrl: 'frame.webp',
    typeIconUrl: 'kp.webp',
  }],
});
assert.equal(library.labels.shipTypes.kp, '导巡');
assert.equal(library.ships[0].searchName, '测试舰');
assert.equal(library.ships[0].shipType, 'kp');

const invalidType = createFleetDraft();
invalidType.slots[0].primary = primary;
invalidType.slots[0].shipTypes = ['ddg'];
assert.throws(
  () => fleetDraftToTeamPlan(invalidType, '非法舰种'),
  /舰种不符合后端接口/,
);

const invalidLevel = createFleetDraft();
invalidLevel.slots[0].primary = primary;
invalidLevel.slots[0].levelEnabled = true;
invalidLevel.slots[0].minLevel = 80;
invalidLevel.slots[0].maxLevel = 20;
assert.throws(
  () => fleetDraftToTeamPlan(invalidLevel, '非法等级'),
  /最大等级不能小于最小等级/,
);

assert.equal(applyFleetDraftEdit(draft, { type: 'clear' }).changed, true);
assert.equal(draft.slots.every(isFleetSlotEmpty), true);

for (const file of [
  'src/model/fleet/FleetDraft.ts',
  'src/model/fleet/FleetDraftEditor.ts',
  'src/controller/plan/FleetPlannerController.ts',
  'src/controller/plan/fleetViewObjects.ts',
  'src/types/view.ts',
  'src/view/plan/FleetEditorView.ts',
  'src/view/plan/FleetGalleryView.ts',
  'src/view/plan/ShipArtwork.ts',
  'src/view/plan/TeamPlanLoaderView.ts',
  'src/view/plan/TeamPlanListUi.ts',
]) {
  assert.doesNotMatch(
    fs.readFileSync(file, 'utf8'),
    /types\/ipc/,
    `${file} must not depend on IPC DTOs`,
  );
}

console.log('fleet domain tests passed');
