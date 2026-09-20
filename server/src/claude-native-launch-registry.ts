import { type CapturedRun, spawnCaptured } from './core/process'

const PROTOCOL = 'Software\\Classes\\claude'
export const CLAUDE_NATIVE_HOST_KEYS = [
  'Software\\Google\\Chrome\\NativeMessagingHosts',
  'Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'Software\\Chromium\\NativeMessagingHosts',
  'Software\\ArcBrowser\\Arc\\NativeMessagingHosts',
  'Software\\Vivaldi\\NativeMessagingHosts',
  'Software\\Opera Software\\Opera Stable\\NativeMessagingHosts',
].map((key) => `${key}\\com.anthropic.claude_browser_extension`)

type RegistryValue = { name: string; kind: string; data: string | string[] }
type RegistryKey = { path: string; values: RegistryValue[] }
type RegistryTree = { path: string; exists: boolean; keys: RegistryKey[] }
type Snapshot = { protocol: RegistryTree; browsers: RegistryTree[] }

export interface NativeLaunchRegistryResult {
  restored: string[]
  preserved: string[]
  errors: string[]
}

export interface NativeLaunchRegistryDependencies {
  run?: (argv: string[]) => Promise<CapturedRun>
  platform?: NodeJS.Platform
}

// Registry integer values travel as decimal strings so QWORD values remain lossless in JSON.
// ExpandString is read without expanding environment variables; empty/default names are retained.
const registryFunctions = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$cu = [Microsoft.Win32.Registry]::CurrentUser
function Read-Key([string]$path) {
  $key = $cu.OpenSubKey($path, $false)
  if ($null -eq $key) { return $null }
  try {
    $values = @()
    foreach ($name in $key.GetValueNames()) {
      $kind = $key.GetValueKind($name).ToString()
      $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      switch ($kind) {
        { $_ -in @('Binary', 'None') } { $data = [Convert]::ToBase64String([byte[]]$value) }
        'MultiString' { $data = @([string[]]$value) }
        default { $data = [string]$value }
      }
      $values += [pscustomobject]@{ name = $name; kind = $kind; data = $data }
    }
    return [pscustomobject]@{ path = $path; values = @($values) }
  } finally { $key.Dispose() }
}
function Read-Tree([string]$path) {
  $first = Read-Key $path
  if ($null -eq $first) { return [pscustomobject]@{ path = $path; exists = $false; keys = @() } }
  $keys = @($first)
  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push($path)
  while ($pending.Count -gt 0) {
    $parent = $pending.Pop()
    $key = $cu.OpenSubKey($parent, $false)
    if ($null -eq $key) { throw 'Registry subtree changed during snapshot' }
    try { $names = @($key.GetSubKeyNames()) } finally { $key.Dispose() }
    foreach ($name in $names) {
      $child = $parent + '\' + $name
      $row = Read-Key $child
      if ($null -eq $row) { throw 'Registry subtree changed during snapshot' }
      $keys += $row
      $pending.Push($child)
    }
  }
  return [pscustomobject]@{ path = $path; exists = $true; keys = @($keys) }
}
function Read-Single([string]$path) {
  $key = Read-Key $path
  return [pscustomobject]@{ path = $path; exists = ($null -ne $key); keys = @($(if ($null -ne $key) { $key })) }
}
function Default-Value([string]$path) {
  $key = $cu.OpenSubKey($path, $false)
  if ($null -eq $key) { return $null }
  try { return $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $key.Dispose() }
}
function Same-Path($left, $right) {
  if ($left -isnot [string] -or $right -isnot [string]) { return $false }
  try { return [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($left).TrimEnd('\'), [IO.Path]::GetFullPath($right).TrimEnd('\')) }
  catch { return $false }
}
function Command-Executable($command) {
  if ($command -isnot [string]) { return $null }
  $command = $command.TrimStart()
  if ($command.StartsWith('"')) {
    $end = $command.IndexOf('"', 1)
    if ($end -lt 0) { return $null }
    return $command.Substring(1, $end - 1)
  }
  return ($command -split '\s+', 2)[0]
}
function Restore-Values($row) {
  $key = $cu.CreateSubKey([string]$row.path)
  try {
    $names = @($row.values | ForEach-Object { [string]$_.name })
    foreach ($name in $key.GetValueNames()) {
      if ($name -notin $names) { $key.DeleteValue($name, $false) }
    }
    foreach ($value in $row.values) {
      $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], [string]$value.kind)
      switch ($value.kind) {
        { $_ -in @('Binary', 'None') } { $data = [Convert]::FromBase64String([string]$value.data) }
        'MultiString' { $data = [string[]]@($value.data) }
        'DWord' { $data = [int]::Parse([string]$value.data, [Globalization.CultureInfo]::InvariantCulture) }
        'QWord' { $data = [long]::Parse([string]$value.data, [Globalization.CultureInfo]::InvariantCulture) }
        default { $data = [string]$value.data }
      }
      $key.SetValue([string]$value.name, $data, $kind)
    }
  } finally { $key.Dispose() }
}
function Remove-EmptyKey([string]$path) {
  $key = $cu.OpenSubKey($path, $false)
  if ($null -eq $key) { return }
  try { $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0 } finally { $key.Dispose() }
  if ($empty) { $cu.DeleteSubKey($path, $false) }
}
function Restore-Tree($original, [bool]$recursive) {
  $current = if ($recursive) { Read-Tree $original.path } else { Read-Single $original.path }
  foreach ($row in $original.keys) { Restore-Values $row }
  $originalPaths = @($original.keys | ForEach-Object { [string]$_.path })
  foreach ($row in @($current.keys | Sort-Object { $_.path.Length } -Descending)) {
    if ($row.path -notin $originalPaths) {
      Restore-Values ([pscustomobject]@{ path = $row.path; values = @() })
      Remove-EmptyKey $row.path
    }
  }
  $after = if ($recursive) { Read-Tree $original.path } else { Read-Single $original.path }
  if ((Canonical-Tree $original) -cne (Canonical-Tree $after)) { throw 'Registry restoration readback differs from snapshot' }
}
function Canonical-Tree($tree) {
  $keys = @($tree.keys | Sort-Object path | ForEach-Object {
    [pscustomobject]@{ path = $_.path; values = @($_.values | Sort-Object name) }
  })
  return ([pscustomobject]@{ path = $tree.path; exists = $tree.exists; keys = $keys } | ConvertTo-Json -Depth 30 -Compress)
}
`

function payload(value: unknown): string {
  return `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}')) | ConvertFrom-Json\n`
}

