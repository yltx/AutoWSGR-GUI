; AutoWSGR-GUI NSIS 自定义安装脚本
; 安装 VC++ Redistributable，并让新版 GUI 首次启动时更新指定后端。

; 覆盖安装时先等待 GUI 正常停止后端，超时后再结束整棵进程树。
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE

  RetryCloseApp:
  IfFileExists "$INSTDIR\adb\adb.exe" 0 CheckRunningProcess
    DetailPrint "正在停止旧版内置 ADB server..."
    nsExec::Exec '"$INSTDIR\adb\adb.exe" kill-server'
    Pop $R2

  CheckRunningProcess:
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    DetailPrint "正在关闭旧版 AutoWSGR-GUI..."
    nsExec::Exec '"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $R2
    StrCpy $R1 0

    WaitForGracefulExit:
    Sleep 1000
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      Goto AppClosed
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 < 20
      Goto WaitForGracefulExit
    ${EndIf}

    DetailPrint "正常退出超时，正在结束 AutoWSGR-GUI 及其子进程..."
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $R2
    IfFileExists "$INSTDIR\adb\adb.exe" 0 VerifyClosed
      nsExec::Exec '"$INSTDIR\adb\adb.exe" kill-server'
      Pop $R2

    VerifyClosed:
    Sleep 2000
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "AutoWSGR-GUI 无法自动关闭。请用管理员权限关闭它，然后单击重试。" \
        IDRETRY RetryCloseApp
      Quit
    ${EndIf}
  ${EndIf}

  AppClosed:
  ; 升级前临时移出后端依赖，避免旧卸载器逐个处理数万个文件。
  ${If} ${isUpdated}
    IfFileExists "$INSTDIR.site-packages-update\*.*" BackendEnvPreserved 0
    IfFileExists "$INSTDIR\python\site-packages\*.*" 0 BackendEnvPreserved
    ClearErrors
    Rename "$INSTDIR\python\site-packages" "$INSTDIR.site-packages-update"
    IfErrors BackendEnvPreserveFailed BackendEnvPreserveDone

    BackendEnvPreserveFailed:
      DetailPrint "后端依赖临时保留失败，将使用完整覆盖安装"
      Goto BackendEnvPreserved

    BackendEnvPreserveDone:
      DetailPrint "已临时保留后端依赖"
  ${EndIf}

  BackendEnvPreserved:
!macroend

!macro customInstall
  ; 新前端写入完成后恢复依赖，后端版本仍由首次启动检查更新。
  IfFileExists "$INSTDIR.site-packages-update\*.*" 0 BackendEnvRestored
    CreateDirectory "$INSTDIR\python"
    ClearErrors
    Rename "$INSTDIR.site-packages-update" "$INSTDIR\python\site-packages"
    IfErrors BackendEnvRestoreFailed BackendEnvRestoreDone

    BackendEnvRestoreFailed:
      DetailPrint "后端依赖恢复失败，首次启动时将重新安装"
      Goto BackendEnvRestored

    BackendEnvRestoreDone:
      DetailPrint "已恢复后端依赖"

  BackendEnvRestored:
  IfFileExists "$SYSDIR\vcruntime140.dll" VCRedistInstalled 0
    DetailPrint "正在安装 Microsoft Visual C++ Redistributable..."
    nsExec::ExecToLog '"$INSTDIR\redist\vc_redist.x64.exe" /install /quiet /norestart'
    Pop $0
    DetailPrint "VC++ Redistributable 安装完成 (exit code: $0)"
  VCRedistInstalled:

  Delete "$INSTDIR\.env_ready"
  DetailPrint "已安排首次启动时更新本包指定的 AutoWSGR 后端"
!macroend
