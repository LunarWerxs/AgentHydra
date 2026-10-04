' What the Hydra Desk 2 shortcut runs: start.ps1 through a hidden PowerShell, so no console window
' ever flashes (a shortcut straight to "powershell -WindowStyle Hidden" shows one for a moment
' before PowerShell can hide it). Arguments are passed through, e.g. start.vbs -DryRun.
Dim sh, fso, here, args, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & WScript.Arguments(i) & """"
Next
' 0 = hidden window, False = do not wait.
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\start.ps1""" & args, 0, False
