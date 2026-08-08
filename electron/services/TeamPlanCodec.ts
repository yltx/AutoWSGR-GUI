/**
 * 归一化、校验并序列化独立编队计划。
 */
import * as yaml from 'js-yaml';

import { normalizeFleetShipTypeCode } from '../../src/shared/fleetShipTypes';

export type PlanPresetSource = 'system' | 'user';

export interface PlanFileReadError {
  file: string;
  source: PlanPresetSource;
  kind: 'battle' | 'team';
  message: string;
}

export interface UserTeamShipRule {
  name: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  relaxed?: boolean;
}

export interface UserTeamPlanSlot {
  name?: string;
  search_name?: string;
  ship_type?: string[];
  min_level?: number;
  max_level?: number;
  relaxed?: boolean;
  candidates?: UserTeamShipRule[];
}

export interface UserTeamPlan {
  file?: string;
  modifiedAt?: number;
  source?: PlanPresetSource;
  name: string;
  ships: UserTeamPlanSlot[];
}

/** 受管编队文件必须使用的既有命名规则。 */
export const TEAM_FILE_PATTERN = /^team[-_][^\\/]+\.ya?ml$/i;

/** 负责独立编队计划的归一化、序列化和文件名生成。 */
export class TeamPlanCodec {
  /** 校验并归一化一份独立编队计划。 */
  normalize(raw: unknown): UserTeamPlan {
    if (!this.isPlainObject(raw)) {
      throw new Error('编队 YAML 根节点必须是对象');
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error('name 不能为空');
    }
    if (
      !Array.isArray(raw.ships)
      || raw.ships.length < 1
      || raw.ships.length > 6
    ) {
      throw new Error('ships 必须包含 1 到 6 个位置');
    }
    if (raw.fleet_id !== undefined && (
      !Number.isInteger(raw.fleet_id)
      || Number(raw.fleet_id) < 1
      || Number(raw.fleet_id) > 4
    )) {
      throw new Error('旧版 fleet_id 必须是 1 到 4');
    }
    const ships = raw.ships
      .map(value => this.normalizeSlot(value))
      .filter((slot): slot is UserTeamPlanSlot => slot !== null);
    if (ships.length === 0) {
      throw new Error('ships 至少需要一个有效位置');
    }
    return { ...raw, name: raw.name.trim(), ships };
  }

