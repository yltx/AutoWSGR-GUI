/**
 * PlanPreviewView —— 方案预览纯渲染组件。
 * 只接收 PlanPreviewViewObject 并将其渲染到 DOM，不做任何业务判断。
 */
import type { PlanPreviewViewObject, NodeViewObject, MapNodeType, MapEdgeVO } from './viewObjects';

const FORMATION_SHORT: Record<string, string> = {
  '单纵阵': '单纵',
  '复纵阵': '复纵',
  '轮型阵': '轮型',
  '梯形阵': '梯形',
  '单横阵': '单横',
};

/** 节点类型 → SVG 图标 (16×16 viewBox) */
const NODE_TYPE_ICON: Record<MapNodeType, string> = {
  Start: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 2l8 6-8 6V2z"/></svg>',
  Normal: '',
  Boss: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 13h12v1.5H2V13z"/><path d="M2 6l2.5 5h7L14 6l-3 3-3-4-3 4-3-3z"/><circle cx="2" cy="5.5" r="1"/><circle cx="8" cy="4.5" r="1"/><circle cx="14" cy="5.5" r="1"/></svg>',
  Resource: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v9H2V4zm1 1v7h10V5H3zm1 1h3v2H4V6zm5 0h3v2H9V6z"/></svg>',
  Penalty: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l6.5 13H1.5L8 1.5zM7 6v4h2V6H7zm0 5v2h2v-2H7z"/></svg>',
  Suppress: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2"/><line x1="8" y1="1" x2="8" y2="5" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="11" x2="8" y2="15" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="8" x2="5" y2="8" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.5"/></svg>',
  Aerial: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="1.5" cy="14.5" r="1.2"/><line x1="2.8" y1="13.2" x2="10" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="3" cy="9" r="1.2"/><line x1="4.3" y1="7.7" x2="12" y2="0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="12" r="1.2"/><line x1="9.3" y1="10.7" x2="15" y2="5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  Hard: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.8 3.6L14 5.4l-3 2.9.7 4.1L8 10.5l-3.7 1.9.7-4.1-3-2.9 4.2-.8z"/><circle cx="8" cy="13" r="1.5"/></svg>',
};

/** 节点类型 → 中文名称 */
const NODE_TYPE_NAME: Record<MapNodeType, string> = {
  Start: '出击点',
  Normal: '普通战斗',
  Boss: 'Boss 点',
  Resource: '资源点',
  Penalty: '罚点',
  Suppress: '航空制压',
  Aerial: '空袭点',
  Hard: '精英点',
};

/** 非战斗类型节点（点击后只显示信息，不显示编辑面板） */
const NON_COMBAT_TYPES: Set<MapNodeType> = new Set(['Start', 'Resource', 'Penalty']);

export class PlanPreviewView {
  private emptyEl: HTMLElement;
  private detailEl: HTMLElement;
  private mapNameEl: HTMLElement;
  private fileNameEl: HTMLElement;
  private repairSelect: HTMLSelectElement;
  private fightCondSelect: HTMLSelectElement;
  private fleetSelect: HTMLSelectElement;
  private commentEl: HTMLElement;
  private nodeListEl: HTMLElement;
  private nodeEditorEl: HTMLElement;
  private nodeEditorIdEl: HTMLElement;
  private nodeEditorPlaceholderEl: HTMLElement;
  private nodeInfoEl: HTMLElement;

  /** 外部回调：用户点击某个节点 chip 时触发 */
  onNodeClick?: (nodeId: string) => void;
  /** 外部回调：方案级别字段修改 */
  onPlanFieldChange?: (field: 'repair_mode' | 'fight_condition' | 'fleet_id', value: number) => void;

  constructor() {
    this.emptyEl = document.getElementById('plan-empty')!;
    this.detailEl = document.getElementById('plan-detail')!;
    this.mapNameEl = document.getElementById('plan-map-name')!;
    this.fileNameEl = document.getElementById('plan-file-name')!;
    this.repairSelect = document.getElementById('plan-edit-repair') as HTMLSelectElement;
    this.fightCondSelect = document.getElementById('plan-edit-fight-cond') as HTMLSelectElement;
    this.fleetSelect = document.getElementById('plan-edit-fleet') as HTMLSelectElement;
    this.commentEl = document.getElementById('plan-comment')!;
    this.nodeListEl = document.getElementById('node-list')!;
    this.nodeEditorEl = document.getElementById('node-editor')!;
    this.nodeEditorIdEl = document.getElementById('node-editor-id')!;
    this.nodeEditorPlaceholderEl = document.getElementById('node-editor-placeholder')!;
    this.nodeInfoEl = document.getElementById('node-info')!;

    // 方案级别字段变更事件
    this.repairSelect.addEventListener('change', () => {
      this.onPlanFieldChange?.('repair_mode', Number(this.repairSelect.value));
    });
    this.fightCondSelect.addEventListener('change', () => {
      this.onPlanFieldChange?.('fight_condition', Number(this.fightCondSelect.value));
    });
    this.fleetSelect.addEventListener('change', () => {
      this.onPlanFieldChange?.('fleet_id', Number(this.fleetSelect.value));
    });
  }

