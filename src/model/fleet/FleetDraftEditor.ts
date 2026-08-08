/** 集中执行普通舰队编辑命令，保证 FleetDraft 只在领域边界内写入。 */
import type {
  FleetDraftEditIntent,
  FleetDraftEditResult,
  FleetEditorSelection,
  FleetRuleUpdate,
} from '../../types/fleetEditor.js';
import type { ShipLibraryShip } from '../../types/ipc.js';
import { normalizeFleetShipTypeCode } from '../../shared/fleetShipTypes.js';
import {
  cloneFleetRule,
  compactFleetDraftSlots,
  copyFleetRule,
  createFleetCandidateDraft,
  createFleetRuleDraft,
  createFleetSlotDraft,
  hasOtherPrimaryShip,
  insertFleetCandidate,
  insertFleetPrimary,
  isFleetSlotEmpty,
  moveFleetPrimary,
  removeFleetPrimary,
  resolveFleetSlotPosition,
  resolveGalleryFormationAssignment,
  resolveGalleryFormationDropTarget,
} from './FleetDraft.js';
import type {
  FleetCandidateDraft,
  FleetDraft,
  FleetRuleDraft,
  FleetSlotDraft,
} from './FleetDraft.js';

const DEFAULT_BACKUP_SLOT_COUNT = 6;
const FLEET_SLOT_COUNT = 6;

const unchanged = (): FleetDraftEditResult => ({ changed: false });
const changed = (
  selection?: FleetEditorSelection,
): FleetDraftEditResult => selection
  ? { changed: true, selection }
  : { changed: true };

const formationSelection = (position: number): FleetEditorSelection => ({
  group: 'formation',
  position,
  candidateIndex: 0,
});

const backupSelection = (
  position: number,
  candidateIndex: number,
): FleetEditorSelection => ({
  group: 'backup',
  position,
  candidateIndex,
});

function selectionAt(
  selection: FleetEditorSelection,
  position: number,
): FleetEditorSelection {
  return selection.group === 'formation'
    ? formationSelection(position)
    : backupSelection(position, selection.candidateIndex);
}

function applyDefaultShipType(
  rule: FleetRuleDraft,
  ship: ShipLibraryShip,
): void {
  const shipType = normalizeFleetShipTypeCode(ship.ship_type);
  if (
    shipType
    && (
      rule.shipTypes.length === 0
      || !rule.shipTypes.includes(shipType)
    )
  ) {
    rule.shipTypes = [shipType];
  }
}

function compactCandidates(candidates: FleetCandidateDraft[]): void {
  const occupied = candidates.filter(candidate => candidate.ship !== null);
  const slotCount = Math.max(DEFAULT_BACKUP_SLOT_COUNT, occupied.length);
  candidates.splice(
    0,
    candidates.length,
    ...occupied,
    ...Array.from(
      { length: slotCount - occupied.length },
      createFleetCandidateDraft,
    ),
  );
}

function assignFormationShip(
  draft: FleetDraft,
  ship: ShipLibraryShip,
  position: number,
): number {
  const firstEmpty = draft.slots.findIndex(isFleetSlotEmpty);
  const requested = draft.slots[position];
  const target = (
    requested.primary
    || !isFleetSlotEmpty(requested)
    || firstEmpty < 0
  )
    ? position
    : firstEmpty;
  const slot = draft.slots[target];
  slot.primary = ship;
  applyDefaultShipType(slot, ship);
  return target;
}

function assignShip(
  draft: FleetDraft,
  intent: Extract<FleetDraftEditIntent, { type: 'assign-ship' }>,
): FleetDraftEditResult {
  const { selection, ship } = intent;
  if (selection.group === 'formation') {
    const assignment = resolveGalleryFormationAssignment(
      draft.slots,
      selection.position,
      ship.search_name,
    );
    assignFormationShip(draft, ship, assignment.targetPosition);
    return changed(formationSelection(assignment.activePosition));
  }

  const slot = draft.slots[selection.position];
  if (!slot) return unchanged();
  const existing = slot.candidates.findIndex(
    candidate => candidate.ship?.search_name === ship.search_name,
  );
  if (existing >= 0) {
    const candidate = slot.candidates[existing];
    candidate.ship = ship;
    applyDefaultShipType(candidate, ship);
    return changed(backupSelection(selection.position, existing));
  }

  const selected = slot.candidates[selection.candidateIndex];
  const replacing = Boolean(selected?.ship);
  const firstEmpty = slot.candidates.findIndex(item => item.ship === null);
  const target = (selected?.ship || firstEmpty < 0)
    ? selection.candidateIndex
    : firstEmpty;
  while (!slot.candidates[target]) {
    slot.candidates.push(createFleetCandidateDraft());
  }
  const candidate = slot.candidates[target];
  candidate.ship = ship;
  applyDefaultShipType(candidate, ship);

  const nextEmpty = replacing
    ? -1
    : slot.candidates.findIndex(
        (item, index) => index > target && item.ship === null,
      );
  return changed(backupSelection(
    selection.position,
    nextEmpty >= 0 ? nextEmpty : target,
  ));
}

