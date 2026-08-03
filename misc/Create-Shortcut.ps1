# Creates / refreshes the "AgentHydra" shortcut in the project root. THIN ADAPTER over the
# shared LunarWerx shortcut engine (misc\New-TrayShortcut.ps1, kit-synced — DO NOT EDIT THAT
# FILE HERE; edit lunarwerx-ui/src/tray-host/New-TrayShortcut.ps1 and run `node sync.mjs`).
# The shortcut launches misc\Tray-Launch.vbs (system tray, auto-discovers AgentHydra-Tray.ps1)
# and carries the icon, so the root has one nice clickable entry. Re-run this if you move or
# rename the folder.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra" `
  -IconFile "AgentHydra.ico" `
  -Description "Launch AgentHydra (system tray)"

# The quick launcher deliberately bypasses the tray/full daemon. Instance-Launch.vbs picks the
# compiled release executable or the source entrypoint and passes --instances with no console.
New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra Instances" `
  -IconFile "AgentHydra.ico" `
  -Description "Quick launch AgentHydra instances" `
  -VbsFile "Instance-Launch.vbs"