  /** 渲染 Plan 预览 */
  render(vo: PlanPreviewViewObject | null): void {
    if (!vo) {
      this.emptyEl.style.display = '';
      this.detailEl.style.display = 'none';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.detailEl.style.display = 'flex';

    this.mapNameEl.textContent = vo.mapName;
    this.fileNameEl.textContent = vo.fileName;
    this.repairSelect.value = String(vo.repairModeValue);
    this.fightCondSelect.value = String(vo.fightConditionValue);
    this.fleetSelect.value = String(vo.fleetId);
    this.commentEl.textContent = vo.comment || '';

    // 渲染节点列表
    this.nodeListEl.innerHTML = '';

    if (vo.allNodes && vo.edges) {
      // ── 地图可视化模式 ──
      this.nodeListEl.classList.add('map-canvas');

      // SVG 连线层 (viewBox 0-100 匹配百分比坐标)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('map-edges');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      this.renderEdges(svg, vo.edges);
      this.nodeListEl.appendChild(svg);

      // 节点层
      const selectedSet = new Set(vo.selectedNodes.map(n => n.id));
      for (const node of vo.allNodes) {
        const chip = this.createMapNode(node, selectedSet.has(node.id));
        this.nodeListEl.appendChild(chip);
      }
    } else {
      // ── 传统列表模式 ──
      this.nodeListEl.classList.remove('map-canvas');
      for (const node of vo.selectedNodes) {
        this.nodeListEl.appendChild(this.createNodeChip(node));
      }
    }
  }

  /** 渲染 SVG 曲线连线 */
  private renderEdges(svg: SVGSVGElement, edges: MapEdgeVO[]): void {
    // 箭头 marker
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'arrowhead');
    marker.setAttribute('markerWidth', '4');
    marker.setAttribute('markerHeight', '3');
    marker.setAttribute('refX', '4');
    marker.setAttribute('refY', '1.5');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', 'strokeWidth');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('d', 'M0,0 L4,1.5 L0,3 Z');
    arrowPath.setAttribute('fill', 'var(--text-muted)');
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    for (const edge of edges) {
      const [x1, y1] = edge.from;
      const [x2, y2] = edge.to;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.1) continue;

      // 用节点 ID 排序决定曲线弯曲方向，确保双向边弧线对称
      const sign = edge.fromId < edge.toId ? 1 : -1;
      const nx = (-dy / dist) * sign;
      const ny = (dx / dist) * sign;
      const bulge = dist * 0.10;
      const cx = (x1 + x2) / 2 + nx * bulge;
      const cy = (y1 + y2) / 2 + ny * bulge;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`);
      path.setAttribute('marker-end', 'url(#arrowhead)');
      path.classList.add('map-edge-line');
      svg.appendChild(path);
    }
  }

  /** 创建地图定位节点 */
  private createMapNode(node: NodeViewObject, isSelected: boolean): HTMLElement {
    const chip = document.createElement('div');
    const typeCls = `node-type-${node.nodeType.toLowerCase()}`;
    chip.className = `map-node ${typeCls}${isSelected ? ' map-node-selected' : ''}${node.detour ? ' is-detour' : ''}`;
    if (node.position) {
      chip.style.left = node.position[0] + '%';
      chip.style.top = node.position[1] + '%';
    }
    chip.dataset['nodeId'] = node.id;

    // 只显示节点 ID，类型用边框/背景色区分
    chip.innerHTML = `<span class="map-node-id">${this.escapeHtml(node.id)}</span>`;

    if (isSelected) {
      chip.addEventListener('click', () => {
        this.nodeListEl.querySelectorAll('.map-node,.node-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        this.onNodeClick?.(node.id);
      });
    }

    return chip;
  }

  private createNodeChip(node: NodeViewObject): HTMLElement {
    const chip = document.createElement('div');
    const typeCls = `node-type-${node.nodeType.toLowerCase()}`;
    chip.className = `node-chip ${typeCls}${node.hasCustomRules ? ' has-custom' : ''}${node.detour ? ' is-detour' : ''}`;
    chip.dataset['nodeId'] = node.id;

    const shortFormation = FORMATION_SHORT[node.formation] || node.formation;
    const typeIcon = NODE_TYPE_ICON[node.nodeType];
    const isCombat = !NON_COMBAT_TYPES.has(node.nodeType);

    chip.innerHTML =
      `<span class="node-id">${this.escapeHtml(node.id)}</span>` +
      (typeIcon ? `<span class="node-type-badge">${typeIcon}</span>` : '') +
      (isCombat ? `<span class="node-detail">${this.escapeHtml(shortFormation)}</span>` : '') +
      (node.night ? '<span class="night-icon">☾</span>' : '') +
      (node.detour ? '<span class="detour-icon">↩</span>' : '') +
      (!node.proceed && isCombat ? '<span class="node-detail stop-icon">⛔</span>' : '');

    chip.addEventListener('click', () => {
      // 清除其他 chip 的选中状态
      this.nodeListEl.querySelectorAll('.node-chip,.map-node').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      this.onNodeClick?.(node.id);
    });

    return chip;
  }

  /** 显示节点编辑面板并填充数据 */
  showNodeEditor(nodeId: string, args: { formation: number; night: boolean; proceed: boolean; enemyRules: string }): void {
    this.nodeInfoEl.style.display = 'none';
    this.nodeEditorIdEl.textContent = nodeId;
    (document.getElementById('node-edit-formation') as HTMLSelectElement).value = String(args.formation);
    (document.getElementById('node-edit-night') as HTMLInputElement).checked = args.night;
    (document.getElementById('node-edit-proceed') as HTMLInputElement).checked = args.proceed;
    (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value = args.enemyRules;
    this.nodeEditorPlaceholderEl.style.display = 'none';
    this.nodeEditorEl.style.display = '';
  }

  /** 显示非战斗节点的信息面板 */
  showNodeInfo(nodeId: string, nodeType: MapNodeType): void {
    this.nodeEditorEl.style.display = 'none';
    this.nodeEditorPlaceholderEl.style.display = 'none';
    this.nodeInfoEl.style.display = '';

    const icon = NODE_TYPE_ICON[nodeType] || '';
    const name = NODE_TYPE_NAME[nodeType];
    const typeCls = `node-type-${nodeType.toLowerCase()}`;

    let desc = '';
    switch (nodeType) {
      case 'Start': desc = '舰队从此处出击，无战斗或设置。'; break;
      case 'Resource': desc = '经过此点可获取资源，无需战斗。'; break;
      case 'Penalty': desc = '经过此点会扣除资源，无需战斗。'; break;
    }

    this.nodeInfoEl.innerHTML =
      `<div class="node-info-header">` +
        `<div class="node-info-badge ${typeCls}">${icon}</div>` +
        `<div><h3>${this.escapeHtml(nodeId)} 点</h3><span class="node-info-type">${this.escapeHtml(name)}</span></div>` +
        `<button class="btn btn-small" id="btn-node-info-close">✕</button>` +
      `</div>` +
      `<p class="node-info-desc">${this.escapeHtml(desc)}</p>` +
      `<p class="node-info-note">此类型节点没有可配置的战斗设置。</p>`;

    this.nodeInfoEl.querySelector('#btn-node-info-close')?.addEventListener('click', () => {
      this.hideNodeEditor();
    });
  }

  /** 隐藏节点编辑面板 */
  hideNodeEditor(): void {
    this.nodeEditorEl.style.display = 'none';
    this.nodeInfoEl.style.display = 'none';
    this.nodeEditorPlaceholderEl.style.display = '';
    this.nodeListEl.querySelectorAll('.node-chip,.map-node').forEach(c => c.classList.remove('selected'));
  }

  /** 收集节点编辑面板的当前值 */
  collectNodeEditorValues(): { formation: number; night: boolean; proceed: boolean; rulesText: string } {
    return {
      formation: parseInt((document.getElementById('node-edit-formation') as HTMLSelectElement).value, 10),
      night: (document.getElementById('node-edit-night') as HTMLInputElement).checked,
      proceed: (document.getElementById('node-edit-proceed') as HTMLInputElement).checked,
      rulesText: (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value,
    };
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
