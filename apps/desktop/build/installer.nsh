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
; Chord's files in use. Ending one isn't enough: the agent starts it again on its next tool call
; (measured with Claude Code). So setup first keeps anything new from running out of this folder (a
; deny-execute entry for Everyone, inherited by its files: a relay that tries gets EPERM at once),
; then ends the relays, then checks for Chord itself. customInstall lifts the entry once the new
; files are in, and the agent's next call starts the new relay. Every way out before that (Cancel,
; Chord won't close, the old version's uninstaller fails) lifts it too, so Chord is never left
; unable to start. Only `Chord.exe mcp` from this folder is ended without asking.
;
; customCheckAppRunning replaces electron-builder's check (its _CHECK_APP_RUNNING, which Chord's
; mirrors with the entry lifted before each Quit). What that check would include itself comes here,
; for the fallback when PowerShell can't run.
!include "getProcessInfo.nsh"
Var pid
Var /GLOBAL chordRelays
Var /GLOBAL chordRunning
Var /GLOBAL chordPowerShell ; "0" when PowerShell can run (electron-builder's IsPowerShellAvailable)

; The folder goes to PowerShell through the environment, never inside its command (a ' in a user's
; name would end the string). nsExec's processes inherit setup's environment.
!macro chordPassFolder
  System::Call 'kernel32::SetEnvironmentVariable(t "CHORD_INSTDIR", t "$INSTDIR\")'
!macroend

; Ends the relays running from this folder. $chordRelays: how many there were.
!macro chordEndRelays
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "$$r = @(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith($$env:CHORD_INSTDIR, 'OrdinalIgnoreCase') -and $$_.CommandLine -match '\smcp(\s|$$)' -and $$_.CommandLine -notmatch '--type=|--single-argument'}); $$r | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit $$r.Count"`
  Pop $chordRelays
!macroend

; How many relays run from this folder, ending none. $chordRelays.
!macro chordCountRelays
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "exit @(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith($$env:CHORD_INSTDIR, 'OrdinalIgnoreCase') -and $$_.CommandLine -match '\smcp(\s|$$)'}).Count"`
  Pop $chordRelays
!macroend

; How many processes run from this folder (Chord, or anything else of its). $chordRunning.
!macro chordFindApp
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "exit @(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith($$env:CHORD_INSTDIR, 'OrdinalIgnoreCase')}).Count"`
  Pop $chordRunning
!macroend

; Asks them to end (FORCE: "" or "-Force").
!macro chordStopApp FORCE
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith($$env:CHORD_INSTDIR, 'OrdinalIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId ${FORCE} -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

; Keeps anything new from starting out of this folder (installer only: the uninstaller removes it).
!macro chordStopRunning
  !ifndef BUILD_UNINSTALLER
    nsExec::Exec `"$SYSDIR\icacls.exe" "$INSTDIR" /deny *S-1-1-0:(OI)(IO)(X)`
    Pop $0
  !endif
!macroend

; Lets Chord's files run again: after the new files are in (customInstall), and before any Quit.
!macro chordAllowRunning
  !ifndef BUILD_UNINSTALLER
    nsExec::Exec `"$SYSDIR\icacls.exe" "$INSTDIR" /remove:d *S-1-1-0`
    Pop $0
  !endif
!macroend

!macro chordQuit
  !insertmacro chordAllowRunning
  SetErrorLevel 2
  Quit
!macroend

!macro customCheckAppRunning
  !insertmacro chordPassFolder
  ; electron-builder's own probe sets $IsPowerShellAvailable, which its fallback check reads. Chord's runs the
  ; very query it depends on instead: on CI's runner electron-builder's said no while this one works.
  !insertmacro IS_POWERSHELL_AVAILABLE
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $$PID) -ErrorAction Stop | Out-Null; exit 0"`
  Pop $chordPowerShell
  ${if} $chordPowerShell != 0
    ; Without PowerShell: electron-builder's own check (tasklist and taskkill by name), then the entry.
    !insertmacro _CHECK_APP_RUNNING
    !insertmacro chordStopRunning
  ${else}
    !insertmacro chordStopRunning
    ; Relays end without asking. A restart that began before the entry may still land: try a few times.
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

    ; Chord itself: electron-builder's question, then its way of closing it.
    !insertmacro chordFindApp
    ${if} $chordRunning > 0
      ${ifNot} ${isUpdated}
        ${if} ${Cmd} `MessageBox MB_OKCANCEL "$(appRunning)" /SD IDOK IDCANCEL`
          !insertmacro chordQuit
        ${endIf}
      ${else}
        ; Chord is quitting to update: give it a moment to go on its own.
        Sleep 1000
      ${endIf}
      DetailPrint "$(appClosing)"
      !insertmacro chordStopApp ""
      Sleep 300
      StrCpy $R1 0
      ${do}
        !insertmacro chordFindApp
        ${if} $chordRunning == 0
          ${break}
        ${endIf}
        Sleep 1000
        !insertmacro chordStopApp "-Force"
        !insertmacro chordFindApp
        ${if} $chordRunning == 0
          ${break}
        ${endIf}
        Sleep 2000
        IntOp $R1 $R1 + 1
        ${if} $R1 > 1
          ${if} ${Cmd} `MessageBox MB_RETRYCANCEL "Chord couldn${U+2019}t close. Close it, then try again." /SD IDCANCEL IDCANCEL`
            !insertmacro chordQuit
          ${endIf}
        ${endIf}
      ${loop}
    ${endIf}
  ${endIf}
!macroend

; The old version's uninstaller couldn't remove its files (electron-builder would say only "Failed to
; uninstall old application files: 2"). Setup puts Chord back as it was and says what held its files.
; Run by the in-app updater, setup is silent: it leaves a note in Chord's profile folder
; (src/main/update-outcome.ts) and reopens Chord when the updater asked for that, and Chord says it.
!macro customUnInstallCheck
  ${if} $R0 != 0
    !insertmacro chordAllowRunning
    StrCpy $chordRelays 0
    ${if} $chordPowerShell == 0
      !insertmacro chordCountRelays
    ${endIf}
    DetailPrint `The old version's uninstaller exited with $R0.`
    ${if} ${isUpdated}
      CreateDirectory "$LOCALAPPDATA\${PRODUCT_NAME}\User Data"
      FileOpen $0 "$LOCALAPPDATA\${PRODUCT_NAME}\User Data\Update Failed" w
      ${if} $chordRelays > 0
        FileWrite $0 "agent"
      ${else}
        FileWrite $0 "other"
      ${endIf}
      FileClose $0
      ${if} ${isForceRun}
        Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}"`
      ${endIf}
    ${elseif} $chordRelays > 0
      MessageBox MB_OK "Chord couldn${U+2019}t update: an agent connected to Chord (like Claude Code, Codex or Antigravity) is still using its files. Close that agent, then run setup again." /SD IDOK
    ${else}
      MessageBox MB_OK "Chord couldn${U+2019}t update: another program is still using its files. Restart your computer, then run setup again." /SD IDOK
    ${endIf}
    SetErrorLevel 2
    Quit
  ${else}
    ; The old uninstaller removed the folder, and the entry with it: put it back on the folder the new files go
    ; into, so nothing starts from them half-written. customInstall lifts it.
    CreateDirectory "$INSTDIR"
    !insertmacro chordStopRunning
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
