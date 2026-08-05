/** 渲染编队方案卡片并实现搜索、筛选和排序。 */
import type { TeamPlanViewObject } from '../../types/view.js';

export type TeamPlanSortField = 'name' | 'modifiedAt';
type TeamPlanSourceViewObject = TeamPlanViewObject['source'];
export type TeamPlanCardSource = TeamPlanSourceViewObject | 'deleted';

export interface TeamPlanListItem {
  name: string;
  source?: TeamPlanSourceViewObject;
  modifiedAt?: number;
  ships: ReadonlyArray<{
    name?: string;
    primary?: unknown;
    candidates?: ReadonlyArray<unknown>;
  }>;
}

export interface TeamPlanCardData {
  name: string;
  source: TeamPlanCardSource;
  primaryCount: number;
  backupCount: number;
  modifiedAt?: number;
}

interface TeamPlanListOptions {
  search: string;
  filterSystem: boolean;
  sortField: TeamPlanSortField;
  ascending: boolean;
}

/** 将名称转换为列表搜索使用的统一格式。 */
export function normalizeTeamPlanSearch(value: string): string {
  return value
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s·•._-]+/g, '');
}

/** 保留原数组索引，避免筛选后点击到错误的编队。 */
export function filterAndSortTeamPlans<T extends TeamPlanListItem>(
  plans: readonly T[],
  options: TeamPlanListOptions,
): Array<{ plan: T; index: number }> {
  const search = normalizeTeamPlanSearch(options.search);
  return plans
    .map((plan, index) => ({ plan, index }))
    .filter(({ plan }) => (
      (!options.filterSystem || plan.source !== 'system')
      && (
        !search
        || normalizeTeamPlanSearch(plan.name).includes(search)
      )
    ))
    .sort((left, right) => compareTeamPlans(
      left.plan,
      right.plan,
      options.sortField,
      options.ascending,
    ));
}

export function compareTeamPlans(
  left: TeamPlanListItem,
  right: TeamPlanListItem,
  sortField: TeamPlanSortField,
  ascending: boolean,
): number {
  let difference = 0;
  if (sortField === 'name') {
    difference = left.name.localeCompare(right.name, 'zh-CN');
  } else {
    difference = (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0);
    if (difference === 0) {
      difference = left.name.localeCompare(right.name, 'zh-CN');
    }
  }
  return ascending ? difference : -difference;
}

export function teamPlanCardData(
  plan: TeamPlanListItem,
): TeamPlanCardData {
  return {
    name: plan.name,
    source: plan.source ?? 'user',
    primaryCount: plan.ships.filter(
      slot => Boolean(slot.primary ?? slot.name),
    ).length,
    backupCount: plan.ships.reduce(
      (count, slot) => count + (slot.candidates?.length ?? 0),
      0,
    ),
    modifiedAt: plan.modifiedAt,
  };
}

function formatModifiedDate(modifiedAt: number | undefined): string {
  if (modifiedAt === undefined || !Number.isFinite(modifiedAt)) return '';
  const date = new Date(modifiedAt);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 两处编队列表共用同一套名称、来源和数量结构。 */
export function appendTeamPlanCardContent(
  target: HTMLElement,
  data: TeamPlanCardData,
): void {
  const heading = document.createElement('div');
  heading.className = 'fleet-team-loader-item-heading';

  const name = document.createElement('strong');
  name.textContent = data.name;

  const badge = document.createElement('span');
  badge.className = `fleet-team-source-badge ${data.source}`;
  badge.textContent = data.source === 'system'
    ? '系统预设'
    : data.source === 'user'
      ? '用户预设'
      : '已删除';
  heading.append(name, badge);

  const summary = document.createElement('span');
  summary.className = 'fleet-team-meta';
  summary.textContent =
    `${data.primaryCount} 艘主选 · ${data.backupCount} 艘备选`;

  const details = document.createElement('div');
  details.className = 'fleet-team-card-details';
  details.append(summary);

  const modifiedDate = formatModifiedDate(data.modifiedAt);
  if (modifiedDate) {
    const time = document.createElement('time');
    time.className = 'fleet-team-card-modified';
    time.dateTime = modifiedDate;
    time.textContent = modifiedDate;
    time.title = `最后修改：${modifiedDate}`;
    details.append(time);
  }
  target.append(heading, details);
}
