/**
 * 把 GUI 舰船清单增量同步到本地 AutoWSGR 舰名库。
 *
 * 同编号缺失时按编号插入新组；同编号已有组但缺少当前名称时追加别名。
 * 旧编号、旧名称和用户已有别名始终保留，避免资料库更新造成兼容性回退。
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseYaml } from '../../src/shared/yamlSerializer';
import { AtomicFileStore } from './AtomicFileStore';

export interface ShipNameSyncResult {
  path: string;
  addedRecords: number;
  addedAliases: number;
  totalRecords: number;
  changed: boolean;
}

export interface ShipNameComparisonResult {
  path: string;
  missingRecords: number;
  missingAliases: number;
  totalRecords: number;
  synchronized: boolean;
}

interface ManifestShipName {
  id: number;
  searchName: string;
}

interface ShipNameBlock {
  id: number;
  start: number;
  end: number;
}

interface TextEdit {
  order: number;
  text: string;
}

type ShipNameDocument = Record<string, unknown>;

/** 非破坏性同步 GUI 舰名到后端 shipnames.yaml。 */
export class ShipNameSynchronizer {
  constructor(private readonly atomicFiles: AtomicFileStore) {}

  /** 只读核对 GUI 舰名与后端舰名库是否一致。 */
  compare(
    shipnamesPath: string,
    ships: Array<Record<string, unknown>>,
  ): ShipNameComparisonResult {
    const target = this.resolveTarget(shipnamesPath);
    const document = this.loadDocument(
      fs.readFileSync(target, 'utf-8'),
    );
    const manifestShips = this.normalizeManifestShips(ships);
    let missingRecords = 0;
    let missingAliases = 0;

    for (const ship of manifestShips) {
      const key = `No.${ship.id}`;
      const existing = document[key];
      if (existing === undefined) {
        missingRecords += 1;
        continue;
      }
      if (
        !Array.isArray(existing)
        || existing.some(name => typeof name !== 'string')
      ) {
        throw new Error(`后端舰名记录格式无效: ${key}`);
      }
      if (!existing.includes(ship.searchName)) missingAliases += 1;
    }

    return {
      path: target,
      missingRecords,
      missingAliases,
      totalRecords: manifestShips.length,
      synchronized: missingRecords === 0 && missingAliases === 0,
    };
  }

  sync(
    shipnamesPath: string,
    ships: Array<Record<string, unknown>>,
  ): ShipNameSyncResult {
    const target = this.resolveTarget(shipnamesPath);
    const original = fs.readFileSync(target, 'utf-8');
    const document = this.loadDocument(original);
    const manifestShips = this.normalizeManifestShips(ships);
    const blocks = this.findBlocks(original);
    const blockById = new Map(blocks.map(block => [block.id, block]));
    const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
    const otherStart = this.findOtherStart(original);
    const edits = new Map<number, TextEdit[]>();
    let addedRecords = 0;
    let addedAliases = 0;

    for (const ship of manifestShips) {
      const key = `No.${ship.id}`;
      const existing = document[key];
      if (existing === undefined) {
        const anchor = blocks.find(block => block.id > ship.id)?.start
          ?? otherStart
          ?? original.length;
        this.addEdit(
          edits,
          anchor,
          ship.id,
          this.newRecord(ship, lineEnding),
        );
        addedRecords += 1;
        continue;
      }

      if (
        !Array.isArray(existing)
        || existing.some(name => typeof name !== 'string')
      ) {
        throw new Error(`后端舰名记录格式无效: ${key}`);
      }
      if (existing.includes(ship.searchName)) continue;

      const block = blockById.get(ship.id);
      if (!block) {
        throw new Error(`无法定位后端舰名记录: ${key}`);
      }
      this.addEdit(
        edits,
        block.end,
        Number.MIN_SAFE_INTEGER,
        `  - ${JSON.stringify(ship.searchName)}${lineEnding}`,
      );
      addedAliases += 1;
    }

    if (edits.size === 0) {
      return {
        path: target,
        addedRecords,
        addedAliases,
        totalRecords: manifestShips.length,
        changed: false,
      };
    }

    const updated = this.applyEdits(original, edits);
    const updatedDocument = this.loadDocument(updated);
    this.verifyDocument(updatedDocument, manifestShips);
    this.verifyOrder(updatedDocument);
    this.atomicFiles.write(target, updated);
    return {
      path: target,
      addedRecords,
      addedAliases,
      totalRecords: manifestShips.length,
      changed: true,
    };
  }