function removePrimary(
  draft: FleetDraft,
  position: number,
  selection: FleetEditorSelection,
): FleetDraftEditResult {
  const activePosition = removeFleetPrimary(
    draft.slots,
    position,
    selection.position,
  );
  return changed(
    position === selection.position
      ? formationSelection(activePosition)
      : selectionAt(selection, activePosition),
  );
}

function removeCandidate(
  draft: FleetDraft,
  position: number,
  candidateIndex: number,
): FleetDraftEditResult {
  const owner = draft.slots[position];
  if (!owner?.candidates[candidateIndex]) return unchanged();
  owner.candidates.splice(candidateIndex, 1);
  compactCandidates(owner.candidates);
  if (isFleetSlotEmpty(owner)) {
    compactFleetDraftSlots(draft.slots);
    return changed(formationSelection(
      Math.min(position, FLEET_SLOT_COUNT - 1),
    ));
  }
  return changed(backupSelection(
    draft.slots.indexOf(owner),
    Math.min(candidateIndex, owner.candidates.length - 1),
  ));
}

function ensureCandidate(
  draft: FleetDraft,
  position: number,
): FleetDraftEditResult {
  const candidates = draft.slots[position]?.candidates;
  if (!candidates) return unchanged();
  let target = candidates.findIndex(candidate => candidate.ship === null);
  if (target < 0) {
    candidates.push(createFleetCandidateDraft());
    target = candidates.length - 1;
  }
  return changed(backupSelection(position, target));
}

function insertFormationShip(
  draft: FleetDraft,
  ship: ShipLibraryShip,
  targetPosition: number,
  mode: 'ship' | 'position',
): number {
  const target = resolveGalleryFormationDropTarget(
    draft.slots,
    targetPosition,
  );
  if (target !== targetPosition) {
    return assignFormationShip(draft, ship, target);
  }
  const targetSlot = draft.slots[target];
  if (targetSlot && !targetSlot.primary && !isFleetSlotEmpty(targetSlot)) {
    return assignFormationShip(draft, ship, target);
  }
  const inserted = createFleetSlotDraft();
  inserted.primary = ship;
  applyDefaultShipType(inserted, ship);
  if (!insertFleetPrimary(draft.slots, target, inserted, mode)) {
    assignFormationShip(draft, ship, target);
  }
  return target;
}

function swapPrimaryAndCandidate(
  primarySlot: FleetSlotDraft,
  candidateSlot: FleetSlotDraft,
  candidateIndex: number,
): FleetCandidateDraft {
  const primary = primarySlot.primary!;
  const primaryRule = cloneFleetRule(primarySlot);
  const candidate = candidateSlot.candidates[candidateIndex];
  const promoted = candidate.ship!;
  const promotedRule = cloneFleetRule(candidate);
  primarySlot.primary = promoted;
  copyFleetRule(primarySlot, promotedRule);
  candidate.ship = primary;
  copyFleetRule(candidate, primaryRule);
  return candidate;
}

function appendBackupCandidate(
  targetSlot: FleetSlotDraft,
  ship: ShipLibraryShip,
  rule: FleetRuleDraft,
): FleetCandidateDraft {
  const occupied = targetSlot.candidates.filter(candidate => (
    candidate.ship !== null
    && candidate.ship.search_name !== ship.search_name
  ));
  const selected = createFleetCandidateDraft(ship);
  copyFleetRule(selected, rule);
  occupied.push(selected);
  targetSlot.candidates = [
    ...occupied,
    ...Array.from(
      {
        length: Math.max(
          0,
          DEFAULT_BACKUP_SLOT_COUNT - occupied.length,
        ),
      },
      createFleetCandidateDraft,
    ),
  ];
  return selected;
}

function appendFormationToBackup(
  draft: FleetDraft,
  source: FleetSlotDraft,
  target: FleetSlotDraft,
): FleetCandidateDraft {
  const selected = appendBackupCandidate(
    target,
    source.primary!,
    cloneFleetRule(source),
  );
  source.primary = null;
  copyFleetRule(source, createFleetRuleDraft());
  if (isFleetSlotEmpty(source)) compactFleetDraftSlots(draft.slots);
  return selected;
}

