; Chord's additions to electron-builder's NSIS installer.
;
; Registers Chord as a browser Windows can offer in Settings > Default apps
; (ARCHITECTURE.md §15, default browser). Per-user, under HKCU, like the
; install itself. Windows never lets an app make itself the default (the
; UserChoice keys are protected), so this only makes Chord a choice.
;
; Links arrive as `Chord.exe --single-argument <url>`, as with Chrome: Chromium
; treats everything after that switch as one argument, so a crafted link can't
; add switches of its own (src/main/os-links.ts).

; Agents' relays (issue #142). Claude Code, Codex and Antigravity start `Chord.exe mcp` from this
; folder (src/main/agents/mcp-main.ts) and keep it running after Chord's window closes, which keeps
; Chord's files in use. Ending one isn't enough: the agent starts it again on its next tool call. So
; setup ends the relays, then stops anything new from running out of this folder (a deny-execute
; entry on its files, for Everyone) until the new files are in. The agent's next call starts the new
; relay. Only `Chord.exe mcp` from this folder is ended without asking; Chord itself still gets
; electron-builder's "Chord is running" question.
;
; customCheckAppRunning replaces electron-builder's check, so what it would include itself comes here.
!include "getProcessInfo.nsh"
Var pid
Var /GLOBAL chordRelays

; Ends the relays running from $INSTDIR. $chordRelays: how many there were (0: none left).
!macro chordEndRelays
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$r = @(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase') -and $$_.CommandLine -match '\smcp(\s|$$)' -and $$_.CommandLine -notmatch '--type=|--single-argument'}); $$r | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit $$r.Count"`
  Pop $chordRelays
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${if} $IsPowerShellAvailable == 0
    !insertmacro chordEndRelays
  ${endIf}
  ; Chord itself, if it's open (and anything else from this folder): electron-builder's own check.
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    ; From here nothing in this folder may start until customInstall (or a failed update) lifts it.
    nsExec::Exec `"$SYSDIR\icacls.exe" "$INSTDIR" /deny *S-1-1-0:(OI)(IO)(X)`
    Pop $0
    ${if} $IsPowerShellAvailable == 0
      StrCpy $R1 0
      ${do}
        !insertmacro chordEndRelays
        ${if} $chordRelays == 0
          ${break}
        ${endIf}
        IntOp $R1 $R1 + 1
        ${if} $R1 > 20
          ${break}
        ${endIf}
        Sleep 250
      ${loop}
    ${endIf}
  !endif
!macroend

; Lets Chord's files run again: after the new files are in (customInstall), or when the update failed.
!macro chordAllowRunning
  nsExec::Exec `"$SYSDIR\icacls.exe" "$INSTDIR" /remove:d *S-1-1-0`
  Pop $0
!macroend

; The old version's uninstaller couldn't remove its files (electron-builder would say only "Failed to
; uninstall old application files: 2"). Says what's holding them, in Chord's voice.
!macro customUnInstallCheck
  ${if} $R0 != 0
    !insertmacro chordAllowRunning
    ; Whether a relay is what's still running (none if PowerShell couldn't tell: "error" counts as 0).
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "exit @(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase') -and $$_.CommandLine -match '\smcp(\s|$$)'}).Count"`
    Pop $chordRelays
    ${if} $chordRelays > 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Chord couldn${U+2019}t update: an agent connected to Chord (like Claude Code, Codex or Antigravity) is still using its files. Close that agent, then run setup again." /SD IDOK
    ${else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Chord couldn${U+2019}t update: another program is still using its files. Restart your computer, then run setup again." /SD IDOK
    ${endIf}
    DetailPrint `The old version's uninstaller exited with $R0.`
    SetErrorLevel 2
    Quit
  ${endIf}
!macroend

!define CHORD_CLIENT "Software\Clients\StartMenuInternet\Chord"

!macro customInstall
  ; The new files are in: Chord, and agents' relays, may run again (customCheckAppRunning stopped them).
  !insertmacro chordAllowRunning

  ; The document type web links and .html files open as.
  WriteRegStr HKCU "Software\Classes\ChordHTML" "" "Chord HTML Document"
  WriteRegStr HKCU "Software\Classes\ChordHTML" "FriendlyTypeName" "Chord HTML Document"
  WriteRegStr HKCU "Software\Classes\ChordHTML\Application" "ApplicationName" "Chord"
  WriteRegStr HKCU "Software\Classes\ChordHTML\Application" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\ChordHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\ChordHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --single-argument %1'

  ; The browser entry, and what it can open.
  WriteRegStr HKCU "${CHORD_CLIENT}" "" "Chord"
  WriteRegStr HKCU "${CHORD_CLIENT}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${CHORD_CLIENT}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities" "ApplicationName" "Chord"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities" "ApplicationDescription" "A calm, colorful browser"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities\StartMenu" "StartMenuInternet" "Chord"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities\URLAssociations" "http" "ChordHTML"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities\URLAssociations" "https" "ChordHTML"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities\FileAssociations" ".htm" "ChordHTML"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities\FileAssociations" ".html" "ChordHTML"
  WriteRegStr HKCU "${CHORD_CLIENT}\Capabilities\FileAssociations" ".xhtml" "ChordHTML"

  ; The value name is what Settings' "registeredAppUser=Chord" link finds (src/main/default-browser.ts).
  WriteRegStr HKCU "Software\RegisteredApplications" "Chord" "${CHORD_CLIENT}\Capabilities"

  ; SHCNE_ASSOCCHANGED: tell the shell the associations changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; Updates run the old uninstaller first; customInstall writes all of this back right after.
  DeleteRegValue HKCU "Software\RegisteredApplications" "Chord"
  DeleteRegKey HKCU "${CHORD_CLIENT}"
  DeleteRegKey HKCU "Software\Classes\ChordHTML"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Chord Player (ARCHITECTURE.md §9, Chord Player) goes with Chord: every version, its profile
  ; (its sign-ins and the Widevine CDM) and its state, from where src/main/player/paths.ts puts it.
  ; Only on a real uninstall: an update runs this uninstaller with --updated (electron-builder's
  ; isUpdated), and the player stays. Chord has quit by now, and the player quits once Chord's
  ; channel closes; a file it still holds stays behind, and nothing else depends on it.
  ; Chord installs per user (perMachine: false), so $LOCALAPPDATA is that user's, as the player's root is.
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Chord Player"
  ${endif}
!macroend
