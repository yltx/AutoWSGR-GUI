<#
.SYNOPSIS
    递归扫描指定目录，统计符合后缀名的源码文件行数并按阈值分级。
.DESCRIPTION
    输出 JSON 数组，每个元素包含 path（工作区相对路径）、lines、level（OK/WARNING/VIOLATION）。
    供 code-length-audit agent 调用，快速获取行数数据后生成报告。
.PARAMETER Path
    要扫描的目录路径，默认为当前目录。
.PARAMETER Extensions
    逗号分隔的后缀名列表（含点号），默认 .ts,.tsx,.js,.jsx,.py,.vue,.svelte,.go,.rs,.java,.kt,.cs,.cpp,.c,.h
.PARAMETER Warn
    警告阈值（行数），默认 450。
.PARAMETER Error
    违规阈值（行数），默认 600。
.PARAMETER ExcludeDirs
    逗号分隔的排除目录名，默认 python,release,build,redist,adb,node_modules,dist,.next,.git
.PARAMETER All
    若指定，输出所有文件（含 OK）；否则仅输出 WARNING 和 VIOLATION。
.EXAMPLE
    .\count-lines.ps1 -Path . -Extensions ".ts,.py" -Warn 400 -Error 550
    .\count-lines.ps1 -Path src -All
#>
param(
    [string]$Path = ".",
    [string]$Extensions = ".ts,.tsx,.js,.jsx,.py,.vue,.svelte,.go,.rs,.java,.kt,.cs,.cpp,.c,.h",
    [int]$Warn = 450,
    [int]$Error = 600,
    [string]$ExcludeDirs = "python,release,build,redist,adb,node_modules,dist,.next,.git",
    [switch]$All
)

$ErrorActionPreference = "Stop"

# 解析参数
$extList = $Extensions -split "," | ForEach-Object { $_.Trim().ToLower() }
$excludeList = $ExcludeDirs -split "," | ForEach-Object { $_.Trim().ToLower() }

# 解析扫描根目录的绝对路径，用于计算相对路径
$rootFull = (Resolve-Path $Path).Path

# 递归获取文件
$files = Get-ChildItem -Path $Path -Recurse -File | Where-Object {
    # 后缀过滤
    $ext = $_.Extension.ToLower()
    if ($ext -notin $extList) { return $false }

    # 排除目录过滤：检查相对路径的每一段
    $rel = $_.FullName.Substring($rootFull.Length).TrimStart('\', '/')
    $parts = $rel -split '[/\\]'
    foreach ($part in $parts[0..($parts.Length - 2)]) {
        if ($part.ToLower() -in $excludeList) { return $false }
    }
    return $true
}

# 统计行数
$results = foreach ($f in $files) {
    $lineCount = (Get-Content -Path $f.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
    $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\', '/') -replace '\\', '/'

    $level = if ($lineCount -gt $Error) { "VIOLATION" }
             elseif ($lineCount -gt $Warn) { "WARNING" }
             else { "OK" }

    [PSCustomObject]@{
        path  = $rel
        lines = $lineCount
        level = $level
    }
}

# 按行数降序排列
$results = $results | Sort-Object -Property lines -Descending

# 过滤输出
if (-not $All) {
    $results = $results | Where-Object { $_.level -ne "OK" }
}

# 汇总
$total = ($files | Measure-Object).Count
$warnCount = ($results | Where-Object { $_.level -eq "WARNING" } | Measure-Object).Count
$violationCount = ($results | Where-Object { $_.level -eq "VIOLATION" } | Measure-Object).Count

# 输出 JSON
$output = @{
    summary = @{
        scanned    = $total
        warnings   = $warnCount
        violations = $violationCount
        warnThreshold  = $Warn
        errorThreshold = $Error
    }
    files = @($results)
}

$output | ConvertTo-Json -Depth 3
