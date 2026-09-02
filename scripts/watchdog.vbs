' watchdog.vbs - runs watchdog.mjs INVISIBLY. The scheduled task used to point at bun.exe
' directly, which popped a console window every 2 minutes all day (owner complaint,
' 2026-09-01: "something just keeps running a bun executable over and over again and it's
' getting annoying"). Same check, same cadence, zero windows - the same wscript pattern
' Supervisor-Tick.vbs and the orchestrator's job shims already use.
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\blogi\.bun\bin\bun.exe"" ""D:\PublicProjects\AgentHydra\app\scripts\watchdog.mjs""", 0, True
