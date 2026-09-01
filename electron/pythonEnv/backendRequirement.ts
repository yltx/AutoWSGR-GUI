/**
 * GUI 管理模式使用的 AutoWSGR 后端来源。
 *
 * 打包版本从 resources/backend-distribution.json 读取不可变发行清单。
 * 开发环境默认与发行清单保持同一 OpenWSGR 仓库目标和固定提交。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface BackendDistribution {
  id: 'stable';
  repository: string;
  ref: string;
  commit: string;
  forceUpdateOnInstall: boolean;
}

const DEFAULT_DISTRIBUTION: BackendDistribution = {
  id: 'stable',
  repository: 'OpenWSGR/AutoWSGR',
  ref: 'main',
  commit: 'b9cfa72e4be10418b5f21e9f68388505a6515925',
  forceUpdateOnInstall: true,
};

/** 校验打包器写入的后端发行清单；正式包缺失或损坏时失败关闭。 */
function readBackendDistribution(): BackendDistribution {
  const resourcesPath = process.resourcesPath;
  if (process.defaultApp || !resourcesPath) return DEFAULT_DISTRIBUTION;
  const manifestPath = path.join(
    resourcesPath,
    'backend-distribution.json',
  );
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (
      raw.id === 'stable'
      && typeof raw.repository === 'string'
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository)
      && typeof raw.ref === 'string'
      && /^[A-Za-z0-9._/-]+$/.test(raw.ref)
      && typeof raw.commit === 'string'
      && /^[0-9a-f]{40}$/.test(raw.commit)
      && typeof raw.forceUpdateOnInstall === 'boolean'
    ) {
      return raw as BackendDistribution;
    }
  } catch (error) {
    throw new Error(
      `后端发行清单无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error('后端发行清单字段无效');
}

export const BACKEND_DISTRIBUTION = readBackendDistribution();
export const MANAGED_AUTOWSGR_COMMIT = BACKEND_DISTRIBUTION.commit;
export const MANAGED_AUTOWSGR_REQUIREMENT = (
  `https://github.com/${BACKEND_DISTRIBUTION.repository}/archive/`
  + `${MANAGED_AUTOWSGR_COMMIT}.zip`
);
export const FORCE_MANAGED_AUTOWSGR_UPDATE_ON_INSTALL = (
  BACKEND_DISTRIBUTION.forceUpdateOnInstall
);
