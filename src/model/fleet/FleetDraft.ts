/** 维护普通舰队槽位、候选舰和拖拽编辑的唯一草稿。 */
import type {
  PlanPresetSource,
  ShipLibraryShip,
  UserTeamPlan,
  UserTeamPlanSlot,
  UserTeamShipRule,
} from '../../types/ipc.js';
import type {
  BackupFollowMode,
} from '../../types/fleetEditor.js';
import {
  FLEET_SHIP_TYPE_CODES,
} from '../../shared/fleetShipTypes.js';

const DEFAULT_BACKUP_SLOT_COUNT = 6;
const FLEET_SLOT_COUNT = 6;
const ALLOWED_FLEET_SHIP_TYPES = new Set(FLEET_SHIP_TYPE_CODES);

export interface FleetRuleDraft {
  shipTypes: string[];
  levelEnabled: boolean;
  minLevel: number | null;
  maxLevel: number | null;
  relaxed: boolean;
}

export interface FleetCandidateDraft extends FleetRuleDraft {
  ship: ShipLibraryShip | null;
}

export interface FleetSlotDraft extends FleetRuleDraft {
  primary: ShipLibraryShip | null;
  candidates: FleetCandidateDraft[];
}

export interface FleetDraft {
  name: string;
  file: string | null;
  source: PlanPresetSource;
  slots: FleetSlotDraft[];
}

/**
 * 执行槽位重排。位置跟随模式只移动主选及其规则，备选队列保留在原位置。
 */
export function reorderFleetSlots<T>(
  slots: FleetSlotDraft[],
  mode: BackupFollowMode,
  reorder: () => T,
): T {
  if (mode === 'ship') return reorder();

  const candidatesByPosition = slots.map(slot => slot.candidates);
  try {
    return reorder();
  } finally {
    slots.forEach((slot, index) => {
      slot.candidates = candidatesByPosition[index];
    });
  }
}

export function isFleetSlotEmpty(slot: FleetSlotDraft): boolean {
  return slot.primary === null
    && slot.candidates.every(candidate => candidate.ship === null);
}

export function hasOtherPrimaryShip(
  slots: FleetSlotDraft[],
  searchName: string,
  targetPosition: number,
): boolean {
  return slots.some((slot, position) => (
    position !== targetPosition
    && slot.primary?.search_name === searchName
  ));
}

/**
 * 槽位真正为空时整体左移。纯备选槽位也属于已占用槽位。
 */
export function compactFleetDraftSlots(slots: FleetSlotDraft[]): void {
  const occupied = slots.filter(slot => !isFleetSlotEmpty(slot));
  slots.splice(
    0,
    slots.length,
    ...occupied,
    ...Array.from(
      { length: Math.max(0, FLEET_SLOT_COUNT - occupied.length) },
      createFleetSlotDraft,
    ),
  );
}

export function resolveFleetSlotPosition(
  slots: FleetSlotDraft[],
  focusedSlot: FleetSlotDraft,
  fallbackPosition: number,
): number {
  const position = slots.indexOf(focusedSlot);
  return position >= 0 ? position : fallbackPosition;
}

/**
 * 删除主选并压缩空槽。删除其他位置时，焦点继续跟随原来选中的槽位。
 */
export function removeFleetPrimary(
  slots: FleetSlotDraft[],
  removedPosition: number,
  activePosition: number,
): number {
  const removed = slots[removedPosition];
  if (!removed?.primary) return activePosition;

  const focused = slots[activePosition];
  const deletingFocused = removedPosition === activePosition;
  removed.primary = null;
  copyFleetRule(removed, createFleetRuleDraft());
  compactFleetDraftSlots(slots);

  const preferred = deletingFocused ? removed : focused;
  return resolveFleetSlotPosition(
    slots,
    preferred,
    Math.min(Math.max(0, removedPosition), FLEET_SLOT_COUNT - 1),
  );
}

export interface GalleryFormationAssignment {
  targetPosition: number;
  activePosition: number;
}

/**
 * 图鉴点击只在最右侧连续新增时右移焦点，替换已有舰船时保留焦点。
 */
