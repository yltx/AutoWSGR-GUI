/** 从后端成功日志维护可持久化的“今日出征统计”。 */
import {
  BATTLE_GRADES,
  type BattleGrade,
  type BattleGradeCounts,
  type DailySortieStatsSnapshot,
  type ShipDropNotice,
} from '../../types/statistics.js';
import {
  browserStorageStore,
  type StorageStore,
} from '../../adapter/StorageAdapter.js';

const STORAGE_KEY = 'daily_sortie_stats_v1';
const STORAGE_VERSION = 1;
const LOG_DEDUP_WINDOW_MS = 1_200;
const DROP_NOTICE_DURATION_MS = 60_000;
const QUINCY_SHIP_NAME = '昆西';
const DEFAULT_LOOT_LIMIT = 50;
const DEFAULT_SHIP_LIMIT = 500;

interface PersistedDailySortieStats {
  version: number;
  dateKey: string;
  battleCount: number;
  grades: BattleGradeCounts;
  quickRepairCount: number;
  bathRepairCount: number;
  lootCount: number;
  lootLimit: number;
  shipCount: number;
  shipLimit: number;
  expeditionCount: number;
  shipDrops: Record<string, number>;
}

type ParsedStatsEvent =
  | { type: 'battle'; grade: BattleGrade }
  | { type: 'quick-repair'; count: number }
  | { type: 'bath-repair' }
  | { type: 'loot-count'; count: number; limit: number }
  | { type: 'ship-count'; count: number; limit: number }
  | { type: 'ship-drop'; shipName: string }
  | { type: 'expedition'; count: number };

