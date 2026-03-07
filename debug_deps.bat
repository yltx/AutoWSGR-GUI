@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "APP_DIR=%~dp0"
set "SITE_PKG=%APP_DIR%python\site-packages"
set "LOCAL_PY=%APP_DIR%python\python.exe"
set "PTH_FILE=%APP_DIR%python\python312._pth"
set "LOG=%APP_DIR%debug_report.txt"

:: 清空旧日志
> "%LOG%" echo ============================================
>> "%LOG%" echo   AutoWSGR-GUI 诊断报告
>> "%LOG%" echo   生成时间: %DATE% %TIME%
>> "%LOG%" echo ============================================
>> "%LOG%" echo.

>> "%LOG%" echo [基础信息]
>> "%LOG%" echo   应用目录: %APP_DIR%
>> "%LOG%" echo   site-packages: %SITE_PKG%
>> "%LOG%" echo.

:: --- 检查本地 Python ---
>> "%LOG%" echo === Python 检测 ===
if exist "%LOCAL_PY%" (
    >> "%LOG%" echo [OK] 本地便携版 Python 存在: %LOCAL_PY%
    set "PY=%LOCAL_PY%"
    for /f "delims=" %%v in ('"%LOCAL_PY%" -c "import sys; print(sys.version)"  2^>nul') do (
        >> "%LOG%" echo   版本: %%v
    )
) else (
    >> "%LOG%" echo [--] 无本地便携版 Python
    where python >nul 2>nul
    if !errorlevel! equ 0 (
        for /f "delims=" %%i in ('python -c "import sys; print(sys.executable)"') do set "PY=%%i"
        >> "%LOG%" echo [OK] 系统 Python: !PY!
        for /f "delims=" %%v in ('python -c "import sys; print(sys.version)" 2^>nul') do (
            >> "%LOG%" echo   版本: %%v
        )
    ) else (
        >> "%LOG%" echo [FAIL] 未找到任何 Python
        >> "%LOG%" echo.
        goto :done
    )
)
>> "%LOG%" echo.

:: --- 检查 ._pth 文件 ---
>> "%LOG%" echo === ._pth 文件检查 (仅便携版) ===
if exist "%PTH_FILE%" (
    >> "%LOG%" echo [INFO] ._pth 文件内容:
    >> "%LOG%" type "%PTH_FILE%"
    >> "%LOG%" echo.
    findstr /c:"import site" "%PTH_FILE%" >nul 2>nul
    if !errorlevel! equ 0 (
        >> "%LOG%" echo [OK] import site 已启用
    ) else (
        >> "%LOG%" echo [FAIL] import site 未启用! .pth 文件不会被处理!
    )
    findstr /c:"site-packages" "%PTH_FILE%" >nul 2>nul
    if !errorlevel! equ 0 (
        >> "%LOG%" echo [OK] site-packages 已在路径中
    ) else (
        >> "%LOG%" echo [FAIL] site-packages 未在路径中!
    )
) else (
    >> "%LOG%" echo [--] 无 ._pth 文件 (非嵌入式 Python 或文件不存在)
)
>> "%LOG%" echo.

:: --- 检查 distutils shim ---
>> "%LOG%" echo === distutils 可用性检查 ===
"%PY%" -c "import sys; sys.path.insert(0, r'%SITE_PKG%'); import site; site.addsitedir(r'%SITE_PKG%'); import distutils; print('OK')" >nul 2>nul
if !errorlevel! equ 0 (
    >> "%LOG%" echo [OK] distutils 可用 (setuptools shim 正常)
) else (
    >> "%LOG%" echo [FAIL] distutils 不可用! 请确认 setuptools 已安装
)
>> "%LOG%" echo.