export function resolveGalleryFormationAssignment(
  slots: FleetSlotDraft[],
  activePosition: number,
  searchName: string,
): GalleryFormationAssignment {
  const currentPosition = Math.min(
    Math.max(0, activePosition),
    FLEET_SLOT_COUNT - 1,
  );
  const existingPosition = slots.findIndex(
    slot => slot.primary?.search_name === searchName,
  );
  if (existingPosition >= 0) {
    return {
      targetPosition: existingPosition,
      activePosition: currentPosition,
    };
  }

  const current = slots[currentPosition];
  if (current && isFleetSlotEmpty(current)) {
    const firstEmpty = slots.findIndex(isFleetSlotEmpty);
    const targetPosition = firstEmpty >= 0
      ? firstEmpty
      : currentPosition;
    const nextPosition = targetPosition + 1;
    const canAdvance = nextPosition < FLEET_SLOT_COUNT
      && slots.slice(nextPosition).every(isFleetSlotEmpty);
    return {
      targetPosition,
      activePosition: canAdvance ? nextPosition : targetPosition,
    };
  }
  const nextPosition = currentPosition + 1;
  const canAdvance = nextPosition < FLEET_SLOT_COUNT
    && slots.slice(nextPosition).every(isFleetSlotEmpty);
  if (canAdvance) {
    return {
      targetPosition: nextPosition,
      activePosition: nextPosition,
    };
  }
  return {
    targetPosition: currentPosition,
    activePosition: currentPosition,
  };
}

/** 图鉴拖入时优先填补目标左侧的第一个空位。 */
export function resolveGalleryFormationDropTarget(
  slots: FleetSlotDraft[],
  targetPosition: number,
): number {
  const boundedTarget = Math.min(
    Math.max(0, targetPosition),
    FLEET_SLOT_COUNT - 1,
  );
  const firstEmpty = slots.findIndex(isFleetSlotEmpty);
  return firstEmpty >= 0 && firstEmpty < boundedTarget
    ? firstEmpty
    : boundedTarget;
}

/**
 * 将图鉴舰船插入编队目标位，目标位及右侧整体后移。
 * 编队没有可用空位时不覆盖已有内容。
 */
export function insertFleetPrimary(
  slots: FleetSlotDraft[],
  targetPosition: number,
  inserted: FleetSlotDraft,
  mode: BackupFollowMode,
): FleetSlotDraft | null {
  if (
    targetPosition < 0
    || targetPosition >= slots.length
    || isFleetSlotEmpty(inserted)
  ) {
    return null;
  }
  const emptyPosition = slots.findIndex((
    slot,
    position,
  ) => position >= targetPosition && isFleetSlotEmpty(slot));
  if (emptyPosition < 0) return null;

  return reorderFleetSlots(slots, mode, () => {
    slots.splice(emptyPosition, 1);
    slots.splice(targetPosition, 0, inserted);
    return inserted;
  });
}

/**
 * 将图鉴舰船插入备选目标位，保留左侧顺序并压缩空槽。
 */
export function insertFleetCandidate(
  candidates: FleetCandidateDraft[],
  targetIndex: number,
  inserted: FleetCandidateDraft,
): number {
  if (
    targetIndex < 0
    || targetIndex >= candidates.length
    || !inserted.ship
  ) {
    return -1;
  }
  const emptyPosition = candidates.findIndex((
    candidate,
    index,
  ) => index >= targetIndex && candidate.ship === null);
  if (emptyPosition >= 0) candidates.splice(emptyPosition, 1);
  candidates.splice(targetIndex, 0, inserted);

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
  return candidates.indexOf(inserted);
}

/**
 * 移动顶层集合卡片。
 * 单主选可以接管备选合集，其余已占用集合按跟随模式交换。
 */
export function moveFleetPrimary(
  slots: FleetSlotDraft[],
  sourcePosition: number,
  targetPosition: number,
  mode: BackupFollowMode,
): FleetSlotDraft | null {
  const source = slots[sourcePosition];
  const target = slots[targetPosition];
  if (!source || !target || isFleetSlotEmpty(source)) return null;
  if (sourcePosition === targetPosition) return source;

  const targetIsCandidateCollection = (
    !target.primary
    && !isFleetSlotEmpty(target)
  );
  const sourceHasCandidates = source.candidates.some(candidate => (
    candidate.ship !== null
  ));
  if (
    source.primary
    && !sourceHasCandidates
    && targetIsCandidateCollection
  ) {
    target.primary = source.primary;
    copyFleetRule(target, source);
    source.primary = null;
    copyFleetRule(source, createFleetRuleDraft());
    if (isFleetSlotEmpty(source)) compactFleetDraftSlots(slots);
    return target;
  }

  if (
    source.primary
    && mode === 'position'
    && isFleetSlotEmpty(target)
  ) {
    const destinationPosition = resolveGalleryFormationDropTarget(
      slots,
      targetPosition,
    );
    const destination = slots[destinationPosition];
    if (!destination || !isFleetSlotEmpty(destination)) return null;
    destination.primary = source.primary;
    copyFleetRule(destination, source);
    source.primary = null;
    copyFleetRule(source, createFleetRuleDraft());
    if (isFleetSlotEmpty(source)) compactFleetDraftSlots(slots);
    return destination;
  }

  return reorderFleetSlots(slots, mode, () => {
    if (!isFleetSlotEmpty(target)) {
      [slots[sourcePosition], slots[targetPosition]] = [
        target,
        source,
      ];
      return source;
    }

    slots.splice(sourcePosition, 1);
    const firstEmpty = slots.findIndex(isFleetSlotEmpty);
    slots.splice(firstEmpty < 0 ? slots.length : firstEmpty, 0, source);
    return source;
  });
}

