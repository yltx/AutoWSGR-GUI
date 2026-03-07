@echo off
chcp 65001 >nul
echo ============================================
echo   AutoWSGR-GUI 依赖诊断脚本
echo ============================================
echo.

set "APP_DIR=%~dp0"
set "SITE_PKG=%APP_DIR%python\site-packages"
set "LOCAL_PY=%APP_DIR%python\python.exe"
set "PTH_FILE=%APP_DIR%python\python312._pth"

echo [1] 应用目录: %APP_DIR%
echo [2] site-packages: %SITE_PKG%
echo.

:: --- 检查本地 Python ---
echo === Python 检测 ===
if exist "%LOCAL_PY%" (
    echo [OK] 本地便携版 Python 存在: %LOCAL_PY%
    set "PY=%LOCAL_PY%"
) else (
    echo [--] 无本地便携版 Python
    where python >nul 2>nul
    if !errorlevel! equ 0 (
        for /f "delims=" %%i in ('python -c "import sys; print(sys.executable)"') do set "PY=%%i"
        echo [OK] 系统 Python: !PY!
    ) else (
        echo [FAIL] 未找到任何 Python
        goto :end
    )
)
echo.

:: --- 检查 ._pth 文件 ---
echo === ._pth 文件检查 (仅便携版) ===
if exist "%PTH_FILE%" (
    echo [INFO] ._pth 文件存在: %PTH_FILE%
    echo --- 内容 ---
    type "%PTH_FILE%"
    echo.
    echo --- 分析 ---
    findstr /c:"import site" "%PTH_FILE%" >nul 2>nul
    if !errorlevel! equ 0 (
        echo [OK] import site 已启用
    ) else (
        echo [FAIL] import site 未启用! PYTHONPATH 将被忽略!
    )
    findstr /c:"site-packages" "%PTH_FILE%" >nul 2>nul
    if !errorlevel! equ 0 (
        echo [OK] site-packages 已在 ._pth 中
    ) else (
        echo [FAIL] site-packages 未在 ._pth 中! 本地包将无法被找到!
    )
) else (
    echo [--] 无 ._pth 文件 (非嵌入式 Python 或文件不存在)
)
echo.

:: --- 检查 site-packages 目录 ---
echo === site-packages 目录检查 ===
if exist "%SITE_PKG%" (
    echo [OK] 目录存在
    echo --- 关键包 ---
    if exist "%SITE_PKG%\uvicorn" (echo   uvicorn: OK) else (echo   uvicorn: MISSING)
    if exist "%SITE_PKG%\fastapi" (echo   fastapi: OK) else (echo   fastapi: MISSING)
    if exist "%SITE_PKG%\autowsgr" (echo   autowsgr: OK) else (echo   autowsgr: MISSING)
    echo --- 目录内容 (前20项) ---
    dir /b "%SITE_PKG%" 2>nul | findstr /n "^" | findstr /b "[1-9]: [12][0-9]:"
    for /f %%a in ('dir /b "%SITE_PKG%" 2^>nul ^| find /c /v ""') do echo   共 %%a 项
) else (
    echo [FAIL] 目录不存在!
)
echo.

:: --- Python import 测试 ---
echo === Python import 测试 ===
setlocal enabledelayedexpansion

echo [测试1] 直接 import (不设 PYTHONPATH, 不设 sys.path):
"%PY%" -c "import uvicorn; print('  uvicorn OK')" 2>nul || echo   uvicorn FAIL
"%PY%" -c "import fastapi; print('  fastapi OK')" 2>nul || echo   fastapi FAIL
"%PY%" -c "import autowsgr; print('  autowsgr', autowsgr.__version__, 'OK')" 2>nul || echo   autowsgr FAIL

echo.
echo [测试2] 设置 PYTHONPATH=%SITE_PKG%:
set "PYTHONPATH=%SITE_PKG%"
"%PY%" -c "import uvicorn; print('  uvicorn OK')" 2>nul || echo   uvicorn FAIL
"%PY%" -c "import fastapi; print('  fastapi OK')" 2>nul || echo   fastapi FAIL
"%PY%" -c "import autowsgr; print('  autowsgr', autowsgr.__version__, 'OK')" 2>nul || echo   autowsgr FAIL
set "PYTHONPATH="

echo.
echo [测试3] 使用 sys.path.insert (GUI 新检测方式):
"%PY%" -c "import sys; sys.path.insert(0, r'%SITE_PKG%'); import uvicorn; print('  uvicorn OK')" 2>nul || echo   uvicorn FAIL
"%PY%" -c "import sys; sys.path.insert(0, r'%SITE_PKG%'); import fastapi; print('  fastapi OK')" 2>nul || echo   fastapi FAIL
"%PY%" -c "import sys; sys.path.insert(0, r'%SITE_PKG%'); import autowsgr; print('  autowsgr', autowsgr.__version__, 'OK')" 2>nul || echo   autowsgr FAIL

echo.
echo [测试4] Python sys.path 内容:
"%PY%" -c "import sys; [print('  ', p) for p in sys.path]"

endlocal
echo.
echo ============================================
echo 诊断完毕。请将以上输出截图发送给开发者。
echo ============================================

:end
pause
