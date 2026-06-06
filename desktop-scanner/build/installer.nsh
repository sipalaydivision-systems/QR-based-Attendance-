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
; under HKLM so the scanner auto-launches for ALL user accounts on
; this machine on every Windows start/restart.
!macro customInstall
  WriteRegStr HKLM \
    "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "Edutrack Scanner" \
    '"$INSTDIR\Edutrack Scanner.exe" --autostart'
!macroend

; Remove the machine-wide startup registry key on uninstall.
!macro customUnInstall
  DeleteRegValue HKLM \
    "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "Edutrack Scanner"
!macroend
