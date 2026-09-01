/** 持有用户配置状态并负责默认值、迁移和 YAML 转换。 */
/**
 * ConfigModel —— 用户配置(UserSettings)的 Model 层。
 * 负责从 YAML 加载、导出配置，以及局部更新。
 */
import { yamlCodec } from '../adapter/index.js';
import type {
  GuiAutomationSettings,
  NormalFightTaskConfig,
  UserSettings,
} from '../types/model.js';
import {
  DEFAULT_LOOT_PLAN_ID,
  DEFAULT_LOOT_PLANS,
  LEGACY_LOOT_PLAN_IDS,
  findLootAutomationPlan,
  lootPlanIdFromIndex,
  migrateLootPlanId,
  normalizeLootAutomationPlans,
} from '../shared/lootPlans.js';
import type {
  LegacyDecisiveAutomationSettings,
  LegacyDecisiveYamlKey,
} from '../shared/legacyDecisiveAutomation.js';
import {
  SYSTEM_DECISIVE_PRESET_ID,
  normalizeDecisiveAutomationSource,
} from '../shared/decisiveAutomation.js';
import { normalizeFleetShipTypeCode } from '../shared/fleetShipTypes.js';
import { DAILY_CAMPAIGN_TIMES } from '../shared/campaign.js';
import { normalFightDailyLimit } from './scheduler/NormalFightDailyQuota.js';
import { Logger } from '../utils/Logger';

const DEFAULT_SETTINGS: UserSettings = {
  emulator: {
    type: '雷电',
  },
  account: {
    game_app: '官服',
  },
  ocr: {
    gpu: false,
    mirror: 'modelscope',
    enhanced_ship_ocr: false,
    ship_name_match_confidence: 0.65,
    ship_name_corrections: {},
    ship_name_aliases: {},
  },
  log: {
    level: 'INFO',
    root: 'logs',
  },
  daily_automation: {
    auto_expedition: false,
    auto_gain_bonus: false,
    auto_bath_repair: false,
    auto_set_support: false,
    bath_repair_blacklist: [],
    auto_battle: false,
    battle_type: '困难潜艇',
    auto_exercise: false,
    exercise_fleet_id: null,
    auto_normal_fight: false,
    normal_fight_tasks: [],
    quick_repair_limit: null,
    stop_max_ship: false,
    stop_max_loot: false,
  },
  operation_delay_min: 0,
  operation_delay_max: 0,
  dock_full_mode: 0,
  dock_full_destroy: false,
  repair_manually: false,
  bathroom_count: 2,
  destroy_ship_work_mode: 0,
  destroy_ship_types: [],
  remove_equipment_mode: true,
  intensify: {
    target_ship: '',
    material_ship_types: [],
    max_materials: 4,
    protected_ships: [],
  },
};

const DEFAULT_GUI_AUTOMATION: GuiAutomationSettings = {
  expeditionInterval: 15,
  battleTimes: DAILY_CAMPAIGN_TIMES,
  autoDecisive: false,
  decisiveTemplateId: SYSTEM_DECISIVE_PRESET_ID,
  autoLoot: false,
  lootPlanSource: 'system',
  lootPlanId: DEFAULT_LOOT_PLAN_ID,
  lootPlans: DEFAULT_LOOT_PLANS.map(plan => ({ ...plan })),
  lootStopCount: 50,
};

const LEGACY_DAILY_KEYS = [
  'expedition_interval',
  'battle_times',
  'auto_loot',
  'loot_plan_id',
  'loot_plan_index',
  'loot_stop_count',
] as const;

export class ConfigModel {
  private settings: UserSettings;
  private guiAutomation: GuiAutomationSettings;
  private legacyGuiAutomation: Partial<GuiAutomationSettings> = {};
  private legacyDecisiveAutomation:
    LegacyDecisiveAutomationSettings = {};
  private invalidLegacyDecisiveFields:
    LegacyDecisiveYamlKey[] = [];
  /** 原始 YAML 根对象，用于保留 GUI 尚未建模的后端配置 */
  private rawRoot: Record<string, unknown> = {};

  constructor() {
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.guiAutomation = structuredClone(DEFAULT_GUI_AUTOMATION);
  }

  /** 当前配置 (只读引用) */
  get current(): UserSettings {
    return this.settings;
  }

