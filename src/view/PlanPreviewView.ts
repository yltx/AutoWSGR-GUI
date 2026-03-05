/**
 * PlanPreviewView —— 方案预览纯渲染组件。
 * 只接收 PlanPreviewViewObject 并将其渲染到 DOM，不做任何业务判断。
 */
import type { PlanPreviewViewObject, NodeViewObject } from './viewObjects';

const FORMATION_SHORT: Record<string, string> = {
  '单纵阵': '单纵',
  '复纵阵': '复纵',
  '轮型阵': '轮型',
  '梯形阵': '梯形',
  '单横阵': '单横',
};

export class PlanPreviewView {
  private emptyEl: HTMLElement;
  private detailEl: HTMLElement;
  private mapNameEl: HTMLElement;
  private fileNameEl: HTMLElement;
  private repairEl: HTMLElement;
  private fightCondEl: HTMLElement;
  private commentEl: HTMLElement;
  private nodeListEl: HTMLElement;
  private nodeEditorEl: HTMLElement;
  private nodeEditorIdEl: HTMLElement;
  private nodeEditorPlaceholderEl: HTMLElement;

  /** 外部回调：用户点击某个节点 chip 时触发 */
  onNodeClick?: (nodeId: string) => void;

  constructor() {
    this.emptyEl = document.getElementById('plan-empty')!;
    this.detailEl = document.getElementById('plan-detail')!;
    this.mapNameEl = document.getElementById('plan-map-name')!;
    this.fileNameEl = document.getElementById('plan-file-name')!;
    this.repairEl = document.getElementById('plan-repair')!;
    this.fightCondEl = document.getElementById('plan-fight-cond')!;
    this.commentEl = document.getElementById('plan-comment')!;
    this.nodeListEl = document.getElementById('node-list')!;
    this.nodeEditorEl = document.getElementById('node-editor')!;
    this.nodeEditorIdEl = document.getElementById('node-editor-id')!;
    this.nodeEditorPlaceholderEl = document.getElementById('node-editor-placeholder')!;
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
    this.repairEl.textContent = vo.repairMode;
    this.fightCondEl.textContent = vo.fightCondition;
    this.commentEl.textContent = vo.comment || '';

    // 渲染节点列表
    this.nodeListEl.innerHTML = '';
    for (const node of vo.selectedNodes) {
      this.nodeListEl.appendChild(this.createNodeChip(node));
    }
  }

  private createNodeChip(node: NodeViewObject): HTMLElement {
    const chip = document.createElement('div');
    chip.className = `node-chip${node.hasCustomRules ? ' has-custom' : ''}`;
    chip.dataset['nodeId'] = node.id;

    const shortFormation = FORMATION_SHORT[node.formation] || node.formation;

    chip.innerHTML =
      `<span class="node-id">${this.escapeHtml(node.id)}</span>` +
      `<span class="node-detail">${this.escapeHtml(shortFormation)}</span>` +
      (node.night ? '<span class="night-icon">☾</span>' : '') +
      (!node.proceed ? '<span class="node-detail">⛔</span>' : '');

    chip.addEventListener('click', () => {
      // 清除其他 chip 的选中状态
      this.nodeListEl.querySelectorAll('.node-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      this.onNodeClick?.(node.id);
    });

    return chip;
  }

  /** 显示节点编辑面板并填充数据 */
  showNodeEditor(nodeId: string, args: { formation: number; night: boolean; proceed: boolean; enemyRules: string }): void {
    this.nodeEditorIdEl.textContent = nodeId;
    (document.getElementById('node-edit-formation') as HTMLSelectElement).value = String(args.formation);
    (document.getElementById('node-edit-night') as HTMLInputElement).checked = args.night;
    (document.getElementById('node-edit-proceed') as HTMLInputElement).checked = args.proceed;
    (document.getElementById('node-edit-rules') as HTMLTextAreaElement).value = args.enemyRules;
    this.nodeEditorPlaceholderEl.style.display = 'none';
    this.nodeEditorEl.style.display = '';
  }

  /** 隐藏节点编辑面板 */
  hideNodeEditor(): void {
    this.nodeEditorEl.style.display = 'none';
    this.nodeEditorPlaceholderEl.style.display = '';
    this.nodeListEl.querySelectorAll('.node-chip').forEach(c => c.classList.remove('selected'));
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
