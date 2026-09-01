/** 维护地图节点选择顺序并同步方案的选中节点。 */
/** 新建计划只开启后端节点追踪使用的起始节点。 */
export function initialSelectedNodesForNewPlan(): string[] {
  return ['0'];
}

/**
 * 将前端方案的 selected_nodes 规范化为后端可用格式。
 *
 * 当节点追踪尚未识别到字母节点时，后端会用 "0" 表示未知节点。
 * 若白名单不包含 "0"，会在索敌阶段被误判为不在白名单而撤退。
 */
export function normalizeSelectedNodesForBackend(selectedNodes: string[] | undefined): string[] {
  if (!Array.isArray(selectedNodes) || selectedNodes.length === 0) return [];

  const normalized = Array.from(
    new Set(
      selectedNodes
        .map((node) => String(node).trim().toUpperCase())
        .filter((node) => node.length > 0),
    ),
  );

  if (!normalized.includes('0')) {
    normalized.push('0');
  }

  return normalized;
}

/** 阻止尚未选择实际路线的计划进入战斗队列。 */
export function assertPlanRouteReadyForExecution(
  selectedNodes: readonly string[],
): void {
  if (selectedNodes.length === 1 && selectedNodes[0] === '0') {
    throw new Error('出征计划只启用了起始节点，请至少开启一个路线节点');
  }
}
