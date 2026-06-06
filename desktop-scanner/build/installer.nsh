; Edutrack Scanner — Custom NSIS installer hooks

; Kill any running instance before installation begins so the
; installer can replace locked files without showing the
; "cannot be closed" dialog.
!macro customInit
  nsExec::ExecToStack 'taskkill /F /IM "Edutrack Scanner.exe" /T'
  Pop $0
  Sleep 1500
!macroend

; After files are installed, write the Windows startup registry key
; so the scanner launches automatically on every Windows start/restart
; even before the user opens the app for the first time.
!macro customInstall
  WriteRegStr HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "Edutrack Scanner" \
    '"$INSTDIR\Edutrack Scanner.exe" --autostart'
!macroend

; Remove the startup registry key on uninstall.
!macro customUnInstall
  DeleteRegValue HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "Edutrack Scanner"
!macroend
