; Installer hooks (tauri.conf.json > bundle > windows > nsis > installerHooks).
; "Upload to Etherdisk" in Explorer's menu for files and folders, and Etherdisk in "Send to":
; both start the app with --upload <paths> (a running app gets them from the second launch).
; Per user (HKCU), like the install itself. On Windows 11 they are under "Show more options".

!define ETHERDISK_EXE "$INSTDIR\etherdisk-desktop.exe"

!macro ETHERDISK_VERB ROOT
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Etherdisk" "" "Upload to Etherdisk"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Etherdisk" "Icon" "${ETHERDISK_EXE}"
  ; Many selected items at once (not only 15).
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Etherdisk" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Etherdisk\command" "" '"${ETHERDISK_EXE}" --upload "%1"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro ETHERDISK_VERB "*"
  !insertmacro ETHERDISK_VERB "Directory"
  CreateShortCut "$SENDTO\Etherdisk.lnk" "${ETHERDISK_EXE}" "--upload" "${ETHERDISK_EXE}" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\Etherdisk"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Etherdisk"
  Delete "$SENDTO\Etherdisk.lnk"
!macroend
