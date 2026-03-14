/**
 * PlanPreviewView —— 方案预览纯渲染组件。
 * 只接收 PlanPreviewViewObject 并将其渲染到 DOM，不做任何业务判断。
 */
import type { PlanPreviewViewObject, NodeViewObject, MapNodeType, MapEdgeVO, FleetPresetVO } from './viewObjects';
import { ALL_SHIPS, shipTypeLabel } from '../data/shipData';
import type { BathRepairConfig, RepairThreshold } from '../model/types';

const FORMATION_SHORT: Record<string, string> = {
  '单纵阵': '单纵',
  '复纵阵': '复纵',
  '轮型阵': '轮型',
  '梯形阵': '梯形',
  '单横阵': '单横',
};

/** 夜战点专用图标 */
const NODE_TYPE_ICON_NIGHT = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7 1a7 7 0 1 0 5.5 11.3A5.5 5.5 0 0 1 7 1z"/></svg>';

/** 节点类型 → SVG 图标 (16×16 viewBox) */
const NODE_TYPE_ICON: Record<MapNodeType, string> = {
  Start: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 2l8 6-8 6V2z"/></svg>',
  Normal: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
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
  Suppress: '压制点',
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
  private fleetPresetSection: HTMLElement;
  private fleetPresetListEl: HTMLElement;
  private fleetPresetAddBtn: HTMLElement;
  private timesInput: HTMLInputElement;
  private gapInput: HTMLInputElement;
  private lootGeInput: HTMLInputElement;
  private shipGeInput: HTMLInputElement;
  private taskConfigEl: HTMLElement;

  /** 当前选中的编队预设索引集合 (多选) */
  selectedFleetPresetIndices: Set<number> = new Set();

  /** 当前方案的编队预设列表（用于动态渲染泡澡舰船阈值） */
  private currentPresets: FleetPresetVO[] = [];

  /** 外部回调：用户点击某个节点 chip 时触发 */
  onNodeClick?: (nodeId: string) => void;
  /** 外部回调：方案级别字段修改 */
  onPlanFieldChange?: (field: 'repair_mode' | 'fight_condition' | 'fleet_id' | 'times' | 'gap' | 'loot_count_ge' | 'ship_count_ge', value: number | undefined) => void;
  /** 外部回调：编队预设变更 (add / edit / delete) */
  onFleetPresetChange?: (action: 'add' | 'edit' | 'delete', index: number, preset?: FleetPresetVO) => void;
  /** 外部回调：注释/说明修改 */
  onCommentChange?: (comment: string) => void;

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
    this.fleetPresetSection = document.getElementById('fleet-preset-section')!;
    this.fleetPresetListEl = document.getElementById('fleet-preset-list')!;
    this.fleetPresetAddBtn = document.getElementById('fleet-preset-add')!;
    this.timesInput = document.getElementById('plan-edit-times') as HTMLInputElement;
    this.gapInput = document.getElementById('plan-edit-gap') as HTMLInputElement;
    this.lootGeInput = document.getElementById('plan-edit-loot-ge') as HTMLInputElement;
    this.shipGeInput = document.getElementById('plan-edit-ship-ge') as HTMLInputElement;
    this.taskConfigEl = document.getElementById('plan-task-config')!;

    // 新增编队按钮
    this.fleetPresetAddBtn.addEventListener('click', () => {
      this.showFleetEditDialog(-1);
    });

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

    // 任务配置字段变更事件
    this.timesInput.addEventListener('change', () => {
      const v = parseInt(this.timesInput.value, 10);
      this.onPlanFieldChange?.('times', v > 0 ? v : 1);
    });
    this.gapInput.addEventListener('change', () => {
      const v = parseInt(this.gapInput.value, 10);
      this.onPlanFieldChange?.('gap', v >= 0 ? v : 0);
    });
    this.lootGeInput.addEventListener('change', () => {
      const v = parseInt(this.lootGeInput.value, 10);
      this.onPlanFieldChange?.('loot_count_ge', v >= 0 ? v : undefined);
    });
    this.shipGeInput.addEventListener('change', () => {
      const v = parseInt(this.shipGeInput.value, 10);
      this.onPlanFieldChange?.('ship_count_ge', v >= 0 ? v : undefined);
    });

    // 泡澡修理开关
    const bathToggle = document.getElementById('plan-bath-repair-enable') as HTMLInputElement;
    const bathConfigDiv = document.getElementById('bath-repair-config');
    if (bathToggle && bathConfigDiv) {
      bathToggle.addEventListener('change', () => {
        bathConfigDiv.style.display = bathToggle.checked ? '' : 'none';
      });
    }

    // 点击注释区域进入编辑模式
    this.commentEl.addEventListener('click', () => {
      this.startCommentEdit();
    });
  }

  /** 读取泡澡修理配置（未启用时返回 undefined） */
  getBathRepairConfig(): BathRepairConfig | undefined {
    const toggle = document.getElementById('plan-bath-repair-enable') as HTMLInputElement;
    if (!toggle || !toggle.checked) return undefined;

    // 默认阈值
    const typeEl = document.getElementById('bath-default-th-type') as HTMLSelectElement;
    const valueEl = document.getElementById('bath-default-th-value') as HTMLInputElement;
    const type = typeEl?.value === 'absolute' ? 'absolute' as const : 'percent' as const;
    const value = valueEl ? parseInt(valueEl.value, 10) : 50;

    // 按舰船名读取覆盖阈值
    const shipThresholds: Record<string, RepairThreshold> = {};
    document.querySelectorAll<HTMLElement>('.bath-ship-th-row').forEach(row => {
      const shipName = row.dataset.ship;
      if (!shipName) return;
      const sType = (row.querySelector('.bath-ship-th-type') as HTMLSelectElement)?.value;
      const sValue = parseInt((row.querySelector('.bath-ship-th-value') as HTMLInputElement)?.value ?? '', 10);
      if (!isNaN(sValue)) {
        shipThresholds[shipName] = {
          type: sType === 'absolute' ? 'absolute' : 'percent',
          value: sValue,
        };
      }
    });

    return {
      enabled: true,
      defaultThreshold: { type, value: isNaN(value) ? 50 : value },
      shipThresholds: Object.keys(shipThresholds).length > 0 ? shipThresholds : undefined,
    };
  }

  /** 获取选中的编队预设列表 */
  getSelectedPresets(): FleetPresetVO[] {
    const result: FleetPresetVO[] = [];
    const sorted = Array.from(this.selectedFleetPresetIndices).sort((a, b) => a - b);
    for (const idx of sorted) {
      if (idx < this.currentPresets.length) result.push(this.currentPresets[idx]);
    }
    return result;
  }

  /** 根据选中的编队预设，动态渲染泡澡修理的舰船阈值列表 */
  private renderBathShipThresholds(): void {
    const container = document.getElementById('bath-ship-thresholds');
    if (!container) return;

    // 收集选中预设的所有不重复舰船名（保持出现顺序）
    const shipNames: string[] = [];
    const seen = new Set<string>();
    const sorted = Array.from(this.selectedFleetPresetIndices).sort((a, b) => a - b);
    for (const idx of sorted) {
      const preset = this.currentPresets[idx];
      if (!preset) continue;
      for (const name of preset.ships) {
        if (!seen.has(name)) {
          seen.add(name);
          shipNames.push(name);
        }
      }
    }

    container.innerHTML = '';
    if (shipNames.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = '';

    // 表头（用 display:contents 让子元素直接参与父 grid）
    const header = document.createElement('div');
    header.className = 'bath-ship-th-header-row';
    header.innerHTML = '<span class="bath-ship-th-label-h">舰船</span><span class="bath-ship-th-h">类型</span><span class="bath-ship-th-h">阈值</span>';
    container.appendChild(header);

    for (const name of shipNames) {
      const row = document.createElement('div');
      row.className = 'bath-ship-th-row';
      row.dataset.ship = name;

      const label = document.createElement('span');
      label.className = 'bath-ship-th-label';
      label.textContent = name;
      label.title = name;
      row.appendChild(label);

      const sel = document.createElement('select');
      sel.className = 'input input-inline bath-ship-th-type';
      sel.innerHTML = '<option value="percent">百分比</option><option value="absolute">绝对值</option>';
      row.appendChild(sel);

      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'input input-inline input-small bath-ship-th-value';
      inp.value = '50';
      inp.min = '0';
      inp.max = '999';
      row.appendChild(inp);

      container.appendChild(row);
    }
  }

  /** 进入注释编辑模式 */
  private startCommentEdit(): void {
    const currentText = this.commentEl.textContent || '';
    const textarea = document.createElement('textarea');
    textarea.className = 'plan-comment-editing';
    textarea.value = currentText;
    textarea.rows = Math.max(2, currentText.split('\n').length + 1);

    this.commentEl.style.display = 'none';
    this.commentEl.parentElement!.insertBefore(textarea, this.commentEl.nextSibling);
    textarea.focus();

    const commit = () => {
      const newText = textarea.value.trim();
      this.commentEl.textContent = newText;
      this.commentEl.style.display = '';
      textarea.remove();
      this.onCommentChange?.(newText);
    };

    textarea.addEventListener('blur', commit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // 取消编辑
        this.commentEl.style.display = '';
        textarea.remove();
      }
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

    // 任务配置
    this.timesInput.value = String(vo.times ?? 1);
    this.gapInput.value = String(vo.gap ?? 0);
    this.lootGeInput.value = vo.lootCountGe != null ? String(vo.lootCountGe) : '-1';
    this.shipGeInput.value = vo.shipCountGe != null ? String(vo.shipCountGe) : '-1';

    // 渲染编队预设
    this.renderFleetPresets(vo.fleetPresets);

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
    const nightCls = (node.mapNight && node.nodeType === 'Normal') ? ' is-night' : '';
    chip.className = `map-node ${typeCls}${isSelected ? ' map-node-selected' : ''}${node.detour ? ' is-detour' : ''}${nightCls}`;
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
  showNodeEditor(nodeId: string, nodeType: MapNodeType, args: { formation: number; night: boolean; proceed: boolean; enemyRules: string }, mapNight = false): void {
    this.nodeInfoEl.style.display = 'none';

    // 更新 header: 图标 + 节点名 + 类型标签
    const isNightBattle = mapNight && nodeType === 'Normal';
    const icon = isNightBattle ? NODE_TYPE_ICON_NIGHT : (NODE_TYPE_ICON[nodeType] || '');
    const typeName = isNightBattle ? '夜战点' : NODE_TYPE_NAME[nodeType];
    const typeCls = isNightBattle ? 'node-type-night' : `node-type-${nodeType.toLowerCase()}`;
    const headerEl = this.nodeEditorEl.querySelector('.node-editor-header')!;
    const badgeEl = headerEl.querySelector('.node-info-badge');
    const typeSpan = headerEl.querySelector('.node-editor-type');
    if (badgeEl) {
      badgeEl.className = `node-info-badge ${typeCls}`;
      badgeEl.innerHTML = icon;
    }
    if (typeSpan) {
      typeSpan.textContent = typeName;
    }
    this.nodeEditorIdEl.textContent = nodeId;
    (document.getElementById('node-edit-formation') as HTMLSelectElement).value = String(args.formation);
    const nightCheckbox = document.getElementById('node-edit-night') as HTMLInputElement;
    if (mapNight && nodeType === 'Normal') {
      nightCheckbox.checked = true;
      nightCheckbox.disabled = true;
    } else {
      nightCheckbox.checked = args.night;
      nightCheckbox.disabled = false;
    }
    (document.getElementById('node-edit-proceed') as HTMLInputElement).checked = args.proceed;
    (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value = args.enemyRules;
    this.nodeEditorPlaceholderEl.style.display = 'none';
    this.nodeEditorEl.style.display = '';
    // 隐藏编队配置和任务配置
    this.fleetPresetSection.style.display = 'none';
    this.taskConfigEl.style.display = 'none';
  }

  /** 显示非战斗节点的信息面板 */
  showNodeInfo(nodeId: string, nodeType: MapNodeType): void {
    this.nodeEditorEl.style.display = 'none';
    this.nodeEditorPlaceholderEl.style.display = 'none';
    this.nodeInfoEl.style.display = '';
    // 隐藏编队配置和任务配置
    this.fleetPresetSection.style.display = 'none';
    this.taskConfigEl.style.display = 'none';

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
    // 恢复编队配置和任务配置
    this.fleetPresetSection.style.display = '';
    this.taskConfigEl.style.display = '';
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

  /** 渲染编队预设选择器 */
  renderFleetPresets(presets?: FleetPresetVO[]): void {
    this.fleetPresetSection.style.display = '';
    this.fleetPresetListEl.innerHTML = '';
    this.currentPresets = presets ?? [];

    if (!presets || presets.length === 0) {
      this.selectedFleetPresetIndices.clear();
      this.renderBathShipThresholds();
      return;
    }

    presets.forEach((preset, index) => {
      const item = document.createElement('div');
      item.className = 'fleet-preset-item' + (this.selectedFleetPresetIndices.has(index) ? ' selected' : '');

      // 第一行：名称 + 操作按钮
      const row = document.createElement('div');
      row.className = 'fleet-preset-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'fleet-preset-name';
      nameEl.textContent = preset.name;
      row.appendChild(nameEl);

      const actionsEl = document.createElement('span');
      actionsEl.className = 'fleet-preset-item-actions';

      const editBtn = document.createElement('button');
      editBtn.textContent = '编辑';
      editBtn.title = '编辑编队';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showFleetEditDialog(index, preset);
      });
      actionsEl.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-delete';
      deleteBtn.textContent = '删除';
      deleteBtn.title = '删除编队';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 重新计算选中集合
        const newSet = new Set<number>();
        for (const idx of this.selectedFleetPresetIndices) {
          if (idx < index) newSet.add(idx);
          else if (idx > index) newSet.add(idx - 1);
          // idx === index: 不加入（已删除）
        }
        this.selectedFleetPresetIndices = newSet;
        this.onFleetPresetChange?.('delete', index);
      });
      actionsEl.appendChild(deleteBtn);

      row.appendChild(actionsEl);
      item.appendChild(row);

      // 第二行：舰船标签
      const shipsEl = document.createElement('div');
      shipsEl.className = 'fleet-preset-ships';
      for (const ship of preset.ships) {
        const tag = document.createElement('span');
        tag.className = 'ship-tag';
        tag.textContent = ship;
        shipsEl.appendChild(tag);
      }
      item.appendChild(shipsEl);

      item.addEventListener('click', () => {
        if (this.selectedFleetPresetIndices.has(index)) {
          this.selectedFleetPresetIndices.delete(index);
        } else {
          this.selectedFleetPresetIndices.add(index);
        }
        this.fleetPresetListEl.querySelectorAll('.fleet-preset-item').forEach((el, i) => {
          el.classList.toggle('selected', this.selectedFleetPresetIndices.has(i));
        });
        this.renderBathShipThresholds();
      });

      this.fleetPresetListEl.appendChild(item);
    });
  }

  /** 显示编队预设编辑弹窗 */
  private showFleetEditDialog(index: number, preset?: FleetPresetVO): void {
    const isNew = index < 0;
    const name = preset?.name ?? '';
    const ships = preset?.ships ?? [];

    const overlay = document.createElement('div');
    overlay.className = 'fleet-edit-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'fleet-edit-dialog';
    dialog.innerHTML = `
      <h3>${isNew ? '新增编队' : '编辑编队'}</h3>
      <div class="form-group">
        <label>编队名称</label>
        <input type="text" id="fleet-edit-name" class="input" value="${this.escapeHtml(name)}" placeholder="例如：传统AIII双装母" />
      </div>
      <div class="form-group">
        <label>舰船（1~6号位，留空表示该位置无舰船）</label>
        <div class="fleet-edit-ships-grid">
          ${[0, 1, 2, 3, 4, 5].map(i => `
            <div class="ship-input-wrapper">
              <input type="text" class="input fleet-edit-ship" placeholder="${i + 1}号位" value="${this.escapeHtml(ships[i] ?? '')}" autocomplete="off" />
              <div class="ship-autocomplete-list"></div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="fleet-edit-actions">
        <button class="btn btn-outline" id="fleet-edit-cancel">取消</button>
        <button class="btn btn-primary" id="fleet-edit-save">保存</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 为每个舰船输入框绑定自动补全
    const shipWrappers = dialog.querySelectorAll('.ship-input-wrapper');
    shipWrappers.forEach(wrapper => {
      const input = wrapper.querySelector('.fleet-edit-ship') as HTMLInputElement;
      const listEl = wrapper.querySelector('.ship-autocomplete-list') as HTMLElement;
      let selectedIdx = -1;

      const updateList = () => {
        const query = input.value.trim();
        listEl.innerHTML = '';
        selectedIdx = -1;

        if (!query) {
          listEl.style.display = 'none';
          return;
        }

        const lowerQ = query.toLowerCase();
        const matches = ALL_SHIPS.filter(s => s.name.toLowerCase().includes(lowerQ)).slice(0, 12);

        if (matches.length === 0) {
          listEl.style.display = 'none';
          return;
        }

        // 如果精确匹配唯一结果，不显示下拉
        if (matches.length === 1 && matches[0].name === query) {
          listEl.style.display = 'none';
          return;
        }

        for (const ship of matches) {
          const item = document.createElement('div');
          item.className = 'ship-autocomplete-item';

          // 高亮匹配文字
          const nameStr = ship.name;
          const matchIdx = nameStr.toLowerCase().indexOf(lowerQ);
          const before = nameStr.substring(0, matchIdx);
          const matched = nameStr.substring(matchIdx, matchIdx + query.length);
          const after = nameStr.substring(matchIdx + query.length);

          const nameSpan = document.createElement('span');
          nameSpan.className = 'ship-ac-name';
          nameSpan.innerHTML = this.escapeHtml(before)
            + '<mark>' + this.escapeHtml(matched) + '</mark>'
            + this.escapeHtml(after);

          const typeSpan = document.createElement('span');
          typeSpan.className = 'ship-ac-type';
          typeSpan.textContent = shipTypeLabel(ship.ship_type);

          item.appendChild(nameSpan);
          item.appendChild(typeSpan);

          item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // 防止 input 失焦
            input.value = ship.name;
            listEl.style.display = 'none';
          });
          listEl.appendChild(item);
        }

        listEl.style.display = 'block';
      };

      input.addEventListener('input', updateList);
      input.addEventListener('focus', updateList);
      input.addEventListener('blur', () => {
        // 延迟隐藏以允许点击选中
        setTimeout(() => { listEl.style.display = 'none'; }, 150);
      });

      input.addEventListener('keydown', (e) => {
        const items = listEl.querySelectorAll('.ship-autocomplete-item');
        if (items.length === 0 || listEl.style.display === 'none') return;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
          items.forEach((el, i) => el.classList.toggle('active', i === selectedIdx));
          items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIdx = Math.max(selectedIdx - 1, 0);
          items.forEach((el, i) => el.classList.toggle('active', i === selectedIdx));
          items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          if (selectedIdx >= 0 && selectedIdx < items.length) {
            e.preventDefault();
            const nameEl = items[selectedIdx].querySelector('.ship-ac-name');
            if (nameEl) input.value = nameEl.textContent || '';
            listEl.style.display = 'none';
          }
        } else if (e.key === 'Escape') {
          listEl.style.display = 'none';
        }
      });
    });

    const nameInput = dialog.querySelector('#fleet-edit-name') as HTMLInputElement;
    nameInput.focus();

    const close = () => overlay.remove();

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    dialog.querySelector('#fleet-edit-cancel')!.addEventListener('click', close);

    dialog.querySelector('#fleet-edit-save')!.addEventListener('click', () => {
      const newName = nameInput.value.trim();
      if (!newName) {
        nameInput.focus();
        return;
      }
      const shipInputs = dialog.querySelectorAll('.fleet-edit-ship') as NodeListOf<HTMLInputElement>;
      const newShips: string[] = [];
      shipInputs.forEach(inp => {
        const v = inp.value.trim();
        if (v) newShips.push(v);
      });

      const newPreset: FleetPresetVO = { name: newName, ships: newShips };
      if (isNew) {
        this.onFleetPresetChange?.('add', -1, newPreset);
      } else {
        this.onFleetPresetChange?.('edit', index, newPreset);
      }
      close();
    });
  }
}
