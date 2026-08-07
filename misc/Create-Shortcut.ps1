# Creates / refreshes the "AgentHydra" shortcut in the project root. THIN ADAPTER over the
# shared LunarWerx shortcut engine (misc\New-TrayShortcut.ps1, kit-synced — DO NOT EDIT THAT
# FILE HERE; edit lunarwerx-ui/src/tray-host/New-TrayShortcut.ps1 and run `node sync.mjs`).
# The shortcut launches misc\Tray-Launch.vbs (system tray, auto-discovers AgentHydra-Tray.ps1)
# and carries the icon, so the root has one nice clickable entry. Re-run this if you move or
# rename the folder.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

# The main shortcut runs the NATIVE tray host (misc\lunarwerx-tray.exe, kit source
# lunarwerx-ui/src/tray-host-native), not wscript + Tray-Launch.vbs + AgentHydra-Tray.ps1.
# Measured on the author's machine, alternating runs: the PowerShell chain started the daemon at
# +475ms and was serving at +745-1115ms; the native host starts it at +25ms and serves at ~274ms.
# Almost all of the difference is script-host overhead (wscript, the CLR, Add-Type of WinForms, and
# parsing 1,215 lines) rather than anything the app does.
New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra" `
  -IconFile "AgentHydra.ico" `
  -Description "Launch AgentHydra (system tray)" `
  -ExeFile "lunarwerx-tray.exe" `
  -ExeArguments "AgentHydra-Tray.json"

# The quick launcher deliberately bypasses the tray/full daemon. Instance-Launch.vbs picks the
# compiled release executable or the source entrypoint and passes --instances with no console.
New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra Instances" `
  -IconFile "AgentHydra.ico" `
  -Description "Quick launch AgentHydra instances" `
  -VbsFile "Instance-Launch.vbs"