export function nativeRegistrySnapshotScript(): string {
  return `${registryFunctions}\n${payload({ protocol: PROTOCOL, browsers: CLAUDE_NATIVE_HOST_KEYS })}
  $snapshot = [pscustomobject]@{ protocol = (Read-Tree $p.protocol); browsers = @($p.browsers | ForEach-Object { Read-Single $_ }) }
  $snapshot | ConvertTo-Json -Depth 30 -Compress
  `
}

export function nativeRegistryRestoreScript(
  managedBinary: string,
  profile: string,
  snapshot: Snapshot,
): string {
  return `${registryFunctions}\n${payload({ managedBinary, profile, snapshot })}
  $restored = @(); $preserved = @(); $errors = @()
  $protocol = $p.snapshot.protocol
  try {
    $command = Default-Value ($protocol.path + '\\shell\\open\\command')
    if (Same-Path (Command-Executable $command) $p.managedBinary) {
      Restore-Tree $protocol $true
      $restored += $protocol.path
    } else { $preserved += $protocol.path }
  } catch { $errors += ($protocol.path + ': ' + $_.Exception.Message) }
  $manifestPath = [IO.Path]::Combine($p.profile, 'ChromeNativeHost', 'com.anthropic.claude_browser_extension.json')
  $expectedHost = [IO.Path]::Combine([IO.Path]::GetDirectoryName($p.managedBinary), 'resources', 'chrome-native-host.exe')
  $manifestOwned = $false
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -eq 'com.anthropic.claude_browser_extension' -and $manifest.path -is [string]) {
      $manifestOwned = Same-Path $manifest.path $expectedHost
    }
  } catch { $manifestOwned = $false }
  foreach ($browser in $p.snapshot.browsers) {
    try {
      $current = Default-Value $browser.path
      if ($manifestOwned -and (Same-Path $current $manifestPath)) {
        Restore-Tree $browser $false
        $restored += $browser.path
      } else {
        $preserved += $browser.path
        if ($null -eq $current -and $browser.exists) { $errors += ($browser.path + ': registration disappeared; ownership is uncertain') }
      }
    } catch { $errors += ($browser.path + ': ' + $_.Exception.Message) }
  }
  [pscustomobject]@{ restored = @($restored); preserved = @($preserved); errors = @($errors) } | ConvertTo-Json -Depth 10 -Compress
  `
}

