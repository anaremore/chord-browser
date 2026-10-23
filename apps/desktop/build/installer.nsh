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

!define CHORD_CLIENT "Software\Clients\StartMenuInternet\Chord"

!macro customInstall
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
!macroend
