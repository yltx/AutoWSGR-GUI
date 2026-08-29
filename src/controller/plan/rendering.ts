/** 把作战方案、地图和节点数据转换为预览 ViewObject。 */
/**
 * rendering —— 方案预览 ViewObject 构建逻辑。
 */
import type {
  PlanPreviewViewObject,
  NodeViewObject,
  MapEdgeVO,
  PlanFleetPresetSelectorViewObject,
} from '../../types/view.js';
import type { PlanModel } from '../../model/PlanModel';
import {
  FORMATION_NAMES,
  type EventMapCatalogEntry,
} from '../../types/model.js';
import { getNodeType, isDetourNode, isNightNode } from '../../model/MapDataLoader';
import type { MapData } from '../../model/MapDataLoader';

/** 构建 PlanPreviewViewObject（纯函数） */
export function buildPlanPreviewVO(
  currentPlan: PlanModel,
  currentMapData: MapData | null,
  eventMaps: EventMapCatalogEntry[] = [],
  fleetPresetSelector: PlanFleetPresetSelectorViewObject,
): PlanPreviewViewObject {
  const plan = currentPlan;
  const mapData = currentMapData;
  const selectedSet = new Set(plan.data.selected_nodes);

  // 已选节点 VO
  const nodes: NodeViewObject[] = plan.data.selected_nodes.map((nodeId) => {
    const args = plan.getNodeArgs(nodeId);
    return {
      id: nodeId,
      formation: FORMATION_NAMES[args.formation ?? 2] ?? '复纵阵',
      night: args.night ?? false,
      proceed: args.proceed ?? true,
      hasCustomRules: plan.hasCustomArgs(nodeId),
      note: '',
      nodeType: mapData ? getNodeType(mapData, nodeId) : 'Normal',
      detour: mapData ? isDetourNode(mapData, nodeId) : false,
      mapNight: mapData ? isNightNode(mapData, nodeId) : false,
    };
  });

  // 构建地图可视化数据
  let allNodes: NodeViewObject[] | undefined;
  let edges: MapEdgeVO[] | undefined;
  let mapAspectRatio: number | undefined;
  if (mapData) {
    const positions = new Map<string, [number, number]>();
    for (const [id, pt] of Object.entries(mapData)) {
      if (pt.position) positions.set(id, pt.position);
    }

    if (positions.size > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of positions.values()) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }

      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      const PAD = 6;
      const innerW = 100 - PAD * 2;
      const innerH = 100 - PAD * 2;
      const scaleX = innerW / rangeX;
      const scaleY = innerH / rangeY;
      mapAspectRatio = rangeX / rangeY;

      const scaledPos = new Map<string, [number, number]>();
      for (const [id, [x, y]] of positions) {
        scaledPos.set(id, [
          (x - minX) * scaleX + PAD,
          (y - minY) * scaleY + PAD,
        ]);
      }

      allNodes = Object.entries(mapData).map(([id, pt]) => {
        const args = plan.getNodeArgs(id);
        const isSelected = selectedSet.has(id);
        return {
          id,
          formation: isSelected ? (FORMATION_NAMES[args.formation ?? 2] ?? '复纵阵') : '',
          night: isSelected ? (args.night ?? false) : false,
          proceed: isSelected ? (args.proceed ?? true) : true,
          hasCustomRules: isSelected ? plan.hasCustomArgs(id) : false,
          note: '',
          nodeType: pt.type,
          detour: pt.detour,
          mapNight: pt.night,
          position: scaledPos.get(id),
        };
      });

      edges = [];
      for (const [id, pt] of Object.entries(mapData)) {
        const fromPos = scaledPos.get(id);
        if (!fromPos) continue;
        for (const nxt of pt.next) {
          const toPos = scaledPos.get(nxt);
          if (toPos) edges.push({ from: fromPos, to: toPos, fromId: id, toId: nxt });
        }
      }
    }
  }

  return {
    fileName: plan.fileName.split(/[\\/]/).pop() || plan.fileName,
    chapter: plan.data.chapter,
    map: plan.data.map,
    mapName: plan.mapName,
    event: plan.data.event,
    eventMaps,
    repairModeValue: Array.isArray(plan.repairMode) ? plan.repairMode[0] ?? 1 : plan.repairMode,
    fightConditionValue: plan.fightCondition,
    fleetId: plan.data.fleet_id ?? 1,
    selectedNodes: nodes,
    comment: plan.comment,
    allNodes,
    edges,
    mapAspectRatio,
    fleetPresetSelector,
    times: plan.data.times,
    gap: plan.data.gap,
    lootCountGe: plan.data.stop_condition?.loot_count_ge,
    shipCountGe: plan.data.stop_condition?.ship_count_ge,
    collectResultInfo: plan.data.collect_result_info,
  };
}
