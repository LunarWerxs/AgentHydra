# Creates / refreshes the "DevWebUI" shortcut in the project root, pointing at
# the shared misc\Tray-Launch.vbs and carrying the icon. Re-run after moving/renaming
# the folder (.lnk files store ABSOLUTE paths) or after regenerating the icon.
#
# THIN ADAPTER over the shared LunarWerx tray shortcut engine — this file just supplies
# DevWebUI's own name / icon / description; the actual .lnk-building logic lives in
# New-TrayShortcut.ps1 (kit-synced, DO NOT EDIT).
param([switch]$Legacy)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

# The shortcut runs the NATIVE tray host (misc\lunarwerx-tray.exe; source vendored beside it in
# misc	ray-host-native\), not wscript + Tray-Launch.vbs + the PowerShell adapter. That chain cost
# ~520ms of script-host startup before the daemon process even existed; this one spawns it at ~25ms.
# Both hosts still ship, so -Legacy rebuilds the shortcut against the old chain if ever needed.
$native = @{ ExeFile = "lunarwerx-tray.exe"; ExeArguments = "DevWebUI-Tray.json" }
if ($Legacy) { $native = @{} }


New-TrayShortcut `
  -Root $root `
  -ScriptDir $scriptDir `
  -LnkName "DevWebUI" `
  -IconFile "DevWebUI.ico" `
  -Description "Launch DevWebUI (system tray)" `
  @native