  /** 序列化编队计划并保留未知业务字段。 */
  serialize(plan: UserTeamPlan): string {
    const output: Record<string, unknown> = {
      ...plan,
      name: plan.name,
      ships: plan.ships,
    };
    delete output.file;
    delete output.modifiedAt;
    delete output.source;
    const lines = [
      ...Object.entries(output)
        .filter(([key]) => key !== 'ships')
        .map(([key, value]) => `${key}: ${this.inlineYaml(value)}`),
      'ships:',
    ];
    for (const slot of plan.ships) {
      const candidateOnly = slot.name === undefined;
      const knownSlotKeys = new Set([
        'name',
        'search_name',
        'ship_type',
        'min_level',
        'max_level',
        'relaxed',
        'candidates',
        'priority',
      ]);
      const extraEntries = Object.entries(slot)
        .filter(
          ([key, value]) => (
            !knownSlotKeys.has(key) && value !== undefined
          ),
        );
      const anonymousEntries = Object.entries(
        this.serializableAnonymousSlot(slot),
      );
      if (slot.name !== undefined) {
        lines.push(`  - name: ${this.inlineYaml(slot.name)}`);
        if (slot.search_name !== undefined) {
          lines.push(
            `    search_name: ${this.inlineYaml(slot.search_name)}`,
          );
        }
        if (slot.ship_type !== undefined) {
          lines.push(
            `    ship_type: ${this.inlineYaml(slot.ship_type)}`,
          );
        }
        if (slot.min_level !== undefined) {
          lines.push(`    min_level: ${slot.min_level}`);
        }
        if (slot.max_level !== undefined) {
          lines.push(`    max_level: ${slot.max_level}`);
        }
        if (slot.relaxed === true) {
          lines.push('    relaxed: true');
        }
      }
      if (candidateOnly && anonymousEntries.length > 0) {
        const [first, ...rest] = anonymousEntries;
        lines.push(`  - ${first[0]}: ${this.inlineYaml(first[1])}`);
        for (const [key, value] of rest) {
          lines.push(`    ${key}: ${this.inlineYaml(value)}`);
        }
      } else if (!candidateOnly) {
        for (const [key, value] of extraEntries) {
          lines.push(`    ${key}: ${this.inlineYaml(value)}`);
        }
      }
      if (slot.candidates?.length) {
        lines.push(
          candidateOnly && anonymousEntries.length === 0
            ? '  - candidates:'
            : '    candidates:',
        );
        for (const candidate of slot.candidates) {
          lines.push(
            `      - ${this.inlineYaml(this.serializableShipRule(candidate))}`,
          );
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /** 把编队名称转换为既有 team-*.yaml 文件名。 */
  fileName(name: string): string {
    const safeName = name
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 80);
    if (!safeName) {
      throw new Error('编队预设名称不能用于文件名');
    }
    return `team-${safeName}.yaml`;
  }

  /** 校验单个位置；位置必须至少包含一艘主选或备选。 */
  private normalizeSlot(raw: unknown): UserTeamPlanSlot | null {
    if (raw === null) return null;
    if (typeof raw === 'string') {
      const name = raw.trim();
      if (!name) throw new Error('ships 中的舰名不能为空');
      return { name };
    }
    if (!this.isPlainObject(raw)) {
      throw new Error('ships 中的槽位必须是对象');
    }

    if (raw.candidates !== undefined && !Array.isArray(raw.candidates)) {
      throw new Error('candidates 必须是列表');
    }
    if (raw.priority !== undefined && !Array.isArray(raw.priority)) {
      throw new Error('旧版 priority 必须是列表');
    }
    const rawCandidates = (
      raw.candidates ?? raw.priority
    ) as unknown[] | undefined;
    const primaryRaw: Record<string, unknown> | null = (
      typeof raw.name === 'string' && raw.name.trim()
    )
      ? raw
      : null;
    const candidatesRaw = rawCandidates ?? [];
    const candidateOnlyWithLegacyNames = (
      primaryRaw === null
      && candidatesRaw.some(value => typeof value === 'string')
    );

    const candidates = candidatesRaw.map((candidate, index) => {
      if (typeof candidate === 'string') {
        const name = candidate.trim();
        if (!name) {
          throw new Error(`candidates[${index}] 舰名不能为空`);
        }
        return this.legacyCandidateRule(name, raw);
      }
      return this.normalizeShipRule(
        candidate,
        `candidates[${index}]`,
      );
    });

    if (primaryRaw === null) {
      const hasAnonymousFilter = (
        raw.ship_type !== undefined
        || raw.nation !== undefined
        || raw.min_level !== undefined
        || raw.max_level !== undefined
      );
      if (
        raw.search_name !== undefined
        && !candidateOnlyWithLegacyNames
      ) {
        throw new Error('没有主选 name 时不能填写 search_name');
      }
      if (!hasAnonymousFilter && candidates.length === 0) {
        throw new Error('位置至少需要一艘主选或备选舰船');
      }
      const shipTypes = this.normalizeShipTypes(
        raw.ship_type,
        '无固定舰名位置.ship_type',
      );
      const minLevel = this.positiveInteger(
        raw.min_level,
        '无固定舰名位置.min_level',
      );
      const maxLevel = this.positiveInteger(
        raw.max_level,
        '无固定舰名位置.max_level',
      );
      const relaxed = this.optionalBoolean(
        raw.relaxed,
        '无固定舰名位置.relaxed',
      );
      if (
        minLevel !== undefined
        && maxLevel !== undefined
        && maxLevel < minLevel
      ) {
        throw new Error(
          '无固定舰名位置.max_level 必须大于或等于 min_level',
        );
      }
      const {
        priority: _legacyPriority,
        search_name: _legacySearchName,
        ...candidateOnlyFields
      } = candidateOnlyWithLegacyNames ? raw : {
        ...raw,
        priority: undefined,
      };
      return {
        ...candidateOnlyFields,
        ...(shipTypes === undefined ? {} : { ship_type: shipTypes }),
        ...(minLevel === undefined ? {} : { min_level: minLevel }),
        ...(maxLevel === undefined ? {} : { max_level: maxLevel }),
        ...(relaxed === undefined ? {} : { relaxed }),
        candidates,
      };
    }

    const {
      candidates: _ignoredCandidates,
      priority: _ignoredPriority,
      ...primaryFields
    } = primaryRaw;
    const result: UserTeamPlanSlot = {
      ...raw,
      ...this.normalizeShipRule(primaryFields, '主选'),
    };
    if (candidates.length > 0) {
      result.candidates = candidates;
    }
    return result;
  }

  /** 校验一艘主选或备选舰船自己的规则。 */
  private normalizeShipRule(
    raw: unknown,
    field: string,
  ): UserTeamShipRule {
    if (!this.isPlainObject(raw)) {
      throw new Error(`${field} 必须是对象`);
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error(`${field}.name 必须是非空字符串`);
    }
    const result: UserTeamShipRule = {
      ...raw,
      name: raw.name.trim(),
    };
    if (raw.search_name !== undefined) {
      if (
        typeof raw.search_name !== 'string'
        || !raw.search_name.trim()
      ) {
        throw new Error(`${field}.search_name 必须是非空字符串`);
      }
      result.search_name = raw.search_name.trim();
    }
    const shipTypes = this.normalizeShipTypes(
      raw.ship_type,
      `${field}.ship_type`,
    );
    if (shipTypes) result.ship_type = shipTypes;
    const minLevel = this.positiveInteger(
      raw.min_level,
      `${field}.min_level`,
    );
    const maxLevel = this.positiveInteger(
      raw.max_level,
      `${field}.max_level`,
    );
    const relaxed = this.optionalBoolean(raw.relaxed, `${field}.relaxed`);
    if (minLevel !== undefined) result.min_level = minLevel;
    if (maxLevel !== undefined) result.max_level = maxLevel;
    if (relaxed !== undefined) result.relaxed = relaxed;
    if (
      minLevel !== undefined
      && maxLevel !== undefined
      && maxLevel < minLevel
    ) {
      throw new Error(
        `${field}.max_level 必须大于或等于 min_level`,
      );
    }
    return result;
  }

  /** 旧字符串候选继承原槽位的舰种和等级限制。 */
  private legacyCandidateRule(
    name: string,
    raw: Record<string, unknown>,
  ): UserTeamShipRule {
    return this.normalizeShipRule({
      name,
      search_name: raw.search_name,
      ship_type: raw.ship_type,
      min_level: raw.min_level,
      max_level: raw.max_level,
    }, `旧版候选 ${name}`);
  }

  private normalizeShipTypes(
    raw: unknown,
    field: string,
  ): string[] | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const values = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`${field} 必须是非空字符串列表`);
    }
    const result = values.map(value => {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} 必须是非空字符串列表`);
      }
      const input = value.trim().toLowerCase();
      const shipType = normalizeFleetShipTypeCode(input);
      if (!shipType) {
        throw new Error(`${field} 不符合后端接口: ${input}`);
      }
      return shipType;
    });
    return [...new Set(result)];
  }

  private positiveInteger(
    value: unknown,
    field: string,
  ): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (!Number.isInteger(value) || Number(value) < 1) {
      throw new Error(`${field} 必须是大于或等于 1 的整数`);
    }
    return Number(value);
  }

  private optionalBoolean(
    value: unknown,
    field: string,
  ): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      throw new Error(`${field} 必须是布尔值`);
    }
    return value;
  }

  /** 固定舰船规则字段顺序；false 使用后端缺省值，不写入 YAML。 */
  private serializableShipRule(
    rule: UserTeamShipRule,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { name: rule.name };
    if (rule.search_name !== undefined) result.search_name = rule.search_name;
    if (rule.ship_type !== undefined) result.ship_type = rule.ship_type;
    if (rule.min_level !== undefined) result.min_level = rule.min_level;
    if (rule.max_level !== undefined) result.max_level = rule.max_level;
    if (rule.relaxed === true) result.relaxed = true;
    const knownKeys = new Set([
      'name',
      'search_name',
      'ship_type',
      'min_level',
      'max_level',
      'relaxed',
    ]);
    for (const [key, value] of Object.entries(rule)) {
      if (!knownKeys.has(key) && value !== undefined) result[key] = value;
    }
    return result;
  }

  /** 无主选位置同样使用固定字段顺序，但不继承候选规则。 */
  private serializableAnonymousSlot(
    slot: UserTeamPlanSlot,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (slot.search_name !== undefined) result.search_name = slot.search_name;
    if (slot.ship_type !== undefined) result.ship_type = slot.ship_type;
    if (slot.min_level !== undefined) result.min_level = slot.min_level;
    if (slot.max_level !== undefined) result.max_level = slot.max_level;
    if (slot.relaxed === true) result.relaxed = true;
    const knownKeys = new Set([
      'name',
      'search_name',
      'ship_type',
      'min_level',
      'max_level',
      'relaxed',
      'candidates',
      'priority',
    ]);
    for (const [key, value] of Object.entries(slot)) {
      if (!knownKeys.has(key) && value !== undefined) result[key] = value;
    }
    return result;
  }

  private inlineYaml(value: unknown): string {
    return yaml.dump(value, {
      flowLevel: 0,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    }).trim();
  }

  private isPlainObject(
    value: unknown,
  ): value is Record<string, unknown> {
    return Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value);
  }
}
