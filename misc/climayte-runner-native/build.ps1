# Builds misc\climayte-runner.exe, the runner AgentHydra starts for each CliMayte worker on Windows.
# The exe is committed (release.yml copies misc\ into the release), so rebuild and commit it with any
# change to this crate. Local paths are remapped, so the binary names no machine paths (c2aaedcf did
# the same for the tray host), and the build refuses an exe that still carries one.
#
#   powershell -NoProfile -File misc\climayte-runner-native\build.ps1
$ErrorActionPreference = 'Stop'
$crate = $PSScriptRoot
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $HOME '.cargo' }
$rustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $HOME '.rustup' }
# CARGO_ENCODED_RUSTFLAGS separates flags with 0x1f, so a path with spaces stays one flag.
$env:CARGO_ENCODED_RUSTFLAGS = @(
  "--remap-path-prefix=$crate=climayte-runner-native",
  "--remap-path-prefix=$cargoHome=cargo",
  "--remap-path-prefix=$rustupHome=rustup"
) -join [char]0x1f
cargo test --quiet --manifest-path (Join-Path $crate 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo build --release --manifest-path (Join-Path $crate 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$built = Join-Path $crate 'target\release\climayte-runner.exe'
$text = [Text.Encoding]::Unicode.GetString([IO.File]::ReadAllBytes($built)) + [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($built))
foreach ($p in @($HOME, $crate)) {
  if ($text.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "the built exe still names $p" }
}
$dest = Join-Path (Split-Path $crate -Parent) 'climayte-runner.exe'
Copy-Item $built $dest -Force
'{0}: {1:N0} bytes' -f $dest, (Get-Item $dest).Length