  /** GUI 自身定时调度配置，不参与 usersettings.yaml 序列化。 */
  get currentGuiAutomation(): GuiAutomationSettings {
    return this.guiAutomation;
  }

  /** 旧版 usersettings.yaml 中可迁移的 GUI 私有字段。 */
  get migratedGuiAutomation(): Partial<GuiAutomationSettings> {
    return structuredClone(this.legacyGuiAutomation);
  }

  /** 等待迁入 gui_settings.json 的旧版决战自动化原值。 */
  get migratedLegacyDecisiveAutomation():
    LegacyDecisiveAutomationSettings {
    return structuredClone(this.legacyDecisiveAutomation);
  }

  /** 格式无法识别且必须继续留在 YAML 中的旧版决战字段。 */
  get unmigratedLegacyDecisiveFields():
    readonly LegacyDecisiveYamlKey[] {
    return [...this.invalidLegacyDecisiveFields];
  }

  /** 从 YAML 字符串加载配置，缺失字段保留默认值 */
  loadFromYaml(yamlStr: string): void {
    const parsed = yamlCodec.parse<Record<string, unknown> | null>(yamlStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      Logger.debug('配置 YAML 解析结果为空，使用默认值');
      return;
    }

    this.rawRoot = structuredClone(parsed);
    const base = structuredClone(DEFAULT_SETTINGS);

    const emulator = this.asRecord(parsed.emulator);
    if (emulator) {
      if (typeof emulator.type === 'string') base.emulator.type = emulator.type;
      if (typeof emulator.path === 'string') base.emulator.path = emulator.path;
      if (typeof emulator.serial === 'string') base.emulator.serial = emulator.serial;
      if (typeof emulator.process_name === 'string') {
        base.emulator.process_name = emulator.process_name;
      }
    }

    const account = this.asRecord(parsed.account);
    if (account && typeof account.game_app === 'string') {
      base.account.game_app = account.game_app;
    }

    const ocr = this.asRecord(parsed.ocr);
    if (ocr) {
      if (typeof ocr.gpu === 'boolean') base.ocr.gpu = ocr.gpu;
      if (['origin', 'github', 'tencent', 'modelscope'].includes(String(ocr.mirror))) {
        base.ocr.mirror = String(ocr.mirror) as UserSettings['ocr']['mirror'];
      }
      if (typeof ocr.enhanced_ship_ocr === 'boolean') {
        base.ocr.enhanced_ship_ocr = ocr.enhanced_ship_ocr;
      }
      base.ocr.ship_name_match_confidence = this.clampNumber(
        ocr.ship_name_match_confidence,
        0,
        1,
        base.ocr.ship_name_match_confidence,
      );
      base.ocr.ship_name_corrections = this.stringMap(
        ocr.ship_name_corrections,
      );
      base.ocr.ship_name_aliases = this.stringMap(ocr.ship_name_aliases);
    }

    const log = this.asRecord(parsed.log);
    if (log) {
      const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
      if (levels.includes(String(log.level))) {
        base.log.level = String(log.level) as UserSettings['log']['level'];
      }
      if (typeof log.root === 'string') base.log.root = log.root;
      if (typeof log.dir === 'string' || log.dir === null) base.log.dir = log.dir;
      for (const key of [
        'show_decisive_battle_info',
        'show_emulator_debug',
        'show_ui_debug',
        'show_vision_debug',
        'show_ops_debug',
        'show_combat_state_debug',
        'show_combat_recognition_debug',
      ] as const) {
        if (typeof log[key] === 'boolean') base.log[key] = log[key];
      }
      if (this.asRecord(log.channels)) {
        base.log.channels = this.stringMap(log.channels);
      }
    }

    const daily = this.asRecord(parsed.daily_automation);
    if (daily) {
      for (const key of [
        'auto_expedition',
        'auto_gain_bonus',
        'auto_bath_repair',
        'auto_set_support',
        'auto_battle',
        'auto_exercise',
        'auto_normal_fight',
        'stop_max_ship',
        'stop_max_loot',
      ] as const) {
        if (typeof daily[key] === 'boolean') base.daily_automation[key] = daily[key];
      }
      if (typeof daily.battle_type === 'string') {
        base.daily_automation.battle_type = daily.battle_type;
      }
      if (daily.exercise_fleet_id === null || Number.isFinite(Number(daily.exercise_fleet_id))) {
        base.daily_automation.exercise_fleet_id = daily.exercise_fleet_id === null
          ? null
          : Math.max(1, Math.trunc(Number(daily.exercise_fleet_id)));
      }
      base.daily_automation.bath_repair_blacklist = this.stringList(
        daily.bath_repair_blacklist,
      );
      base.daily_automation.normal_fight_tasks = this.normalFightTasks(
        daily.normal_fight_tasks,
      );
      if (daily.quick_repair_limit === null || Number.isFinite(Number(daily.quick_repair_limit))) {
        base.daily_automation.quick_repair_limit = daily.quick_repair_limit === null
          ? null
          : Math.max(0, Math.trunc(Number(daily.quick_repair_limit)));
      }
      this.legacyGuiAutomation = this.readLegacyGuiAutomation(daily);
      this.legacyDecisiveAutomation =
        this.readLegacyDecisiveAutomation(daily);
    } else {
      this.legacyGuiAutomation = {};
      this.legacyDecisiveAutomation = {};
      this.invalidLegacyDecisiveFields = [];
    }

    base.operation_delay_min = this.clampNumber(
      parsed.operation_delay_min,
      0,
      10,
      0,
    );
    base.operation_delay_max = this.clampNumber(
      parsed.operation_delay_max,
      0,
      10,
      0,
    );
    if (parsed.dock_full_mode !== undefined) {
      base.dock_full_mode = this.dockFullMode(parsed.dock_full_mode);
      base.dock_full_destroy = base.dock_full_mode > 0;
    } else if (typeof parsed.dock_full_destroy === 'boolean') {
      base.dock_full_destroy = parsed.dock_full_destroy;
      base.dock_full_mode = parsed.dock_full_destroy ? 1 : 0;
    }
    if (typeof parsed.repair_manually === 'boolean') {
      base.repair_manually = parsed.repair_manually;
    }
    base.bathroom_count = Math.max(
      1,
      Math.min(12, Math.trunc(Number(parsed.bathroom_count) || 2)),
    );
    base.destroy_ship_work_mode = this.destroyMode(parsed.destroy_ship_work_mode);
    base.destroy_ship_types = this.stringList(parsed.destroy_ship_types);
    if (typeof parsed.remove_equipment_mode === 'boolean') {
      base.remove_equipment_mode = parsed.remove_equipment_mode;
    }
    if (typeof parsed.plan_root === 'string' && parsed.plan_root.trim()) {
      base.plan_root = parsed.plan_root;
    }
    const intensify = this.asRecord(parsed.intensify);
    if (intensify) {
      if (typeof intensify.target_ship === 'string') {
        base.intensify.target_ship = intensify.target_ship.trim();
      }
      base.intensify.material_ship_types = this.stringList(
        intensify.material_ship_types,
      ).map(normalizeFleetShipTypeCode).filter(
        (item): item is string => item !== null && item !== 'ss_or_ssg',
      ).map(item => item.toUpperCase());
      const maximumMaterials = Number(intensify.max_materials);
      base.intensify.max_materials = intensify.max_materials === null
        ? null
        : Number.isFinite(maximumMaterials)
          ? Math.max(1, Math.trunc(maximumMaterials))
          : 4;
      base.intensify.protected_ships = this.stringList(
        intensify.protected_ships,
      );
    }

    this.settings = base;
  }

