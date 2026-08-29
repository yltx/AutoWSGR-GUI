/** 持有作战方案状态并处理节点规则、迁移和 YAML 往返。 */
/**
 * PlanModel —— 战斗方案(Plan)的 Model 层。
 * 负责从 YAML 文件解析战斗方案，并提供节点参数的查询与合并。
 */
import { yamlCodec } from '../adapter/index.js';
import { normalizeLegacyNodeDecisionFields } from '../shared/nodeDecision.js';
import { serializePlanYaml } from '../shared/yamlSerializer.js';
import type {
  PlanData,
  NodeArgs,
  FleetPreset,
  ShipSlot,
  ShipFilter,
  ShipRule,
  EnemyRule,
  BattleResultGrade,
} from '../types/model.js';

const BATTLE_RESULT_GRADES = new Set<BattleResultGrade>(['D', 'C', 'B', 'A', 'S', 'SS']);

export class PlanModel {
  data: PlanData;
  fileName: string;
  comment: string;
  /** 原始 YAML 根对象，用于保留 GUI 尚未建模的方案字段 */
  private rawRoot: Record<string, unknown>;

  private constructor(
    data: PlanData,
    fileName: string,
    comment: string,
    rawRoot: Record<string, unknown> = {},
  ) {
    this.data = data;
    this.fileName = fileName;
    this.comment = comment;
    this.rawRoot = rawRoot;
  }

  /** 从 YAML 字符串 + 文件路径创建 PlanModel */
  static fromYaml(content: string, path: string): PlanModel {
    const comment = PlanModel.extractComment(content);
    const parsed = yamlCodec.parse<Record<string, unknown>>(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('无效的方案文件');
    }

    const chapterRaw = parsed.chapter;
    const mapRaw = parsed.map;
    const chapter = typeof chapterRaw === 'string' && /^[EH]$/i.test(chapterRaw.trim())
      ? chapterRaw.trim().toUpperCase()
      : Number(chapterRaw) || 0;
    const map = typeof mapRaw === 'string' && /^\d+[ab]$/i.test(mapRaw.trim())
      ? mapRaw.trim().toLowerCase()
      : Number(mapRaw) || 0;
    const chapterCode = String(chapter).toUpperCase();
    if ((chapterCode === 'E' || chapterCode === 'H') && parsed.event == null) {
      throw new Error('活动方案缺少 event 字段');
    }

    const data: PlanData = {
      chapter,
      map,
      mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
      event: parsed.event != null ? String(parsed.event) : undefined,
      selected_nodes: Array.isArray(parsed.selected_nodes)
        ? parsed.selected_nodes.map(String)
        : [],
      endpoint_nodes: Array.isArray(parsed.endpoint_nodes)
        ? parsed.endpoint_nodes.map(String)
        : undefined,
      result: typeof parsed.result === 'string'
        && BATTLE_RESULT_GRADES.has(parsed.result.toUpperCase() as BattleResultGrade)
        ? parsed.result.toUpperCase() as BattleResultGrade
        : undefined,
      fight_condition: parsed.fight_condition != null ? Number(parsed.fight_condition) : undefined,
      repair_mode: parsed.repair_mode != null
        ? (Array.isArray(parsed.repair_mode)
          ? (parsed.repair_mode as number[]).map(Number)
          : Number(parsed.repair_mode))
        : undefined,
      fleet_id: parsed.fleet_id != null ? Number(parsed.fleet_id) : undefined,
      node_defaults: PlanModel.normalizeNodeArgs(parsed.node_defaults as NodeArgs | undefined),
      node_args: PlanModel.normalizeNodeArgsMap(parsed.node_args as Record<string, NodeArgs> | undefined),
      fleet_presets: PlanModel.parseFleetPresets(parsed.fleet_presets),
      // 任务级字段
      times: parsed.times != null ? Number(parsed.times) : undefined,
      gap: parsed.gap != null ? Number(parsed.gap) : undefined,
      stop_condition: parsed.stop_condition as PlanData['stop_condition'],
      scheduled_time: typeof parsed.scheduled_time === 'string' ? parsed.scheduled_time : undefined,
      collect_result_info: typeof parsed.collect_result_info === 'boolean'
        ? parsed.collect_result_info
        : undefined,
    };

    return new PlanModel(data, path, comment, structuredClone(parsed));
  }

