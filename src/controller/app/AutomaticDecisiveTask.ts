/** 分别从用户计划和系统预设构造自动决战请求。 */
import type { DecisiveReq } from '../../types/api.js';
import type {
  DecisivePlanSettings,
  ShipLibraryShip,
} from '../../types/ipc.js';
import type { TaskTemplate } from '../../types/model.js';
import { toBackendDecisiveShipNames } from '../../shared/shipNameNormalizer.js';

function buildRequest(
  chapterValue: unknown,
  useQuickRepair: boolean,
  names: Pick<
    DecisiveReq,
    'level1' | 'level2' | 'flagship_priority'
  >,
  ships: readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[] = [],
): DecisiveReq {
  const chapter = Math.trunc(Number(chapterValue));
  if (!Number.isFinite(chapter) || chapter < 1 || chapter > 6) {
    throw new Error(`决战章节无效: ${String(chapterValue)}`);
  }

  const {
    level1,
    level2,
    flagship_priority: flagshipPriority,
  } = toBackendDecisiveShipNames(names, ships);
  const request: DecisiveReq = {
    type: 'decisive',
    chapter,
    decisive_rounds: 1,
    use_quick_repair: useQuickRepair,
  };
  if (level1.length > 0) request.level1 = level1;
  if (level2.length > 0) request.level2 = level2;
  if (flagshipPriority.length > 0) {
    request.flagship_priority = flagshipPriority;
  }
  return request;
}

/** 使用计划页面当前保存的用户方案。 */
export function buildAutomaticDecisivePlanRequest(
  plan: DecisivePlanSettings,
  ships: readonly Pick<ShipLibraryShip, 'name' | 'search_name'>[] = [],
): DecisiveReq {
  return buildRequest(
    plan.chapter,
    plan.useQuickRepair,
    plan,
    ships,
  );
}

/** 使用只读内置模板，不混入用户方案。 */
export function buildAutomaticDecisivePresetRequest(
  template: TaskTemplate,
): DecisiveReq {
  if (template.type !== 'decisive') {
    throw new Error(`模板「${template.name}」不是决战模板`);
  }
  return buildRequest(
    template.chapter,
    template.use_quick_repair ?? true,
    template,
  );
}