function moveBackupToFormation(
  draft: FleetDraft,
  sourcePosition: number,
  sourceIndex: number,
  targetPosition: number,
): FleetDraftEditResult {
  const source = draft.slots[sourcePosition];
  const requestedTarget = draft.slots[targetPosition];
  const candidate = source?.candidates[sourceIndex];
  if (!candidate?.ship || !requestedTarget) return unchanged();
  const destinationPosition = isFleetSlotEmpty(requestedTarget)
    ? resolveGalleryFormationDropTarget(draft.slots, targetPosition)
    : targetPosition;
  const target = draft.slots[destinationPosition];
  if (!target) return unchanged();
  if (hasOtherPrimaryShip(
    draft.slots,
    candidate.ship.search_name,
    destinationPosition,
  )) {
    return {
      changed: false,
      error: {
        title: '无法移动',
        message: `主选编队中已存在 ${candidate.ship.name}，不能添加同名舰船`,
      },
    };
  }
  if (target.primary) {
    swapPrimaryAndCandidate(target, source, sourceIndex);
  } else {
    target.primary = candidate.ship;
    copyFleetRule(target, candidate);
    source.candidates.splice(sourceIndex, 1);
    compactCandidates(source.candidates);
    if (isFleetSlotEmpty(source)) compactFleetDraftSlots(draft.slots);
  }
  return changed(formationSelection(
    Math.max(0, draft.slots.indexOf(target)),
  ));
}

function moveFormationToBackup(
  draft: FleetDraft,
  sourcePosition: number,
  targetPosition: number,
  targetIndex: number,
): FleetDraftEditResult {
  const source = draft.slots[sourcePosition];
  const target = draft.slots[targetPosition];
  const candidate = target?.candidates[targetIndex];
  if (!source?.primary || !target || !candidate) return unchanged();
  const selected = candidate.ship
    ? swapPrimaryAndCandidate(source, target, targetIndex)
    : appendFormationToBackup(draft, source, target);
  return changed(backupSelection(
    Math.max(0, draft.slots.indexOf(target)),
    Math.max(0, target.candidates.indexOf(selected)),
  ));
}

function moveBackupCandidate(
  draft: FleetDraft,
  sourcePosition: number,
  sourceIndex: number,
  targetPosition: number,
  targetIndex: number,
): FleetDraftEditResult {
  const source = draft.slots[sourcePosition];
  const target = draft.slots[targetPosition];
  const selected = source?.candidates[sourceIndex];
  const replaced = target?.candidates[targetIndex];
  if (!source || !target || !selected?.ship || !replaced) return unchanged();

  if (source === target) {
    [source.candidates[sourceIndex], source.candidates[targetIndex]] = [
      source.candidates[targetIndex],
      selected,
    ];
    compactCandidates(source.candidates);
  } else if (replaced.ship) {
    [source.candidates[sourceIndex], target.candidates[targetIndex]] = [
      replaced,
      selected,
    ];
    compactCandidates(source.candidates);
    compactCandidates(target.candidates);
  } else {
    target.candidates[targetIndex] = selected;
    source.candidates[sourceIndex] = createFleetCandidateDraft();
    compactCandidates(source.candidates);
    compactCandidates(target.candidates);
    if (isFleetSlotEmpty(source)) compactFleetDraftSlots(draft.slots);
  }
  return changed(backupSelection(
    Math.max(0, draft.slots.indexOf(target)),
    Math.max(0, target.candidates.indexOf(selected)),
  ));
}

function dropOnFormation(
  draft: FleetDraft,
  intent: Extract<FleetDraftEditIntent, { type: 'drop-formation' }>,
): FleetDraftEditResult {
  if (
    intent.targetPosition < 0
    || intent.targetPosition >= FLEET_SLOT_COUNT
  ) return unchanged();

  const { source, selection } = intent;
  if (source.group === 'formation') {
    const focused = draft.slots[selection.position];
    const moved = moveFleetPrimary(
      draft.slots,
      source.position,
      intent.targetPosition,
      intent.backupFollowMode,
    );
    if (!moved || !focused) return unchanged();
    return changed(selectionAt(
      selection,
      resolveFleetSlotPosition(
        draft.slots,
        focused,
        selection.position,
      ),
    ));
  }
  if (source.group === 'backup') {
    return moveBackupToFormation(
      draft,
      source.position,
      source.candidateIndex,
      intent.targetPosition,
    );
  }

  const ship = source.ship;
  const focused = draft.slots[selection.position];
  const existing = draft.slots.findIndex(
    slot => slot.primary?.search_name === ship.search_name,
  );
  if (existing >= 0) {
    assignFormationShip(draft, ship, existing);
    const position = focused
      ? resolveFleetSlotPosition(draft.slots, focused, selection.position)
      : selection.position;
    return changed(formationSelection(position));
  }
  return changed(formationSelection(insertFormationShip(
    draft,
    ship,
    intent.targetPosition,
    intent.backupFollowMode,
  )));
}