  /** 导出当前配置为 YAML 字符串 */
  toYaml(): string {
    const output = structuredClone(this.rawRoot);
    output.emulator = this.mergeSection(this.rawRoot.emulator, this.settings.emulator);
    output.account = this.mergeSection(this.rawRoot.account, this.settings.account);
    output.ocr = this.mergeSection(
      this.rawRoot.ocr,
      this.settings.ocr,
      ['ship_name_corrections', 'ship_name_aliases'],
    );
    output.log = this.mergeSection(
      this.rawRoot.log,
      this.settings.log,
      ['channels'],
    );

    const daily = this.mergeSection(
      this.rawRoot.daily_automation,
      this.settings.daily_automation,
    );
    if (daily.exercise_fleet_id === null) delete daily.exercise_fleet_id;
    if (daily.quick_repair_limit === null) delete daily.quick_repair_limit;
    output.daily_automation = daily;

    output.operation_delay_min = this.settings.operation_delay_min;
    output.operation_delay_max = this.settings.operation_delay_max;
    output.dock_full_mode = this.settings.dock_full_mode;
    output.dock_full_destroy = this.settings.dock_full_destroy;
    output.repair_manually = this.settings.repair_manually;
    output.bathroom_count = this.settings.bathroom_count;
    output.destroy_ship_work_mode = this.settings.destroy_ship_work_mode;
    output.destroy_ship_types = [...this.settings.destroy_ship_types];
    output.remove_equipment_mode = this.settings.remove_equipment_mode;
    if (this.settings.plan_root) output.plan_root = this.settings.plan_root;
    else delete output.plan_root;
    output.intensify = this.mergeSection(
      this.rawRoot.intensify,
      this.settings.intensify,
    );

    return yamlCodec.stringify(output, { lineWidth: -1, noRefs: true });
  }