export function createFleetRuleDraft(): FleetRuleDraft {
  return {
    shipTypes: [],
    levelEnabled: false,
    minLevel: null,
    maxLevel: null,
    relaxed: false,
  };
}

export function createFleetCandidateDraft(
  ship: ShipLibraryShip | null = null,
): FleetCandidateDraft {
  return {
    ship,
    ...createFleetRuleDraft(),
  };
}

export function createFleetSlotDraft(): FleetSlotDraft {
  return {
    primary: null,
    candidates: Array.from(
      { length: DEFAULT_BACKUP_SLOT_COUNT },
      () => createFleetCandidateDraft(),
    ),
    ...createFleetRuleDraft(),
  };
}

export function createFleetDraft(): FleetDraft {
  return {
    name: '',
    file: null,
    source: 'user',
    slots: Array.from(
      { length: FLEET_SLOT_COUNT },
      createFleetSlotDraft,
    ),
  };
}

export function cloneFleetRule(source: FleetRuleDraft): FleetRuleDraft {
  return {
    shipTypes: [...source.shipTypes],
    levelEnabled: source.levelEnabled,
    minLevel: source.minLevel,
    maxLevel: source.maxLevel,
    relaxed: source.relaxed,
  };
}

export function copyFleetRule(
  target: FleetRuleDraft,
  source: FleetRuleDraft,
): void {
  target.shipTypes = [...source.shipTypes];
  target.levelEnabled = source.levelEnabled;
  target.minLevel = source.minLevel;
  target.maxLevel = source.maxLevel;
  target.relaxed = source.relaxed;
}

export function fleetDraftSnapshot(draft: FleetDraft): string {
  const ruleSnapshot = (rule: FleetRuleDraft) => ({
    shipTypes: [...rule.shipTypes],
    levelEnabled: rule.levelEnabled,
    minLevel: rule.minLevel,
    maxLevel: rule.maxLevel,
    relaxed: rule.relaxed,
  });
  return JSON.stringify({
    name: draft.name,
    slots: draft.slots.map(slot => ({
      primary: slot.primary?.id ?? null,
      rule: ruleSnapshot(slot),
      candidates: slot.candidates.map(candidate => ({
        ship: candidate.ship?.id ?? null,
        rule: ruleSnapshot(candidate),
      })),
    })),
  });
}

export function hasFleetDraftChanges(
  draft: FleetDraft,
  savedSnapshot: string,
): boolean {
  return fleetDraftSnapshot(draft) !== savedSnapshot;
}

function teamRuleConstraintsFromDraft(
  rule: FleetRuleDraft,
  field: string,
): Omit<UserTeamShipRule, 'name' | 'search_name'> {
  const invalidShipType = rule.shipTypes.find(
    shipType => !ALLOWED_FLEET_SHIP_TYPES.has(shipType),
  );
  if (invalidShipType) {
    throw new Error(`${field} 的舰种不符合后端接口：${invalidShipType}`);
  }
  if (rule.levelEnabled) {
    if (
      rule.minLevel !== null
      && (!Number.isInteger(rule.minLevel) || rule.minLevel < 1)
    ) {
      throw new Error(`${field} 的最小等级不合法`);
    }
    if (
      rule.maxLevel !== null
      && (!Number.isInteger(rule.maxLevel) || rule.maxLevel < 1)
    ) {
      throw new Error(`${field} 的最大等级不合法`);
    }
    if (
      rule.minLevel !== null
      && rule.maxLevel !== null
      && rule.maxLevel < rule.minLevel
    ) {
      throw new Error(`${field} 的最大等级不能小于最小等级`);
    }
  }

  const result: Omit<UserTeamShipRule, 'name' | 'search_name'> = {};
  if (rule.shipTypes.length > 0) {
    result.ship_type = [...rule.shipTypes];
  }
  if (rule.levelEnabled && rule.minLevel !== null) {
    result.min_level = rule.minLevel;
  }
  if (rule.levelEnabled && rule.maxLevel !== null) {
    result.max_level = rule.maxLevel;
  }
  if (rule.relaxed) result.relaxed = true;
  return result;
}

