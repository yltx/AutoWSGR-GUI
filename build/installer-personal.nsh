; AutoWSGR-GUI 自用包安装脚本
; 安装完成后清除环境标记，首次启动时强制重装 ShiinaKuroko 后端。

!macro customInstall
  IfFileExists "$SYSDIR\vcruntime140.dll" VCRedistInstalled 0
    DetailPrint "正在安装 Microsoft Visual C++ Redistributable..."
    nsExec::ExecToLog '"$INSTDIR\redist\vc_redist.x64.exe" /install /quiet /norestart'
    Pop $0
    DetailPrint "Visual C++ Redistributable 安装完成 (exit code: $0)"
  VCRedistInstalled:

  Delete "$INSTDIR\.env_ready"
  DetailPrint "已安排首次启动时强制更新 ShiinaKuroko 后端"
!macroend
