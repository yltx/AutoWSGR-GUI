"""Download and publish validated AutoNoelle map-intelligence snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


DEFAULT_DATA_URL = "https://data.auto.noelle.cool/GameData"
SNAPSHOT_SCHEMA_VERSION = 1
PAGE_SIZE = 100
MAX_ATTEMPTS = 3
RETRYABLE_HTTP_CODES = {408, 429, 500, 502, 503, 504}

MAPS_QUERY = """
query Maps($scope: String!, $first: Int!, $after: String) {
  maps(scope: $scope, first: $first, after: $after) {
    totalCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      title
      mapName
      mapType
      initNodeId
      release
      nodes {
        id
        flag
        nodeType
        roundabout
        nightAtk
        drop
        formation {
          id
          formation
          ships {
            id
            title
            shipType
            country
            star
            speed
            deepSea
          }
        }
        nodeRouter {
          id
          passCount
          weight
          showBy
          missBy
          garrisonShowBy
          garrisonMissBy
          conditions {
            number
            shipType
            routeType
          }
        }
      }
    }
  }
}
""".strip()


class SyncError(RuntimeError):
    """Raised when the remote contract or local snapshot is unsafe to publish."""


class ValidationError(SyncError):
    """Raised when downloaded data violates the snapshot contract."""


FetchPage = Callable[[str | None], dict[str, object]]


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _post_graphql(
    data_url: str,
    variables: dict[str, object],
    timeout_seconds: float,
) -> dict[str, object]:
    body = _canonical_bytes({"query": MAPS_QUERY, "variables": variables})
    request = urllib.request.Request(
        data_url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "AutoWSGR-map-intel-sync/1",
        },
        method="POST",
    )

    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            _require(isinstance(payload, dict), "GraphQL response must be an object")
            return payload
        except urllib.error.HTTPError as error:
            if error.code not in RETRYABLE_HTTP_CODES or attempt == MAX_ATTEMPTS:
                detail = error.read().decode("utf-8", errors="replace")[:500]
                raise SyncError(
                    f"GraphQL HTTP {error.code}: {detail or error.reason}",
                ) from error
            last_error = error
        except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
            if attempt == MAX_ATTEMPTS:
                raise SyncError(f"GraphQL request failed: {error}") from error
            last_error = error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SyncError(f"GraphQL returned invalid JSON: {error}") from error

        time.sleep(0.5 * (2 ** (attempt - 1)))

    raise SyncError(f"GraphQL request failed: {last_error}")


def request_maps_page(
    data_url: str,
    scope: str,
    cursor: str | None,
    timeout_seconds: float,
) -> dict[str, object]:
    payload = _post_graphql(
        data_url,
        {
            "scope": scope,
            "first": PAGE_SIZE,
            "after": cursor,
        },
        timeout_seconds,
    )
    errors = payload.get("errors")
    if errors:
        raise SyncError(
            "GraphQL contract error: "
            + json.dumps(errors, ensure_ascii=False, separators=(",", ":")),
        )

    data = payload.get("data")
    _require(isinstance(data, dict), "GraphQL response is missing data")
    connection = data.get("maps")
    _require(isinstance(connection, dict), "GraphQL response is missing data.maps")
    return connection


def collect_maps(fetch_page: FetchPage) -> list[dict[str, object]]:
    maps: list[dict[str, object]] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    expected_total: int | None = None

    while True:
        connection = fetch_page(cursor)
        total_count = connection.get("totalCount")
        page_info = connection.get("pageInfo")
        page_maps = connection.get("nodes")

        _require(_is_int(total_count), "maps.totalCount must be an integer")
        _require(total_count >= 0, "maps.totalCount must not be negative")
        _require(isinstance(page_info, dict), "maps.pageInfo must be an object")
        _require(isinstance(page_maps, list), "maps.nodes must be an array")

        if expected_total is None:
            expected_total = total_count
        else:
            _require(
                total_count == expected_total,
                "maps.totalCount changed during pagination",
            )

        has_next_page = page_info.get("hasNextPage")
        end_cursor = page_info.get("endCursor")
        _require(
            isinstance(has_next_page, bool),
            "pageInfo.hasNextPage must be a boolean",
        )
        _require(
            not has_next_page or bool(page_maps),
            "maps.nodes must contain maps when another page exists",
        )
        for item in page_maps:
            _require(isinstance(item, dict), "each map must be an object")
            maps.append(item)
        _require(
            len(maps) <= expected_total,
            "downloaded more maps than maps.totalCount",
        )

        if not has_next_page:
            break

        _require(
            isinstance(end_cursor, str) and bool(end_cursor),
            "pageInfo.endCursor is required when another page exists",
        )
        _require(end_cursor not in seen_cursors, "pagination cursor repeated")
        seen_cursors.add(end_cursor)
        cursor = end_cursor

    _require(expected_total is not None, "map query returned no connection")
    _require(
        len(maps) == expected_total,
        f"expected {expected_total} maps but downloaded {len(maps)}",
    )

    normalized = sorted(
        maps,
        key=lambda item: item.get("id") if _is_int(item.get("id")) else -1,
    )
    for map_data in normalized:
        nodes = map_data.get("nodes")
        if isinstance(nodes, list):
            map_data["nodes"] = sorted(
                nodes,
                key=lambda item: (
                    item.get("id")
                    if isinstance(item, dict) and _is_int(item.get("id"))
                    else -1
                ),
            )

    validate_maps(normalized)
    return normalized


def validate_maps(maps: object) -> dict[str, int]:
    _require(isinstance(maps, list), "maps must be an array")
    _require(bool(maps), "maps must not be empty")
    map_ids: set[int] = set()
    counts = {
        "maps": len(maps),
        "released_maps": 0,
        "nodes": 0,
        "routes": 0,
        "route_conditions": 0,
        "enemy_formations": 0,
        "enemy_ships": 0,
    }

    for map_index, map_data in enumerate(maps):
        path = f"maps[{map_index}]"
        _require(isinstance(map_data, dict), f"{path} must be an object")
        map_id = map_data.get("id")
        _require(_is_int(map_id), f"{path}.id must be an integer")
        _require(map_id not in map_ids, f"duplicate map id {map_id}")
        map_ids.add(map_id)
        _require(
            isinstance(map_data.get("title"), str) and bool(map_data["title"]),
            f"{path}.title must be a non-empty string",
        )
        _require(
            map_data.get("mapName") is None
            or isinstance(map_data.get("mapName"), str),
            f"{path}.mapName must be a string or null",
        )
        _require(
            isinstance(map_data.get("mapType"), str),
            f"{path}.mapType must be a string",
        )
        _require(
            _is_int(map_data.get("initNodeId")),
            f"{path}.initNodeId must be an integer",
        )
        _require(
            isinstance(map_data.get("release"), bool),
            f"{path}.release must be a boolean",
        )
        if map_data["release"]:
            counts["released_maps"] += 1

        nodes = map_data.get("nodes")
        _require(isinstance(nodes, list), f"{path}.nodes must be an array")
        node_ids: set[int] = set()
        node_flags: set[str] = set()
        for node_index, node in enumerate(nodes):
            node_path = f"{path}.nodes[{node_index}]"
            _require(isinstance(node, dict), f"{node_path} must be an object")
            node_id = node.get("id")
            flag = node.get("flag")
            _require(_is_int(node_id), f"{node_path}.id must be an integer")
            _require(node_id not in node_ids, f"duplicate node id {node_id}")
            node_ids.add(node_id)
            _require(
                isinstance(flag, str) and bool(flag),
                f"{node_path}.flag must be a non-empty string",
            )
            _require(flag not in node_flags, f"duplicate node flag {flag!r}")
            node_flags.add(flag)
            _require(
                isinstance(node.get("nodeType"), str),
                f"{node_path}.nodeType must be a string",
            )
            _require(
                isinstance(node.get("roundabout"), bool),
                f"{node_path}.roundabout must be a boolean",
            )
            _require(
                isinstance(node.get("nightAtk"), bool),
                f"{node_path}.nightAtk must be a boolean",
            )
            _require(isinstance(node.get("drop"), list), f"{node_path}.drop must be an array")

            formations = node.get("formation")
            routes = node.get("nodeRouter")
            _require(
                isinstance(formations, list),
                f"{node_path}.formation must be an array",
            )
            _require(
                isinstance(routes, list),
                f"{node_path}.nodeRouter must be an array",
            )
            counts["nodes"] += 1

            for formation_index, formation in enumerate(formations):
                formation_path = f"{node_path}.formation[{formation_index}]"
                _require(
                    isinstance(formation, dict),
                    f"{formation_path} must be an object",
                )
                _require(
                    _is_int(formation.get("id")),
                    f"{formation_path}.id must be an integer",
                )
                _require(
                    _is_int(formation.get("formation")),
                    f"{formation_path}.formation must be an integer",
                )
                ships = formation.get("ships")
                _require(
                    isinstance(ships, list),
                    f"{formation_path}.ships must be an array",
                )
                counts["enemy_formations"] += 1
                counts["enemy_ships"] += len(ships)
                for ship_index, ship in enumerate(ships):
                    ship_path = f"{formation_path}.ships[{ship_index}]"
                    _require(isinstance(ship, dict), f"{ship_path} must be an object")
                    _require(
                        _is_int(ship.get("id")),
                        f"{ship_path}.id must be an integer",
                    )
                    _require(
                        isinstance(ship.get("title"), str),
                        f"{ship_path}.title must be a string",
                    )
                    _require(
                        isinstance(ship.get("shipType"), str),
                        f"{ship_path}.shipType must be a string",
                    )
                    _require(
                        isinstance(ship.get("country"), str),
                        f"{ship_path}.country must be a string",
                    )
                    _require(
                        _is_int(ship.get("star")),
                        f"{ship_path}.star must be an integer",
                    )
                    _require(
                        _is_int(ship.get("speed")),
                        f"{ship_path}.speed must be an integer",
                    )
                    _require(
                        isinstance(ship.get("deepSea"), bool),
                        f"{ship_path}.deepSea must be a boolean",
                    )

            for route_index, route in enumerate(routes):
                route_path = f"{node_path}.nodeRouter[{route_index}]"
                _require(isinstance(route, dict), f"{route_path} must be an object")
                _require(
                    _is_int(route.get("id")),
                    f"{route_path}.id must be an integer",
                )
                for field in (
                    "showBy",
                    "missBy",
                    "garrisonShowBy",
                    "garrisonMissBy",
                ):
                    _require(
                        isinstance(route.get(field), list),
                        f"{route_path}.{field} must be an array",
                    )
                _require(
                    _is_int(route.get("passCount")),
                    f"{route_path}.passCount must be an integer",
                )
                _require(
                    isinstance(route.get("weight"), (int, float))
                    and not isinstance(route.get("weight"), bool)
                    and math.isfinite(route["weight"]),
                    f"{route_path}.weight must be a finite number",
                )
                conditions = route.get("conditions")
                _require(
                    isinstance(conditions, list),
                    f"{route_path}.conditions must be an array",
                )
                counts["routes"] += 1
                counts["route_conditions"] += len(conditions)
                for condition_index, condition in enumerate(conditions):
                    condition_path = (
                        f"{route_path}.conditions[{condition_index}]"
                    )
                    _require(
                        isinstance(condition, dict),
                        f"{condition_path} must be an object",
                    )
                    _require(
                        isinstance(condition.get("number"), (int, float))
                        and not isinstance(condition.get("number"), bool)
                        and math.isfinite(condition["number"]),
                        f"{condition_path}.number must be a finite number",
                    )
                    _require(
                        isinstance(condition.get("shipType"), str),
                        f"{condition_path}.shipType must be a string",
                    )
                    _require(
                        isinstance(condition.get("routeType"), str),
                        f"{condition_path}.routeType must be a string",
                    )

        _require(
            map_data["initNodeId"] in node_ids,
            (
                f"{path}.initNodeId references missing node id "
                f"{map_data['initNodeId']}"
            ),
        )
        for node_index, node in enumerate(nodes):
            for route_index, route in enumerate(node["nodeRouter"]):
                target_id = route["id"]
                _require(
                    target_id in node_ids,
                    (
                        f"{path}.nodes[{node_index}].nodeRouter[{route_index}] "
                        f"references missing node id {target_id}"
                    ),
                )

    try:
        _canonical_bytes(maps)
    except (TypeError, ValueError) as error:
        raise ValidationError(
            "maps must contain only strict JSON values",
        ) from error
    return counts


def _snapshot_document(
    maps: list[dict[str, object]],
    data_url: str,
    scope: str,
    fetched_at: str,
) -> dict[str, object]:
    counts = validate_maps(maps)
    data_sha256 = hashlib.sha256(_canonical_bytes(maps)).hexdigest()
    query_sha256 = hashlib.sha256(MAPS_QUERY.encode("utf-8")).hexdigest()
    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "source": {
            "data_url": data_url,
            "scope": scope,
            "fetched_at": fetched_at,
            "query_sha256": query_sha256,
        },
        "data_sha256": data_sha256,
        "counts": counts,
        "maps": maps,
    }


def _read_snapshot(path: Path) -> dict[str, object]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SyncError(f"cannot read existing snapshot {path}: {error}") from error

    _require(isinstance(document, dict), f"{path} must contain an object")
    _require(
        document.get("schema_version") == SNAPSHOT_SCHEMA_VERSION,
        f"{path} uses an unsupported schema version",
    )
    source = document.get("source")
    _require(isinstance(source, dict), f"{path}.source must be an object")
    for field in ("data_url", "scope", "fetched_at"):
        _require(
            isinstance(source.get(field), str) and bool(source[field]),
            f"{path}.source.{field} must be a non-empty string",
        )
    _require(
        _is_sha256(source.get("query_sha256")),
        f"{path}.source.query_sha256 must be a SHA-256 hash",
    )
    maps = document.get("maps")
    expected_counts = validate_maps(maps)
    _require(
        document.get("counts") == expected_counts,
        f"{path} counts do not match maps",
    )
    actual_hash = hashlib.sha256(_canonical_bytes(maps)).hexdigest()
    _require(
        document.get("data_sha256") == actual_hash,
        f"{path} failed its data_sha256 check",
    )
    return document


def _atomic_write_json(path: Path, document: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temp_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(
                document,
                handle,
                allow_nan=False,
                ensure_ascii=False,
                indent=2,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def _map_diff(
    previous: dict[str, object] | None,
    current_maps: list[dict[str, object]],
) -> dict[str, list[int]]:
    previous_maps = previous.get("maps", []) if previous else []
    _require(isinstance(previous_maps, list), "previous maps must be an array")
    old_by_id = {item["id"]: item for item in previous_maps}
    new_by_id = {item["id"]: item for item in current_maps}
    old_ids = set(old_by_id)
    new_ids = set(new_by_id)
    changed = sorted(
        map_id
        for map_id in old_ids & new_ids
        if _canonical_bytes(old_by_id[map_id])
        != _canonical_bytes(new_by_id[map_id])
    )
    return {
        "added_map_ids": sorted(new_ids - old_ids),
        "removed_map_ids": sorted(old_ids - new_ids),
        "changed_map_ids": changed,
    }


def publish_snapshot(
    maps: list[dict[str, object]],
    output_dir: Path,
    data_url: str,
    scope: str,
    fetched_at: str | None = None,
) -> dict[str, object]:
    document = _snapshot_document(
        maps,
        data_url,
        scope,
        fetched_at or _utc_now(),
    )
    latest_path = output_dir / "latest.json"
    previous = _read_snapshot(latest_path) if latest_path.exists() else None
    data_sha256 = document["data_sha256"]
    _require(isinstance(data_sha256, str), "snapshot hash must be a string")
    snapshot_path = output_dir / "snapshots" / f"{data_sha256}.json"

    if snapshot_path.exists():
        archived = _read_snapshot(snapshot_path)
        _require(
            archived.get("data_sha256") == data_sha256,
            f"snapshot archive collision at {snapshot_path}",
        )
    else:
        _atomic_write_json(snapshot_path, document)

    if previous and previous.get("data_sha256") == data_sha256:
        status = "unchanged"
    else:
        _atomic_write_json(latest_path, document)
        status = "updated"

    return {
        "status": status,
        "data_sha256": data_sha256,
        "counts": document["counts"],
        **_map_diff(previous, maps),
        "latest": str(latest_path.resolve()),
        "snapshot": str(snapshot_path.resolve()),
    }


def update_snapshot(
    data_url: str,
    scope: str,
    output_dir: Path,
    timeout_seconds: float,
) -> dict[str, object]:
    parsed_url = urllib.parse.urlparse(data_url)
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        raise SyncError("data URL must be an absolute HTTPS URL")
    if not scope:
        raise SyncError("scope must not be empty")
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise SyncError("timeout must be a finite number greater than zero")

    maps = collect_maps(
        lambda cursor: request_maps_page(
            data_url,
            scope,
            cursor,
            timeout_seconds,
        ),
    )
    return publish_snapshot(maps, output_dir, data_url, scope)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download all map routes and enemy formations into validated, "
            "content-addressed JSON snapshots."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Snapshot output directory; project resource directories are not implied.",
    )
    parser.add_argument(
        "--scope",
        default="CN",
        help="Game-data scope passed to GraphQL (default: CN).",
    )
    parser.add_argument(
        "--data-url",
        default=DEFAULT_DATA_URL,
        help=f"GraphQL endpoint (default: {DEFAULT_DATA_URL}).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Timeout for each HTTP attempt in seconds (default: 30).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    try:
        result = update_snapshot(
            args.data_url,
            args.scope,
            args.output,
            args.timeout,
        )
    except (SyncError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(
        "RESULT_JSON="
        + json.dumps(result, ensure_ascii=False, separators=(",", ":")),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
