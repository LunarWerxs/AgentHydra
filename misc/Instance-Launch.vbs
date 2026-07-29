' Lightweight instance-manager launcher. Runs hidden via the generated .lnk.
' Release layout: invoke the compiled GUI executable with --instances.
' Source layout: ensure the web build exists once, then run the dynamic main.ts entry with Bun.
Option Explicit

Dim fso, shell, scriptDir, root, releaseExe, sourceEntry, command, rc, bunCommand, comspec
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(scriptDir)
releaseExe = fso.BuildPath(root, "CCManagerUI.exe")
sourceEntry = fso.BuildPath(root, "server\src\main.ts")
shell.CurrentDirectory = root
comspec = shell.ExpandEnvironmentStrings("%ComSpec%")

If fso.FileExists(releaseExe) Then
  command = Quote(releaseExe) & " --instances"
  shell.Run command, 0, False
ElseIf fso.FileExists(sourceEntry) Then
  bunCommand = shell.ExpandEnvironmentStrings("%APPDATA%\npm\bun.cmd")
  If Not fso.FileExists(bunCommand) Then
    bunCommand = shell.ExpandEnvironmentStrings("%USERPROFILE%\.bun\bin\bun.exe")
  End If
  If Not fso.FileExists(bunCommand) Then bunCommand = "bun"

  If Not fso.FolderExists(fso.BuildPath(root, "web\dist")) Then
    rc = shell.Run(Cmd(Quote(bunCommand) & " run build"), 0, True)
    If rc <> 0 Then
      MsgBox "CC Manager UI could not build the quick instance interface.", vbCritical, "Quick Instances"
      WScript.Quit rc
    End If
  End If
  ' Explorer and WScript can inherit a PATH that predates Bun's install. Resolve the common Bun
  ' locations explicitly and execute through cmd so a .cmd shim is always launchable.
  shell.Run Cmd(Quote(bunCommand) & " server/src/main.ts --instances"), 0, False
Else
  MsgBox "CC Manager UI could not find its executable or source entrypoint.", vbCritical, "Quick Instances"
End If

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function

Function Cmd(value)
  Cmd = Quote(comspec) & " /d /s /c " & Quote(value)
End Function