  /** 局部更新配置 (深合并) */
  update(partial: Partial<UserSettings>): void {
    if (partial.emulator) {
      Object.assign(this.settings.emulator, partial.emulator);
    }
    if (partial.account) {
      Object.assign(this.settings.account, partial.account);
    }
    if (partial.ocr) {
      Object.assign(this.settings.ocr, partial.ocr);
    }
    if (partial.log) {
      Object.assign(this.settings.log, partial.log);
    }
    if (partial.daily_automation) {
      Object.assign(this.settings.daily_automation, partial.daily_automation);
    }
    if (partial.intensify) {
      Object.assign(this.settings.intensify, partial.intensify);
    }
    for (const key of [
      'operation_delay_min',
      'operation_delay_max',
      'dock_full_mode',
      'dock_full_destroy',
      'repair_manually',
      'bathroom_count',
      'destroy_ship_work_mode',
      'destroy_ship_types',
      'remove_equipment_mode',
      'plan_root',
    ] as const) {
      if (key in partial) {
        (this.settings as unknown as Record<string, unknown>)[key] =
          structuredClone(partial[key]);
      }
    }
  }

  updateGuiAutomation(partial: Partial<GuiAutomationSettings>): void {
    Object.assign(this.guiAutomation, partial);
    const lootPlans = normalizeLootAutomationPlans(
      this.guiAutomation.lootPlans,
    );
    const selectedLootPlan = findLootAutomationPlan(
      lootPlans,
      this.guiAutomation.lootPlanSource,
      this.guiAutomation.lootPlanId,
    );
    const fallbackLootPlan = lootPlans[0] ?? DEFAULT_LOOT_PLANS[0];
    this.guiAutomation.expeditionInterval = Math.max(
      1,
      Math.min(120, Math.trunc(this.guiAutomation.expeditionInterval || 15)),
    );
    this.guiAutomation.battleTimes = DAILY_CAMPAIGN_TIMES;
    this.guiAutomation.autoDecisive =
      this.guiAutomation.autoDecisive === true;
    this.guiAutomation.decisiveTemplateId =
      normalizeDecisiveAutomationSource(
        this.guiAutomation.decisiveTemplateId,
      );
    this.guiAutomation.lootPlans = lootPlans;
    this.guiAutomation.lootPlanSource =
      selectedLootPlan?.source ?? fallbackLootPlan?.source ?? 'system';
    this.guiAutomation.lootPlanId =
      selectedLootPlan?.file ?? fallbackLootPlan?.file ?? DEFAULT_LOOT_PLAN_ID;
    if (!selectedLootPlan) this.guiAutomation.autoLoot = false;
    this.guiAutomation.lootStopCount = Math.max(
      1,
      Math.min(50, Math.trunc(this.guiAutomation.lootStopCount || 50)),
    );
  }

  /** 用默认值重置后再应用迁移结果，避免上一次加载状态参与字段优先级。 */
  replaceGuiAutomation(partial: Partial<GuiAutomationSettings>): void {
    this.guiAutomation = structuredClone(DEFAULT_GUI_AUTOMATION);
    this.updateGuiAutomation(partial);
  }

