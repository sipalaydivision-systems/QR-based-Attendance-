; EduTrack Scanner — Custom NSIS installer hooks

; Kill any running instance before installation begins so the
; installer can replace locked files without showing the
; "cannot be closed" dialog. Both the new and legacy exe names are
; targeted so upgrades from the old "Edutrack" build close cleanly.
!macro customInit
  nsExec::ExecToStack 'taskkill /F /IM "EduTrack Scanner.exe" /T'
  Pop $0
  nsExec::ExecToStack 'taskkill /F /IM "Edutrack Scanner.exe" /T'
  Pop $0
  Sleep 1500
!macroend

; After files are installed, write the Windows startup registry key
; under HKLM so the scanner auto-launches for ALL user accounts on
; this machine on every Windows start/restart.
!macro customInstall
  ; Remove any legacy startup key from the old "Edutrack" build.
  DeleteRegValue HKLM \
    "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "Edutrack Scanner"
  WriteRegStr HKLM \
    "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "EduTrack Scanner" \
    '"$INSTDIR\EduTrack Scanner.exe" --autostart'
!macroend

; Remove the machine-wide startup registry key on uninstall.
!macro customUnInstall
  DeleteRegValue HKLM \
    "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "EduTrack Scanner"
  DeleteRegValue HKLM \
    "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "Edutrack Scanner"
!macroend
