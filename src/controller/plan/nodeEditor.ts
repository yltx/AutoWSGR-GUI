/**
 * nodeEditor —— 节点编辑面板值保存逻辑。
 */
import type { PlanPreviewView } from '../../view/plan/PlanPreviewView';
import type { PlanModel } from '../../model/PlanModel';
import type { EnemyRule } from '../../types/model';
import { Logger } from '../../utils/Logger';

function normalizeRuleAction(actionRaw: string): string | number {
  const trimmed = actionRaw.trim();
  if (!trimmed) return trimmed;

  const aliases: Record<string, string> = {
    detour: 'detour',
    '迂回': 'detour',
    retreat: 'retreat',
    '撤退': 'retreat',
  };

  const lower = trimmed.toLowerCase();
  const normalized = aliases[lower] ?? aliases[trimmed] ?? trimmed;
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }
  return normalized;
}

function parseRuleLine(rawLine: string): EnemyRule | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  let expr = '';
  let action = '';

  const arrowMatch = trimmed.match(/^(.*?)\s*(?:=>|->)\s*(.+)$/);
  if (arrowMatch) {
    expr = arrowMatch[1].trim();
    action = arrowMatch[2].trim();
  } else {
    const commaIdx = Math.max(trimmed.lastIndexOf(','), trimmed.lastIndexOf('，'));
    if (commaIdx < 0) return null;
    expr = trimmed.slice(0, commaIdx).trim();
    action = trimmed.slice(commaIdx + 1).trim();
  }

  if (!expr || !action) return null;
  return [expr, normalizeRuleAction(action)];
}

/**
 * 从节点编辑面板收集值并写回 PlanModel，然后即时保存到文件。
 * 返回 true 表示成功执行。
 */
export function saveNodeEditorValues(
  planView: PlanPreviewView,
  currentPlan: PlanModel | null,
  editingNodeId: string | null,
): boolean {
  if (!currentPlan || !editingNodeId) return false;

  const vals = planView.collectNodeEditorValues();
  const selectedNodes = currentPlan.data.selected_nodes;
  const selectedIndex = selectedNodes.indexOf(editingNodeId);

  // 支持在编辑面板中直接启用/关闭节点。
  if (!vals.enabled) {
    if (selectedIndex >= 0) {
      selectedNodes.splice(selectedIndex, 1);
    }
    if (currentPlan.data.node_args && editingNodeId in currentPlan.data.node_args) {
      delete currentPlan.data.node_args[editingNodeId];
      if (Object.keys(currentPlan.data.node_args).length === 0) {
        currentPlan.data.node_args = undefined;
      }
    }

    if (currentPlan.fileName) {
      const bridge = window.electronBridge;
      bridge?.saveFile(currentPlan.fileName, currentPlan.toYaml());
    }

    planView.hideNodeEditor();
    return true;
  }

  if (selectedIndex < 0) {
    selectedNodes.push(editingNodeId);
  }

  // 终点节点管理
  if (!currentPlan.data.endpoint_nodes) {
    currentPlan.data.endpoint_nodes = [];
  }
  const epIndex = currentPlan.data.endpoint_nodes.indexOf(editingNodeId);
  if (vals.isEndpoint && epIndex < 0) {
    currentPlan.data.endpoint_nodes.push(editingNodeId);
  } else if (!vals.isEndpoint && epIndex >= 0) {
    currentPlan.data.endpoint_nodes.splice(epIndex, 1);
  }
  if (currentPlan.data.endpoint_nodes.length === 0) {
    currentPlan.data.endpoint_nodes = undefined;
  }

  // 解析索敌规则文本
  const rules: EnemyRule[] = [];
  const invalidRuleLines: string[] = [];
  for (const line of vals.rulesText.split('\n')) {
    const parsed = parseRuleLine(line);
    if (!parsed) {
      const raw = line.trim();
      if (raw.length > 0 && !raw.startsWith('#')) invalidRuleLines.push(raw);
      continue;
    }
    rules.push(parsed);
  }

  if (invalidRuleLines.length > 0) {
    const sample = invalidRuleLines.slice(0, 3).join(' | ');
    Logger.warn(`节点 ${editingNodeId} 有 ${invalidRuleLines.length} 条索敌规则格式无效，已忽略（示例: ${sample}）`);
  }

  if (!currentPlan.data.node_args) {
    currentPlan.data.node_args = {};
  }

  currentPlan.data.node_args[editingNodeId] = {
    ...currentPlan.data.node_args[editingNodeId],
    formation: vals.formation,
    night: vals.night,
    long_missile_support: vals.longMissileSupport,
    proceed: vals.proceed,
    detour: vals.detour,
    SL_when_detour_fails: vals.slWhenDetourFails || undefined,
    enemy_rules: rules.length > 0 ? rules : undefined,
  };

  // 即时保存到文件
  if (currentPlan.fileName) {
    const bridge = window.electronBridge;
    bridge?.saveFile(currentPlan.fileName, currentPlan.toYaml());
  }

  planView.hideNodeEditor();
  return true;
}
