"""Build and incrementally update the local ship library.

The updater reads the structured ship database from the Wiki Lua modules.
It reads the illustration, rarity background, frame, and type icon URLs from
the public ship index page instead of guessing resource names.
Internal table names, column names, and enum values are maintained in English.
Chinese source names are preserved only as game-facing display data.
Size and role filters are maintained as fixed groups of ship types.
Each ship is keyed by its stable in-game illustration index.
SQLite is the maintainable source for local queries and update bookkeeping.
A compact JSON manifest is generated for direct GUI consumption.
Shared rarity backgrounds, frames, and type icons are stored only once.
Asset downloads are atomic and retry failed requests.
Existing assets are skipped unless their source record changed or is missing.
Removed Wiki records are retained in SQLite and marked inactive.
The generated manifest contains active records only.
Every run records source revisions, hashes, counts, and validation results.
The final machine-readable result is printed for the Electron IPC caller.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

WIKI_ROOT = 'https://www.zjsnrwiki.com'
WIKI_API = f'{WIKI_ROOT}/api.php'
SHIP_INDEX_URL = (
    f'{WIKI_ROOT}/wiki/'
    '%E8%88%B0%E5%A8%98%E5%9B%BE%E9%89%B4'
)
DATABASE_MODULE = '模块:数据库/舰娘'
PATCH_MODULE = '模块:特殊数据/舰娘'
USER_AGENT = (
    'AutoWSGR-GUI ship-library-updater/1.0 '
    '(local incremental cache)'
)

TYPE_LABELS_ZH = {
    'ap': '补给舰',
    'av': '装甲航空母舰',
    'bb': '战列舰',
    'bbg': '导弹战列舰',
    'bbv': '航空战列舰',
    'bc': '战列巡洋舰',
    'bm': '浅水重炮舰',
    'ca': '重巡洋舰',
    'cav': '航空巡洋舰',
    'cbg': '导弹大型巡洋舰',
    'cf': '旗舰',
    'cg': '反舰导弹巡洋舰',
    'cgaa': '防空导弹巡洋舰',
    'cl': '轻巡洋舰',
    'clt': '重雷装巡洋舰',
    'cv': '航空母舰',
    'cvl': '轻型航空母舰',
    'dd': '驱逐舰',
    'ddg': '反舰导弹驱逐舰',
    'ddgaa': '防空导弹驱逐舰',
    'sc': '重炮潜艇',
    'ss': '潜水艇',
    'ssg': '导弹潜艇',
}
SIZE_LABELS_ZH = {
    'large': '大型舰',
    'medium': '中型舰',
    'small': '小型舰',
}
ROLE_LABELS_ZH = {
    'main_force': '主力舰',
    'escort': '护卫舰',
}
SIZE_TYPE_GROUPS = {
    'large': ('cv', 'av', 'bb', 'bbv', 'bc', 'cbg', 'bbg'),
    'medium': ('cvl', 'ca', 'cav', 'cl', 'clt', 'cg', 'cgaa', 'cf'),
    'small': ('dd', 'ddg', 'ddgaa', 'bm', 'ss', 'sc', 'ssg', 'ap'),
}
ROLE_TYPE_GROUPS = {
    'main_force': (
        'cv', 'av', 'bb', 'bbv', 'bc', 'cbg', 'bbg', 'cg', 'ddg', 'ssg',
    ),
    'escort': (
        'cvl', 'ca', 'cav', 'cl', 'clt', 'cgaa', 'cf',
        'dd', 'ddgaa', 'bm', 'ss', 'sc', 'ap',
    ),
}
COUNTRY_LABELS_ZH = {
    'china': '中国',
    'france': '法国',
    'germany': '德国',
    'italy': '意大利',
    'japan': '日本',
    'other': '其他',
    'soviet_union': '苏联',
    'united_kingdom': '英国',
    'united_states': '美国',
}

SHIP_BLOCK_RE = re.compile(
    r"ships\['((?:\\.|[^'])+)'\]\s*=\s*\{(.*?)\n\}",
    re.DOTALL,
)
PATCH_RE = re.compile(
    r"patchShips\(data,\s*'((?:\\.|[^'])+)',\s*"
    r"'([^']+)',\s*(?:'((?:\\.|[^'])*)'|(-?\d+(?:\.\d+)?))\)",
)


@dataclass(frozen=True)
class SourceRevision:
    title: str
    revision_id: int
    timestamp: str
    sha1: str
    content: str


@dataclass(frozen=True)
class AssetSpec:
    kind: str
    path: str
    url: str
    refresh: bool = False


@dataclass(frozen=True)
class ShipRecord:
    ship_id: int
    source_name: str
    display_name_zh: str
    search_name: str
    variant_code: str
    rarity: int
    ship_type_code: str
    size_class_code: str
    role_class_code: str
    country_code: str
    source_country_zh: str
    portrait_path: str
    background_path: str
    frame_path: str
    type_icon_path: str
    wiki_url: str
    portrait_url: str
    background_url: str
    frame_url: str
    type_icon_url: str
    source_hash: str


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def request_headers() -> dict[str, str]:
    return {
        'User-Agent': USER_AGENT,
        'Referer': f'{WIKI_ROOT}/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
    }


def fetch_revision(session: requests.Session, title: str) -> SourceRevision:
    response = session.get(
        WIKI_API,
        params={
            'action': 'query',
            'prop': 'revisions',
            'rvprop': 'ids|timestamp|sha1|content',
            'rvslots': 'main',
            'titles': title,
            'format': 'json',
            'formatversion': '2',
        },
        timeout=60,
    )
    response.raise_for_status()
    page = response.json()['query']['pages'][0]
    if page.get('missing'):
        raise RuntimeError(f'Wiki source page is missing: {title}')
    revision = page['revisions'][0]
    return SourceRevision(
        title=title,
        revision_id=int(revision['revid']),
        timestamp=str(revision['timestamp']),
        sha1=str(revision['sha1']),
        content=str(revision['slots']['main']['content']),
    )


def lua_unescape(value: str) -> str:
    return value.replace("\\'", "'").replace('\\\\', '\\')


def read_lua_field(body: str, key: str) -> str | None:
    match = re.search(
        rf"\b{re.escape(key)}\s*=\s*(?:'((?:\\.|[^'])*)'|"
        r'(-?\d+(?:\.\d+)?))',
        body,
    )
    if not match:
        return None
    return lua_unescape(match.group(1)) if match.group(1) is not None else match.group(2)


def parse_ship_module(
    database_source: str,
    patch_source: str,
) -> dict[int, dict[str, Any]]:
    by_name: dict[str, dict[str, Any]] = {}
    for match in SHIP_BLOCK_RE.finditer(database_source):
        name = lua_unescape(match.group(1))
        body = match.group(2)
        index = read_lua_field(body, 'index')
        rarity = read_lua_field(body, 'rarity')
        ship_type = read_lua_field(body, 'type')
        country = read_lua_field(body, 'country')
        size = read_lua_field(body, 'size')
        if None in (index, rarity, ship_type, country, size):
            raise ValueError(f'Incomplete Wiki ship record: {name}')
        by_name[name] = {
            'index': int(float(index)),
            'rarity': int(float(rarity)),
            'type': ship_type,
            'country': country,
            'size': size,
        }

    # The patch module is part of the Wiki data contract and overrides fields.
    for match in PATCH_RE.finditer(patch_source):
        name = lua_unescape(match.group(1))
        attribute = match.group(2)
        value = (
            lua_unescape(match.group(3))
            if match.group(3) is not None
            else match.group(4)
        )
        if name in by_name and attribute in by_name[name]:
            by_name[name][attribute] = value

    by_id = {int(data['index']): {'name': name, **data} for name, data in by_name.items()}
    if len(by_id) != len(by_name):
        raise ValueError('Duplicate ship indexes found in Wiki module')
    return by_id


def country_group(source_country: str) -> str:
    normalized = re.sub(r'\s+', '', source_country)
    direct = {
        '中国': 'china',
        '法国': 'france',
        '德国': 'germany',
        '意大利': 'italy',
        '日本': 'japan',
        '英国': 'united_kingdom',
        '美国': 'united_states',
    }
    if normalized in direct:
        return direct[normalized]
    if normalized in {'苏联', '沙俄'}:
        return 'soviet_union'
    return 'other'


def ship_type_groups(ship_type_code: str) -> tuple[str, str]:
    size_matches = [
        group
        for group, ship_types in SIZE_TYPE_GROUPS.items()
        if ship_type_code in ship_types
    ]
    role_matches = [
        group
        for group, ship_types in ROLE_TYPE_GROUPS.items()
        if ship_type_code in ship_types
    ]
    if len(size_matches) != 1 or len(role_matches) != 1:
        raise ValueError(
            f'Unsupported or duplicate ship type group: {ship_type_code}',
        )
    return size_matches[0], role_matches[0]


def variant_code(ship_id: int, source_name: str) -> str:
    if source_name.endswith('·改') or 1000 <= ship_id < 2000:
        return 'refit'
    if ship_id >= 8000:
        return 'special'
    return 'normal'


def search_name(source_name: str) -> str:
    return source_name[:-2] if source_name.endswith('·改') else source_name


def card_image_url(card: Any, pattern: str) -> str:
    for image in card.find_all('img'):
        source = str(image.get('src', ''))
        if re.search(pattern, source):
            return urljoin(WIKI_ROOT, source)
    raise ValueError(f'Card asset not found: {pattern}')


def build_ship_records(
    index_html: str,
    module_ships: dict[int, dict[str, Any]],
) -> list[ShipRecord]:
    soup = BeautifulSoup(index_html, 'html.parser')
    records: list[ShipRecord] = []
    portrait_pattern = re.compile(r'/M_NORMAL_WEBP/M_NORMAL_(\d+)\.webp$')

    for portrait in soup.find_all('img', src=portrait_pattern):
        portrait_url = urljoin(WIKI_ROOT, str(portrait['src']))
        ship_id = int(portrait_pattern.search(str(portrait['src'])).group(1))
        source = module_ships.get(ship_id)
        if not source:
            raise ValueError(f'Index ship {ship_id} is missing from Wiki module')
        card = portrait.find_parent(
            'div',
            style=lambda value: value and 'position: relative' in value,
        )
        if card is None:
            raise ValueError(f'Cannot locate ship card for index {ship_id}')

        background_url = card_image_url(card, r'/\d+star_bg\.webp$')
        frame_url = card_image_url(card, r'/\d+star_box\.webp$')
        type_icons = []
        for image in card.find_all('img'):
            image_url = urljoin(WIKI_ROOT, str(image.get('src', '')))
            file_name = image_url.rsplit('/', maxsplit=1)[-1]
            type_code = file_name.removesuffix('.webp').lower()
            if type_code in TYPE_LABELS_ZH:
                type_icons.append((type_code, image_url))
        if len(type_icons) != 1:
            raise ValueError(
                f'Expected one type icon for ship {ship_id}, got {type_icons}',
            )
        ship_type_code, type_icon_url = type_icons[0]

        anchor = portrait.find_parent('a')
        wiki_url = urljoin(WIKI_ROOT, str(anchor.get('href', ''))) if anchor else ''
        size_code, role_code = ship_type_groups(ship_type_code)
        source_name = str(source['name'])
        rarity = int(source['rarity'])
        data = {
            'ship_id': ship_id,
            'source_name': source_name,
            'display_name_zh': source_name,
            'search_name': search_name(source_name),
            'variant_code': variant_code(ship_id, source_name),
            'rarity': rarity,
            'ship_type_code': ship_type_code,
            'size_class_code': size_code,
            'role_class_code': role_code,
            'country_code': country_group(str(source['country'])),
            'source_country_zh': re.sub(r'\s+', '', str(source['country'])),
            'portrait_path': f'assets/portraits/{ship_id}.webp',
            'background_path': f'assets/backgrounds/rarity-{rarity}.webp',
            'frame_path': f'assets/frames/rarity-{rarity}.webp',
            'type_icon_path': f'assets/type-icons/{ship_type_code}.webp',
            'wiki_url': wiki_url,
            'portrait_url': portrait_url,
            'background_url': background_url,
            'frame_url': frame_url,
            'type_icon_url': type_icon_url,
        }
        source_hash = hashlib.sha256(
            json.dumps(data, ensure_ascii=False, sort_keys=True).encode('utf-8'),
        ).hexdigest()
        records.append(ShipRecord(**data, source_hash=source_hash))

    records.sort(key=lambda item: item.ship_id)
    if len({item.ship_id for item in records}) != len(records):
        raise ValueError('Duplicate ship indexes found on Wiki index page')
    return records


def open_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS ships (
            ship_id INTEGER PRIMARY KEY,
            source_name TEXT NOT NULL,
            display_name_zh TEXT NOT NULL,
            search_name TEXT NOT NULL,
            variant_code TEXT NOT NULL,
            rarity INTEGER NOT NULL,
            ship_type_code TEXT NOT NULL,
            size_class_code TEXT NOT NULL,
            role_class_code TEXT NOT NULL,
            country_code TEXT NOT NULL,
            source_country_zh TEXT NOT NULL,
            portrait_path TEXT NOT NULL,
            background_path TEXT NOT NULL,
            frame_path TEXT NOT NULL,
            type_icon_path TEXT NOT NULL,
            wiki_url TEXT NOT NULL,
            portrait_url TEXT NOT NULL,
            background_url TEXT NOT NULL,
            frame_url TEXT NOT NULL,
            type_icon_url TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            source_revision INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ships_display_name
            ON ships(display_name_zh);
        CREATE INDEX IF NOT EXISTS idx_ships_filters
            ON ships(ship_type_code, country_code, size_class_code, role_class_code);

        CREATE TABLE IF NOT EXISTS ship_type_groups (
            ship_type_code TEXT NOT NULL,
            group_kind TEXT NOT NULL,
            group_code TEXT NOT NULL,
            PRIMARY KEY (ship_type_code, group_kind)
        );

        CREATE INDEX IF NOT EXISTS idx_ship_type_groups_lookup
            ON ship_type_groups(group_kind, group_code);

        CREATE TABLE IF NOT EXISTS assets (
            path TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            url TEXT NOT NULL,
            etag TEXT,
            last_modified TEXT,
            sha256 TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sources (
            title TEXT PRIMARY KEY,
            revision_id INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            sha1 TEXT NOT NULL,
            checked_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_runs (
            run_id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            added_count INTEGER NOT NULL,
            updated_count INTEGER NOT NULL,
            removed_count INTEGER NOT NULL,
            downloaded_count INTEGER NOT NULL,
            failed_count INTEGER NOT NULL
        );
        """,
    )
    return connection


