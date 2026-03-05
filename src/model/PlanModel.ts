/**
 * PlanModel —— 战斗方案(Plan)的 Model 层。
 * 负责从 YAML 文件解析战斗方案，并提供节点参数的查询与合并。
 */
import * as yaml from 'js-yaml';
import type { PlanData, NodeArgs } from './types';

export class PlanModel {
  readonly data: PlanData;
  readonly fileName: string;
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
      repair_mode: parsed.repair_mode != null ? Number(parsed.repair_mode) : undefined,
      node_defaults: parsed.node_defaults as NodeArgs | undefined,
      node_args: parsed.node_args as Record<string, NodeArgs> | undefined,
    };

    return new PlanModel(data, path, comment);
  }

  /** 地图名，如 "7-4" */
  get mapName(): string {
    return `${this.data.chapter}-${this.data.map}`;
  }

  /** 修理模式，默认 1 */
  get repairMode(): number {
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
}
