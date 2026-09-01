/** 加载、缓存并查询地图节点、连线和位置信息。 */
/**
 * MapDataLoader —— 加载地图 JSON 数据。
 * 通过 IPC 从 resource/maps/ 目录读取地图数据文件。
 */
import { jsonCodec, mapDataRepository } from '../adapter/index.js';
import type {
  EventChapter,
  EventMapCatalog,
  EventMapCatalogEntry,
} from '../types/model.js';

/** 地图节点类型 */
export type MapNodeType = 'Start' | 'Normal' | 'Boss' | 'Resource' | 'Penalty' | 'Suppress' | 'Aerial' | 'Hard';

/** 单个地图节点的数据 */
export interface MapPoint {
  type: MapNodeType;
  detour: boolean;
  night: boolean;
  position: [number, number];
  next: string[];
}

/** 一张地图的完整数据 (key → MapPoint) */
export type MapData = Record<string, MapPoint>;

/** 地图数据缓存 */
const mapCache = new Map<string, MapData>();
let eventCatalogPromise: Promise<EventMapCatalogEntry[]> | null = null;
const eventMapFiles = new Map<string, string>();

function eventMapKey(
  eventName: string,
  chapter: EventChapter,
  map: string,
): string {
  return `${eventName}:${chapter}:${map}`;
}

function isSafeMapFileName(value: unknown): value is string {
  return typeof value === 'string'
    && /^[^/\\]+\.json$/i.test(value)
    && value !== '.json'
    && !value.includes('..');
}

async function readMap(filePath: string): Promise<MapData | null> {
  try {
    const content = await mapDataRepository.read(filePath);
    return jsonCodec.parse<MapData>(content);
  } catch {
    return null;
  }
}

/** 加载指定章节-关卡的地图数据 */
export async function loadMapData(chapter: number, map: number): Promise<MapData | null> {
  const key = `${chapter}-${map}`;
  if (mapCache.has(key)) return mapCache.get(key)!;

  const data = await readMap(`resource/maps/normal/${key}.json`);
  if (data) mapCache.set(key, data);
  return data;
}

function normalizeEventNodeType(raw: unknown): MapNodeType {
  switch (String(raw).toUpperCase()) {
    case 'NULL': return 'Start';
    case 'FIGTH':
    case 'FIGHT': return 'Normal';
    case 'BOSS':
    case 'SPECIAL_BOSS':
    case 'LITTLE_BOSS': return 'Boss';
    default: return 'Normal';
  }
}

/** 加载 GUI 内置的活动、难度和真实入口清单。 */
export function loadEventMapCatalog(): Promise<EventMapCatalogEntry[]> {
  if (eventCatalogPromise) return eventCatalogPromise;
  eventCatalogPromise = mapDataRepository
    .read('resource/maps/event/index.json')
    .then((content) => {
      const catalog = jsonCodec.parse<EventMapCatalog>(content);
      if (
        catalog.schema_version !== 2
        || !Array.isArray(catalog.events)
      ) {
        return [];
      }
      eventMapFiles.clear();
      return catalog.events.flatMap((entry) => {
        if (
          !entry
          || typeof entry.event !== 'string'
          || !/^\d{8}$/.test(entry.event)
        ) {
          return [];
        }
        const chapters: Record<EventChapter, string[]> = { E: [], H: [] };
        const files: Record<EventChapter, Record<string, string>> = {
          E: {},
          H: {},
        };
        const eventChapters: EventChapter[] = ['E', 'H'];
        for (const chapter of eventChapters) {
          const maps = entry.chapters?.[chapter];
          if (!Array.isArray(maps)) continue;
          chapters[chapter] = maps
            .map(String)
            .filter(map => /^\d+(?:[ab])?$/.test(map));
          const chapterFiles = entry.files?.[chapter];
          if (!chapterFiles || typeof chapterFiles !== 'object') continue;
          for (const map of chapters[chapter]) {
            const file = chapterFiles[map];
            if (!isSafeMapFileName(file)) continue;
            files[chapter][map] = file;
            eventMapFiles.set(
              eventMapKey(entry.event, chapter, map),
              file,
            );
          }
        }
        const normalized: EventMapCatalogEntry = {
          event: entry.event,
          chapters,
        };
        if (
          Object.keys(files.E).length > 0
          || Object.keys(files.H).length > 0
        ) {
          normalized.files = files;
        }
        return [normalized];
      });
    })
    .catch(() => []);
  return eventCatalogPromise;
}

function normalizeEventNodeId(nodeId: string): string {
  return nodeId === 'α' || nodeId === 'β' ? '0' : nodeId;
}

/** 按 AutoWSGR 活动目录和原始文件名加载地图。 */
export async function loadEventMapData(
  eventName: string,
  chapter: number | string,
  map: number | string,
): Promise<MapData | null> {
  const match = String(map).trim().match(/^(\d+)([ab])?$/i);
  const rawDifficulty = String(chapter).trim().toUpperCase();
  const normalizedEvent = String(eventName).trim();
  if (
    !/^\d{8}$/.test(normalizedEvent)
    || !match
    || !['E', 'H'].includes(rawDifficulty)
  ) {
    return null;
  }
  const difficulty: EventChapter = rawDifficulty === 'E' ? 'E' : 'H';
  const stage = match[1];
  const entrance = match[2]?.toLowerCase() ?? '';
  const mapCode = `${stage}${entrance}`;
  const key = `event-${normalizedEvent}-${difficulty}-${mapCode}`;
  if (mapCache.has(key)) return mapCache.get(key)!;

  await loadEventMapCatalog();
  const canonicalFile = eventMapFiles.get(
    eventMapKey(normalizedEvent, difficulty, mapCode),
  );
  if (!canonicalFile) return null;
  const raw = await readMap(
    `resource/maps/event/${normalizedEvent}/${canonicalFile}`,
  );
  if (!raw) return null;

  const data: MapData = {};
  for (const [id, point] of Object.entries(raw)) {
    const normalizedId = normalizeEventNodeId(id);
    const position: [number, number] = (
      Array.isArray(point.position)
      && point.position.length === 2
    )
      ? [Number(point.position[0]), Number(point.position[1])]
      : [0, 0];
    data[normalizedId] = {
      type: normalizeEventNodeType(point.type),
      detour: !!point.detour,
      night: !!point.night,
      position,
      next: Array.isArray(point.next)
        ? point.next.map(node => normalizeEventNodeId(String(node)))
        : [],
    };
  }
  mapCache.set(key, data);
  return data;
}

/** 获取地图中某节点的类型，找不到则返回 'Normal' */
export function getNodeType(mapData: MapData, nodeId: string): MapNodeType {
  return mapData[nodeId]?.type ?? 'Normal';
}

/** 获取地图中某节点是否为迂回点 */
export function isDetourNode(mapData: MapData, nodeId: string): boolean {
  return mapData[nodeId]?.detour ?? false;
}

/** 获取地图中某节点是否为夜战点 */
export function isNightNode(mapData: MapData, nodeId: string): boolean {
  return mapData[nodeId]?.night ?? false;
}

/** 获取地图中某节点是否为终端节点（无后续节点，如 BOSS 点） */
export function isTerminalNode(mapData: MapData, nodeId: string): boolean {
  const next = mapData[nodeId]?.next;
  return !next || next.length === 0;
}
