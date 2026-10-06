# Creates (or refreshes) the "AgentHydra" shortcuts on the Desktop and in the Start Menu. They run
# launcher/start.vbs through wscript.exe, which starts start.ps1 hidden: no console flash. Icon:
# launcher/hydra-desk.ico (regenerate with `python launcher/make-icon.py`). Re-run after moving
# the desk folder.
#
# This window was called Hydra Desk 2 until 2026-10-06, when it became AgentHydra 2.0 (owner): the
# "Hydra Desk 2" shortcuts this script made before go to the Recycle Bin, and only those that run this
# launcher.
#
#   -DryRun  print the shortcuts it would write and retire, and exit 0
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$DeskRoot = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'start.vbs'
$Icon = Join-Path $PSScriptRoot 'hydra-desk.ico'
$Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

foreach ($f in $Vbs, $Icon) {
  if (-not (Test-Path $f)) { [Console]::Error.WriteLine("missing $f"); exit 1 }
}

$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
$sh = New-Object -ComObject WScript.Shell

foreach ($dir in $folders) {
  $lnk = Join-Path $dir 'AgentHydra.lnk'
  if ($DryRun) {
    Write-Output "[dry-run] would write $lnk -> $Wscript `"$Vbs`" (icon $Icon, start in $DeskRoot)"
  } else {
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = $Wscript
    $s.Arguments = "`"$Vbs`""
    $s.WorkingDirectory = $DeskRoot
    $s.IconLocation = "$Icon,0"
    $s.Description = 'AgentHydra: Claude Code chats, CliMayte workers and every account in one window'
    $s.WindowStyle = 7  # minimized: wscript has no window anyway; this keeps any edge case out of sight
    $s.Save()
    Write-Output "wrote $lnk"
  }

  $old = Join-Path $dir 'Hydra Desk 2.lnk'
  if (-not (Test-Path -LiteralPath $old)) { continue }
  if ($sh.CreateShortcut($old).Arguments -notlike "*$Vbs*") { continue }  # not ours: left alone
  if ($DryRun) {
    Write-Output "[dry-run] would move $old to the Recycle Bin"
    continue
  }
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($old, 'OnlyErrorDialogs', 'SendToRecycleBin')
  Write-Output "moved $old to the Recycle Bin"
}
exit 0
