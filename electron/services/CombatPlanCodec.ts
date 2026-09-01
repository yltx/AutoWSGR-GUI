/**
 * 校验、拆分、展开并序列化出征计划。
 */
import {
  normalizeLegacyNodeDecisionFields,
} from '../../src/shared/nodeDecision';
import {
  parseYaml,
  serializePlanYaml,
} from '../../src/shared/yamlSerializer';
import {
  type PlanPresetSource,
  TeamPlanCodec,
  type UserTeamPlan,
} from './TeamPlanCodec';
import { TeamPlanRepository } from './TeamPlanRepository';

export interface SplitCombatPlan {
  mapRoot: Record<string, unknown>;
  teams: UserTeamPlan[];
}

/** 负责出征计划的拆分、展开、序列化和名称清理。 */
export class CombatPlanCodec {
  constructor(
    private readonly teamCodec: TeamPlanCodec,
    private readonly teamRepository: TeamPlanRepository,
  ) {}

  /** 判断未知值是否为可读取的普通对象。 */
  isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value);
  }

  /** 解析 YAML，并使用调用方指定的既有错误文本校验根对象。 */
  parseRoot(
    content: string,
    invalidRootMessage: string,
  ): Record<string, unknown> {
    const parsed = parseYaml(content);
    if (!this.isPlainObject(parsed)) {
      throw new Error(invalidRootMessage);
    }
    return parsed;
  }

  /** 序列化计划并保留原文件开头的注释。 */
  serialize(
    root: Record<string, unknown>,
    originalContent = '',
  ): string {
    const leadingComments: string[] = [];
    for (const line of originalContent.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#') || trimmed === '') {
        leadingComments.push(line);
        continue;
      }
      break;
    }
    const prefix = leadingComments.some(
      line => line.trimStart().startsWith('#'),
    )
      ? `${leadingComments.join('\n').replace(/\s+$/, '')}\n`
      : '';
    return `${prefix}${serializePlanYaml(root)}`;
  }

  /** 把内嵌舰队拆成独立编队，并在地图中只保留名称引用。 */
  normalizeFleetPresets(
    root: Record<string, unknown>,
    source: PlanPresetSource,
    requireEmbeddedShips: boolean,
    allowMissingReferences = false,
  ): SplitCombatPlan {
    this.requireMapCoordinates(root);
    const normalizedRoot = structuredClone(root);
    if (this.isPlainObject(normalizedRoot.node_args)) {
      for (const [nodeId, node] of Object.entries(normalizedRoot.node_args)) {
        if (!this.isPlainObject(node)) continue;
        normalizedRoot.node_args[nodeId] =
          normalizeLegacyNodeDecisionFields(node);
      }
    }
    if (normalizedRoot.fleet_presets === undefined) {
      return {
        mapRoot: normalizedRoot,
        teams: [],
      };
    }
    if (!Array.isArray(normalizedRoot.fleet_presets)) {
      throw new Error('fleet_presets 必须是列表');
    }

    const names = new Set<string>();
    const teams: UserTeamPlan[] = [];
    const references = normalizedRoot.fleet_presets.map((rawPreset, index) => {
      if (!this.isPlainObject(rawPreset)) {
        throw new Error(`fleet_presets[${index}] 必须是对象`);
      }
      const name = typeof rawPreset.name === 'string'
        ? rawPreset.name.trim()
        : '';
      if (!name) {
        throw new Error(`fleet_presets[${index}].name 不能为空`);
      }
      if (names.has(name)) {
        throw new Error(`fleet_presets 中存在重复舰队名称：${name}`);
      }
      names.add(name);

      if (Array.isArray(rawPreset.ships)) {
        teams.push(this.teamCodec.normalize({
          name,
          ships: rawPreset.ships,
        }));
      } else {
        if (requireEmbeddedShips) {
          throw new Error(`旧计划中的舰队「${name}」缺少 ships`);
        }
        if (
          !allowMissingReferences
          && !this.teamRepository.find(name, source)
        ) {
          throw new Error(`找不到舰队「${name}」的独立配置`);
        }
      }
      return { name };
    });

    return {
      mapRoot: {
        ...normalizedRoot,
        fleet_presets: references,
      },
      teams,
    };
  }

  /** 拆分旧计划，并让其中缺少校验模式的内嵌舰队默认使用弱校验。 */
  normalizeLegacyFleetPresets(
    root: Record<string, unknown>,
    source: PlanPresetSource,
    requireEmbeddedShips: boolean,
  ): SplitCombatPlan {
    const split = this.normalizeFleetPresets(
      root,
      source,
      requireEmbeddedShips,
    );
    return {
      ...split,
      teams: split.teams.map(team => this.teamCodec.normalizeLegacy(team)),
    };
  }

  /** 为后端执行展开舰队引用，并保留引用对象的未知字段。 */
  expandRoot(
    root: Record<string, unknown>,
    source: PlanPresetSource,
  ): Record<string, unknown> {
    this.requireMapCoordinates(root);
    if (root.fleet_presets === undefined) {
      return structuredClone(root);
    }
    if (!Array.isArray(root.fleet_presets)) {
      throw new Error('fleet_presets 必须是列表');
    }

    const listedTeams = this.teamRepository.list().plans;
    const presets = root.fleet_presets.map((rawPreset, index) => {
      if (!this.isPlainObject(rawPreset)) {
        throw new Error(`fleet_presets[${index}] 必须是对象`);
      }
      const name = typeof rawPreset.name === 'string'
        ? rawPreset.name.trim()
        : '';
      if (!name) {
        throw new Error(`fleet_presets[${index}].name 不能为空`);
      }

      const userOverride = listedTeams.find(team => (
        team.name === name && team.source === 'user'
      )) ?? null;
      const sameSourceTeam = listedTeams.find(team => (
        team.name === name && team.source === source
      )) ?? null;
      const embeddedTeam = Array.isArray(rawPreset.ships)
        ? this.teamCodec.normalize({
          name,
          ships: rawPreset.ships,
        })
        : null;
      const team = userOverride
        ?? sameSourceTeam
        ?? embeddedTeam
        ?? this.teamRepository.find(name, source, listedTeams);
      if (!team) {
        throw new Error(`地图引用的舰队「${name}」不存在`);
      }
      return {
        ...structuredClone(rawPreset),
        name,
        ships: structuredClone(team.ships),
      };
    });

    return {
      ...structuredClone(root),
      fleet_presets: presets,
    };
  }

  /** 清理出征计划名称，生成既有 bettle- 文件名前的名称部分。 */
  safeBaseName(value: string): string {
    return value
      .trim()
      .replace(/\.ya?ml$/i, '')
      .replace(/^bettle-/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 100);
  }

  /** 校验后端执行计划必须包含的地图坐标。 */
  private requireMapCoordinates(root: Record<string, unknown>): void {
    if (!('chapter' in root) || !('map' in root)) {
      throw new Error('出征计划必须包含 chapter 和 map');
    }
  }
}
