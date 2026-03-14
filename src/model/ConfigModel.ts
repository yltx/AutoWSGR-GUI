/**
 * ConfigModel —— 用户配置(UserSettings)的 Model 层。
 * 负责从 YAML 加载、导出配置，以及局部更新。
 */
import * as yaml from 'js-yaml';
import type { UserSettings } from './types';
import { Logger } from '../utils/Logger';

const DEFAULT_SETTINGS: UserSettings = {
  emulator: {
    type: '雷电',
  },
  account: {
    game_app: '官服',
  },
  daily_automation: {
    auto_expedition: true,
    expedition_interval: 15,
    auto_battle: false,
    battle_type: '困难潜艇',
    battle_times: 3,
    auto_exercise: false,
    exercise_fleet_id: 1,
    auto_normal_fight: false,
    auto_decisive: false,
    decisive_ticket_reserve: 0,
    decisive_template_id: '',
  },
};

export class ConfigModel {
  private settings: UserSettings;

  constructor() {
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  /** 当前配置 (只读引用) */
  get current(): UserSettings {
    return this.settings;
  }

  /** 从 YAML 字符串加载配置，缺失字段保留默认值 */
  loadFromYaml(yamlStr: string): void {
    const parsed = yaml.load(yamlStr) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      Logger.debug('配置 YAML 解析结果为空，使用默认值');
      return;
    }

    const base = structuredClone(DEFAULT_SETTINGS);

    if (parsed.emulator && typeof parsed.emulator === 'object') {
      Object.assign(base.emulator, parsed.emulator);
    }
    if (parsed.account && typeof parsed.account === 'object') {
      Object.assign(base.account, parsed.account);
    }
    if (parsed.daily_automation && typeof parsed.daily_automation === 'object') {
      Object.assign(base.daily_automation, parsed.daily_automation);
      // 确保 expedition_interval 在合理范围
      const ei = base.daily_automation.expedition_interval;
      if (typeof ei !== 'number' || ei < 1 || ei > 120) {
        base.daily_automation.expedition_interval = 15;
      }
    }

    this.settings = base;
  }

  /** 导出当前配置为 YAML 字符串 */
  toYaml(): string {
    return yaml.dump(this.settings, { lineWidth: -1, noRefs: true });
  }

  /** 局部更新配置 (深合并) */
  update(partial: Partial<UserSettings>): void {
    if (partial.emulator) {
      Object.assign(this.settings.emulator, partial.emulator);
    }
    if (partial.account) {
      Object.assign(this.settings.account, partial.account);
    }
    if (partial.daily_automation) {
      Object.assign(this.settings.daily_automation, partial.daily_automation);
    }
  }
}
