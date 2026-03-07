/**
 * PlanModel —— 战斗方案(Plan)的 Model 层。
 * 负责从 YAML 文件解析战斗方案，并提供节点参数的查询与合并。
 */
import * as yaml from 'js-yaml';
import type { PlanData, NodeArgs } from './types';

export class PlanModel {
  data: PlanData;
  fileName: string;
  readonly comment: string;

  private constructor(data: PlanData, fileName: string, comment: string) {
    this.data = data;
    this.fileName = fileName;
    this.comment = comment;
  }

  /** 从 YAML 字符串 + 文件路径创建 PlanModel */
  static fromYaml(content: string, path: string): PlanModel {
    const comment = PlanModel.extractComment(content);
    const parsed = yaml.load(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('无效的方案文件');
    }

    const data: PlanData = {
      chapter: Number(parsed.chapter) || 0,
      map: Number(parsed.map) || 0,
      selected_nodes: Array.isArray(parsed.selected_nodes)
        ? parsed.selected_nodes.map(String)
        : [],
      fight_condition: parsed.fight_condition != null ? Number(parsed.fight_condition) : undefined,
      repair_mode: parsed.repair_mode != null
        ? (Array.isArray(parsed.repair_mode)
          ? (parsed.repair_mode as number[]).map(Number)
          : Number(parsed.repair_mode))
        : undefined,
      fleet_id: parsed.fleet_id != null ? Number(parsed.fleet_id) : undefined,
      node_defaults: parsed.node_defaults as NodeArgs | undefined,
      node_args: parsed.node_args as Record<string, NodeArgs> | undefined,
      // 任务级字段
      times: parsed.times != null ? Number(parsed.times) : undefined,
      gap: parsed.gap != null ? Number(parsed.gap) : undefined,
      stop_condition: parsed.stop_condition as PlanData['stop_condition'],
      scheduled_time: typeof parsed.scheduled_time === 'string' ? parsed.scheduled_time : undefined,
    };

    return new PlanModel(data, path, comment);
  }

  /** 地图名，如 "7-4" 或 "Ex-3" */
  get mapName(): string {
    if (this.data.chapter === 99) return `Ex-${this.data.map}`;
    return `${this.data.chapter}-${this.data.map}`;
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
    return { ...defaults, ...overrides };
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
  static create(chapter: number, map: number, selectedNodes: string[]): PlanModel {
    const data: PlanData = {
      chapter,
      map,
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
    const obj: Record<string, unknown> = {
      chapter: this.data.chapter,
      map: this.data.map,
      selected_nodes: this.data.selected_nodes,
    };

    if (this.data.fleet_id != null) obj.fleet_id = this.data.fleet_id;
    if (this.data.fight_condition != null) obj.fight_condition = this.data.fight_condition;
    if (this.data.repair_mode != null) obj.repair_mode = this.data.repair_mode;

    if (this.data.node_defaults && Object.keys(this.data.node_defaults).length > 0) {
      obj.node_defaults = this.cleanNodeArgs(this.data.node_defaults);
    }

    if (this.data.node_args) {
      const cleaned: Record<string, unknown> = {};
      for (const [nodeId, args] of Object.entries(this.data.node_args)) {
        const c = this.cleanNodeArgs(args);
        if (Object.keys(c).length > 0) cleaned[nodeId] = c;
      }
      if (Object.keys(cleaned).length > 0) obj.node_args = cleaned;
    }

    // 任务级字段 (仅导出已设置的)
    if (this.data.times != null) obj.times = this.data.times;
    if (this.data.gap != null) obj.gap = this.data.gap;
    if (this.data.stop_condition != null) obj.stop_condition = this.data.stop_condition;
    if (this.data.scheduled_time) obj.scheduled_time = this.data.scheduled_time;

    let result = '';
    if (this.comment) {
      result = this.comment.split('\n').map(l => `# ${l}`).join('\n') + '\n';
    }
    result += yaml.dump(obj, { lineWidth: -1, noRefs: true, sortKeys: false });
    return result;
  }

  /** 清理节点参数：移除 undefined 值 */
  private cleanNodeArgs(args: NodeArgs): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (args.formation != null) out.formation = args.formation;
    if (args.night != null) out.night = args.night;
    if (args.proceed != null) out.proceed = args.proceed;
    if (args.SL_when_detour_fails != null) out.SL_when_detour_fails = args.SL_when_detour_fails;
    if (args.enemy_rules && args.enemy_rules.length > 0) out.enemy_rules = args.enemy_rules;
    if (args.proceed_stop) out.proceed_stop = args.proceed_stop;
    return out;
  }
}
