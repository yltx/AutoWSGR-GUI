/** 渲染主选、候选、舰种和等级规则编辑区。 */
import type {
  FleetCandidateDraftViewObject,
  FleetRuleDraftViewObject,
  FleetSlotDraftViewObject,
} from '../../types/view.js';
import type {
  FleetRuleUpdate,
} from '../../types/fleetEditor.js';

export interface FleetRuleViewHost {
  primaryRule(): FleetSlotDraftViewObject;
  backupRule(): FleetCandidateDraftViewObject;
  updatePrimaryRule(update: FleetRuleUpdate): void;
  updateBackupRule(update: FleetRuleUpdate): void;
}

export class FleetRuleView {
  private readonly levelEnabled = document.getElementById(
    'fleet-level-enabled',
  ) as HTMLInputElement;
  private readonly levelFields = document.getElementById(
    'fleet-level-fields',
  )!;
  private readonly minLevel = document.getElementById(
    'fleet-min-level',
  ) as HTMLInputElement;
  private readonly maxLevel = document.getElementById(
    'fleet-max-level',
  ) as HTMLInputElement;
  private readonly backupLevelEnabled = document.getElementById(
    'fleet-backup-level-enabled',
  ) as HTMLInputElement;
  private readonly backupLevelFields = document.getElementById(
    'fleet-backup-level-fields',
  )!;
  private readonly backupMinLevel = document.getElementById(
    'fleet-backup-min-level',
  ) as HTMLInputElement;
  private readonly backupMaxLevel = document.getElementById(
    'fleet-backup-max-level',
  ) as HTMLInputElement;

  constructor(private readonly host: FleetRuleViewHost) {
    this.bindActions();
  }

  render(): void {
    const primary = this.host.primaryRule();
    const hasPrimary = primary.primary !== null;
    this.levelEnabled.checked = primary.levelEnabled;
    this.levelEnabled.disabled = !hasPrimary;
    this.levelFields.hidden = !hasPrimary || !primary.levelEnabled;
    this.minLevel.disabled = !hasPrimary;
    this.maxLevel.disabled = !hasPrimary;
    this.minLevel.value = primary.minLevel === null
      ? ''
      : String(primary.minLevel);
    this.maxLevel.value = primary.maxLevel === null
      ? ''
      : String(primary.maxLevel);
    this.updateLevelValidity(primary, this.minLevel, this.maxLevel);

    const backup = this.host.backupRule();
    const hasBackup = backup.ship !== null;
    this.backupLevelEnabled.checked = hasBackup && backup.levelEnabled;
    this.backupLevelEnabled.disabled = !hasBackup;
    this.backupLevelFields.hidden = !hasBackup || !backup.levelEnabled;
    this.backupMinLevel.disabled = !hasBackup;
    this.backupMaxLevel.disabled = !hasBackup;
    this.backupMinLevel.value = backup.minLevel === null
      ? ''
      : String(backup.minLevel);
    this.backupMaxLevel.value = backup.maxLevel === null
      ? ''
      : String(backup.maxLevel);
    this.updateLevelValidity(
      backup,
      this.backupMinLevel,
      this.backupMaxLevel,
    );
  }

  private bindActions(): void {
    this.levelEnabled.addEventListener('change', () => {
      this.host.updatePrimaryRule({
        levelEnabled: this.levelEnabled.checked,
      });
      this.levelFields.hidden = !this.levelEnabled.checked;
    });
    this.minLevel.addEventListener('input', () => {
      this.host.updatePrimaryRule({
        minLevel: this.readLevel(this.minLevel),
      });
      this.updateLevelValidity(
        this.host.primaryRule(),
        this.minLevel,
        this.maxLevel,
      );
    });
    this.maxLevel.addEventListener('input', () => {
      this.host.updatePrimaryRule({
        maxLevel: this.readLevel(this.maxLevel),
      });
      this.updateLevelValidity(
        this.host.primaryRule(),
        this.minLevel,
        this.maxLevel,
      );
    });
    this.backupLevelEnabled.addEventListener('change', () => {
      const rule = this.host.backupRule();
      const levelEnabled = rule.ship !== null
        && this.backupLevelEnabled.checked;
      this.host.updateBackupRule({ levelEnabled });
      this.backupLevelEnabled.checked = levelEnabled;
      this.backupLevelFields.hidden = !levelEnabled;
    });
    this.backupMinLevel.addEventListener('input', () => {
      this.host.updateBackupRule({
        minLevel: this.readLevel(this.backupMinLevel),
      });
      this.updateLevelValidity(
        this.host.backupRule(),
        this.backupMinLevel,
        this.backupMaxLevel,
      );
    });
    this.backupMaxLevel.addEventListener('input', () => {
      this.host.updateBackupRule({
        maxLevel: this.readLevel(this.backupMaxLevel),
      });
      this.updateLevelValidity(
        this.host.backupRule(),
        this.backupMinLevel,
        this.backupMaxLevel,
      );
    });
  }

  private readLevel(input: HTMLInputElement): number | null {
    if (!input.value.trim()) return null;
    return Number(input.value);
  }

  private updateLevelValidity(
    rule: FleetRuleDraftViewObject,
    minInput: HTMLInputElement,
    maxInput: HTMLInputElement,
  ): void {
    const minInvalid = minInput.value !== ''
      && (!Number.isInteger(Number(minInput.value))
        || Number(minInput.value) < 1);
    const maxInvalid = maxInput.value !== ''
      && (!Number.isInteger(Number(maxInput.value))
        || Number(maxInput.value) < 1);
    const rangeInvalid = rule.minLevel !== null
      && rule.maxLevel !== null
      && rule.maxLevel < rule.minLevel;
    minInput.setCustomValidity(
      minInvalid ? '最小等级必须是大于或等于 1 的整数' : '',
    );
    maxInput.setCustomValidity(
      maxInvalid
        ? '最大等级必须是大于或等于 1 的整数'
        : rangeInvalid
          ? '最大等级必须大于或等于最小等级'
          : '',
    );
  }
}
