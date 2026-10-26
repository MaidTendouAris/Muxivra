!ifndef MUXIVRA_MANAGED_FILES_INCLUDE
  !define MUXIVRA_MANAGED_FILES_INCLUDE "${PROJECT_DIR}\.runtime\installer-managed-files.nsh"
!endif
!include "${MUXIVRA_MANAGED_FILES_INCLUDE}"
!include "WordFunc.nsh"

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Var muxivraRemovalBackup
    Var muxivraRemovalError
    Var muxivraRestoreError

    Function un.MuxivraStageFile
      Exch $R0
      Push $R1
      ${If} $muxivraRemovalError == ""
        ${If} ${FileExists} "$INSTDIR\$R0"
          ${GetParent} "$muxivraRemovalBackup\$R0" $R1
          CreateDirectory "$R1"
          ClearErrors
          Rename "$INSTDIR\$R0" "$muxivraRemovalBackup\$R0"
          ${If} ${Errors}
            ; The uninstaller may be running in place. It is the only file
            ; allowed to remain; a busy application file aborts removal.
            ${If} $R0 != "${UNINSTALL_FILENAME}"
              StrCpy $muxivraRemovalError "$INSTDIR\$R0"
            ${EndIf}
            ClearErrors
          ${EndIf}
        ${EndIf}
      ${EndIf}
      Pop $R1
      Pop $R0
    FunctionEnd

    Function un.MuxivraRestoreFile
      Exch $R0
      Push $R1
      ${If} ${FileExists} "$muxivraRemovalBackup\$R0"
        ${GetParent} "$INSTDIR\$R0" $R1
        CreateDirectory "$R1"
        ClearErrors
        Rename "$muxivraRemovalBackup\$R0" "$INSTDIR\$R0"
        ${If} ${Errors}
          StrCpy $muxivraRestoreError "$muxivraRemovalBackup"
          ClearErrors
        ${EndIf}
      ${EndIf}
      Pop $R1
      Pop $R0
    FunctionEnd
  !else
    Var muxivraLegacyDirectory
    Var muxivraLegacyVersion

    !ifdef APP_FILENAME
      Function MuxivraCheckRegisteredLegacyOutputs
        ReadRegStr $muxivraLegacyDirectory HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
        ReadRegStr $muxivraLegacyVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
        Call MuxivraCheckLegacyOutputs
        ReadRegStr $muxivraLegacyDirectory HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
        ReadRegStr $muxivraLegacyVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
        Call MuxivraCheckLegacyOutputs
        ClearErrors
      FunctionEnd
    !endif

    Function MuxivraCheckLegacyOutputs
      ${If} $muxivraLegacyDirectory == ""
        Return
      ${EndIf}
      ${If} $muxivraLegacyVersion != ""
        ${VersionCompare} "$muxivraLegacyVersion" "0.13.0" $R0
        ${If} $R0 != 2
          Return
        ${EndIf}
      ${EndIf}
      FindFirst $R0 $R1 "$muxivraLegacyDirectory\outputs\*.*"
      ${DoWhile} $R1 != ""
        ${If} $R1 != "."
        ${AndIf} $R1 != ".."
          FindClose $R0
          MessageBox MB_ICONSTOP|MB_OK "旧版本卸载程序会删除安装目录中的输出文件。请先将以下 outputs 文件夹移到安装目录之外，再重新安装；安装完成后可移回。安装目录中的其他个人文件也应先移出。安装尚未开始，文件未被修改。$\r$\n$\r$\n$muxivraLegacyDirectory\outputs" /SD IDOK
          SetErrorLevel 3
          Quit
        ${EndIf}
        FindNext $R0 $R1
      ${Loop}
      FindClose $R0
      ClearErrors
    FunctionEnd
  !endif
!macroend

!macro customInit
  ; Previous releases did not include safe removal. Their own uninstallers
  ; cannot be fixed by a new installer, so fail before touching those outputs.
  Call MuxivraCheckRegisteredLegacyOutputs
  ClearErrors
!macroend

; Stop before replacing the application when a registered old uninstaller
; cannot start, fails or is cancelled. Personal data is always preserved.
!macro MuxivraRequireOldUninstallSuccess
  ${If} ${Errors}
    DetailPrint "Old uninstaller could not be started. Installation stopped."
    MessageBox MB_OK|MB_ICONSTOP "无法启动旧版卸载程序，安装已停止。$\r$\nCannot start the old uninstaller. Installation stopped." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $R0 != 0
    DetailPrint "Old uninstaller failed or was cancelled (exit $R0). Installation stopped."
    MessageBox MB_OK|MB_ICONSTOP "旧版卸载失败或已取消，安装已停止。$\r$\nThe old uninstall failed or was cancelled. Installation stopped." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro MuxivraRequireOldUninstallSuccess
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro MuxivraRequireOldUninstallSuccess
!macroend

!macro MuxivraStageFile File
  Push "${File}"
  Call un.MuxivraStageFile
!macroend

!macro MuxivraRestoreFile File
  Push "${File}"
  Call un.MuxivraRestoreFile
!macroend

!macro MuxivraRemoveEmptyDirectory Directory
  ; Do not recurse: unknown files inside a package directory also survive.
  RMDir "$INSTDIR\${Directory}"
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  StrCpy $muxivraRemovalError ""
  StrCpy $muxivraRestoreError ""
  ClearErrors
  GetTempFileName $muxivraRemovalBackup "$INSTDIR"
  ${If} ${Errors}
    DetailPrint "Cannot prepare safe application removal. No files were removed."
    SetErrorLevel 2
    Abort "Cannot prepare safe application removal."
  ${EndIf}
  Delete "$muxivraRemovalBackup"
  CreateDirectory "$muxivraRemovalBackup"
  ${If} ${Errors}
    DetailPrint "Cannot prepare safe application removal. No files were removed."
    SetErrorLevel 2
    Abort "Cannot prepare safe application removal."
  ${EndIf}

  !insertmacro MuxivraManagedFiles MuxivraStageFile
  ${If} $muxivraRemovalError != ""
    !insertmacro MuxivraManagedFiles MuxivraRestoreFile
    ${If} $muxivraRestoreError == ""
      RMDir /r "$muxivraRemovalBackup"
      DetailPrint "File is busy; the original application was restored: $muxivraRemovalError"
    ${Else}
      ; Leave the staged app files intact if restoration itself fails.
      DetailPrint "Application files awaiting recovery: $muxivraRestoreError"
    ${EndIf}
    SetErrorLevel 2
    Abort "Application files are busy. Close the application and retry."
  ${EndIf}

  RMDir /r "$muxivraRemovalBackup"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  !insertmacro MuxivraManagedDirectories MuxivraRemoveEmptyDirectory
  RMDir "$INSTDIR"
  ClearErrors
!macroend