def asset_specs(
    records: list[ShipRecord],
    changed_ids: set[int],
) -> list[AssetSpec]:
    unique: dict[str, AssetSpec] = {}
    for record in records:
        values = (
            AssetSpec(
                'portrait',
                record.portrait_path,
                record.portrait_url,
                record.ship_id in changed_ids,
            ),
            AssetSpec('background', record.background_path, record.background_url),
            AssetSpec('frame', record.frame_path, record.frame_url),
            AssetSpec('type_icon', record.type_icon_path, record.type_icon_url),
        )
        for spec in values:
            current = unique.get(spec.path)
            unique[spec.path] = (
                spec
                if current is None
                else AssetSpec(
                    spec.kind,
                    spec.path,
                    spec.url,
                    current.refresh or spec.refresh,
                )
            )
    return sorted(unique.values(), key=lambda item: item.path)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download_asset(
    output: Path,
    spec: AssetSpec,
    previous: dict[str, Any] | None,
    force_assets: bool,
) -> tuple[AssetSpec, dict[str, Any] | None, str | None]:
    target = output / spec.path
    if (
        target.exists()
        and target.stat().st_size > 0
        and not force_assets
        and not spec.refresh
        and previous
        and previous.get('url') == spec.url
    ):
        return spec, None, None

    headers = request_headers()
    if target.exists() and previous and previous.get('url') == spec.url:
        if previous.get('etag'):
            headers['If-None-Match'] = str(previous['etag'])
        if previous.get('last_modified'):
            headers['If-Modified-Since'] = str(previous['last_modified'])

    error: str | None = None
    for attempt in range(3):
        try:
            response = requests.get(
                spec.url,
                headers=headers,
                timeout=45,
            )
            if response.status_code == 304 and target.exists():
                return spec, None, None
            response.raise_for_status()
            content_type = response.headers.get('content-type', '')
            is_webp = (
                target.suffix.lower() == '.webp'
                and response.content.startswith(b'RIFF')
                and response.content[8:12] == b'WEBP'
            )
            if len(response.content) < 100 or (
                'image/' not in content_type
                and not is_webp
            ):
                raise ValueError(
                    f'Unexpected asset response: {content_type}, '
                    f'{len(response.content)} bytes',
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(f'{target.suffix}.tmp')
            temporary.write_bytes(response.content)
            os.replace(temporary, target)
            metadata = {
                'path': spec.path,
                'kind': spec.kind,
                'url': spec.url,
                'etag': response.headers.get('etag'),
                'last_modified': response.headers.get('last-modified'),
                'sha256': hashlib.sha256(response.content).hexdigest(),
                'byte_size': len(response.content),
                'updated_at': utc_now(),
            }
            return spec, metadata, None
        except Exception as exc:  # Retry transient CDN or network failures.
            error = str(exc)
            time.sleep(0.6 * (attempt + 1))
    return spec, None, error


def download_assets(
    connection: sqlite3.Connection,
    output: Path,
    specs: list[AssetSpec],
    workers: int,
    force_assets: bool,
) -> tuple[list[dict[str, Any]], list[str], int]:
    previous = {
        str(row['path']): dict(row)
        for row in connection.execute('SELECT * FROM assets')
    }
    updates: list[dict[str, Any]] = []
    failures: list[str] = []
    downloaded = 0
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                download_asset,
                output,
                spec,
                previous.get(spec.path),
                force_assets,
            ): spec
            for spec in specs
        }
        completed = 0
        for future in as_completed(futures):
            spec, metadata, error = future.result()
            completed += 1
            if metadata:
                updates.append(metadata)
                downloaded += 1
            if error:
                failures.append(f'{spec.path}: {error}')
            if completed % 25 == 0 or completed == len(specs):
                print(
                    f'PROGRESS assets {completed}/{len(specs)} '
                    f'downloaded={downloaded} failed={len(failures)}',
                    flush=True,
                )
    return updates, failures, downloaded


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f'{path.suffix}.tmp')
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    os.replace(temporary, path)


