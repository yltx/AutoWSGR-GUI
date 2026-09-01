"""OCR 日志分析开发者工具测试。"""

from __future__ import annotations

import csv
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import ocr_log_analyzer


def _log_line(timestamp: str, message: str) -> str:
    return (
        f"{timestamp} | INFO     | ui/battle/fleet_change/_detect.py:184 | {message}\n"
    )


def _sample_log() -> str:
    return "".join(
        [
            _log_line(
                "09:34:08.048",
                "[准备页] 根据主选优先规则确定目标编成: ['U-47', 'U-81', 'Z1', None, None, None]",
            ),
            _log_line(
                "09:34:47.806",
                "[准备页] 编队 OCR 识别: "
                "[{'slot': 0, 'raw': '0.47.狼群', "
                "'patched': 'U.47.狼群', 'matched': None}, "
                "{'slot': 1, 'raw': '0-81', "
                "'patched': 'U-81', 'matched': 'U-81'}, "
                "{'slot': 2, 'raw': 'Z1', "
                "'patched': 'Z1', 'matched': 'Z1'}]",
            ),
        ],
    )


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as csv_file:
        return list(csv.DictReader(csv_file))


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


class OcrLogAnalyzerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.temp_path = Path(self.temporary_directory.name)

    def test_extracts_structured_ocr_and_deduplicates_logs(self) -> None:
        debug_log = self.temp_path / "autowsgr_2026-08-05.debug.log"
        info_log = self.temp_path / "autowsgr_2026-08-05.2.log"
        debug_log.write_text(_sample_log(), encoding="utf-8")
        info_log.write_text(_sample_log(), encoding="utf-8")

        observations, stats = ocr_log_analyzer.extract_observations(
            [debug_log, info_log],
        )

        self.assertEqual(stats.files, 2)
        self.assertEqual(stats.structured_events, 2)
        self.assertEqual(stats.observations, 3)
        self.assertEqual(stats.duplicates, 3)
        self.assertEqual(stats.parse_errors, 0)
        self.assertEqual(observations[0].event_time, "2026-08-05 09:34:47.806")
        self.assertEqual(observations[0].raw_text, "0.47.狼群")
        self.assertEqual(observations[0].matcher_result, "")
        self.assertEqual(observations[0].target_slot_hint, "U-47")
        self.assertEqual(
            observations[0].source_locations,
            {
                "autowsgr_2026-08-05.debug.log:2",
                "autowsgr_2026-08-05.2.log:2",
            },
        )

    def test_writes_reports_without_inventing_ground_truth(self) -> None:
        log_file = self.temp_path / "autowsgr_2026-08-05.log"
        log_file.write_text(_sample_log(), encoding="utf-8")
        output = self.temp_path / "report"

        console = io.StringIO()
        with redirect_stdout(console):
            return_code = ocr_log_analyzer.main(
                [str(log_file), "--output-dir", str(output)],
            )

        self.assertEqual(return_code, 0)
        self.assertIn(
            "当前没有人工确认的真实舰名，请先填写 ocr_review.csv",
            console.getvalue(),
        )
        self.assertIn("0.47.狼群 -> 未匹配: 1 次", console.getvalue())
        observations = _read_csv(output / "ocr_observations.csv")
        self.assertEqual(len(observations), 3)
        self.assertEqual(observations[0]["actual_ship"], "")
        self.assertEqual(observations[0]["comparison_status"], "unmatched")
        self.assertEqual(observations[0]["target_slot_hint"], "U-47")
        self.assertEqual(observations[1]["comparison_status"], "matcher_corrected")
        self.assertEqual(observations[2]["comparison_status"], "matcher_exact")

        review_rows = _read_csv(output / "ocr_review.csv")
        self.assertEqual(
            [row["raw_text"] for row in review_rows],
            ["0.47.狼群", "0-81", "Z1"],
        )
        self.assertTrue(all(row["actual_ship"] == "" for row in review_rows))
        report = (output / "ocr_report.md").read_text(encoding="utf-8")
        self.assertNotIn(str(self.temp_path), report)
        self.assertIn("# OCR 分析结果", report)
        self.assertIn("当前没有人工确认的真实舰名", report)
        self.assertIn(
            "- 1 次：OCR `0.47.狼群` → 补丁 `U.47.狼群` "
            "→ 程序结果 **未匹配**；候选提示 `U-47`",
            report,
        )
        self.assertIn(
            "先在 `ocr_review.csv` 的 `actual_ship` 列填写真实舰名",
            report,
        )
        self.assertNotIn("## 状态分布", report)

    def test_review_generates_only_verified_needed_corrections(self) -> None:
        log_file = self.temp_path / "autowsgr_2026-08-05.log"
        log_file.write_text(
            _sample_log()
            + _log_line(
                "09:34:48.806",
                "[准备页] 编队 OCR 识别: "
                "[{'slot': 0, 'raw': '71', 'patched': '71', 'matched': None}, "
                "{'slot': 1, 'raw': '乙46', 'patched': '乙46', 'matched': 'Z46'}, "
                "{'slot': 2, 'raw': '初戛', 'patched': '初戛', 'matched': None}]",
            )
            + _log_line(
                "09:34:49.806",
                "[准备页] 编队 OCR 识别: "
                "[{'slot': 0, 'raw': '0.47.狼群', "
                "'patched': 'U.47.狼群', 'matched': None}]",
            ),
            encoding="utf-8",
        )
        output = self.temp_path / "report"
        self.assertEqual(
            ocr_log_analyzer.main([str(log_file), "-o", str(output)]),
            0,
        )

        review_path = output / "ocr_review.csv"
        review_rows = _read_csv(review_path)
        actual_by_raw = {
            "0.47.狼群": "U-47",
            "0-81": "U-81",
            "71": "Z1",
            "乙46": "Z31",
            "初戛": "初夏",
            "Z1": "Z1",
        }
        for row in review_rows:
            row["actual_ship"] = actual_by_raw[row["raw_text"]]
        _write_csv(review_path, review_rows)

        console = io.StringIO()
        with redirect_stdout(console):
            return_code = ocr_log_analyzer.main(
                [
                    str(log_file),
                    "--review",
                    str(review_path),
                    "--output-dir",
                    str(output),
                ],
            )

        self.assertEqual(return_code, 0)
        self.assertIn(
            "U-47: 2 次（正确 0，问题 2）；0.47.狼群 -> 未匹配 2 次",
            console.getvalue(),
        )
        self.assertIn("0.47.狼群: U-47", console.getvalue())
        corrections = (output / "ocr_corrections.txt").read_text(encoding="utf-8")
        self.assertIn("0.47.狼群: U-47", corrections)
        self.assertIn("乙46: Z31", corrections)
        self.assertIn("初戛: 初夏", corrections)
        self.assertNotIn("0-81: U-81", corrections)
        self.assertNotIn("71: Z1", corrections)
        report = (output / "ocr_report.md").read_text(encoding="utf-8")
        self.assertIn("### U-47：2 次（正确 0，问题 2）", report)
        self.assertIn(
            "- 2 次：OCR `0.47.狼群` → 补丁 `U.47.狼群` "
            "→ 程序结果 **未匹配** → **有问题**",
            report,
        )
        self.assertIn("### U-81：1 次（正确 1，问题 0）", report)
        self.assertIn("### 初夏：1 次（正确 0，问题 1）", report)
        self.assertIn("0.47.狼群: U-47", report)
        self.assertIn("乙46: Z31", report)
        self.assertIn("初戛: 初夏", report)
        self.assertIn("跳过过短规则", report)

        observations = _read_csv(output / "ocr_observations.csv")
        status_by_raw = {
            row["raw_text"]: row["comparison_status"] for row in observations
        }
        self.assertEqual(status_by_raw["0.47.狼群"], "verified_unmatched")
        self.assertEqual(status_by_raw["0-81"], "verified_corrected")
        self.assertEqual(status_by_raw["乙46"], "verified_mismatch")

    def test_malformed_structured_record_is_counted(self) -> None:
        log_file = self.temp_path / "autowsgr_2026-08-05.log"
        log_file.write_text(
            _log_line(
                "09:34:47.806",
                "[准备页] 编队 OCR 识别: not-a-list",
            ),
            encoding="utf-8",
        )

        observations, stats = ocr_log_analyzer.extract_observations([log_file])

        self.assertEqual(observations, [])
        self.assertEqual(stats.structured_events, 1)
        self.assertEqual(stats.parse_errors, 1)

    def test_discovers_directory_and_wildcard_log_files(self) -> None:
        nested = self.temp_path / "nested"
        nested.mkdir()
        first = self.temp_path / "a.log"
        second = nested / "b.log"
        ignored = nested / "c.txt"
        for path in (first, second, ignored):
            path.write_text("", encoding="utf-8")

        from_directory = ocr_log_analyzer.discover_log_files([str(self.temp_path)])
        from_wildcard = ocr_log_analyzer.discover_log_files(
            [str(self.temp_path / "*.log")],
        )

        self.assertEqual(
            from_directory,
            sorted([first.resolve(), second.resolve()], key=str),
        )
        self.assertEqual(from_wildcard, [first.resolve()])


if __name__ == "__main__":
    unittest.main()