  /** 地图名，如 "7-4" 或 "Ex-3" */
  get mapName(): string {
    if (this.isEvent) {
      const rawMap = String(this.data.map);
      const match = rawMap.match(/^(\d+)([ab])?$/i);
      const stage = match?.[1] ?? rawMap;
      const entranceCode = match?.[2]?.toLowerCase();
      const entrance = entranceCode === 'a'
        ? '-α'
        : entranceCode === 'b'
          ? '-β'
          : '';
      return `${String(this.data.chapter).toUpperCase()}-Ex-${stage}${entrance}`;
    }
    if (this.data.chapter === 99) return `Ex-${this.data.map}`;
    return `${this.data.chapter}-${this.data.map}`;
  }

  /** 是否为活动作战方案。 */
  get isEvent(): boolean {
    const chapter = String(this.data.chapter).toUpperCase();
    return !!this.data.event || this.data.mode === 'event' || chapter === 'E' || chapter === 'H';
  }

  /** 修理模式，默认 1。若为数组则返回原始数组 */
  get repairMode(): number | number[] {
    return this.data.repair_mode ?? 1;
  }

  /** 战况条件，默认 1 */
  get fightCondition(): number {
    return this.data.fight_condition ?? 1;
  }

  /** 获取指定节点的合并参数 (node_defaults + node_args 覆盖) */
  getNodeArgs(nodeId: string): NodeArgs {
    const defaults = this.data.node_defaults ?? {};
    const overrides = this.data.node_args?.[nodeId] ?? {};
    const args = { ...defaults, ...overrides };
    if (this.data.endpoint_nodes?.includes(nodeId)) {
      args.proceed = false;
    }
    return args;
  }

  /** 获取任务执行用节点覆盖，确保终点节点不会继续前进。 */
  getNodeArgsForExecution(): Record<string, NodeArgs> {
    const nodeArgs = structuredClone(this.data.node_args ?? {});
    for (const nodeId of this.data.endpoint_nodes ?? []) {
      nodeArgs[nodeId] = {
        ...nodeArgs[nodeId],
        proceed: false,
      };
    }
    return nodeArgs;
  }

  /** 该节点是否有自定义参数 (node_args 中存在条目) */
  hasCustomArgs(nodeId: string): boolean {
    return this.data.node_args != null && nodeId in this.data.node_args;
  }

