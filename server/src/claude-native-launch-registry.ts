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
function Restore-Owned($original, [bool]$recursive, [string]$ownerKey, [string]$owner, [bool]$isCommand) {
  # Another managed launch's app can register itself while this one restores. While the key still
  # names this launch it is put back again; once it names anything else it is that writer's to restore.
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $named = Default-Value $ownerKey
    if ($isCommand) { $named = Command-Executable $named }
    if (-not (Same-Path $named $owner)) { return $false }
    if (Restore-Tree $original $recursive) { return $true }
  }
  throw 'Registry restoration readback differs from snapshot'
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
  return ((Canonical-Tree $original) -ceq (Canonical-Tree $after))
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
    if (Restore-Owned $protocol $true ($protocol.path + '\\shell\\open\\command') $p.managedBinary $true) {
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
      if ($manifestOwned -and (Restore-Owned $browser $false $browser.path $manifestPath $false)) {
        $restored += $browser.path
      } else {
        $preserved += $browser.path
        if ($null -eq (Default-Value $browser.path) -and $browser.exists) { $errors += ($browser.path + ': registration disappeared; ownership is uncertain') }
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

function assertWindowsPath(value: string): void {
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) || /["\r\n]/.test(value))
    throw Error('Native launch registry guard requires absolute Windows paths')
}

async function readSnapshot(deps: NativeLaunchRegistryDependencies): Promise<Snapshot> {
  const snapshot = (await runJson(nativeRegistrySnapshotScript(), deps)) as Snapshot
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
  return snapshot
}

function restoreResult(raw: unknown): NativeLaunchRegistryResult {
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
}

/** One managed launch's hold on the shared baseline. */
export interface NativeLaunchRegistryLease {
  /** Restore what remains registered to this launch (its app ran from `managedBinary`) to the
   *  baseline, and end the lease. Never replayed: a second call answers the first's outcome. */
  restore(managedBinary: string): Promise<NativeLaunchRegistryResult>
  /** End the lease without restoring: this launch never started an app. */
  release(): void
}

/**
 * The registrations as they were before the managed launches now under way, shared by every launch
 * that overlaps them. Each launch's app rewrites the claude:// handler and the browser hosts while it
 * starts, so a baseline read while another managed launch is running would capture that launch's
 * temporary registration as the thing to restore. Launches used to be run one at a time for that
 * reason, each waiting for the one before it to be fully up (2026-10-08, owner: "Why are launching
 * accounts in this fucking thing so slow?"). Now the first launch reads the baseline, every launch that
 * begins while any is under way shares it, and a new one is read only once all of them have ended and
 * their restorations have finished. Each launch still restores only what still names it, and the
 * restorations run one at a time: two at once would each read the other's half-written tree back.
 */
export function createNativeLaunchRegistryGuard(deps: NativeLaunchRegistryDependencies = {}): {
  begin(profile: string): Promise<NativeLaunchRegistryLease>
} {
  let baseline: { snapshot: Promise<Snapshot>; leases: number } | null = null
  const restoring = new Set<Promise<unknown>>()
  let lastRestore: Promise<unknown> = Promise.resolve()
  return {
    async begin(profile) {
      if ((deps.platform ?? process.platform) !== 'win32')
        throw Error('Native launch registry guard requires Windows')
      assertWindowsPath(profile)
      if (!baseline) {
        const finishing = Promise.allSettled([...restoring])
        const fresh = { snapshot: finishing.then(() => readSnapshot(deps)), leases: 0 }
        // A baseline that could not be read is not kept: the next launch reads it again.
        fresh.snapshot.catch(() => {
          if (baseline === fresh) baseline = null
        })
        baseline = fresh
      }
      const shared = baseline
      shared.leases++
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        if (--shared.leases === 0 && baseline === shared) baseline = null
      }
      let snapshot: Snapshot
      try {
        snapshot = await shared.snapshot
      } catch (error) {
        end()
        throw error
      }
      let restored: Promise<NativeLaunchRegistryResult> | undefined
      return {
        restore(managedBinary) {
          // Never replay an uncertain restore. The caller can report its failure and preserve evidence.
          if (restored) return restored
          restored = lastRestore
            .then(() => {
              assertWindowsPath(managedBinary)
              return runJson(nativeRegistryRestoreScript(managedBinary, profile, snapshot), deps)
            })
            .then(restoreResult)
          // Recorded before the lease ends, so a baseline read after the last lease waits for it.
          const tracked = restored.catch(() => undefined)
          lastRestore = tracked
          restoring.add(tracked)
          void tracked.then(() => restoring.delete(tracked))
          end()
          return restored
        },
        release: end,
      }
    },
  }
}

/** The daemon's one guard: every managed launch from this process shares it. */
export const nativeLaunchRegistryGuard = createNativeLaunchRegistryGuard()