function emptyGrades(): BattleGradeCounts {
  return { SS: 0, S: 0, A: 0, B: 0, C: 0, D: 0 };
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function createEmptyState(timestamp: number): PersistedDailySortieStats {
  return {
    version: STORAGE_VERSION,
    dateKey: localDateKey(timestamp),
    battleCount: 0,
    grades: emptyGrades(),
    quickRepairCount: 0,
    bathRepairCount: 0,
    lootCount: 0,
    lootLimit: DEFAULT_LOOT_LIMIT,
    shipCount: 0,
    shipLimit: DEFAULT_SHIP_LIMIT,
    expeditionCount: 0,
    shipDrops: {},
  };
}

function sanitizeState(
  value: unknown,
  timestamp: number,
): PersistedDailySortieStats {
  if (!value || typeof value !== 'object') return createEmptyState(timestamp);
  const source = value as Partial<PersistedDailySortieStats>;
  if (
    source.version !== STORAGE_VERSION
    || source.dateKey !== localDateKey(timestamp)
  ) {
    return createEmptyState(timestamp);
  }

  const grades = emptyGrades();
  for (const grade of BATTLE_GRADES) {
    grades[grade] = safeCount(source.grades?.[grade]);
  }

  const shipDrops: Record<string, number> = {};
  if (source.shipDrops && typeof source.shipDrops === 'object') {
    for (const [rawName, rawCount] of Object.entries(source.shipDrops)) {
      const name = rawName.trim();
      const count = safeCount(rawCount);
      if (name && count > 0) shipDrops[name] = count;
    }
  }

  return {
    version: STORAGE_VERSION,
    dateKey: source.dateKey,
    battleCount: safeCount(source.battleCount),
    grades,
    quickRepairCount: safeCount(source.quickRepairCount),
    bathRepairCount: safeCount(source.bathRepairCount),
    lootCount: safeCount(source.lootCount),
    lootLimit: safeCount(source.lootLimit, DEFAULT_LOOT_LIMIT)
      || DEFAULT_LOOT_LIMIT,
    shipCount: safeCount(source.shipCount),
    shipLimit: safeCount(source.shipLimit, DEFAULT_SHIP_LIMIT)
      || DEFAULT_SHIP_LIMIT,
    expeditionCount: safeCount(source.expeditionCount),
    shipDrops,
  };
}

function parseStatsEvent(message: string): ParsedStatsEvent | null {
  const battleMatch = message.match(
    /\[Combat\]\s*战果:\s*.*?评价\s*[=：:]\s*(SS|S|A|B|C|D)\b/i,
  );
  if (battleMatch) {
    return {
      type: 'battle',
      grade: battleMatch[1].toUpperCase() as BattleGrade,
    };
  }

  const quickRepairMatch = message.match(
    /\[UI\]\s*修理位置:\s*\[([0-9,\s]*)\]/,
  );
  if (quickRepairMatch) {
    const count = quickRepairMatch[1]
      .split(',')
      .map(value => value.trim())
      .filter(value => /^\d+$/.test(value))
      .length;
    return { type: 'quick-repair', count };
  }

  if (
    /\[OPS\]\s*浴室修理(?:派单成功|操作完成(?:\s*:.*)?)(?:\s|$)/.test(
      message,
    )
  ) {
    return { type: 'bath-repair' };
  }

  const lootMatch = message.match(
    /\[UI\]\s*战利品数量:\s*(\d+)\s*\/\s*(\d+)/,
  );
  if (lootMatch) {
    return {
      type: 'loot-count',
      count: Number(lootMatch[1]),
      limit: Number(lootMatch[2]),
    };
  }

  const shipCountMatch = message.match(
    /\[UI\]\s*舰船数量:\s*(\d+)\s*\/\s*(\d+)/,
  );
  if (shipCountMatch) {
    return {
      type: 'ship-count',
      count: Number(shipCountMatch[1]),
      limit: Number(shipCountMatch[2]),
    };
  }

  const shipDropMatch = message.match(
    /\[Combat\]\s*获得舰船:\s*(.+?)\s*$/,
  );
  if (shipDropMatch?.[1].trim()) {
    return { type: 'ship-drop', shipName: shipDropMatch[1].trim() };
  }

  const expeditionMatch = message.match(
    /\[UI\]\s*远征收取:\s*(\d+)\s*支/,
  );
  if (expeditionMatch) {
    return { type: 'expedition', count: Number(expeditionMatch[1]) };
  }

  return null;
}

export class DailySortieStats {
  private state: PersistedDailySortieStats;
  private dropNotice: ShipDropNotice | null = null;
  private readonly recentLogs = new Map<string, number>();

  constructor(
    private readonly storage: StorageStore = browserStorageStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = this.load(this.now());
  }

  /** 解析一条运行日志。返回 true 表示统计显示内容发生变化。 */
  consume(message: string, timestamp = this.now()): boolean {
    const dayChanged = this.ensureCurrentDay(timestamp);
    const normalized = message.trim();
    const event = parseStatsEvent(normalized);
    if (!event) return dayChanged;

    if (this.isDuplicate(normalized, timestamp)) return dayChanged;

    switch (event.type) {
      case 'battle':
        this.state.battleCount += 1;
        this.state.grades[event.grade] += 1;
        break;
      case 'quick-repair':
        if (event.count === 0) return dayChanged;
        this.state.quickRepairCount += event.count;
        break;
      case 'bath-repair':
        this.state.bathRepairCount += 1;
        break;
      case 'loot-count':
        this.state.lootCount = safeCount(event.count);
        this.state.lootLimit = safeCount(event.limit, DEFAULT_LOOT_LIMIT)
          || DEFAULT_LOOT_LIMIT;
        break;
      case 'ship-count':
        this.state.shipCount = safeCount(event.count);
        this.state.shipLimit = safeCount(event.limit, DEFAULT_SHIP_LIMIT)
          || DEFAULT_SHIP_LIMIT;
        break;
      case 'ship-drop':
        this.state.shipCount += 1;
        this.state.shipDrops[event.shipName] =
          (this.state.shipDrops[event.shipName] ?? 0) + 1;
        if (event.shipName === QUINCY_SHIP_NAME) {
          this.dropNotice = {
            shipName: event.shipName,
            dailyIndex: this.state.shipCount,
            visibleUntil: timestamp + DROP_NOTICE_DURATION_MS,
          };
        }
        break;
      case 'expedition':
        this.state.expeditionCount += safeCount(event.count);
        break;
    }

    this.save();
    return true;
  }

  getSnapshot(timestamp = this.now()): DailySortieStatsSnapshot {
    this.ensureCurrentDay(timestamp);
    if (this.dropNotice && this.dropNotice.visibleUntil <= timestamp) {
      this.dropNotice = null;
    }

    return {
      battleCount: this.state.battleCount,
      grades: { ...this.state.grades },
      quickRepairCount: this.state.quickRepairCount,
      bathRepairCount: this.state.bathRepairCount,
      lootCount: this.state.lootCount,
      lootLimit: this.state.lootLimit,
      shipCount: this.state.shipCount,
      shipLimit: this.state.shipLimit,
      expeditionCount: this.state.expeditionCount,
      shipDrops: Object.entries(this.state.shipDrops)
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => (
          right.count - left.count
          || left.name.localeCompare(right.name, 'zh-CN')
        )),
      dropNotice: this.dropNotice ? { ...this.dropNotice } : null,
    };
  }

  reset(timestamp = this.now()): void {
    this.state = createEmptyState(timestamp);
    this.dropNotice = null;
    this.recentLogs.clear();
    this.save();
  }

  private ensureCurrentDay(timestamp: number): boolean {
    if (this.state.dateKey === localDateKey(timestamp)) return false;
    this.reset(timestamp);
    return true;
  }

  private isDuplicate(message: string, timestamp: number): boolean {
    const previous = this.recentLogs.get(message);
    this.recentLogs.set(message, timestamp);

    for (const [loggedMessage, loggedAt] of this.recentLogs) {
      if (
        timestamp < loggedAt
        || timestamp - loggedAt >= LOG_DEDUP_WINDOW_MS
      ) {
        this.recentLogs.delete(loggedMessage);
      }
    }

    return previous !== undefined
      && timestamp >= previous
      && timestamp - previous < LOG_DEDUP_WINDOW_MS;
  }

  private load(timestamp: number): PersistedDailySortieStats {
    try {
      const raw = this.storage.get(STORAGE_KEY);
      if (!raw) return createEmptyState(timestamp);
      return sanitizeState(JSON.parse(raw), timestamp);
    } catch {
      return createEmptyState(timestamp);
    }
  }

  private save(): void {
    try {
      this.storage.set(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // localStorage 不可用时只保留本次运行内的统计。
    }
  }
}
