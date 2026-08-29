"""Deterministic tests for the standalone map-intelligence synchronizer."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sync_map_intel import (
    DEFAULT_DATA_URL,
    SyncError,
    ValidationError,
    _read_snapshot,
    _atomic_write_json,
    collect_maps,
    publish_snapshot,
    update_snapshot,
)


def sample_map(map_id: int = 1) -> dict[str, object]:
    start_id = map_id * 100 + 1
    boss_id = map_id * 100 + 2
    return {
        "id": map_id,
        "title": f"Test-{map_id}",
        "mapName": f"Test map {map_id}",
        "mapType": "NORMAL_MAP",
        "initNodeId": start_id,
        "release": True,
        "nodes": [
            {
                "id": boss_id,
                "flag": "A",
                "nodeType": "BOSS",
                "roundabout": False,
                "nightAtk": False,
                "drop": [1001],
                "formation": [
                    {
                        "id": 7001,
                        "formation": 4,
                        "ships": [
                            {
                                "id": 9001,
                                "title": "Enemy",
                                "shipType": "DD",
                                "country": "UNKNOWN",
                                "star": 5,
                                "speed": 35,
                                "deepSea": True,
                            },
                        ],
                    },
                ],
                "nodeRouter": [],
            },
            {
                "id": start_id,
                "flag": "0",
                "nodeType": "START",
                "roundabout": False,
                "nightAtk": False,
                "drop": [],
                "formation": [],
                "nodeRouter": [
                    {
                        "id": boss_id,
                        "passCount": 1,
                        "weight": 100,
                        "showBy": [],
                        "missBy": [],
                        "garrisonShowBy": [],
                        "garrisonMissBy": [],
                        "conditions": [
                            {
                                "number": 1,
                                "shipType": "DD",
                                "routeType": "SHIP_TYPE_COUNT_GE",
                            },
                        ],
                    },
                ],
            },
        ],
    }


def page(
    total: int,
    maps: list[dict[str, object]],
    has_next: bool,
    cursor: str | None,
) -> dict[str, object]:
    return {
        "totalCount": total,
        "pageInfo": {
            "hasNextPage": has_next,
            "endCursor": cursor,
        },
        "nodes": maps,
    }


class MapIntelSyncTest(unittest.TestCase):
    def test_collects_all_pages_and_only_sorts_maps_and_nodes(self) -> None:
        first_map = sample_map(1)
        first_map["nodes"][1]["nodeRouter"][0]["conditions"][0] = {
            "number": 26.9,
            "shipType": "ALL",
            "routeType": "SPEED_MIN_LE",
        }
        pages = {
            None: page(2, [sample_map(2)], True, "next"),
            "next": page(2, [first_map], False, None),
        }

        maps = collect_maps(lambda cursor: pages[cursor])

        self.assertEqual([item["id"] for item in maps], [1, 2])
        self.assertEqual(
            [node["flag"] for node in maps[0]["nodes"]],
            ["0", "A"],
        )
        self.assertEqual(
            maps[0]["nodes"][0]["nodeRouter"][0]["conditions"][0]["routeType"],
            "SPEED_MIN_LE",
        )

    def test_rejects_pagination_that_makes_no_progress(self) -> None:
        calls = 0

        def fetch_page(_: str | None) -> dict[str, object]:
            nonlocal calls
            calls += 1
            if calls > 1:
                raise AssertionError("requested another empty page")
            return page(1, [], True, "next")

        with self.assertRaisesRegex(
            ValidationError,
            "must contain maps when another page exists",
        ):
            collect_maps(fetch_page)

    def test_unchanged_data_reuses_one_content_addressed_snapshot(self) -> None:
        maps = collect_maps(
            lambda _: page(1, [sample_map()], False, None),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)

            first = publish_snapshot(
                maps,
                output_dir,
                DEFAULT_DATA_URL,
                "CN",
                "2026-08-10T00:00:00Z",
            )
            latest_before = (output_dir / "latest.json").read_bytes()
            second = publish_snapshot(
                maps,
                output_dir,
                DEFAULT_DATA_URL,
                "CN",
                "2026-08-11T00:00:00Z",
            )

            self.assertEqual(first["status"], "updated")
            self.assertEqual(second["status"], "unchanged")
            self.assertEqual(
                len(list((output_dir / "snapshots").glob("*.json"))),
                1,
            )
            self.assertEqual(
                (output_dir / "latest.json").read_bytes(),
                latest_before,
            )

    def test_rejects_snapshot_with_inconsistent_metadata(self) -> None:
        maps = collect_maps(
            lambda _: page(1, [sample_map()], False, None),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            publish_snapshot(
                maps,
                output_dir,
                DEFAULT_DATA_URL,
                "CN",
            )
            latest_path = output_dir / "latest.json"
            document = json.loads(latest_path.read_text(encoding="utf-8"))
            document["counts"]["maps"] = 999
            latest_path.write_text(
                json.dumps(document, ensure_ascii=False),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ValidationError,
                "counts do not match maps",
            ):
                _read_snapshot(latest_path)

    def test_invalid_download_does_not_replace_last_good_snapshot(self) -> None:
        maps = collect_maps(
            lambda _: page(1, [sample_map()], False, None),
        )
        invalid_maps = copy.deepcopy(maps)
        invalid_maps[0]["nodes"][0]["nodeRouter"][0]["id"] = 999999

        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            publish_snapshot(
                maps,
                output_dir,
                DEFAULT_DATA_URL,
                "CN",
            )
            latest_before = (output_dir / "latest.json").read_bytes()

            with self.assertRaisesRegex(
                ValidationError,
                "references missing node id",
            ):
                publish_snapshot(
                    invalid_maps,
                    output_dir,
                    DEFAULT_DATA_URL,
                    "CN",
                )

            self.assertEqual(
                (output_dir / "latest.json").read_bytes(),
                latest_before,
            )

    def test_empty_download_does_not_replace_last_good_snapshot(self) -> None:
        maps = collect_maps(
            lambda _: page(1, [sample_map()], False, None),
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            publish_snapshot(
                maps,
                output_dir,
                DEFAULT_DATA_URL,
                "CN",
            )
            latest_before = (output_dir / "latest.json").read_bytes()

            with self.assertRaisesRegex(
                ValidationError,
                "maps must not be empty",
            ):
                publish_snapshot(
                    [],
                    output_dir,
                    DEFAULT_DATA_URL,
                    "CN",
                )

            self.assertEqual(
                (output_dir / "latest.json").read_bytes(),
                latest_before,
            )

    def test_non_finite_route_weight_does_not_publish_snapshot(self) -> None:
        for weight in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(weight=weight):
                invalid_map = sample_map()
                invalid_map["nodes"][1]["nodeRouter"][0]["weight"] = weight

                with tempfile.TemporaryDirectory() as temp_dir:
                    output_dir = Path(temp_dir)
                    with self.assertRaisesRegex(
                        ValidationError,
                        "weight must be a finite number",
                    ):
                        publish_snapshot(
                            [invalid_map],
                            output_dir,
                            DEFAULT_DATA_URL,
                            "CN",
                        )

                    self.assertFalse((output_dir / "latest.json").exists())

    def test_non_finite_raw_value_does_not_publish_invalid_json(self) -> None:
        invalid_map = sample_map()
        invalid_map["nodes"][0]["drop"] = [float("nan")]

        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            with self.assertRaisesRegex(
                ValidationError,
                "strict JSON values",
            ):
                publish_snapshot(
                    [invalid_map],
                    output_dir,
                    DEFAULT_DATA_URL,
                    "CN",
                )

            self.assertFalse((output_dir / "latest.json").exists())

    def test_missing_initial_node_does_not_publish_snapshot(self) -> None:
        invalid_map = sample_map()
        invalid_map["initNodeId"] = 999999

        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            with self.assertRaisesRegex(
                ValidationError,
                "initNodeId references missing node id",
            ):
                publish_snapshot(
                    [invalid_map],
                    output_dir,
                    DEFAULT_DATA_URL,
                    "CN",
                )

            self.assertFalse((output_dir / "latest.json").exists())

    def test_invalid_timeout_is_rejected_before_request(self) -> None:
        for timeout in (0.0, -1.0, float("nan"), float("inf")):
            with self.subTest(timeout=timeout):
                with tempfile.TemporaryDirectory() as temp_dir:
                    with self.assertRaisesRegex(
                        SyncError,
                        "timeout must be a finite number greater than zero",
                    ):
                        update_snapshot(
                            DEFAULT_DATA_URL,
                            "CN",
                            Path(temp_dir),
                            timeout,
                        )

    def test_atomic_replace_failure_keeps_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "latest.json"
            target.write_text('{"old":true}\n', encoding="utf-8")

            with mock.patch(
                "sync_map_intel.os.replace",
                side_effect=OSError("replace failed"),
            ):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    _atomic_write_json(target, {"new": True})

            self.assertEqual(
                json.loads(target.read_text(encoding="utf-8")),
                {"old": True},
            )
            self.assertEqual(list(target.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
