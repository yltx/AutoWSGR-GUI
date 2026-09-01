/** 维护自动战役每日正常结算次数，并在本地日期变化时重置。 */
import {
  browserStorageStore,
  type StorageStore,
} from '../../adapter/StorageAdapter.js';

const STORAGE_KEY = 'campaign_daily_quota_v1';
const STORAGE_VERSION = 1;

interface PersistedCampaignQuota {
  version: number;
  dateKey: string;
  completed: Record<string, number>;
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function campaignKey(campaignName: string): string {
  return campaignName.trim().toLocaleLowerCase() || '__default__';
}

function targetCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.trunc(parsed));
}

function emptyState(timestamp: number): PersistedCampaignQuota {
  return {
    version: STORAGE_VERSION,
    dateKey: localDateKey(timestamp),
    completed: {},
  };
}

function sanitizeState(
  value: unknown,
  timestamp: number,
): PersistedCampaignQuota {
  if (!value || typeof value !== 'object') return emptyState(timestamp);
  const source = value as Partial<PersistedCampaignQuota>;
  if (
    source.version !== STORAGE_VERSION
    || source.dateKey !== localDateKey(timestamp)
    || !source.completed
    || typeof source.completed !== 'object'
  ) {
    return emptyState(timestamp);
  }

  const completed: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(source.completed)) {
    const count = Number(rawCount);
    if (key && Number.isFinite(count) && count > 0) {
      completed[key] = Math.trunc(count);
    }
  }
  return {
    version: STORAGE_VERSION,
    dateKey: source.dateKey,
    completed,
  };
}

export class CampaignDailyQuota {
  private state: PersistedCampaignQuota;

  constructor(
    private readonly storage: StorageStore = browserStorageStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = this.load(this.now());
  }

  remaining(
    campaignName: string,
    target: number,
    timestamp = this.now(),
  ): number {
    this.ensureCurrentDay(timestamp);
    const completed = this.state.completed[campaignKey(campaignName)] ?? 0;
    return Math.max(0, targetCount(target) - completed);
  }

  markCompleted(
    campaignName: string,
    target: number,
    timestamp = this.now(),
  ): number {
    this.ensureCurrentDay(timestamp);
    const key = campaignKey(campaignName);
    this.state.completed[key] = Math.min(
      targetCount(target),
      (this.state.completed[key] ?? 0) + 1,
    );
    this.save();
    return this.remaining(campaignName, target, timestamp);
  }

  private ensureCurrentDay(timestamp: number): void {
    if (this.state.dateKey === localDateKey(timestamp)) return;
    this.state = emptyState(timestamp);
    this.save();
  }

  private load(timestamp: number): PersistedCampaignQuota {
    try {
      const raw = this.storage.get(STORAGE_KEY);
      return raw
        ? sanitizeState(JSON.parse(raw), timestamp)
        : emptyState(timestamp);
    } catch {
      return emptyState(timestamp);
    }
  }

  private save(): void {
    try {
      this.storage.set(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // 存储不可用时仅影响跨重启恢复，不阻断调度。
    }
  }
}
