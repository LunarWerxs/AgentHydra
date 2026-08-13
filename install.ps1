<#
.SYNOPSIS
  Install AgentHydra on Windows, verifying the download against the release's published SHA-256.

.DESCRIPTION
  We ship a bare .exe and a ZIP, and the instructions were "download it and put it somewhere". That
  works, and it also means nobody checks what they downloaded — so this script exists mainly to make
  the checksum step the DEFAULT rather than an extra thing a careful person does by hand.

  THE VERIFICATION IS THE POINT, so it is not optional and there is no -SkipVerify switch. Every
  release publishes SHA256SUMS.txt (see docs/RELEASING.md), generated in the same workflow job that
  uploads the binaries. This downloads that file, finds the line for the asset it just fetched, and
  compares. A mismatch deletes the download and stops. An installer that would proceed anyway is an
  installer whose checksum step is decoration.

  What it does NOT do, deliberately:
    * No elevation. Everything lands under %LOCALAPPDATA%, so this never needs Administrator, and a
      script fetched from the internet asking for admin is a habit worth not teaching.
    * No PATH edit, no registry writes, no service. It copies files and optionally makes a shortcut.
    * No auto-start. AgentHydra has its own update path once installed (docs/RELEASING.md).

.PARAMETER Version
  A specific release tag (e.g. v0.19.3). Defaults to the latest published release.

.PARAMETER InstallDir
  Where to install. Defaults to %LOCALAPPDATA%\Programs\AgentHydra.

.PARAMETER NoShortcut
  Skip creating the Start Menu shortcut.

.EXAMPLE
  irm https://raw.githubusercontent.com/LunarWerxs/AgentHydra/main/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Version v0.19.3 -InstallDir D:\Tools\AgentHydra
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\AgentHydra'),
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'LunarWerxs/AgentHydra'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# --- architecture -------------------------------------------------------------
# Only windows-x64 is built today (see the matrix in .github/workflows/release.yml). An arm64
# machine is told so plainly rather than handed an x64 binary that will run under emulation with no
# indication of why it is slow.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') {
  throw "No ARM64 build is published yet. On an ARM64 machine, run the x64 build under emulation at your own discretion, or build from source with 'bun run dist'."
}
if ($arch -ne 'AMD64') {
  throw "Unsupported architecture '$arch'. AgentHydra publishes a Windows x64 build."
}
$target = 'windows-x64'

# --- which release ------------------------------------------------------------
Write-Step 'Finding the release'
$headers = @{ 'User-Agent' = 'agenthydra-install' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

$releaseUrl = if ($Version) {
  "https://api.github.com/repos/$Repo/releases/tags/$Version"
} else {
  "https://api.github.com/repos/$Repo/releases/latest"
}
$release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
$tag = $release.tag_name
Write-Note "release $tag"

# The ZIP, not the bare .exe: it carries the tray toolkit (misc\), without which the app can only
# run console-style. That was a real regression once — see the long comment in release.yml.
$assetName = "AgentHydra-$($tag.TrimStart('v'))-$target.zip"
$asset = $release.assets | Where-Object { $_.name -eq $assetName }
if (-not $asset) {
  $available = ($release.assets | ForEach-Object { $_.name }) -join ', '
  throw "Release $tag has no asset named '$assetName'. It published: $available"
}
$sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }
if (-not $sums) {
  throw "Release $tag published no SHA256SUMS.txt, so the download cannot be verified. Refusing to install."
}

# --- download -----------------------------------------------------------------
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("agenthydra-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  $zipPath = Join-Path $work $assetName
  Write-Step "Downloading $assetName"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers $headers

  Write-Step 'Verifying SHA-256'
  $sumsPath = Join-Path $work 'SHA256SUMS.txt'
  Invoke-WebRequest -Uri $sums.browser_download_url -OutFile $sumsPath -Headers $headers

  # sha256sum's format is "<hash>  <path>", and the path side carries the build's own directory
  # prefix (`out/`), so match on the leaf rather than the whole field.
  $expected = $null
  foreach ($line in Get-Content $sumsPath) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and ((Split-Path $parts[1].Trim() -Leaf) -eq $assetName)) {
      $expected = $parts[0].Trim().ToLowerInvariant()
      break
    }
  }
  if (-not $expected) { throw "SHA256SUMS.txt has no entry for $assetName. Refusing to install." }

  $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    throw "Checksum mismatch for $assetName.`n  expected $expected`n  actual   $actual`nThe download was deleted. Do not install it."
  }
  Write-Note "sha256 $actual"

  # --- install ----------------------------------------------------------------
  Write-Step "Installing to $InstallDir"
  $running = Get-Process -Name 'AgentHydra' -ErrorAction SilentlyContinue
  if ($running) {
    throw "AgentHydra is running (pid $($running.Id -join ', ')). Quit it from the tray and run this again."
  }

  $extract = Join-Path $work 'extract'
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  # The archive holds one top-level folder named after the release.
  $payload = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
  if (-not $payload) { throw "The archive did not contain the expected folder." }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Copy-Item -Path (Join-Path $payload.FullName '*') -Destination $InstallDir -Recurse -Force

  $exe = Join-Path $InstallDir 'AgentHydra.exe'
  if (-not (Test-Path $exe)) { throw "AgentHydra.exe is missing from $InstallDir after extraction." }

  # Canary, the same one the release workflow runs: a binary that cannot print its own version is
  # not one to hand back to the user as installed.
  $reported = & $exe --version
  Write-Note "installed version $reported"

  if (-not $NoShortcut) {
    Write-Step 'Creating a Start Menu shortcut'
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startMenu 'AgentHydra.lnk'))
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = 'Local AI coding-session manager'
    $shortcut.Save()
  }

  Write-Host ''
  Write-Host "AgentHydra $reported is installed." -ForegroundColor Green
  Write-Host "  $exe"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
