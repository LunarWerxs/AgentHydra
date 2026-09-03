' tray-launch.vbs - start the Orchestrator tray icon with NO console window, ever.
'
' WHY THIS EXISTS: a shortcut pointing straight at powershell.exe -WindowStyle Hidden still
' CREATES a console and then hides it, so every launch (and every login, with the Startup
' shortcut) flashes a black box on screen. Windows Script Host's Run with intWindowStyle 0
' never creates one, which is the same trick the LunarWerx tray apps use. Owner, 2026-09-02:
' "I wouldn't want this open in like a console."
'
' Nothing app-specific lives here: it resolves its own folder and runs the sibling tray.ps1.
Option Explicit
Dim sh, fso, here, tray, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
tray = fso.BuildPath(here, "tray.ps1")
If Not fso.FileExists(tray) Then
  MsgBox "Orchestrator: tray.ps1 was not found next to this launcher." & vbCrLf & tray, 16, "Orchestrator"
  WScript.Quit 1
End If
' Working directory = the repo root, so the tray's own relative paths resolve as they do from a terminal.
sh.CurrentDirectory = fso.GetParentFolderName(here)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & tray & """"
' 0 = no window at all. False = do not wait; the launcher exits and the icon keeps running.
sh.Run cmd, 0, False
