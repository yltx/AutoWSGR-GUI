; AutoWSGR-GUI NSIS 自定义安装脚本
; 安装 VC++ Redistributable，并让新版 GUI 首次启动时更新指定后端。

!macro ExtractInstallerHelper
  InitPluginsDir
  File "/oname=$PLUGINSDIR\autowsgr-installer-helper.ps1" "${PROJECT_DIR}\build\installer-helper.ps1"
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInit
  StrCpy $InstallerPowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  !insertmacro ExtractInstallerHelper
  ${If} ${Silent}
    ; 静默的 per-machine outer 随后只负责拉起 UAC inner；事务由 inner 唯一接管。
    ${If} $hasPerMachineInstallation == "1"
    ${AndIfNot} ${UAC_IsAdmin}
      DetailPrint "等待提升后的安装进程接管升级事务"
    ${Else}
      !insertmacro InstallerUpgradeTransaction RetryPrepareLegacyUpgradeInit
    ${EndIf}
  ${EndIf}
!macroend

; 交互安装在目录选择和 UAC 接管均完成后、进入 install Section 前启动事务。
; electron-builder 到 instfiles pre 才补 APP_FILENAME，因此这里先调用其幂等规范化函数。
!macro customPageAfterChangeDir
  Page custom AutoWsgrPrepareUpgradePage
  Function AutoWsgrPrepareUpgradePage
    !ifdef allowToChangeInstallationDirectory
      Call instFilesPre
    !endif
    !insertmacro InstallerUpgradeTransaction RetryPrepareLegacyUpgradePage
    Abort
  FunctionEnd
!macroend
!endif

; electron-builder 的内置 FIND_PROCESS 使用字符串前缀匹配，并且强制关闭只按
; AutoWSGR-GUI.exe 名称处理。这里统一按可执行文件的规范路径关闭 $INSTDIR 内
; 的残留后端、ADB 和 GUI 进程，避免影响同名的系统或其他工具进程。
!macro StopDirectoryProcesses INSTALL_DIRECTORY RETRY_LABEL
  Push $0
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  DetailPrint "正在结束旧安装目录内残留进程..."
  nsExec::ExecToLog '"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autowsgr-installer-helper.ps1" -Action stop-processes -InstallDirectory "${INSTALL_DIRECTORY}" -ExcludedProcessId "$0" -GracefulExecutableName "${APP_EXECUTABLE_FILENAME}" -GracefulTimeoutSeconds 20'
  Pop $R2
  Pop $0
  ${If} $R2 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "无法安全关闭旧安装目录内的全部进程。请用管理员权限关闭它们，然后单击重试。" \
      IDRETRY ${RETRY_LABEL}
    Quit
  ${EndIf}
!macroend

; 1.4.x 把用户设置和计划写在安装目录。覆盖升级会先运行旧卸载器，
; 因此事务必须绑定注册表旧源、最终 $INSTDIR、注册表 hive 和安装范围。
!ifndef BUILD_UNINSTALLER
Var LegacyUpgradeRoot
Var LegacyUpgradeHkcuSource
Var LegacyUpgradeHklmSource
Var LegacyUpgradeScope
Var LegacyUpgradeTarget
Var InstallerPowerShellPath
!endif

!macro LoadLegacyUpgradeInputs
  StrCpy $LegacyUpgradeRoot "$LOCALAPPDATA\AutoWSGR-GUI\legacy-upgrade"
  StrCpy $LegacyUpgradeTarget "$INSTDIR"
  ReadRegStr $LegacyUpgradeHkcuSource HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $LegacyUpgradeHklmSource HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $installMode == "all"
    StrCpy $LegacyUpgradeScope "all-users"
  ${Else}
    StrCpy $LegacyUpgradeScope "current-user"
    StrCpy $LegacyUpgradeHklmSource ""
  ${EndIf}
!macroend

!macro InstallerUpgradeTransaction RETRY_LABEL
  !insertmacro LoadLegacyUpgradeInputs
  ${RETRY_LABEL}:
  DetailPrint "正在保留旧安装数据并建立可重试升级事务..."
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  ${If} $LegacyUpgradeScope == "all-users"
    nsExec::ExecToLog '"$InstallerPowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autowsgr-installer-helper.ps1" -Action prepare-upgrade -TransactionRoot "$LegacyUpgradeRoot" -Target "$LegacyUpgradeTarget" -Scope "$LegacyUpgradeScope" -HkcuSource "$LegacyUpgradeHkcuSource" -HklmSource "$LegacyUpgradeHklmSource" -ExcludedProcessId "$0" -GracefulExecutableName "${APP_EXECUTABLE_FILENAME}" -GracefulTimeoutSeconds 20'
  ${Else}
    nsExec::ExecToLog '"$InstallerPowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autowsgr-installer-helper.ps1" -Action prepare-upgrade -TransactionRoot "$LegacyUpgradeRoot" -Target "$LegacyUpgradeTarget" -Scope "$LegacyUpgradeScope" -HkcuSource "$LegacyUpgradeHkcuSource" -ExcludedProcessId "$0" -GracefulExecutableName "${APP_EXECUTABLE_FILENAME}" -GracefulTimeoutSeconds 20'
  ${EndIf}
  Pop $R2
  ${If} $R2 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONSTOP \
      "无法安全保留旧安装数据，安装已在运行旧卸载器前停止。请勿删除 $LegacyUpgradeRoot；解决冲突后单击重试。" /SD IDCANCEL \
      IDRETRY ${RETRY_LABEL}
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

