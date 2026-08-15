/**
 * GUI 管理模式使用的 Stable/Alpha AutoWSGR 后端来源。
 *
 * 打包版本从 resources/backend-distribution.json 读取不可变发行清单。
 * 开发环境使用与发行包相同的双通道固定提交。
 */
import * as fs from 'fs';
import * as path from 'path';

export type BackendDistributionId = 'alpha' | 'stable';

export interface BackendDistribution {
  id: BackendDistributionId;
  repository: string;
  ref: string;
  commit: string;
  forceUpdateOnInstall: boolean;
}

export interface BackendDistributionManifest {
  stable: BackendDistribution;
  alpha: BackendDistribution;
}

const DEFAULT_DISTRIBUTIONS: BackendDistributionManifest = {
  stable: {
    id: 'stable',
    repository: 'OpenWSGR/AutoWSGR',
    ref: 'main',
    commit: 'a5effbfc606794ec30fa8bfd2f8edd2cc15d3852',
    forceUpdateOnInstall: true,
  },
  alpha: {
    id: 'alpha',
    repository: 'ShiinaKuroko/AutoWSGR',
    ref: 'ShiinaKuroko',
    commit: '77f34b7b30d18f7b86cf736bdd5cf17ae35d5f78',
    forceUpdateOnInstall: true,
  },
};

/** 校验单个后端发行项，拒绝浮动或不完整来源。 */
function isBackendDistribution(
  value: unknown,
  id: BackendDistributionId,
): value is BackendDistribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    raw.id === id
    && typeof raw.repository === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository)
    && typeof raw.ref === 'string'
    && /^[A-Za-z0-9._/-]+$/.test(raw.ref)
    && typeof raw.commit === 'string'
    && /^[0-9a-f]{40}$/.test(raw.commit)
    && typeof raw.forceUpdateOnInstall === 'boolean'
  );
}

/** 校验打包器写入的双通道清单；正式包缺失或损坏时失败关闭。 */
function readBackendDistributions(): BackendDistributionManifest {
  const resourcesPath = process.resourcesPath;
  if (process.defaultApp || !resourcesPath) return DEFAULT_DISTRIBUTIONS;
  const manifestPath = path.join(
    resourcesPath,
    'backend-distribution.json',
  );
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (
      isBackendDistribution(raw.stable, 'stable')
      && isBackendDistribution(raw.alpha, 'alpha')
    ) {
      return raw as BackendDistributionManifest;
    }
  } catch (error) {
    throw new Error(
      `后端发行清单无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error('后端发行清单字段无效');
}

export const BACKEND_DISTRIBUTIONS = readBackendDistributions();

/** 使用与 GUI 更新通道相同的设置选择受管后端。 */
export function resolveBackendDistribution(
  allowTestUpdates: boolean,
): BackendDistribution {
  return allowTestUpdates
    ? BACKEND_DISTRIBUTIONS.alpha
    : BACKEND_DISTRIBUTIONS.stable;
}

/** 生成固定提交归档地址，禁止运行时跟随浮动分支。 */
export function buildManagedAutowsgrRequirement(
  distribution: BackendDistribution,
): string {
  return (
    `https://github.com/${distribution.repository}/archive/`
    + `${distribution.commit}.zip`
  );
}
