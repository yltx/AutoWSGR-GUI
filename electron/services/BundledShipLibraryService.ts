/** 读取只读内置舰船资料库并生成 renderer 可用的安全清单。 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { normalizeFleetShipTypeCode } from '../../src/shared/fleetShipTypes.js';
import type {
  ShipLibraryLabels,
  ShipLibraryManifest,
  ShipLibraryShip,
} from '../../src/types/ipc.js';
import { AppPaths } from './AppPaths.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function stringArrayMap(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const output: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      Array.isArray(item)
      && item.every(entry => typeof entry === 'string')
    ) {
      output[key] = [...item];
    }
  }
  return output;
}

/** 舰船资料库是安装资源，运行时只读，不产生第二份可写状态。 */
export class BundledShipLibraryService {
  constructor(private readonly appPaths: AppPaths) {}

  getManifest(): ShipLibraryManifest {
    const root = this.libraryRoot();
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('内置舰船资料库缺失');
    }
    const parsed: unknown = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.ships)) {
      throw new Error('舰船资料库清单格式无效');
    }

    return {
      schemaVersion: typeof parsed.schema_version === 'number'
        ? parsed.schema_version
        : 0,
      generatedAt: stringValue(parsed.generated_at),
      labels: this.labels(parsed.labels),
      typeGroups: this.typeGroups(parsed.type_groups),
      ships: parsed.ships.map((ship, index) => (
        this.ship(ship, index, root)
      )),
    };
  }

  private libraryRoot(): string {
    return path.join(
      this.appPaths.resourceRoot(),
      'resource',
      'ship-library',
    );
  }

  private labels(value: unknown): ShipLibraryLabels {
    const labels = isRecord(value) ? value : {};
    return {
      locale: stringValue(labels.locale) || undefined,
      ship_types: stringMap(labels.ship_types),
      size_classes: stringMap(labels.size_classes),
      role_classes: stringMap(labels.role_classes),
      countries: stringMap(labels.countries),
      variants: stringMap(labels.variants),
    };
  }

  private typeGroups(
    value: unknown,
  ): ShipLibraryManifest['typeGroups'] {
    const groups = isRecord(value) ? value : {};
    return {
      size_classes: stringArrayMap(groups.size_classes),
      role_classes: stringArrayMap(groups.role_classes),
    };
  }

  private ship(
    value: unknown,
    index: number,
    root: string,
  ): ShipLibraryShip {
    if (!isRecord(value)) {
      throw new Error(`舰船资料库第 ${index + 1} 条记录格式无效`);
    }
    const shipType = normalizeFleetShipTypeCode(
      stringValue(value.ship_type),
    );
    if (!shipType || shipType === 'ss_or_ssg') {
      throw new Error(
        `舰船资料库包含非规范舰种: ${stringValue(value.ship_type)}`,
      );
    }
    const variant = stringValue(value.variant);
    if (
      variant !== 'normal'
      && variant !== 'refit'
      && variant !== 'special'
    ) {
      throw new Error(`舰船资料库包含未知形态: ${variant}`);
    }
    const id = Number(value.id);
    const rarity = Number(value.rarity);
    if (!Number.isInteger(id) || !stringValue(value.name)) {
      throw new Error(`舰船资料库第 ${index + 1} 条记录缺少编号或舰名`);
    }
    return {
      id,
      name: stringValue(value.name),
      search_name: stringValue(value.search_name),
      variant,
      rarity: Number.isFinite(rarity) ? rarity : 0,
      ship_type: shipType,
      size_class: stringValue(value.size_class),
      role_class: stringValue(value.role_class),
      country: stringValue(value.country),
      portraitUrl: this.assetUrl(root, value.portrait),
      backgroundUrl: this.assetUrl(root, value.background),
      frameUrl: this.assetUrl(root, value.frame),
      typeIconUrl: this.assetUrl(root, value.type_icon),
      wiki_url: stringValue(value.wiki_url) || undefined,
    };
  }

  private assetUrl(root: string, value: unknown): string {
    if (typeof value !== 'string' || !value) return '';
    const rootPath = fs.realpathSync.native(root);
    const candidate = path.resolve(root, value);
    if (!fs.existsSync(candidate)) return '';
    const realCandidate = fs.realpathSync.native(candidate);
    const relative = path.relative(rootPath, realCandidate);
    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      return '';
    }
    return pathToFileURL(realCandidate).href;
  }
}
