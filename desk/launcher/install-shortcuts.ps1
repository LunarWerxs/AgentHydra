# Creates (or refreshes) the "Hydra Desk" shortcuts on the Desktop and in the Start Menu. They run
# launcher/start.vbs through wscript.exe, which starts start.ps1 hidden: no console flash. Icon:
# launcher/hydra-desk.ico (regenerate with `python launcher/make-icon.py`). Re-run after moving
# the desk folder.
#
#   -DryRun  print the shortcuts it would write and exit 0
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$DeskRoot = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'start.vbs'
$Icon = Join-Path $PSScriptRoot 'hydra-desk.ico'
$Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

foreach ($f in $Vbs, $Icon) {
  if (-not (Test-Path $f)) { [Console]::Error.WriteLine("missing $f"); exit 1 }
}

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hydra Desk.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Hydra Desk.lnk')
)

foreach ($lnk in $targets) {
  if ($DryRun) {
    Write-Output "[dry-run] would write $lnk -> $Wscript `"$Vbs`" (icon $Icon, start in $DeskRoot)"
    continue
  }
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $Wscript
  $s.Arguments = "`"$Vbs`""
  $s.WorkingDirectory = $DeskRoot
  $s.IconLocation = "$Icon,0"
  $s.Description = 'Hydra Desk: Claude Code chats, CliMayte workers and AgentHydra in one window'
  $s.WindowStyle = 7  # minimized: wscript has no window anyway; this keeps any edge case out of sight
  $s.Save()
  Write-Output "wrote $lnk"
}
exit 0
