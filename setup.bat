@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ═══════════════════════════════════════════════════════
:: AutoWSGR-GUI 环境安装脚本
:: 自动安装 Python 3.12、Node.js 22 LTS 并配置所有依赖
:: ═══════════════════════════════════════════════════════

set "SCRIPT_DIR=%~dp0"
set "TEMP_DIR=%SCRIPT_DIR%_setup_tmp"
set "PYTHON_VERSION=3.12.8"
set "NODE_VERSION=22.14.0"
set "PYTHON_INSTALLER=python-%PYTHON_VERSION%-amd64.exe"
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
set "BACKEND_REPO=OpenWSGR/AutoWSGR"
set "BACKEND_BRANCH=main"

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║     AutoWSGR-GUI 环境安装                    ║
echo  ╚══════════════════════════════════════════════╝
echo.

if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

:: ────────────── 检测 Python ──────────────
echo [1/5] 检测 Python 环境...

set "PYTHON_CMD="
where python >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set "PY_VER=%%v"
    for /f "tokens=1,2 delims=." %%a in ("!PY_VER!") do (
        if %%a GEQ 3 if %%b GEQ 12 (
            set "PYTHON_CMD=python"
            echo       √ 已安装 Python !PY_VER!
        )
    )
)

if not defined PYTHON_CMD (
    echo       未找到 Python 3.12+，开始下载安装...
    set "PY_URL=https://www.python.org/ftp/python/%PYTHON_VERSION%/%PYTHON_INSTALLER%"
    echo       下载 !PY_URL!
    curl -L -o "%TEMP_DIR%\%PYTHON_INSTALLER%" "!PY_URL!"
    if !errorlevel! neq 0 (
        echo       × 下载 Python 失败，请检查网络连接
        goto :error
    )
    echo       正在静默安装 Python %PYTHON_VERSION%...
    "%TEMP_DIR%\%PYTHON_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1
    if !errorlevel! neq 0 (
        echo       × Python 安装失败
        goto :error
    )
    :: 刷新 PATH
    for /f "tokens=*" %%i in ('where python 2^>nul') do set "PYTHON_CMD=%%i"
    if not defined PYTHON_CMD (
        :: 默认安装位置
        set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
        if not exist "!PYTHON_CMD!" (
            echo       × 安装后仍找不到 Python，请重启终端后重试
            goto :error
        )
    )
    echo       √ Python %PYTHON_VERSION% 安装完成
)

:: ────────────── 检测 Node.js ──────────────
echo [2/5] 检测 Node.js 环境...

set "NODE_CMD="
where node >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=1 delims=v" %%v in ('node --version 2^>^&1') do (
        for /f "tokens=1 delims=." %%m in ("%%v") do (
            :: node --version 输出 "v22.x.x"，去掉v后取主版本号
            set "NODE_MAJOR=%%m"
        )
    )
    :: 重新获取完整版本用于显示
    for /f %%v in ('node --version 2^>^&1') do set "NODE_FULL=%%v"
    echo       √ 已安装 Node.js !NODE_FULL!
    set "NODE_CMD=node"
) else (
    echo       未找到 Node.js，开始下载...
    set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%"
    echo       下载 !NODE_URL!
    curl -L -o "%TEMP_DIR%\%NODE_ZIP%" "!NODE_URL!"
    if !errorlevel! neq 0 (
        echo       × 下载 Node.js 失败，请检查网络连接
        goto :error
    )
    echo       正在解压 Node.js...
    set "NODE_DIR=%SCRIPT_DIR%node"
    if exist "!NODE_DIR!" rmdir /s /q "!NODE_DIR!"
    powershell -NoProfile -Command "Expand-Archive -Path '%TEMP_DIR%\%NODE_ZIP%' -DestinationPath '%TEMP_DIR%\node_extract' -Force"
    :: 解压后目录名为 node-vXX.XX.X-win-x64，移动到 ./node/
    for /d %%d in ("%TEMP_DIR%\node_extract\node-*") do (
        move "%%d" "!NODE_DIR!" >nul
    )
    set "NODE_CMD=!NODE_DIR!\node.exe"
    :: 将本地 node 加入当前 PATH
    set "PATH=!NODE_DIR!;!PATH!"
    echo       √ Node.js v%NODE_VERSION% 安装到 !NODE_DIR!
)

:: ────────────── 下载后端代码 ──────────────
echo [3/5] 检测后端代码...

set "BACKEND_DIR=%SCRIPT_DIR%autowsgr"
if exist "%BACKEND_DIR%\pyproject.toml" (
    echo       √ 后端代码已存在
) else (
    echo       下载后端代码（%BACKEND_REPO% %BACKEND_BRANCH%）...
    set "BACKEND_ZIP_URL=https://github.com/%BACKEND_REPO%/archive/refs/heads/%BACKEND_BRANCH%.zip"
    curl -L -o "%TEMP_DIR%\autowsgr.zip" "!BACKEND_ZIP_URL!"
    if !errorlevel! neq 0 (
        echo       × 下载后端代码失败，请检查网络连接
        goto :error
    )
    echo       正在解压...
    if exist "%BACKEND_DIR%" rmdir /s /q "%BACKEND_DIR%"
    powershell -NoProfile -Command "Expand-Archive -Path '%TEMP_DIR%\autowsgr.zip' -DestinationPath '%TEMP_DIR%\backend_extract' -Force"
    :: 重命名为 autowsgr/
    for /d %%d in ("%TEMP_DIR%\backend_extract\AutoWSGR-*") do (
        move "%%d" "%BACKEND_DIR%" >nul
    )
    echo       √ 后端代码下载完成
)

:: ────────────── 安装前端依赖 ──────────────
echo [4/5] 安装前端依赖 (npm install)...

pushd "%SCRIPT_DIR%"
call npm install --no-optional 2>&1
if !errorlevel! neq 0 (
    echo       × npm install 失败
    goto :error
)
echo       √ 前端依赖安装完成
popd

:: ────────────── 安装后端依赖 ──────────────
echo [5/5] 安装后端 Python 依赖...

pushd "%SCRIPT_DIR%"
"!PYTHON_CMD!" -m pip install --upgrade pip 2>nul
"!PYTHON_CMD!" -m pip install -e "./autowsgr"
if !errorlevel! neq 0 (
    echo       × Python 依赖安装失败
    goto :error
)
echo       √ 后端依赖安装完成
popd

:: ────────────── 清理临时文件 ──────────────
echo.
echo  正在清理临时文件...
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║     环境安装完成!                             ║
echo  ║     运行 AutoWSGR-GUI.exe 即可启动            ║
echo  ╚══════════════════════════════════════════════╝
echo.
pause
exit /b 0

:error
echo.
echo  × 安装过程中出现错误，请查看上方日志
echo.
pause
exit /b 1
