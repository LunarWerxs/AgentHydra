' What the AgentHydra shortcut runs: start.ps1 through a hidden PowerShell, so no console window
' ever flashes (a shortcut straight to "powershell -WindowStyle Hidden" shows one for a moment
' before PowerShell can hide it). Arguments are passed through, e.g. start.vbs -DryRun.
'
' When the server already answers and the host has run before, the window host is run from here and
' start.ps1 follows with -NoWindow for the tray: PowerShell's own startup was a quarter of a second
' of every open (2026-10-08). Anything else (arguments, no server, the host's first run) goes through
' start.ps1 as before, which starts the server, waits for it and reports failures.
Dim sh, fso, here, args, i, port, hostExe, ps, direct
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & WScript.Arguments(i) & """"
Next
ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\start.ps1"""

Function ServerAnswers(url)
  ServerAnswers = False
  On Error Resume Next
  Dim req
  Set req = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  ' resolve, connect, send, receive (ms): a refused or busy server falls back to start.ps1 at once.
  req.setTimeouts 300, 300, 500, 800
  req.open "GET", url & "/api/health", False
  req.send
  If Err.Number = 0 Then ServerAnswers = (req.status = 200)
  On Error GoTo 0
End Function

port = sh.Environment("PROCESS")("HYDRA_DESK_PORT")
If port = "" Then port = "7798"
hostExe = here & "\HydraDesk2.exe"
' VBScript's And evaluates both sides, so the health call sits behind the cheap checks.
direct = False
If WScript.Arguments.Count = 0 And fso.FileExists(hostExe) _
    And fso.FolderExists(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\HydraDesk2\webview") Then
  direct = ServerAnswers("http://127.0.0.1:" & port)
End If
If direct Then
  sh.CurrentDirectory = here
  ' 1 = a normal window, as start.ps1's Start-Process gives it; the host shows itself once placed.
  sh.Run """" & hostExe & """ --url http://127.0.0.1:" & port, 1, False
  sh.Run ps & " -NoWindow", 0, False
Else
  ' 0 = hidden window, False = do not wait.
  sh.Run ps & args, 0, False
End If
