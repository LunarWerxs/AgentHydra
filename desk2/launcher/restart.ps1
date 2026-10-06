# Restarts the AgentHydra server onto the code on disk, the chats running on (SPEC "Chat hosts"): stop.ps1,
# which lets the chats go to their hosts, then start.ps1 -NoWindow. The open window reconnects by itself,
# and reloads once its page changed. A change to the window alone needs no restart: `bun run build` in the
# desk folder is enough (the window picks the new build up within a minute).
#
#   -Chats   end the chats too (stop.ps1 -Chats)
#   -DryRun  print what each step would do and exit 0
param([switch]$Chats, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
$stopArgs = @{}
if ($Chats) { $stopArgs.Chats = $true }
if ($DryRun) { $stopArgs.DryRun = $true }
& (Join-Path $PSScriptRoot 'stop.ps1') @stopArgs
if ($DryRun) {
  & (Join-Path $PSScriptRoot 'start.ps1') -DryRun -NoWindow
  exit 0
}
# start.ps1 exits 1 when the server does not come up; on success it sets no code of its own.
$global:LASTEXITCODE = 0
& (Join-Path $PSScriptRoot 'start.ps1') -NoWindow -NoDialog
exit $LASTEXITCODE
