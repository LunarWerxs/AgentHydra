' =====================================================================================
' Run Ensure-Daemon.ps1 with NO visible window. This is the supervisor's action, invoked
' by the "AgentHydra Daemon Supervisor" scheduled task (see Install-DaemonSupervisor.ps1).
'
' WHY A VBS AND NOT JUST powershell.exe: the task fires every few minutes, forever. A bare
' PowerShell action flashes a console window each time even with -WindowStyle Hidden,
' because the host window exists before the switch is read. A supervisor that strobes a
' black rectangle across your screen all day is a supervisor you will disable by Friday,
' and then the thing it was guarding dies unwatched. Same reason and same technique as
' Tray-Launch.vbs next door: WScript.Shell.Run with windowStyle 0 never creates one.
'
' EXIT CODE IS FORWARDED, deliberately. Ensure-Daemon.ps1 exits 0 when a healthy daemon of
' ours is answering (already up, or up after a restart) and 1 when it could not be brought
' back. Task Scheduler records that as the task's Last Run Result, so "is the supervisor
' actually keeping it alive?" is answerable from the task's own history instead of taking
' the schedule's word for it. Swallowing it would make every failed recovery look like a
' success.
' =====================================================================================

Dim sh, fso, scriptDir, root, ps, cmd, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\misc
root = fso.GetParentFolderName(scriptDir)                     ' project root

' Parity with Tray-Launch.vbs: run from the project root so the daemon's relative paths
' (server/src/index.ts, web build outputs) resolve when Ensure-Daemon delegates a restart.
sh.CurrentDirectory = root

ps = scriptDir & "\Ensure-Daemon.ps1"
If Not fso.FileExists(ps) Then
  ' No MsgBox here, unlike the tray launcher: this runs unattended every few minutes, and a
  ' modal dialog nobody is present to dismiss would pile up invisibly forever. Exit non-zero
  ' and let the task history carry the bad news.
  WScript.Quit 2
End If

cmd = "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps & """"

' 0 = hidden window (no flash), True = WAIT, so the exit code below is real rather than the
' exit code of having successfully started something.
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
