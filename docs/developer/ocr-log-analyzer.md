# OCR 日志分析工具

`tools/ocr_log_analyzer.py` 是 GUI 源码仓库中的独立开发者工具。它不会被
Electron、GUI 页面或 AutoWSGR 后端调用，也不在 `electron-builder` 的安装包
文件白名单中。

工具从日志中提取准备页舰名 OCR 结果，用于收集、人工确认和汇总识别差异。
只依赖 Python 标准库，可以使用仓库的便携版 Python 或系统 Python 运行。

## 快速使用

分析单个日志：

```powershell
.\python\python.exe tools\ocr_log_analyzer.py ..\autowsgr_2026-08-05.debug.log
```

分析目录或多个日志：

```powershell
.\python\python.exe tools\ocr_log_analyzer.py ..\*.log `
  --output-dir ocr-log-report
```

工具会根据时间、日志来源、槽位和 OCR 内容对重复事件去重。因此可以同时传入
同一次运行生成的 INFO 和 DEBUG 日志，不会重复统计。

## 输出文件

- `ocr_report.md`：默认先看这个；按真实舰名列出次数、识别结果和解决办法。
- `ocr_review.csv`：所有唯一识别结果的人工真值复核表。
- `ocr_corrections.txt`：根据人工真值生成、可粘贴到 GUI 的纠错规则。
- `ocr_observations.csv`：排查用的逐槽 OCR 明细。
- `ocr_summary.csv`：排查用的原文、补丁和程序结果聚合统计。

CSV 使用 UTF-8 BOM 编码，可以直接使用 Windows Excel 打开。

报告默认只保留日志文件名和行号，不输出用户本机绝对路径，也不会复制与 OCR
无关的日志内容。

## 人工复核流程

1. 首次运行后先看 `ocr_report.md`，其中直接列出高频未匹配和候选提示。
2. 在 `ocr_review.csv` 的 `actual_ship` 列填写人工确认的真实舰名。要得到完整的
   “每艘船出现几次”统计，需要确认表中的所有唯一识别结果。
3. 使用填写后的复核表再次运行：

```powershell
.\python\python.exe tools\ocr_log_analyzer.py ..\*.log `
  --review ocr-log-report\ocr_review.csv `
  --output-dir ocr-log-report
```

工具会按真实舰名汇总：

```text
U-47：19 次（正确 0，问题 19）
- 14 次：OCR 0.47.狼群 → 补丁 U.47.狼群 → 未匹配
- 处理：加入 0.47.狼群: U-47
```

`target_slot_hint` 只作为候选提示。换船期间舰队位置可能尚未对齐，不能把它当成
真实舰名。只有人工填写的 `actual_ship` 会被工具视为真值。

## 规则安全

当前用户纠错采用“原文包含规则键即替换”的语义。工具不会自动生成单字符或
两位 ASCII 规则，避免 `71: Z1` 之类的短规则误伤其他舰名；`初戛: 初夏`
这种完整的双汉字规则可以生成。被跳过的规则会记录在 `ocr_report.md`。

工具只解析 `[准备页] 编队 OCR 识别` 结构化日志。其他场景需要先在运行时代码中
输出同等信息的结构化记录，不能通过拼接相邻调试文本推断真值。

## 开发验证

```powershell
npm run test:ocr-log-analyzer
```

测试使用 Python 标准库 `unittest`，依次尝试 `AUTOWSGR_PYTHON`、仓库便携版
Python 和系统 Python。