def labels_manifest() -> dict[str, Any]:
    return {
        'locale': 'zh-CN',
        'ship_types': TYPE_LABELS_ZH,
        'size_classes': SIZE_LABELS_ZH,
        'role_classes': ROLE_LABELS_ZH,
        'countries': COUNTRY_LABELS_ZH,
        'variants': {
            'normal': '普通',
            'refit': '改造',
            'special': '特殊',
        },
    }


def type_groups_manifest() -> dict[str, dict[str, list[str]]]:
    return {
        'size_classes': {
            group: list(ship_types)
            for group, ship_types in SIZE_TYPE_GROUPS.items()
        },
        'role_classes': {
            group: list(ship_types)
            for group, ship_types in ROLE_TYPE_GROUPS.items()
        },
    }


def update_database(
    connection: sqlite3.Connection,
    records: list[ShipRecord],
    revisions: list[SourceRevision],
    asset_updates: list[dict[str, Any]],
    started_at: str,
    downloaded: int,
    failed_count: int,
) -> tuple[int, int, int]:
    now = utc_now()
    old_rows = {
        int(row['ship_id']): dict(row)
        for row in connection.execute(
            'SELECT ship_id, source_hash, is_active FROM ships',
        )
    }
    active_ids = {record.ship_id for record in records}
    added = sum(record.ship_id not in old_rows for record in records)
    updated = sum(
        record.ship_id in old_rows
        and old_rows[record.ship_id]['source_hash'] != record.source_hash
        for record in records
    )
    removed = sum(
        bool(row['is_active']) and ship_id not in active_ids
        for ship_id, row in old_rows.items()
    )

    with connection:
        connection.execute('UPDATE ships SET is_active = 0')
        connection.execute('DELETE FROM ship_type_groups')
        connection.executemany(
            """
            INSERT INTO ship_type_groups (
                ship_type_code, group_kind, group_code
            ) VALUES (?, 'size_class', ?)
            """,
            [
                (ship_type, group)
                for group, ship_types in SIZE_TYPE_GROUPS.items()
                for ship_type in ship_types
            ],
        )
        connection.executemany(
            """
            INSERT INTO ship_type_groups (
                ship_type_code, group_kind, group_code
            ) VALUES (?, 'role_class', ?)
            """,
            [
                (ship_type, group)
                for group, ship_types in ROLE_TYPE_GROUPS.items()
                for ship_type in ship_types
            ],
        )
        for record in records:
            values = asdict(record)
            connection.execute(
                """
                INSERT INTO ships (
                    ship_id, source_name, display_name_zh, search_name,
                    variant_code, rarity, ship_type_code, size_class_code,
                    role_class_code, country_code, source_country_zh,
                    portrait_path, background_path, frame_path, type_icon_path,
                    wiki_url, portrait_url, background_url, frame_url,
                    type_icon_url, source_hash, source_revision, is_active,
                    updated_at
                ) VALUES (
                    :ship_id, :source_name, :display_name_zh, :search_name,
                    :variant_code, :rarity, :ship_type_code, :size_class_code,
                    :role_class_code, :country_code, :source_country_zh,
                    :portrait_path, :background_path, :frame_path,
                    :type_icon_path, :wiki_url, :portrait_url,
                    :background_url, :frame_url, :type_icon_url, :source_hash,
                    :source_revision, 1, :updated_at
                )
                ON CONFLICT(ship_id) DO UPDATE SET
                    source_name = excluded.source_name,
                    display_name_zh = excluded.display_name_zh,
                    search_name = excluded.search_name,
                    variant_code = excluded.variant_code,
                    rarity = excluded.rarity,
                    ship_type_code = excluded.ship_type_code,
                    size_class_code = excluded.size_class_code,
                    role_class_code = excluded.role_class_code,
                    country_code = excluded.country_code,
                    source_country_zh = excluded.source_country_zh,
                    portrait_path = excluded.portrait_path,
                    background_path = excluded.background_path,
                    frame_path = excluded.frame_path,
                    type_icon_path = excluded.type_icon_path,
                    wiki_url = excluded.wiki_url,
                    portrait_url = excluded.portrait_url,
                    background_url = excluded.background_url,
                    frame_url = excluded.frame_url,
                    type_icon_url = excluded.type_icon_url,
                    source_hash = excluded.source_hash,
                    source_revision = excluded.source_revision,
                    is_active = 1,
                    updated_at = excluded.updated_at
                """,
                {
                    **values,
                    'source_revision': revisions[0].revision_id,
                    'updated_at': now,
                },
            )
        for asset in asset_updates:
            connection.execute(
                """
                INSERT INTO assets (
                    path, kind, url, etag, last_modified, sha256,
                    byte_size, updated_at
                ) VALUES (
                    :path, :kind, :url, :etag, :last_modified, :sha256,
                    :byte_size, :updated_at
                )
                ON CONFLICT(path) DO UPDATE SET
                    kind = excluded.kind,
                    url = excluded.url,
                    etag = excluded.etag,
                    last_modified = excluded.last_modified,
                    sha256 = excluded.sha256,
                    byte_size = excluded.byte_size,
                    updated_at = excluded.updated_at
                """,
                asset,
            )
        for revision in revisions:
            connection.execute(
                """
                INSERT INTO sources (
                    title, revision_id, timestamp, sha1, checked_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(title) DO UPDATE SET
                    revision_id = excluded.revision_id,
                    timestamp = excluded.timestamp,
                    sha1 = excluded.sha1,
                    checked_at = excluded.checked_at
                """,
                (
                    revision.title,
                    revision.revision_id,
                    revision.timestamp,
                    revision.sha1,
                    now,
                ),
            )
        connection.execute(
            """
            INSERT INTO sync_runs (
                started_at, completed_at, added_count, updated_count,
                removed_count, downloaded_count, failed_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                started_at,
                now,
                added,
                updated,
                removed,
                downloaded,
                failed_count,
            ),
        )
    return added, updated, removed


def manifest_ship(record: ShipRecord) -> dict[str, Any]:
    return {
        'id': record.ship_id,
        'name': record.display_name_zh,
        'search_name': record.search_name,
        'variant': record.variant_code,
        'rarity': record.rarity,
        'ship_type': record.ship_type_code,
        'size_class': record.size_class_code,
        'role_class': record.role_class_code,
        'country': record.country_code,
        'portrait': record.portrait_path,
        'background': record.background_path,
        'frame': record.frame_path,
        'type_icon': record.type_icon_path,
        'wiki_url': record.wiki_url,
    }


def validate_assets(output: Path, specs: list[AssetSpec]) -> list[str]:
    return [
        spec.path
        for spec in specs
        if not (output / spec.path).is_file()
        or (output / spec.path).stat().st_size == 0
    ]


def run(args: argparse.Namespace) -> dict[str, Any]:
    started_at = utc_now()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(request_headers())

    print('PROGRESS sources fetching Wiki data', flush=True)
    database_revision = fetch_revision(session, DATABASE_MODULE)
    patch_revision = fetch_revision(session, PATCH_MODULE)
    index_response = session.get(SHIP_INDEX_URL, timeout=60)
    index_response.raise_for_status()
    index_response.encoding = 'utf-8'

    module_ships = parse_ship_module(
        database_revision.content,
        patch_revision.content,
    )
    records = build_ship_records(index_response.text, module_ships)
    if not records:
        raise RuntimeError('Wiki index returned no ship records')
    print(f'PROGRESS records parsed={len(records)}', flush=True)

    database_path = output / 'database' / 'ships.sqlite3'
    connection = open_database(database_path)
    try:
        previous_hashes = {
            int(row['ship_id']): str(row['source_hash'])
            for row in connection.execute('SELECT ship_id, source_hash FROM ships')
        }
        changed_ids = {
            record.ship_id
            for record in records
            if previous_hashes.get(record.ship_id) != record.source_hash
        }
        specs = asset_specs(records, changed_ids)
        asset_updates, download_failures, downloaded = download_assets(
            connection,
            output,
            specs,
            max(1, min(16, int(args.workers))),
            bool(args.force_assets),
        )
        missing_assets = validate_assets(output, specs)
        failed_paths = sorted({
            *missing_assets,
            *(failure.partition(': ')[0] for failure in download_failures),
        })
        failure_details = sorted(set(
            download_failures
            + [
                path
                for path in missing_assets
                if not any(
                    failure.startswith(f'{path}: ')
                    for failure in download_failures
                )
            ]
        ))
        added, updated, removed = update_database(
            connection,
            records,
            [database_revision, patch_revision],
            asset_updates,
            started_at,
            downloaded,
            len(failed_paths),
        )
    finally:
        connection.close()

    generated_at = utc_now()
    labels = labels_manifest()
    manifest = {
        'schema_version': 2,
        'generated_at': generated_at,
        'source': {
            'wiki': WIKI_ROOT,
            'index_url': SHIP_INDEX_URL,
            'database_revision': database_revision.revision_id,
            'patch_revision': patch_revision.revision_id,
        },
        'counts': {
            'ships': len(records),
            'assets': len(specs),
            'missing_assets': len(missing_assets),
        },
        'labels': labels,
        'type_groups': type_groups_manifest(),
        'ships': [manifest_ship(record) for record in records],
    }
    write_json_atomic(output / 'manifest.json', manifest)
    write_json_atomic(output / 'labels.zh-CN.json', labels)

    return {
        'success': not failed_paths,
        'output': str(output),
        'generated_at': generated_at,
        'ship_count': len(records),
        'asset_count': len(specs),
        'added': added,
        'updated': updated,
        'removed': removed,
        'downloaded': downloaded,
        'failed': len(failed_paths),
        'failures': failure_details[:20],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Incrementally update the AutoWSGR GUI ship library.',
    )
    parser.add_argument(
        '--output',
        required=True,
        help='Ship library output directory.',
    )
    parser.add_argument(
        '--workers',
        type=int,
        default=8,
        help='Concurrent asset downloads (default: 8).',
    )
    parser.add_argument(
        '--force-assets',
        action='store_true',
        help='Conditionally verify every existing asset.',
    )
    return parser.parse_args()


def main() -> int:
    try:
        result = run(parse_args())
    except Exception as exc:
        result = {
            'success': False,
            'error': f'{type(exc).__name__}: {exc}',
        }
    print(
        'RESULT_JSON=' + json.dumps(result, ensure_ascii=False),
        flush=True,
    )
    return 0 if result.get('success') else 1


if __name__ == '__main__':
    sys.exit(main())
