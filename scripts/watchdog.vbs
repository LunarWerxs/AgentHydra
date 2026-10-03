' watchdog.vbs - runs watchdog.mjs INVISIBLY. The scheduled task used to point at bun.exe
' directly, which popped a console window every 2 minutes all day (owner complaint,
' 2026-09-01: "something just keeps running a bun executable over and over again and it's
' getting annoying"). Same check, same cadence, zero windows - the same wscript pattern
' Supervisor-Tick.vbs and the orchestrator's job shims already use.
' watchdog.mjs is resolved beside this file, so the task follows whichever checkout it points
' at (the live checkout, docs/LIVE-CHECKOUT.md) instead of a hard-coded path.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
mjs = fso.GetParentFolderName(WScript.ScriptFullName) & "\watchdog.mjs"
sh.Run """" & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.bun\bin\bun.exe"" """ & mjs & """", 0, True