  /** 提取 YAML 文件顶部的注释行 */
  private static extractComment(content: string): string {
    const lines: string[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#')) {
        lines.push(trimmed.slice(1).trim());
      } else if (trimmed === '') {
        continue;
      } else {
        break;
      }
    }
    return lines.join('\n');
  }

  /** 创建空方案 (新建方案用) */
  static create(
    chapter: number | string,
    map: number | string,
    selectedNodes: string[],
    event?: string,
  ): PlanModel {
    const data: PlanData = {
      chapter,
      map,
      event,
      selected_nodes: selectedNodes,
      fight_condition: 1,
      repair_mode: 1,
      fleet_id: 1,
      node_defaults: { formation: 2, night: false, proceed: true },
      node_args: {},
    };
    return new PlanModel(data, '', '');
  }

  /** 序列化为 YAML 字符串 */
  toYaml(): string {
    const obj = structuredClone(this.rawRoot);
    const rawFleetPresets = obj.fleet_presets;
    delete obj.fleet_presets;
    obj.chapter = this.data.chapter;
    obj.map = this.data.map;
    obj.selected_nodes = [...this.data.selected_nodes];

    this.setOptionalField(obj, 'mode', this.data.mode);
    this.setOptionalField(obj, 'event', this.data.event);
    this.setOptionalField(obj, 'fleet_id', this.data.fleet_id);
    this.setOptionalField(
      obj,
      'endpoint_nodes',
      this.data.endpoint_nodes?.length ? [...this.data.endpoint_nodes] : undefined,
    );
    this.setOptionalField(obj, 'result', this.data.result);
    this.setOptionalField(obj, 'fight_condition', this.data.fight_condition);
    this.setOptionalField(obj, 'repair_mode', this.data.repair_mode);

    if (this.data.node_defaults) {
      obj.node_defaults = this.mergeNodeArgs(
        this.rawRoot.node_defaults,
        this.data.node_defaults,
      );
    } else {
      delete obj.node_defaults;
    }

    const nodeArgs = this.getNodeArgsForExecution();
    if (Object.keys(nodeArgs).length > 0) {
      const rawNodeArgs = this.rawRoot.node_args;
      const rawMap = rawNodeArgs && typeof rawNodeArgs === 'object' && !Array.isArray(rawNodeArgs)
        ? rawNodeArgs as Record<string, unknown>
        : {};
      const cleaned: Record<string, unknown> = {};
      for (const [nodeId, args] of Object.entries(nodeArgs)) {
        const merged = this.mergeNodeArgs(rawMap[nodeId], args);
        if (Object.keys(merged).length > 0) cleaned[nodeId] = merged;
      }
      if (Object.keys(cleaned).length > 0) obj.node_args = cleaned;
      else delete obj.node_args;
    } else {
      delete obj.node_args;
    }

    this.setOptionalField(obj, 'times', this.data.times);
    this.setOptionalField(obj, 'gap', this.data.gap);
    this.setOptionalField(obj, 'stop_condition', this.data.stop_condition);
    this.setOptionalField(obj, 'scheduled_time', this.data.scheduled_time);
    this.setOptionalField(obj, 'collect_result_info', this.data.collect_result_info);

    if (this.data.fleet_presets !== undefined) {
      if (this.data.fleet_presets.length > 0) {
        obj.fleet_presets = this.mergeFleetPresets(this.data.fleet_presets);
      }
    } else if (rawFleetPresets !== undefined) {
      obj.fleet_presets = rawFleetPresets;
    }

    let result = '';
    if (this.comment) {
      result = this.comment.split('\n').map(l => `# ${l}`).join('\n') + '\n';
    }
    result += serializePlanYaml(obj);
    return result;
  }

  /** 写入可选字段；值被清空时同步删除旧 YAML 中的字段 */
  private setOptionalField(
    obj: Record<string, unknown>,
    key: string,
    value: unknown,
  ): void {
    if (value == null || value === '') delete obj[key];
    else obj[key] = structuredClone(value);
  }

  /** 更新 GUI 管理的节点参数，同时保留后端新增的未知参数 */
  private mergeNodeArgs(raw: unknown, args: NodeArgs): Record<string, unknown> {
    const output = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? structuredClone(raw as Record<string, unknown>)
      : {};
    const managedKeys = [
      'formation',
      'night',
      'long_missile_support',
      'proceed',
      'detour',
      'SL_when_detour_fails',
      'sl_when_detour_fails',
      'enemy_rules',
      'proceed_stop',
    ];
    for (const key of managedKeys) delete output[key];
    Object.assign(output, this.cleanNodeArgs(args));
    return output;
  }

  /** 更新编队预设，同时保留预设和槽位中 GUI 尚未建模的字段 */
  private mergeFleetPresets(presets: FleetPreset[]): Record<string, unknown>[] {
    const rawPresets = Array.isArray(this.rawRoot.fleet_presets)
      ? this.rawRoot.fleet_presets
      : [];

    return presets.map((preset, index) => {
      const rawPreset = rawPresets.find((item) => (
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && (item as Record<string, unknown>).name === preset.name
      )) ?? rawPresets[index];
      const output = rawPreset && typeof rawPreset === 'object' && !Array.isArray(rawPreset)
        ? structuredClone(rawPreset as Record<string, unknown>)
        : {};
      const rawShips = Array.isArray(output.ships) ? output.ships : [];

      output.name = preset.name;
      output.ships = preset.ships.map((slot, slotIndex) => (
        this.mergeShipSlot(rawShips[slotIndex], slot)
      ));
      return output;
    });
  }

  /** 覆盖单个槽位的正式字段，并清理旧版 priority 字段 */
  private mergeShipSlot(raw: unknown, slot: ShipSlot): ShipSlot | Record<string, unknown> {
    if (slot === null) return null;
    if (typeof slot === 'string') return slot;

    const output = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? structuredClone(raw as Record<string, unknown>)
      : {};
    const managedKeys = [
      'name',
      'nation',
      'search_name',
      'ship_type',
      'priority',
      'candidates',
      'min_level',
      'max_level',
      'relaxed',
    ];
    for (const key of managedKeys) delete output[key];
    Object.assign(output, structuredClone(slot));
    return output;
  }

  /** 清理节点参数：移除 undefined 值 */
  private cleanNodeArgs(args: NodeArgs): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (args.formation != null) out.formation = args.formation;
    if (args.night != null) out.night = args.night;
    if (args.long_missile_support != null) out.long_missile_support = args.long_missile_support;
    if (args.proceed != null) out.proceed = args.proceed;
    if (args.detour != null) out.detour = args.detour;
    if (args.SL_when_detour_fails != null) out.SL_when_detour_fails = args.SL_when_detour_fails;
    if (args.enemy_rules && args.enemy_rules.length > 0) out.enemy_rules = args.enemy_rules;
    if (args.proceed_stop) out.proceed_stop = args.proceed_stop;
    return out;
  }

  /** 解析 fleet_presets 字段 */
  private static parseFleetPresets(raw: unknown): FleetPreset[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const presets: FleetPreset[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== 'string' || !Array.isArray(obj.ships)) continue;
      presets.push({
        ...obj,
        name: obj.name,
        ships: (obj.ships as unknown[]).map(PlanModel.parseShipSlot),
      });
    }
    return presets.length > 0 ? presets : undefined;
  }

  /** 解析单个舰船槽位: 字符串 → 具体舰船, 对象 → ShipFilter */
  private static parseShipSlot(raw: unknown): ShipSlot {
    if (raw === null) return null;
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const filter: ShipFilter = {};
      if (typeof obj.name === 'string' || typeof obj.name === 'number') {
        const normalizedName = String(obj.name).trim();
        if (normalizedName) filter.name = normalizedName;
      }
      if (typeof obj.search_name === 'string' && obj.search_name.trim()) {
        filter.search_name = obj.search_name.trim();
      }
      if (typeof obj.nation === 'string') filter.nation = obj.nation;
      const shipTypes = PlanModel.parseShipTypes(obj.ship_type);
      if (shipTypes) filter.ship_type = shipTypes;
      PlanModel.assignLevelRange(filter, obj);
      if (typeof obj.relaxed === 'boolean') filter.relaxed = obj.relaxed;

      const rawCandidates = Array.isArray(obj.candidates)
        ? obj.candidates
        : obj.priority;
      if (Array.isArray(rawCandidates)) {
        const candidateOnlyWithLegacyNames = (
          !filter.name
          && rawCandidates.some(value => typeof value === 'string')
        );
        const candidates = rawCandidates.flatMap((candidate) => {
          if (typeof candidate === 'string') {
            const name = candidate.trim();
            if (!name) return [];
            const legacyRule: ShipRule = { name };
            if (filter.search_name) {
              legacyRule.search_name = filter.search_name;
            }
            if (filter.ship_type) legacyRule.ship_type = [...filter.ship_type];
            if (filter.min_level !== undefined) {
              legacyRule.min_level = filter.min_level;
            }
            if (filter.max_level !== undefined) {
              legacyRule.max_level = filter.max_level;
            }
            return [legacyRule];
          }
          const parsed = PlanModel.parseShipRule(candidate);
          return parsed ? [parsed] : [];
        });
        if (candidates.length > 0) filter.candidates = candidates;
        if (candidateOnlyWithLegacyNames) delete filter.search_name;
      }
      return filter;
    }
    return String(raw);
  }

  private static parseShipRule(raw: unknown): ShipRule | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name !== 'string' || !obj.name.trim()) return null;

    const rule: ShipRule = {
      name: obj.name.trim(),
    };
    if (typeof obj.search_name === 'string' && obj.search_name.trim()) {
      rule.search_name = obj.search_name.trim();
    }
    const shipTypes = PlanModel.parseShipTypes(obj.ship_type);
    if (shipTypes) rule.ship_type = shipTypes;
    PlanModel.assignLevelRange(rule, obj);
    if (typeof obj.relaxed === 'boolean') rule.relaxed = obj.relaxed;
    return rule;
  }

  private static parseShipTypes(raw: unknown): string[] | undefined {
    const values = typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw)
        ? raw
        : [];
    const result = Array.from(new Set(
      values
        .filter(value => typeof value === 'string')
        .map(value => String(value).trim().toLowerCase())
        .filter(Boolean),
    ));
    return result.length > 0 ? result : undefined;
  }

  private static assignLevelRange(
    rule: {
      min_level?: number;
      max_level?: number;
    },
    raw: Record<string, unknown>,
  ): void {
    if (raw.min_level != null && Number.isFinite(Number(raw.min_level))) {
      rule.min_level = Math.max(1, Math.floor(Number(raw.min_level)));
    }
    if (raw.max_level != null && Number.isFinite(Number(raw.max_level))) {
      rule.max_level = Math.max(1, Math.floor(Number(raw.max_level)));
    }
  }

  private static normalizeRuleAction(actionRaw: unknown): EnemyRule[1] | null {
    if (typeof actionRaw === 'number' && Number.isFinite(actionRaw)) {
      const value = Math.trunc(actionRaw);
      return value >= 1 && value <= 5 ? (value as EnemyRule[1]) : null;
    }

    const raw = String(actionRaw ?? '').trim();
    if (!raw) return null;

    const aliases: Record<string, string> = {
      detour: 'detour',
      '迂回': 'detour',
      retreat: 'retreat',
      '撤退': 'retreat',
    };

    const lower = raw.toLowerCase();
    const normalized = aliases[lower] ?? aliases[raw] ?? raw;
    if (/^\d+$/.test(normalized)) {
      const value = Number(normalized);
      return value >= 1 && value <= 5 ? (value as EnemyRule[1]) : null;
    }
    return normalized === 'retreat' || normalized === 'detour'
      ? normalized
      : null;
  }

  private static normalizeEnemyRules(rules: unknown): EnemyRule[] | undefined {
    if (!Array.isArray(rules)) return undefined;
    const normalized: EnemyRule[] = [];

    for (const item of rules) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const expr = String(item[0] ?? '').trim();
      if (!expr) continue;
      const action = PlanModel.normalizeRuleAction(item[1]);
      if (action === null) continue;
      normalized.push([expr, action]);
    }

    return normalized.length > 0 ? normalized : undefined;
  }

  private static normalizeNodeArgs(args: NodeArgs | undefined): NodeArgs | undefined {
    if (!args) return undefined;
    const normalized = normalizeLegacyNodeDecisionFields(
      args as NodeArgs & Record<string, unknown>,
    );
    normalized.enemy_rules = PlanModel.normalizeEnemyRules(args.enemy_rules);
    normalized.enemy_formation_rules = PlanModel.normalizeEnemyRules(
      args.enemy_formation_rules,
    );
    return normalized;
  }

  private static normalizeNodeArgsMap(nodeArgs: Record<string, NodeArgs> | undefined): Record<string, NodeArgs> | undefined {
    if (!nodeArgs || typeof nodeArgs !== 'object') return undefined;
    const normalized: Record<string, NodeArgs> = {};
    for (const [nodeId, args] of Object.entries(nodeArgs)) {
      const node = PlanModel.normalizeNodeArgs(args);
      if (node) normalized[nodeId] = node;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }
}