function dropGalleryOnBackup(
  draft: FleetDraft,
  ship: ShipLibraryShip,
  targetPosition: number,
  targetIndex: number,
): FleetDraftEditResult {
  const candidates = draft.slots[targetPosition]?.candidates;
  if (!candidates?.[targetIndex]) return unchanged();
  const existing = candidates.findIndex(
    candidate => candidate.ship?.search_name === ship.search_name,
  );
  if (existing >= 0) {
    candidates[existing].ship = ship;
    applyDefaultShipType(candidates[existing], ship);
    return changed(backupSelection(targetPosition, existing));
  }
  const selected = createFleetCandidateDraft(ship);
  applyDefaultShipType(selected, ship);
  const index = insertFleetCandidate(candidates, targetIndex, selected);
  return index < 0
    ? unchanged()
    : changed(backupSelection(targetPosition, index));
}

function dropOnBackup(
  draft: FleetDraft,
  intent: Extract<FleetDraftEditIntent, { type: 'drop-backup' }>,
): FleetDraftEditResult {
  const target = draft.slots[intent.targetPosition]
    ?.candidates[intent.targetCandidateIndex];
  if (!target) return unchanged();
  const { source } = intent;
  if (source.group === 'formation') {
    return moveFormationToBackup(
      draft,
      source.position,
      intent.targetPosition,
      intent.targetCandidateIndex,
    );
  }
  if (source.group === 'backup') {
    return moveBackupCandidate(
      draft,
      source.position,
      source.candidateIndex,
      intent.targetPosition,
      intent.targetCandidateIndex,
    );
  }
  return dropGalleryOnBackup(
    draft,
    source.ship,
    intent.targetPosition,
    intent.targetCandidateIndex,
  );
}

function copyBackups(
  draft: FleetDraft,
  sourcePosition: number,
  targetPosition: number,
): FleetDraftEditResult {
  const source = draft.slots[sourcePosition];
  const target = draft.slots[targetPosition];
  if (!source || !target || source === target) return unchanged();
  const copied = source.candidates
    .filter((candidate): candidate is FleetCandidateDraft & {
      ship: ShipLibraryShip;
    } => candidate.ship !== null)
    .map(candidate => ({
      ship: candidate.ship,
      ...cloneFleetRule(candidate),
    }));
  if (copied.length === 0) return unchanged();
  target.candidates = [
    ...copied,
    ...Array.from(
      {
        length: Math.max(
          0,
          DEFAULT_BACKUP_SLOT_COUNT - copied.length,
        ),
      },
      createFleetCandidateDraft,
    ),
  ];
  return changed();
}

function updateRule(
  draft: FleetDraft,
  position: number,
  candidateIndex: number | undefined,
  update: FleetRuleUpdate,
): FleetDraftEditResult {
  const slot = draft.slots[position];
  const target = candidateIndex === undefined
    ? slot
    : slot?.candidates[candidateIndex];
  const hasShip = candidateIndex === undefined
    ? Boolean(slot?.primary)
    : Boolean((target as FleetCandidateDraft | undefined)?.ship);
  if (!target || !hasShip) return unchanged();
  if (update.levelEnabled !== undefined) {
    target.levelEnabled = update.levelEnabled;
  }
  if (update.minLevel !== undefined) target.minLevel = update.minLevel;
  if (update.maxLevel !== undefined) target.maxLevel = update.maxLevel;
  if (update.relaxed !== undefined) target.relaxed = update.relaxed;
  return changed();
}

/** 在 Controller 持有的唯一草稿上应用一个明确的用户编辑意图。 */
export function applyFleetDraftEdit(
  draft: FleetDraft,
  intent: FleetDraftEditIntent,
): FleetDraftEditResult {
  switch (intent.type) {
    case 'assign-ship':
      return assignShip(draft, intent);
    case 'remove-primary':
      return removePrimary(draft, intent.position, intent.selection);
    case 'remove-candidate':
      return removeCandidate(draft, intent.position, intent.candidateIndex);
    case 'clear':
      draft.slots = Array.from(
        { length: FLEET_SLOT_COUNT },
        createFleetSlotDraft,
      );
      return changed(formationSelection(0));
    case 'ensure-candidate':
      return ensureCandidate(draft, intent.position);
    case 'drop-formation':
      return dropOnFormation(draft, intent);
    case 'drop-backup':
      return dropOnBackup(draft, intent);
    case 'copy-backups':
      return copyBackups(
        draft,
        intent.sourcePosition,
        intent.targetPosition,
      );
    case 'update-rule':
      return updateRule(
        draft,
        intent.position,
        intent.candidateIndex,
        intent.update,
      );
  }
}
