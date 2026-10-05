' =====================================================================================
' Boot the app's tray host with no visible window. Auto-discovers the sibling
' "*-Tray.ps1" adapter in this folder and launches it hidden via PowerShell; the
' adapter's own param() default supplies the port on a plain launch.
'
' DRAG-AND-DROP: dropping files/folders onto the .lnk passes their paths here as
' WScript.Arguments. We forward them to the adapter through the LUNARWERX_TRAY_DROP
' environment variable (paths joined with '|', which is illegal in Windows paths so a
' safe delimiter) — NOT as a -parameter, so an adapter that doesn't opt in simply
' ignores the var instead of erroring on an unknown switch. Adapters that support drops
' read $env:LUNARWERX_TRAY_DROP and act on it.
' =====================================================================================

Dim sh, fso, scriptDir, root, adapter
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\misc
root = fso.GetParentFolderName(scriptDir)                     ' project root
' Parity with the old per-app launchers: run from the project root so the daemon's relative
' paths (src\index.ts, web build outputs, runtime.json under the app home) resolve.
sh.CurrentDirectory = root

' --- Auto-discover the sibling adapter (the one "*-tray.ps1", case-insensitive) ---
Dim f, lname, matchName, matchCount
matchName = ""
matchCount = 0
For Each f In fso.GetFolder(scriptDir).Files
  lname = LCase(f.Name)
  ' Endswith "-tray.ps1": matches "<App>-Tray.ps1"; excludes "-host.ps1" and "-shortcut.ps1".
  If Len(lname) >= 9 Then
    If Right(lname, 9) = "-tray.ps1" Then
      matchName = f.Name
      matchCount = matchCount + 1
    End If
  End If
Next

If matchCount = 0 Then
  MsgBox "Tray launcher: no '*-Tray.ps1' adapter found in " & scriptDir & vbCrLf & _
         "Restore the app's *-Tray.ps1 adapter script.", _
         vbCritical, "LunarWerx tray launcher"
  WScript.Quit 1
End If
If matchCount > 1 Then
  MsgBox "Tray launcher: more than one '*-Tray.ps1' adapter found in " & scriptDir & _
         vbCrLf & "Exactly one is expected. Leave only the app's <App>-Tray.ps1.", _
         vbCritical, "LunarWerx tray launcher"
  WScript.Quit 1
End If
adapter = matchName

' --- Drag-and-drop: forward any dropped paths to the adapter via an env var it can opt into ---
' Join them with '|' (illegal in Windows paths) and set LUNARWERX_TRAY_DROP on THIS process, which
' the hidden PowerShell child inherits. Empty on a plain (double-click) launch, so nothing changes
' there; an adapter without drop support never reads the var, so this is harmless for every app.
Dim dropList, i
dropList = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then dropList = dropList & "|"
  dropList = dropList & WScript.Arguments(i)
Next
If Len(dropList) > 0 Then
  sh.Environment("Process").Item("LUNARWERX_TRAY_DROP") = dropList
End If

' --- Launch the adapter hidden, with NO -Port (its param default supplies the port) ---
' 0 = hidden window (no console flash), False = don't wait.
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\" & adapter & """", 0, False