  /** 仅在完整 GUI 自动化配置持久化成功后清理旧 YAML 字段。 */
  markLegacyGuiAutomationMigrated(): void {
    const daily = this.asRecord(this.rawRoot.daily_automation);
    if (!daily) return;
    for (const key of LEGACY_DAILY_KEYS) delete daily[key];
    this.legacyGuiAutomation = this.readLegacyGuiAutomation(daily);
  }

  /**
   * 仅清理已经由主进程写入并回读确认的旧版决战字段。
   * 未迁移或格式异常的字段继续由 rawRoot 原样写回 YAML。
   */
  markLegacyDecisiveAutomationMigrated(
    settings: LegacyDecisiveAutomationSettings,
  ): void {
    const daily = this.asRecord(this.rawRoot.daily_automation);
    if (!daily) return;
    if (
      Object.prototype.hasOwnProperty.call(settings, 'autoDecisive')
    ) {
      delete daily.auto_decisive;
    }
    if (
      Object.prototype.hasOwnProperty.call(settings, 'ticketReserve')
    ) {
      delete daily.decisive_ticket_reserve;
    }
    if (
      Object.prototype.hasOwnProperty.call(settings, 'templateId')
    ) {
      delete daily.decisive_template_id;
    }
    this.legacyDecisiveAutomation =
      this.readLegacyDecisiveAutomation(daily);
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private mergeSection(
    raw: unknown,
    values: object,
    stringMapKeys: readonly string[] = [],
  ): Record<string, unknown> {
    const output = structuredClone(this.asRecord(raw) ?? {});
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete output[key];
      } else if (stringMapKeys.includes(key)) {
        output[key] = this.mergeStringMap(output[key], value);
      } else {
        const nested = this.asRecord(value);
        output[key] = nested
          ? this.mergeSection(output[key], nested)
          : structuredClone(value);
      }
    }
    return output;
  }

  /** 合并动态字符串映射，同时保留 GUI 无法识别的扩展值。 */
  private mergeStringMap(
    raw: unknown,
    value: unknown,
  ): Record<string, unknown> {
    const rawEntries = this.asRecord(raw) ?? {};
    const current = this.asRecord(value) ?? {};
    const output = structuredClone(rawEntries);
    for (const [key, rawValue] of Object.entries(rawEntries)) {
      if (
        typeof rawValue === 'string'
        && !Object.prototype.hasOwnProperty.call(current, key)
      ) {
        delete output[key];
      }
    }
    for (const [key, currentValue] of Object.entries(current)) {
      if (currentValue === undefined) {
        delete output[key];
      } else {
        output[key] = structuredClone(currentValue);
      }
    }
    return output;
  }

  private clampNumber(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  private stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean);
  }

  private stringMap(value: unknown): Record<string, string> {
    const record = this.asRecord(value);
    if (!record) return {};
    const output: Record<string, string> = {};
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === 'string' && key.trim() && item.trim()) {
        output[key.trim()] = item.trim();
      }
    }
    return output;
  }

  private normalFightTasks(value: unknown): NormalFightTaskConfig[] {
    if (!Array.isArray(value)) return [];
    const output: NormalFightTaskConfig[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        output.push({ name: item.trim() });
        continue;
      }
      if (Array.isArray(item) && item.length > 0) {
        const name = String(item[0] ?? '').trim();
        if (!name) continue;
        const task: NormalFightTaskConfig = { name };
        if (item[1] != null && Number.isFinite(Number(item[1]))) {
          task.fleet_id = Math.max(1, Math.trunc(Number(item[1])));
        }
        if (item[2] != null && Number.isFinite(Number(item[2]))) {
          task.times = normalFightDailyLimit(item[2]);
        }
        output.push(task);
        continue;
      }
      const record = this.asRecord(item);
      if (!record || typeof record.name !== 'string' || !record.name.trim()) continue;
      const task: NormalFightTaskConfig = { name: record.name.trim() };
      if (record.source === 'system' || record.source === 'user') {
        task.source = record.source;
      }
      if (record.fleet_id != null && Number.isFinite(Number(record.fleet_id))) {
        task.fleet_id = Math.max(1, Math.trunc(Number(record.fleet_id)));
      }
      if (
        record.fleet_preset_index != null
        && Number.isFinite(Number(record.fleet_preset_index))
      ) {
        task.fleet_preset_index = Math.max(
          0,
          Math.trunc(Number(record.fleet_preset_index)),
        );
      }
      if (record.times != null && Number.isFinite(Number(record.times))) {
        task.times = normalFightDailyLimit(record.times);
      }
      output.push(task);
    }
    return output;
  }

  private readLegacyGuiAutomation(
    daily: Record<string, unknown>,
  ): Partial<GuiAutomationSettings> {
    const output: Partial<GuiAutomationSettings> = {};
    if (Number.isFinite(Number(daily.expedition_interval))) {
      output.expeditionInterval = Number(daily.expedition_interval);
    }
    if (Number.isFinite(Number(daily.battle_times))) {
      output.battleTimes = Number(daily.battle_times);
    }
    if (typeof daily.auto_loot === 'boolean') output.autoLoot = daily.auto_loot;
    if (typeof daily.loot_plan_id === 'string') {
      const migrated = migrateLootPlanId(daily.loot_plan_id);
      if (migrated) {
        output.lootPlanSource = 'system';
        output.lootPlanId = migrated;
      } else {
        output.autoLoot = false;
      }
    } else if (
      Object.prototype.hasOwnProperty.call(daily, 'loot_plan_index')
    ) {
      const resolved = lootPlanIdFromIndex(
        daily.loot_plan_index,
        LEGACY_LOOT_PLAN_IDS,
      );
      if (resolved) {
        output.lootPlanSource = 'system';
        output.lootPlanId = resolved;
      }
      else output.autoLoot = false;
    }
    if (output.autoLoot === true && !output.lootPlanId) {
      output.autoLoot = false;
    }
    if (Number.isFinite(Number(daily.loot_stop_count))) {
      output.lootStopCount = Number(daily.loot_stop_count);
    }
    return output;
  }

  /** 读取可安全迁移的旧决战值，并记录必须原样保留的异常字段。 */
  private readLegacyDecisiveAutomation(
    daily: Record<string, unknown>,
  ): LegacyDecisiveAutomationSettings {
    const output: LegacyDecisiveAutomationSettings = {};
    const invalid: LegacyDecisiveYamlKey[] = [];
    if (
      Object.prototype.hasOwnProperty.call(daily, 'auto_decisive')
    ) {
      if (typeof daily.auto_decisive === 'boolean') {
        output.autoDecisive = daily.auto_decisive;
      } else {
        invalid.push('auto_decisive');
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(
        daily,
        'decisive_ticket_reserve',
      )
    ) {
      const raw = daily.decisive_ticket_reserve;
      const numericString = typeof raw === 'string' && raw.trim();
      if (
        (typeof raw === 'number' && Number.isFinite(raw))
        || (
          numericString
          && Number.isFinite(Number(raw))
        )
      ) {
        output.ticketReserve = Number(raw);
      } else {
        invalid.push('decisive_ticket_reserve');
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(
        daily,
        'decisive_template_id',
      )
    ) {
      if (typeof daily.decisive_template_id === 'string') {
        if (daily.decisive_template_id.length > 0) {
          output.templateId = daily.decisive_template_id;
        }
      } else {
        invalid.push('decisive_template_id');
      }
    }
    this.invalidLegacyDecisiveFields = invalid;
    return output;
  }

  private dockFullMode(value: unknown): number {
    const aliases: Record<string, number> = {
      '关闭': 0,
      disable: 0,
      '解装': 1,
      destroy: 1,
      '强化': 2,
      intensify: 2,
      '自动': 3,
      auto: 3,
      '混合': 3,
    };
    if (typeof value === 'string' && value.trim() in aliases) {
      return aliases[value.trim()];
    }
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    const number = Math.trunc(Number(value));
    return [0, 1, 2, 3].includes(number) ? number : 0;
  }

  private destroyMode(value: unknown): number {
    const aliases: Record<string, number> = {
      '不启用': 0,
      disable: 0,
      '黑名单': 1,
      include: 1,
      '白名单': 2,
      exclude: 2,
    };
    if (typeof value === 'string' && value.trim() in aliases) {
      return aliases[value.trim()];
    }
    const number = Math.trunc(Number(value));
    return [0, 1, 2].includes(number) ? number : 0;
  }
}
