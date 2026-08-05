/**
 * GUI 管理模式使用的 AutoWSGR 后端来源。
 *
 * 打包版本从 resources/backend-distribution.json 读取不可变发行清单。
 * 开发环境默认使用个人 ShiinaKuroko 分支对应的已验证提交。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface BackendDistribution {
  id: 'personal' | 'public';
  repository: string;
  ref: string;
  commit: string;
  forceUpdateOnInstall: boolean;
}

const DEFAULT_DISTRIBUTION: BackendDistribution = {
  id: 'personal',
  repository: 'ShiinaKuroko/AutoWSGR',
  ref: 'ShiinaKuroko',
  commit: '32b5cb2cb4cc20f4c1255a8d42784aaf24e1f432',
  forceUpdateOnInstall: true,
};

/** 校验打包器写入的后端发行清单，损坏时回退到开发默认值。 */
function readBackendDistribution(): BackendDistribution {
  const resourcesPath = process.resourcesPath;
  if (!resourcesPath) return DEFAULT_DISTRIBUTION;
  const manifestPath = path.join(
    resourcesPath,
    'backend-distribution.json',
  );
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (
      (raw.id === 'personal' || raw.id === 'public')
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
  } catch {
    // 开发模式和旧包没有发行清单，继续使用已验证默认值。
  }
  return DEFAULT_DISTRIBUTION;
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