async function runJson(script: string, deps: NativeLaunchRegistryDependencies): Promise<unknown> {
  if (script.length > 30000)
    throw Error('Native launch registry snapshot exceeds safe command length')
  const result = await (deps.run ?? spawnCaptured)([
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  if (result.timedOut || result.code !== 0) {
    throw Error(
      `Native launch registry guard failed: ${result.timedOut ? 'timed out' : result.stderr.slice(0, 500)}`,
    )
  }
  return JSON.parse(result.stdout.trim())
}

function validTree(value: unknown, path: string, recursive: boolean): value is RegistryTree {
  if (!value || typeof value !== 'object') return false
  const tree = value as RegistryTree
  if (tree.path !== path || typeof tree.exists !== 'boolean' || !Array.isArray(tree.keys))
    return false
  if (tree.exists !== tree.keys.length > 0) return false
  if (tree.exists && !tree.keys.some((key) => key?.path === path)) return false
  if (new Set(tree.keys.map((key) => key?.path)).size !== tree.keys.length) return false
  return tree.keys.every(
    (key) =>
      key &&
      typeof key.path === 'string' &&
      (key.path === path ||
        (recursive && key.path.startsWith(`${path}\\`) && !key.path.includes('..'))) &&
      Array.isArray(key.values) &&
      key.values.every(
        (value) =>
          value &&
          typeof value.name === 'string' &&
          ['String', 'ExpandString', 'Binary', 'None', 'DWord', 'QWord', 'MultiString'].includes(
            value.kind,
          ) &&
          (value.kind === 'MultiString'
            ? Array.isArray(value.data) && value.data.every((item) => typeof item === 'string')
            : typeof value.data === 'string'),
      ),
  )
}

/** Snapshot before a managed launch; restore only registrations that still identify this launch. */
export async function beginNativeLaunchRegistryGuard(
  managedBinary: string,
  profile: string,
  deps: NativeLaunchRegistryDependencies = {},
): Promise<{ restore(): Promise<NativeLaunchRegistryResult> }> {
  if ((deps.platform ?? process.platform) !== 'win32')
    throw Error('Native launch registry guard requires Windows')
  for (const value of [managedBinary, profile]) {
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) || /["\r\n]/.test(value))
      throw Error('Native launch registry guard requires absolute Windows paths')
  }
  const raw = await runJson(nativeRegistrySnapshotScript(), deps)
  const snapshot = raw as Snapshot
  if (
    !snapshot ||
    !validTree(snapshot.protocol, PROTOCOL, true) ||
    !Array.isArray(snapshot.browsers) ||
    snapshot.browsers.length !== CLAUDE_NATIVE_HOST_KEYS.length ||
    !snapshot.browsers.every((tree, index) =>
      validTree(tree, CLAUDE_NATIVE_HOST_KEYS[index]!, false),
    )
  )
    throw Error('Malformed native launch registry snapshot')
  let restored: Promise<NativeLaunchRegistryResult> | undefined
  return {
    restore() {
      // Never replay an uncertain restore. The caller can report its failure and preserve evidence.
      restored ??= runJson(
        nativeRegistryRestoreScript(managedBinary, profile, snapshot),
        deps,
      ).then((raw) => {
        const result = raw as NativeLaunchRegistryResult
        if (
          !result ||
          !['restored', 'preserved', 'errors'].every((key) => {
            const values = result[key as keyof NativeLaunchRegistryResult]
            return Array.isArray(values) && values.every((value) => typeof value === 'string')
          })
        )
          throw Error('Malformed native launch registry restore result')
        return result
      })
      return restored
    },
  }
}
