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
