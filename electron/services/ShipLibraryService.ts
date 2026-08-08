/**
 * 管理舰船资料库同步、状态和渲染清单。
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { AppPaths } from './AppPaths';

const NATIVE_SHIP_TYPE_SCHEMA_VERSION = 3;
const BACKEND_CANONICAL_SHIP_TYPE_SCHEMA_VERSION = 4;
const LEGACY_SHIP_LIBRARY_TYPE_CODES: Readonly<Record<string, string>> =
  Object.freeze({
    cbg: 'bg',
    cg: 'kp',
    cgaa: 'cg',
    ddg: 'asdg',
    ddgaa: 'aadg',
  });

export interface ShipLibraryStatus {
  exists: boolean;
  path: string;
  generatedAt?: string;
  shipCount: number;
  assetCount: number;
  missingAssets: number;
  backendSynchronized?: boolean;
  backendMissingRecords?: number;
  backendMissingAliases?: number;
  backendError?: string;
  error?: string;
}

export interface ShipLibraryManifest {
  schemaVersion: number;
  generatedAt: string;
  labels: Record<string, unknown>;
  typeGroups: Record<string, unknown>;
  ships: Array<Record<string, unknown>>;
}

export interface ShipLibraryDependencies {
  processId: number;
  now?(): number;
}

/** 管理舰船资料库目录、内置升级、状态和渲染清单。 */
export class ShipLibraryService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly dependencies: ShipLibraryDependencies,
  ) {}

  /** 返回当前可写的用户舰船资料库目录。 */
  directory(): string {
    return path.join(this.appPaths.userDataRoot(), 'ship-library');
  }

  /** 返回开发或打包模式下的资料库更新脚本。 */
  updaterPath(): string {
    const root = this.appPaths.isPackaged()
      ? this.appPaths.resourceRoot()
      : this.appPaths.appRoot();
    return path.join(
      root,
      'tools',
      'ship_library',
      'update_ship_library.py',
    );
  }

  /** 按清单版本把内置资料库安全同步到用户目录。 */
  initialize(): void {
    const bundledDir = path.join(
      this.appPaths.resourceRoot(),
      'resource',
      'ship-library',
    );
    const bundledManifestPath = path.join(
      bundledDir,
      'manifest.json',
    );
    const userManifestPath = path.join(
      this.directory(),
      'manifest.json',
    );
    if (!fs.existsSync(bundledManifestPath)) return;

    let shouldSync = !fs.existsSync(userManifestPath);
    if (!shouldSync) {
      try {
        const bundled = JSON.parse(
          fs.readFileSync(bundledManifestPath, 'utf-8'),
        ) as Record<string, unknown>;
        const user = JSON.parse(
          fs.readFileSync(userManifestPath, 'utf-8'),
        ) as Record<string, unknown>;
        shouldSync = Number(
          bundled.schema_version ?? bundled.schemaVersion ?? 0,
        ) > Number(
          user.schema_version ?? user.schemaVersion ?? 0,
        )
          || String(
            bundled.generated_at ?? bundled.generatedAt ?? '',
          ) > String(
            user.generated_at ?? user.generatedAt ?? '',
          );
      } catch {
        shouldSync = true;
      }
    }
    if (!shouldSync) return;

    const temporary = `${this.directory()}.${this.dependencies.processId}.${this.now()}.sync`;
    const backup = `${this.directory()}.${this.dependencies.processId}.${this.now()}.backup`;
    let movedExisting = false;
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
      this.copyDirectoryNoOverwrite(bundledDir, temporary);
      if (fs.existsSync(this.directory())) {
        fs.renameSync(this.directory(), backup);
        movedExisting = true;
      }
      fs.renameSync(temporary, this.directory());
      if (movedExisting) {
        fs.rmSync(backup, { recursive: true, force: true });
      }
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      if (
        movedExisting
        && !fs.existsSync(this.directory())
        && fs.existsSync(backup)
      ) {
        try {
          fs.renameSync(backup, this.directory());
        } catch {
          console.error(
            '[ShipLibrary] 资料库旧版本恢复失败:',
            backup,
          );
        }
      }
      console.error('[ShipLibrary] 资料库升级失败:', error);
    }
  }

  /** 读取清单，为配置页提供当前资料库状态。 */
  getStatus(): ShipLibraryStatus {
    const directory = this.directory();
    const manifestPath = path.join(directory, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return {
        exists: false,
        path: directory,
        shipCount: 0,
        assetCount: 0,
        missingAssets: 0,
      };
    }
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf-8'),
      ) as {
        generated_at?: unknown;
        counts?: Record<string, unknown>;
      };
      const counts = manifest.counts ?? {};
      return {
        exists: true,
        path: directory,
        generatedAt: typeof manifest.generated_at === 'string'
          ? manifest.generated_at
          : undefined,
        shipCount: typeof counts.ships === 'number'
          ? counts.ships
          : 0,
        assetCount: typeof counts.assets === 'number'
          ? counts.assets
          : 0,
        missingAssets: typeof counts.missing_assets === 'number'
          ? counts.missing_assets
          : 0,
      };
    } catch (error) {
      return {
        exists: false,
        path: directory,
        shipCount: 0,
        assetCount: 0,
        missingAssets: 0,
        error: `资料库清单读取失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** 返回舰队规划使用的清单字段和受限本地资源 URL。 */
  getManifest(): ShipLibraryManifest {
    const manifestPath = path.join(this.directory(), 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        '舰船资料库尚未建立，请先在配置页更新舰船数据库',
      );
    }
    const raw = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    ) as {
      schema_version?: unknown;
      generated_at?: unknown;
      labels?: unknown;
      type_groups?: unknown;
      ships?: unknown;
    };
    if (!Array.isArray(raw.ships)) {
      throw new Error('舰船资料库清单格式无效');
    }
    const schemaVersion = typeof raw.schema_version === 'number'
      ? raw.schema_version
      : 0;
    return {
      schemaVersion,
      generatedAt: typeof raw.generated_at === 'string'
        ? raw.generated_at
        : '',
      labels: this.normalizeLegacyLabels(raw.labels, schemaVersion),
      typeGroups: this.normalizeLegacyTypeGroups(
        raw.type_groups,
        schemaVersion,
      ),
      ships: raw.ships.map((entry) => {
        const ship = entry && typeof entry === 'object'
          ? entry as Record<string, unknown>
          : {};
        const normalizedShip = this.normalizeLegacyShip(
          ship,
          schemaVersion,
        );
        return {
          ...normalizedShip,
          portraitUrl: this.assetUrl(normalizedShip.portrait),
          backgroundUrl: this.assetUrl(normalizedShip.background),
          frameUrl: this.assetUrl(normalizedShip.frame),
          typeIconUrl: this.assetUrl(normalizedShip.type_icon),
        };
      }),
    };
  }

  /**
   * schema 2 及更早版本使用 Wiki 旧舰种代码，schema 3 仍保留 CF。
   * 只在资料库读取边界转换，不把源代码加入编队 API 的允许集合。
   */
  private normalizeLegacyShipTypeCode(
    value: string,
    schemaVersion: number,
  ): string {
    let code = value.trim().toLowerCase();
    if (schemaVersion < NATIVE_SHIP_TYPE_SCHEMA_VERSION) {
      code = LEGACY_SHIP_LIBRARY_TYPE_CODES[code] ?? code;
    }
    if (
      schemaVersion < BACKEND_CANONICAL_SHIP_TYPE_SCHEMA_VERSION
      && code === 'cf'
    ) {
      return 'cav';
    }
    return code;
  }

  private normalizeLegacyShip(
    ship: Record<string, unknown>,
    schemaVersion: number,
  ): Record<string, unknown> {
    if (typeof ship.ship_type !== 'string') return ship;
    return {
      ...ship,
      ship_type: this.normalizeLegacyShipTypeCode(
        ship.ship_type,
        schemaVersion,
      ),
    };
  }

  private normalizeLegacyLabels(
    value: unknown,
    schemaVersion: number,
  ): Record<string, unknown> {
    const labels = value && typeof value === 'object'
      ? { ...value as Record<string, unknown> }
      : {};
    if (
      schemaVersion >= BACKEND_CANONICAL_SHIP_TYPE_SCHEMA_VERSION
      || !labels.ship_types
      || typeof labels.ship_types !== 'object'
      || Array.isArray(labels.ship_types)
    ) {
      return labels;
    }
    const normalizedLabels: Record<string, unknown> = {};
    for (
      const [sourceCode, label]
      of Object.entries(labels.ship_types as Record<string, unknown>)
    ) {
      const code = this.normalizeLegacyShipTypeCode(
        sourceCode,
        schemaVersion,
      );
      const sourceIsCanonical = sourceCode.trim().toLowerCase() === code;
      if (!(code in normalizedLabels) || sourceIsCanonical) {
        normalizedLabels[code] = label;
      }
    }
    labels.ship_types = normalizedLabels;
    return labels;
  }

  private normalizeLegacyTypeGroups(
    value: unknown,
    schemaVersion: number,
  ): Record<string, unknown> {
    const groups = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    if (schemaVersion >= BACKEND_CANONICAL_SHIP_TYPE_SCHEMA_VERSION) {
      return groups;
    }
    const normalize = (entry: unknown): unknown => {
      if (Array.isArray(entry)) {
        return [...new Set(entry.map(item => (
          typeof item === 'string'
            ? this.normalizeLegacyShipTypeCode(item, schemaVersion)
            : item
        )))];
      }
      if (entry && typeof entry === 'object') {
        return Object.fromEntries(
          Object.entries(entry as Record<string, unknown>)
            .map(([key, item]) => [key, normalize(item)]),
        );
      }
      return entry;
    };
    return normalize(groups) as Record<string, unknown>;
  }

  /** 将资料库内部相对路径转换为本地 file URL。 */
  assetUrl(relativePath: unknown): string {
    if (typeof relativePath !== 'string' || !relativePath) return '';
    const root = path.resolve(this.directory());
    const absolutePath = path.resolve(root, relativePath);
    if (
      absolutePath !== root
      && !absolutePath.startsWith(`${root}${path.sep}`)
    ) {
      return '';
    }
    return pathToFileURL(absolutePath).href;
  }

  /** 递归复制目录，并继续跳过已存在的文件。 */
  private copyDirectoryNoOverwrite(source: string, target: string): void {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        this.copyDirectoryNoOverwrite(sourcePath, targetPath);
      } else if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  /** 返回可注入的时间戳或当前系统时间。 */
  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}