:: --- 检查 site-packages 关键包 ---
>> "%LOG%" echo === 关键包检查 ===
if exist "%SITE_PKG%" (
    >> "%LOG%" echo [OK] site-packages 目录存在
    if exist "%SITE_PKG%\uvicorn" (>> "%LOG%" echo   uvicorn: OK) else (>> "%LOG%" echo   uvicorn: MISSING)
    if exist "%SITE_PKG%\fastapi" (>> "%LOG%" echo   fastapi: OK) else (>> "%LOG%" echo   fastapi: MISSING)
    if exist "%SITE_PKG%\autowsgr" (>> "%LOG%" echo   autowsgr: OK) else (>> "%LOG%" echo   autowsgr: MISSING)
    if exist "%SITE_PKG%\setuptools" (>> "%LOG%" echo   setuptools: OK) else (>> "%LOG%" echo   setuptools: MISSING)
    for /f %%a in ('dir /b "%SITE_PKG%" 2^>nul ^| find /c /v ""') do >> "%LOG%" echo   总计 %%a 项
) else (
    >> "%LOG%" echo [FAIL] site-packages 目录不存在!
)
>> "%LOG%" echo.

:: --- Python import 测试 ---
>> "%LOG%" echo === Python import 测试 ===

>> "%LOG%" echo [测试1] 直接 import (无 sys.path 修改):
for %%m in (uvicorn fastapi autowsgr) do (
    "%PY%" -c "import %%m; print('OK')" >nul 2>nul
    if !errorlevel! equ 0 (>> "%LOG%" echo   %%m: OK) else (>> "%LOG%" echo   %%m: FAIL)
)
>> "%LOG%" echo.

>> "%LOG%" echo [测试2] sys.path.insert 后 import:
for %%m in (uvicorn fastapi autowsgr) do (
    "%PY%" -c "import sys; sys.path.insert(0, r'%SITE_PKG%'); import %%m; print('OK')" >nul 2>nul
    if !errorlevel! equ 0 (>> "%LOG%" echo   %%m: OK) else (>> "%LOG%" echo   %%m: FAIL)
)
>> "%LOG%" echo.

>> "%LOG%" echo [测试3] site.addsitedir 后 import (GUI 实际启动方式):
for %%m in (uvicorn fastapi autowsgr) do (
    "%PY%" -c "import sys; sys.path.insert(0, r'%SITE_PKG%'); import site; site.addsitedir(r'%SITE_PKG%'); import %%m; print('OK')" >nul 2>nul
    if !errorlevel! equ 0 (>> "%LOG%" echo   %%m: OK) else (>> "%LOG%" echo   %%m: FAIL)
)
>> "%LOG%" echo.

:: --- autowsgr 版本 ---
>> "%LOG%" echo === autowsgr 版本 ===
for /f "delims=" %%v in ('"%PY%" -c "import sys; sys.path.insert(0, r'%SITE_PKG%'); import autowsgr; print(autowsgr.__version__)" 2^>nul') do (
    >> "%LOG%" echo   版本: %%v
)
>> "%LOG%" echo.

:: --- sys.path 内容 ---
>> "%LOG%" echo === sys.path 内容 ===
"%PY%" -c "import sys; [print(' ', p) for p in sys.path]" >> "%LOG%" 2>nul
>> "%LOG%" echo.

:: --- 模拟器连接检查 ---
>> "%LOG%" echo === 模拟器 adb 检查 ===
where adb >nul 2>nul
if !errorlevel! equ 0 (
    >> "%LOG%" echo [OK] adb 在 PATH 中
    for /f "delims=" %%d in ('adb devices 2^>nul') do >> "%LOG%" echo   %%d
) else (
    >> "%LOG%" echo [--] adb 不在 PATH 中 (可能由程序内部提供)
)
>> "%LOG%" echo.

>> "%LOG%" echo ============================================
>> "%LOG%" echo 诊断完毕。请将此文件发送给开发者。
>> "%LOG%" echo ============================================

:done
endlocal

echo 诊断完成！报告已保存到:
echo   %LOG%
echo.
echo 按任意键打开报告文件...
pause >nul
start "" "%LOG%"
