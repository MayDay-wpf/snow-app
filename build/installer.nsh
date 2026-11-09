!macro customCheckAppRunning
  # New releases understand the quit request and perform their normal cleanup.
  # Older releases ignore it, so give them a short grace period before closing
  # only processes whose executable lives inside the selected install folder.
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 snow_force_close
  Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-update'
  Sleep 2500

  snow_force_close:
  DetailPrint "$(appClosing)"
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$deadline = [DateTime]::UtcNow.AddSeconds(15); do { $$processes = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR\', [StringComparison]::OrdinalIgnoreCase) }); if ($$processes.Count -eq 0) { exit 0 }; $$processes | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 } while ([DateTime]::UtcNow -lt $$deadline); exit 1"`
  Pop $0

  ${If} $0 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY snow_force_close
    Quit
  ${EndIf}
!macroend

!macro customUnInstall
  # Explorer folder context menu "Open in Snow App" is registered by the app at
  # runtime (native/src/exports/explorer_menu.rs). Keep it during updates: the
  # new version rewrites it on startup; remove it only on a real uninstall.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\SnowApp"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\SnowApp"
  ${endIf}
!macroend
