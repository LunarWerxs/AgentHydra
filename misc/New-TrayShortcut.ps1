# =====================================================================================
# Create a Start-menu / desktop shortcut that launches the app's tray host hidden
# (via Tray-Launch.vbs), using the app's icon and description. Idempotent: re-running
# just refreshes the shortcut in place.
# =====================================================================================

function New-TrayShortcut {
  # -Root        Project root — where the .lnk lives and the shortcut's WorkingDirectory.
  # -ScriptDir   The app's misc/ dir — holds Tray-Launch.vbs and the icon.
  # -LnkName     Shortcut label WITHOUT ".lnk" (the name users SEE under the icon). MAY contain
  #              non-ASCII (e.g. 'RēDesign' with U+0113) — handled via the ASCII-temp dance below.
  # -IconFile    Icon filename inside ScriptDir (e.g. '<App>.ico').
  # -Description The .lnk Description tooltip. MUST be pure ASCII (see the ANSI note below).
  # -VbsFile     The launcher the shortcut runs (default the shared 'Tray-Launch.vbs').
  # -LegacyLnks  Old .lnk BASE names (with or without .lnk) to delete from Root so a rename/history
  #              doesn't leave the user with duplicate shortcuts. Best-effort.
  param(
    [Parameter(Mandatory = $true)] [string]   $Root,
    [Parameter(Mandatory = $true)] [string]   $ScriptDir,
    [Parameter(Mandatory = $true)] [string]   $LnkName,
    [Parameter(Mandatory = $true)] [string]   $IconFile,
    [Parameter(Mandatory = $true)] [string]   $Description,
    [string]   $VbsFile = 'Tray-Launch.vbs',
    [string[]] $LegacyLnks = @(),
    # NATIVE HOST (opt-in): point the shortcut straight at an executable in ScriptDir instead of at
    # wscript.exe + the .vbs. The .vbs indirection exists only to launch PowerShell without a
    # console flash; a native host suppresses its own console, so both layers can go. An app that
    # has not moved over simply omits these and keeps the wscript path byte-identical.
    [string]   $ExeFile = '',
    [string]   $ExeArguments = ''
  )

  $finalLnk = Join-Path $Root ($LnkName + '.lnk')

  # Does the label contain any non-ASCII char (code point > 127)? WScript.Shell saves the .lnk
  # through an ANSI path, so it can only WRITE to an ASCII filename — a Unicode target name is
  # silently transliterated (e.g. ē -> e). So for a non-ASCII label we save to a plain-ASCII temp
  # name, then rename to the real name via the Unicode filesystem API (Move-Item), which preserves
  # it (NTFS stores filenames as UTF-16, so the macron/accent survives there). A pure-ASCII label
  # needs none of that — we save straight to the final path.
  $isAscii = $true
  foreach ($ch in $LnkName.ToCharArray()) { if ([int][char]$ch -gt 127) { $isAscii = $false; break } }

  # An ASCII-only sibling name for the temp save (strip any non-ASCII char). Used only on the
  # non-ASCII path; a pure-ASCII label writes to $finalLnk directly (no temp, no rename).
  if ($isAscii) {
    $tmpLnk = $finalLnk
  } else {
    $asciiBase = -join ($LnkName.ToCharArray() | Where-Object { [int][char]$_ -le 127 })
    if (-not $asciiBase) { $asciiBase = 'TrayShortcut' }
    $tmpLnk = Join-Path $Root ($asciiBase + '.lnk')
  }

  # Best-effort cleanup: any legacy .lnk names (supersedes older pre-rename shortcuts), the ASCII
  # temp, and the final target — so a re-run never leaves the owner with duplicate/stale shortcuts.
  $toRemove = @($finalLnk, $tmpLnk)
  foreach ($n in $LegacyLnks) {
    $bn = $n
    if (-not $bn.ToLower().EndsWith('.lnk')) { $bn = $bn + '.lnk' }
    $toRemove += (Join-Path $Root $bn)
  }
  foreach ($p in ($toRemove | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $p) { try { Remove-Item -LiteralPath $p -Force } catch {} }
  }

  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($tmpLnk)
  if ($ExeFile) {
    # Native host: the shortcut runs the executable directly. One process instead of three
    # (wscript -> powershell -> daemon), and no console to suppress.
    $sc.TargetPath = Join-Path $ScriptDir $ExeFile
    $sc.Arguments  = $ExeArguments
  } else {
    # Run the .vbs through wscript explicitly (no console window, no file-association surprises).
    $sc.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
    $sc.Arguments  = '"' + (Join-Path $ScriptDir $VbsFile) + '"'
  }
  $sc.WorkingDirectory = $Root
  $sc.IconLocation = (Join-Path $ScriptDir $IconFile) + ",0"
  # WScript.Shell's .lnk Description property is ANSI-limited and silently drops non-ASCII (ē
  # becomes e), so callers pass the plain-ASCII form here rather than have it disagree with the
  # filename. (The filename above carries the accent; the Description can't.)
  $sc.Description = $Description
  $sc.Save()

  # Non-ASCII label only: rename the saved ASCII shortcut to the real name. Renaming does not touch
  # the .lnk's internal TargetPath / IconLocation, so the shortcut keeps working. (ASCII label saved
  # straight to $finalLnk, so $tmpLnk -eq $finalLnk and there is nothing to move.)
  if ($tmpLnk -ne $finalLnk) {
    Move-Item -LiteralPath $tmpLnk -Destination $finalLnk -Force
  }
  Write-Host "Created shortcut: $finalLnk"
}