  private resolveTarget(shipnamesPath: string): string {
    const target = path.resolve(shipnamesPath);
    if (
      path.basename(target).toLowerCase() !== 'shipnames.yaml'
      || path.basename(path.dirname(target)).toLowerCase() !== 'data'
      || path.basename(path.dirname(path.dirname(target))).toLowerCase()
        !== 'autowsgr'
    ) {
      throw new Error(`后端舰名库路径无效: ${target}`);
    }
    if (!fs.existsSync(target)) {
      throw new Error(`本地后端舰名库不存在: ${target}`);
    }
    return fs.realpathSync(target);
  }

  private loadDocument(content: string): ShipNameDocument {
    const value = parseYaml(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('后端舰名库不是有效的 YAML 映射');
    }
    return value as ShipNameDocument;
  }

  private normalizeManifestShips(
    ships: Array<Record<string, unknown>>,
  ): ManifestShipName[] {
    const records = new Map<number, string>();
    for (const ship of ships) {
      const id = Number(ship.id);
      const searchName = typeof ship.search_name === 'string'
        ? ship.search_name.trim()
        : '';
      if (!Number.isSafeInteger(id) || id <= 0 || !searchName) {
        throw new Error('GUI 舰船清单包含无效的 id 或 search_name');
      }
      const existing = records.get(id);
      if (existing !== undefined && existing !== searchName) {
        throw new Error(`GUI 舰船编号 ${id} 对应多个搜索名称`);
      }
      records.set(id, searchName);
    }
    return [...records.entries()]
      .sort(([left], [right]) => left - right)
      .map(([id, searchName]) => ({ id, searchName }));
  }

  private findBlocks(content: string): ShipNameBlock[] {
    const pattern = /^(?:\uFEFF)?No\.(\d+):[^\r\n]*(?:\r?\n|$)/gm;
    const matches = [...content.matchAll(pattern)];
    return matches.map((match, index) => ({
      id: Number(match[1]),
      start: match.index,
      end: matches[index + 1]?.index
        ?? this.findOtherStart(content)
        ?? content.length,
    }));
  }

  private findOtherStart(content: string): number | null {
    const match = /^Other:[^\r\n]*(?:\r?\n|$)/m.exec(content);
    return match?.index ?? null;
  }

  private addEdit(
    edits: Map<number, TextEdit[]>,
    position: number,
    order: number,
    text: string,
  ): void {
    const entries = edits.get(position) ?? [];
    entries.push({ order, text });
    edits.set(position, entries);
  }

  private newRecord(
    ship: ManifestShipName,
    lineEnding: string,
  ): string {
    const comment = ship.searchName.replace(/[\r\n#]/g, ' ').trim();
    return [
      `No.${ship.id}: # ${comment}`,
      `  - ${JSON.stringify(ship.searchName)}`,
      '',
    ].join(lineEnding);
  }

  private applyEdits(
    content: string,
    edits: Map<number, TextEdit[]>,
  ): string {
    let updated = content;
    const positions = [...edits.keys()].sort((left, right) => right - left);
    for (const position of positions) {
      const inserted = (edits.get(position) ?? [])
        .sort((left, right) => left.order - right.order)
        .map(edit => edit.text)
        .join('');
      updated = updated.slice(0, position)
        + inserted
        + updated.slice(position);
    }
    return updated;
  }

  private verifyDocument(
    document: ShipNameDocument,
    ships: ManifestShipName[],
  ): void {
    for (const ship of ships) {
      const value = document[`No.${ship.id}`];
      if (!Array.isArray(value) || !value.includes(ship.searchName)) {
        throw new Error(
          `后端舰名同步校验失败: No.${ship.id} -> ${ship.searchName}`,
        );
      }
    }
  }

  private verifyOrder(document: ShipNameDocument): void {
    const ids = Object.keys(document)
      .filter(key => /^No\.\d+$/.test(key))
      .map(key => Number(key.slice(3)));
    const sorted = [...ids].sort((left, right) => left - right);
    if (ids.some((id, index) => id !== sorted[index])) {
      throw new Error('后端舰名同步后编号顺序无效');
    }
  }
}