function teamShipRuleFromDraft(
  ship: ShipLibraryShip,
  rule: FleetRuleDraft,
  field: string,
): UserTeamShipRule {
  const result: UserTeamShipRule = {
    name: ship.name,
    ...teamRuleConstraintsFromDraft(rule, field),
  };
  if (ship.search_name && ship.search_name !== ship.name) {
    result.search_name = ship.search_name;
  }
  return result;
}

function teamPlanSlotFromDraft(
  slot: FleetSlotDraft,
  index: number,
): UserTeamPlanSlot {
  const backups = slot.candidates.filter(
    (candidate): candidate is FleetCandidateDraft & {
      ship: ShipLibraryShip;
    } => candidate.ship !== null,
  );
  const result: UserTeamPlanSlot = slot.primary
    ? teamShipRuleFromDraft(
        slot.primary,
        slot,
        `位置 ${index + 1} 主选`,
      )
    : teamRuleConstraintsFromDraft(slot, `位置 ${index + 1}`);
  if (backups.length > 0) {
    result.candidates = backups.map((candidate, candidateIndex) => (
      teamShipRuleFromDraft(
        candidate.ship,
        candidate,
        `位置 ${index + 1} 备选 ${candidateIndex + 1}`,
      )
    ));
  }
  return result;
}

/** 将编辑草稿转换为持久化计划，并在模型边界校验后端规则。 */
export function fleetDraftToTeamPlan(
  draft: FleetDraft,
  rawName: string,
): UserTeamPlan {
  const name = rawName.trim();
  if (!name) throw new Error('请输入舰队预设名称');

  const occupiedSlots = draft.slots.filter(
    slot => !isFleetSlotEmpty(slot),
  );
  if (occupiedSlots.length === 0) {
    throw new Error('当前编队至少需要一艘主选或备选舰船');
  }
  return {
    name,
    ships: occupiedSlots.map(teamPlanSlotFromDraft),
  };
}

function findTeamPlanShip(
  rule: UserTeamShipRule,
  ships: readonly ShipLibraryShip[],
): ShipLibraryShip {
  const ship = ships.find(item => item.name === rule.name)
    ?? ships.find(item => item.search_name === rule.search_name);
  if (!ship) throw new Error(`舰船不存在: ${rule.name}`);
  return ship;
}

function fleetCandidateFromTeamRule(
  rule: UserTeamShipRule,
  ships: readonly ShipLibraryShip[],
): FleetCandidateDraft {
  return {
    ship: findTeamPlanShip(rule, ships),
    shipTypes: [...(rule.ship_type ?? [])],
    levelEnabled: (
      rule.min_level !== undefined || rule.max_level !== undefined
    ),
    minLevel: rule.min_level ?? null,
    maxLevel: rule.max_level ?? null,
    relaxed: rule.relaxed === true,
  };
}

function fleetSlotFromTeamPlan(
  slot: UserTeamPlanSlot,
  ships: readonly ShipLibraryShip[],
): FleetSlotDraft {
  const primary = slot.name
    ? findTeamPlanShip({
        name: slot.name,
        search_name: slot.search_name,
        ship_type: slot.ship_type,
        min_level: slot.min_level,
        max_level: slot.max_level,
      }, ships)
    : null;
  const backups = (slot.candidates ?? []).map(candidate => (
    fleetCandidateFromTeamRule(candidate, ships)
  ));
  return {
    primary,
    candidates: [
      ...backups,
      ...Array.from(
        { length: Math.max(0, DEFAULT_BACKUP_SLOT_COUNT - backups.length) },
        () => createFleetCandidateDraft(),
      ),
    ],
    shipTypes: [...(slot.ship_type ?? [])],
    levelEnabled: (
      slot.min_level !== undefined || slot.max_level !== undefined
    ),
    minLevel: slot.min_level ?? null,
    maxLevel: slot.max_level ?? null,
    relaxed: slot.relaxed === true,
  };
}

/** 将持久化计划恢复为编辑草稿，文件身份仅保留在模型中。 */
export function fleetDraftFromTeamPlan(
  plan: UserTeamPlan,
  ships: readonly ShipLibraryShip[],
): FleetDraft {
  const slots = plan.ships.map(slot => fleetSlotFromTeamPlan(slot, ships));
  while (slots.length < FLEET_SLOT_COUNT) {
    slots.push(createFleetSlotDraft());
  }
  return {
    name: plan.name,
    file: plan.file ?? null,
    source: plan.source ?? 'user',
    slots: slots.slice(0, FLEET_SLOT_COUNT),
  };
}
