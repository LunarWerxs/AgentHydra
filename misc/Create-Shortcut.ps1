# Creates / refreshes the "AgentHydra" shortcut in the project root. THIN ADAPTER over the
# shared LunarWerx shortcut engine (misc\New-TrayShortcut.ps1, kit-synced — DO NOT EDIT THAT
# FILE HERE; edit lunarwerx-ui/src/tray-host/New-TrayShortcut.ps1 and run `node sync.mjs`).
# The shortcut launches the native tray host and carries the icon, so the root has one nice
# clickable entry. Re-run this if you move or rename the folder.
#
#   -Legacy   Rebuild the shortcut against the OLD wscript + Tray-Launch.vbs + AgentHydra-Tray.ps1
#             chain. Both hosts are shipped and either can drive the app, so if the native one ever
#             misbehaves the rollback is this one switch rather than a code change:
#                 powershell -File misc\Create-Shortcut.ps1 -Legacy
param([switch]$Legacy)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

# The main shortcut runs the NATIVE tray host (misc\lunarwerx-tray.exe; source vendored beside it in
# misc\tray-host-native\, kit source lunarwerx-ui/src/tray-host-native), not wscript +
# Tray-Launch.vbs + AgentHydra-Tray.ps1. Measured on the author's machine, alternating runs: the
# PowerShell chain started the daemon at +475ms and was serving at +745-1115ms; the native host
# starts it at +25ms and serves at ~400ms through the real shortcut. Almost all of the difference is
# script-host overhead (wscript, the CLR, Add-Type of WinForms, and parsing 1,215 lines) rather than
# anything the app does.
$native = @{ ExeFile = "lunarwerx-tray.exe"; ExeArguments = "AgentHydra-Tray.json" }
if ($Legacy) { $native = @{} }
New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra" `
  -IconFile "AgentHydra.ico" `
  -Description "Launch AgentHydra (system tray)" `
  @native

# The quick launcher deliberately bypasses the tray/full daemon. Instance-Launch.vbs picks the
# compiled release executable or the source entrypoint and passes --instances with no console.
New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra Instances" `
  -IconFile "AgentHydra.ico" `
  -Description "Quick launch AgentHydra instances" `
  -VbsFile "Instance-Launch.vbs"
