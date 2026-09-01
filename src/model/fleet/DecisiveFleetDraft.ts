/** 维护决战舰队独立草稿及决战配置转换规则。 */
import {
  DEFAULT_DECISIVE_PLAN_SETTINGS,
  type DecisivePlanSettings,
} from '../../shared/decisivePlan.js';

export {
  DEFAULT_DECISIVE_PLAN_SETTINGS,
} from '../../shared/decisivePlan.js';

export type DecisiveFleetLevel = 'level1' | 'level2';

export interface DecisiveFleetPosition {
  level: DecisiveFleetLevel;
  index: number;
}

export function cloneDecisiveFleetDraft(
  settings: DecisivePlanSettings,
): DecisivePlanSettings {
  return {
    chapter: settings.chapter,
    useQuickRepair: settings.useQuickRepair,
    level1: [...settings.level1],
    level2: [...settings.level2],
  };
}

export function decisiveFleetDraftSnapshot(
  settings: DecisivePlanSettings,
): string {
  return JSON.stringify({
    chapter: settings.chapter,
    useQuickRepair: settings.useQuickRepair,
    level1: [...settings.level1],
    level2: [...settings.level2],
  });
}

export function hasDecisiveFleetDraftChanges(
  settings: DecisivePlanSettings,
  savedSnapshot: string,
): boolean {
  return decisiveFleetDraftSnapshot(settings) !== savedSnapshot;
}

export class DecisiveFleetDraft {
  private settings: DecisivePlanSettings;
  private savedSnapshot: string;

  constructor(
    settings: DecisivePlanSettings = DEFAULT_DECISIVE_PLAN_SETTINGS,
  ) {
    this.settings = cloneDecisiveFleetDraft(settings);
    this.savedSnapshot = decisiveFleetDraftSnapshot(this.settings);
  }

  get chapter(): number {
    return this.settings.chapter;
  }

  get useQuickRepair(): boolean {
    return this.settings.useQuickRepair;
  }

  get dirty(): boolean {
    return hasDecisiveFleetDraftChanges(
      this.settings,
      this.savedSnapshot,
    );
  }

  setChapter(chapter: number): void {
    this.settings.chapter = chapter;
  }

  setUseQuickRepair(useQuickRepair: boolean): void {
    this.settings.useQuickRepair = useQuickRepair;
  }

  queue(level: DecisiveFleetLevel): readonly string[] {
    return this.settings[level];
  }

  find(name: string): DecisiveFleetPosition | null {
    for (const level of ['level1', 'level2'] as const) {
      const index = this.settings[level].indexOf(name);
      if (index >= 0) return { level, index };
    }
    return null;
  }

  place(
    name: string,
    level: DecisiveFleetLevel,
    requestedIndex: number,
    maxIndex: number,
  ): number {
    const queue = this.settings[level];
    let target = Math.min(Math.max(0, requestedIndex), maxIndex);
    if (target < queue.length) {
      queue[target] = name;
    } else {
      target = Math.min(target, queue.length);
      queue.splice(target, 0, name);
    }
    return target;
  }

  remove(level: DecisiveFleetLevel, index: number): boolean {
    const queue = this.settings[level];
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      return false;
    }
    queue.splice(index, 1);
    return true;
  }

  move(
    sourceLevel: DecisiveFleetLevel,
    sourceIndex: number,
    targetLevel: DecisiveFleetLevel,
    targetIndex: number,
  ): number | null {
    const sourceQueue = this.settings[sourceLevel];
    const targetQueue = this.settings[targetLevel];
    const sourceName = sourceQueue[sourceIndex];
    if (!sourceName) return null;

    if (sourceLevel === targetLevel) {
      if (sourceIndex === targetIndex) return null;
      if (targetIndex < targetQueue.length) {
        [targetQueue[sourceIndex], targetQueue[targetIndex]] = [
          targetQueue[targetIndex],
          sourceName,
        ];
      } else {
        sourceQueue.splice(sourceIndex, 1);
        targetQueue.push(sourceName);
        targetIndex = targetQueue.length - 1;
      }
    } else {
      const targetName = targetQueue[targetIndex];
      if (targetName) {
        sourceQueue[sourceIndex] = targetName;
        targetQueue[targetIndex] = sourceName;
      } else {
        sourceQueue.splice(sourceIndex, 1);
        targetQueue.splice(
          Math.min(targetIndex, targetQueue.length),
          0,
          sourceName,
        );
        targetIndex = Math.min(targetIndex, targetQueue.length - 1);
      }
    }

    return targetIndex;
  }

  resetTeams(
    defaults: Pick<DecisivePlanSettings, 'level1' | 'level2'> =
      DEFAULT_DECISIVE_PLAN_SETTINGS,
  ): void {
    this.settings.level1 = [
      ...defaults.level1,
    ];
    this.settings.level2 = [
      ...defaults.level2,
    ];
  }

  load(settings: DecisivePlanSettings): void {
    this.settings = cloneDecisiveFleetDraft(settings);
    this.savedSnapshot = decisiveFleetDraftSnapshot(this.settings);
  }

  toSettings(): DecisivePlanSettings {
    return cloneDecisiveFleetDraft(this.settings);
  }
}