!macro CommitInstallerUpgradeTransaction
  !insertmacro LoadLegacyUpgradeInputs
  DetailPrint "正在恢复旧用户数据迁移源并完成升级事务..."
  nsExec::ExecToLog '"$InstallerPowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autowsgr-installer-helper.ps1" -Action commit-upgrade -TransactionRoot "$LegacyUpgradeRoot" -Target "$LegacyUpgradeTarget" -Scope "$LegacyUpgradeScope"'
  Pop $R2
  ${If} $R2 != 0
    MessageBox MB_OK|MB_ICONSTOP \
      "新版文件已安装，但旧用户数据恢复失败。事务备份仍保留在 $LegacyUpgradeRoot；请勿删除并重新运行安装器。" /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend

!macro RollbackInstallerUpgradeTransaction
  !insertmacro LoadLegacyUpgradeInputs
  DetailPrint "旧版本卸载失败，正在恢复受控后端目录..."
  nsExec::ExecToLog '"$InstallerPowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autowsgr-installer-helper.ps1" -Action rollback-upgrade -TransactionRoot "$LegacyUpgradeRoot" -Target "$LegacyUpgradeTarget" -Scope "$LegacyUpgradeScope"'
  Pop $R2
  ${If} $R2 != 0
    MessageBox MB_OK|MB_ICONSTOP \
      "旧版本卸载失败，且受控后端目录自动恢复失败。事务和用户数据备份仍保留在 $LegacyUpgradeRoot；请勿删除。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; electron-builder 在每次旧卸载器返回后调用该 hook。任何非零结果都先由同一
; helper 依据 manifest 恢复 runtime，再沿用 builder 的失败关闭语义。
!macro HandleInstallerUninstallResult LABEL_SUFFIX
  IfErrors 0 UninstallResultAvailable_${LABEL_SUFFIX}
    DetailPrint "旧卸载器无法启动，正在回滚升级事务"
    !insertmacro RollbackInstallerUpgradeTransaction
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller."
    SetErrorLevel 2
    Quit
  UninstallResultAvailable_${LABEL_SUFFIX}:
  ${If} $R0 != 0
    !insertmacro RollbackInstallerUpgradeTransaction
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro HandleInstallerUninstallResult ShellContext
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro HandleInstallerUninstallResult CurrentUser
!macroend

; 仅按安装目录内可执行文件路径请求 GUI 退出，并关闭残留后端进程。
!macro customCheckAppRunning
  ; Installer 的 UAC inner 进程通过 customInit 提取；卸载器没有 customInit，
  ; 因而必须在进程检查前为本次卸载器进程提取同一 helper。
  !ifdef BUILD_UNINSTALLER
    !insertmacro ExtractInstallerHelper
  !endif
  RetryCloseApp:
  !insertmacro StopDirectoryProcesses "$INSTDIR" RetryCloseApp
!macroend

; 覆盖升级会调用旧卸载器，此时保留依赖；只有主动卸载才完整清理。
; NSIS 的 RMDir /r 无法可靠删除 Python 包中的超长嵌套许可证路径，统一交由
; 已完成 containment/reparse-point 校验的 helper 使用 Win32 extended path 清理。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autowsgr-installer-helper.ps1" -Action remove-managed-runtime -InstallDirectory "$INSTDIR"'
    Pop $R2
    ${If} $R2 != 0
      MessageBox MB_OK|MB_ICONSTOP \
        "无法完整删除受管 Python 后端目录。请关闭占用安装目录的进程后重新卸载。" /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${endIf}
!macroend

!macro customInstall
  ${If} ${isUpdated}
    ${If} ${FileExists} "$newDesktopLink"
      !insertmacro addDesktopLink "false"
    ${EndIf}
    ${If} ${FileExists} "$newStartMenuLink"
      !insertmacro addStartMenuLink "false"
    ${EndIf}
  ${EndIf}
  !insertmacro CommitInstallerUpgradeTransaction
  IfFileExists "$SYSDIR\vcruntime140.dll" VCRedistInstalled 0
    DetailPrint "正在安装 Microsoft Visual C++ Redistributable..."
    nsExec::ExecToLog '"$INSTDIR\redist\vc_redist.x64.exe" /install /quiet /norestart'
    Pop $0
    DetailPrint "VC++ Redistributable 安装完成 (exit code: $0)"
  VCRedistInstalled:

  Delete "$INSTDIR\.env_ready"
  DetailPrint "已安排首次启动时更新本包指定的 AutoWSGR 后端"
!macroend
