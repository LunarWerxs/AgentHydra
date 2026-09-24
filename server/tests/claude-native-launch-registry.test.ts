import { describe, expect, test } from 'bun:test'
import {
  beginNativeLaunchRegistryGuard,
  CLAUDE_NATIVE_HOST_KEYS,
  nativeRegistryRestoreScript,
  nativeRegistrySnapshotScript,
} from '../src/claude-native-launch-registry'
import type { CapturedRun } from '../src/core/process'

const binary = 'C:\\Managed Claude\\2.2553.1\\claude.exe'
const profile = 'C:\\Profiles\\Ashley'
const protocol = 'Software\\Classes\\claude'
function snapshot() {
  return {
    protocol: {
      path: protocol,
      exists: true,
      keys: [
        {
          path: protocol,
          values: [
            { name: '', kind: 'String', data: 'URL:Claude' },
            { name: 'expand', kind: 'ExpandString', data: '%USERPROFILE%\\Claude' },
            { name: 'large', kind: 'QWord', data: '9223372036854775807' },
            { name: 'binary', kind: 'Binary', data: 'AAECA/8=' },
            { name: 'multi', kind: 'MultiString', data: ['one', 'two'] },
          ],
        },
      ],
    },
    browsers: CLAUDE_NATIVE_HOST_KEYS.map((path) => ({ path, exists: false, keys: [] })),
  }
}
function success(value: unknown): CapturedRun {
  return { code: 0, timedOut: false, stdout: JSON.stringify(value), stderr: '' }
}
function decodePayload(script: string): any {
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)![1]!
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
}

describe('managed Claude launch registry guard', () => {
  test('accepts real protocol child keys separated by single backslashes', async () => {
    const baseline = snapshot()
    for (const suffix of ['shell', 'shell\\open', 'shell\\open\\command']) {
      baseline.protocol.keys.push({ path: `${protocol}\\${suffix}`, values: [] })
    }
    const guard = await beginNativeLaunchRegistryGuard(binary, profile, {
      platform: 'win32',
      run: async () => success(baseline),
    })
    expect(typeof guard.restore).toBe('function')
    expect(baseline.protocol.keys[3]!.path).toBe('Software\\Classes\\claude\\shell\\open\\command')
  })

  test('captures exact supported browser keys and preserves lossless snapshot values', async () => {
    const calls: string[][] = []
    const baseline = snapshot()
    const expected = { restored: [protocol], preserved: CLAUDE_NATIVE_HOST_KEYS, errors: [] }
    const guard = await beginNativeLaunchRegistryGuard(binary, profile, {
      platform: 'win32',
      run: async (argv) => {
        calls.push(argv)
        return success(calls.length === 1 ? baseline : expected)
      },
    })
    expect(calls).toHaveLength(1)
    expect(decodePayload(calls[0]!.at(-1)!)).toEqual({
      protocol,
      browsers: CLAUDE_NATIVE_HOST_KEYS,
    })
    expect(await guard.restore()).toEqual(expected)
    const payload = decodePayload(calls[1]!.at(-1)!)
    expect(payload).toEqual({ managedBinary: binary, profile, snapshot: baseline })
    expect(payload.snapshot.protocol.keys[0].values[2].data).toBe('9223372036854775807')
    expect(CLAUDE_NATIVE_HOST_KEYS[4]).toContain('ArcBrowser\\Arc')
    expect(CLAUDE_NATIVE_HOST_KEYS[6]).toContain('Opera Software\\Opera Stable')
  })

  test('restoration is never replayed after a lost response', async () => {
    let calls = 0
    const guard = await beginNativeLaunchRegistryGuard(binary, profile, {
      platform: 'win32',
      run: async () => {
        calls++
        if (calls === 1) return success(snapshot())
        throw Error('transport lost')
      },
    })
    const first = guard.restore()
    const second = guard.restore()
    expect(second).toBe(first)
    await expect(first).rejects.toThrow('transport lost')
    await expect(guard.restore()).rejects.toThrow('transport lost')
    expect(calls).toBe(2)
  })

  test('snapshot failure refuses before a managed launch can be protected', async () => {
    await expect(
      beginNativeLaunchRegistryGuard(binary, profile, {
        platform: 'win32',
        run: async () => ({ code: null, timedOut: true, stdout: '', stderr: '' }),
      }),
    ).rejects.toThrow('timed out')
  })

  test('rejects malformed or out-of-scope snapshot paths', async () => {
    for (const path of ['Software\\Unrelated', `${protocol}\\..\\Unrelated`]) {
      const baseline = snapshot()
      baseline.protocol.keys[0]!.path = path
      await expect(
        beginNativeLaunchRegistryGuard(binary, profile, {
          platform: 'win32',
          run: async () => success(baseline),
        }),
      ).rejects.toThrow('Malformed')
    }
    const baseline = snapshot()
    baseline.protocol.keys.push(baseline.protocol.keys[0]!)
    await expect(
      beginNativeLaunchRegistryGuard(binary, profile, {
        platform: 'win32',
        run: async () => success(baseline),
      }),
    ).rejects.toThrow('Malformed')
  })

  test('non-Windows and nonabsolute paths perform no registry call', async () => {
    const run = async () => {
      throw Error('must not run')
    }
    await expect(
      beginNativeLaunchRegistryGuard(binary, profile, { platform: 'linux', run }),
    ).rejects.toThrow('requires Windows')
    await expect(
      beginNativeLaunchRegistryGuard('claude.exe', profile, { platform: 'win32', run }),
    ).rejects.toThrow('absolute Windows')
  })

  test('malformed restoration evidence does not report success', async () => {
    let calls = 0
    const guard = await beginNativeLaunchRegistryGuard(binary, profile, {
      platform: 'win32',
      run: async () => success(++calls === 1 ? snapshot() : { restored: true }),
    })
    await expect(guard.restore()).rejects.toThrow('Malformed')
  })
})

// These Windows checks execute only an inert branch harness or PowerShell's parser. They never
// execute the real registry reader/writer. Other platforms retain all transport/payload tests.
const windowsTest = process.platform === 'win32' ? test : test.skip
async function powershell(script: string): Promise<any> {
  const proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', '-'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(script)
  proc.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw Error(stderr)
  return JSON.parse(stdout.trim())
}

windowsTest('both generated PowerShell scripts parse without invoking registry APIs', async () => {
  const scripts = [
    nativeRegistrySnapshotScript(),
    nativeRegistryRestoreScript(binary, profile, snapshot()),
  ]
  const encoded = Buffer.from(JSON.stringify(scripts)).toString('base64')
  const errors = await powershell(`
    $scripts = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
    $all = @()
    foreach ($script in $scripts) {
      $tokens = $null; $errors = $null
      [void][Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)
      $all += @($errors | ForEach-Object { $_.Message })
    }
    ConvertTo-Json -InputObject @($all) -Compress
  `)
  expect(errors).toEqual([])
})

async function branches(options: {
  command: string
  manifestBinary: string
  browserValue: string | null
  browserExisted?: boolean
}) {
  const baseline = snapshot()
  if (options.browserExisted)
    baseline.browsers[0] = { path: CLAUDE_NATIVE_HOST_KEYS[0]!, exists: true, keys: [] }
  const script = nativeRegistryRestoreScript(binary, profile, baseline)
  const helpers = script.slice(
    script.indexOf('function Same-Path'),
    script.indexOf('function Restore-Values'),
  )
  const body = script.slice(script.indexOf('$p = '))
  const fake = Buffer.from(JSON.stringify(options)).toString('base64')
  return powershell(`
    $ErrorActionPreference = 'Stop'
    $fake = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fake}')) | ConvertFrom-Json
    function Default-Value([string]$path) {
      if ($path.EndsWith('shell\\open\\command')) { return $fake.command }
      return $fake.browserValue
    }
    function Restore-Tree($original, [bool]$recursive) { }
    function Get-Content { param($LiteralPath, [switch]$Raw)
      return ([pscustomobject]@{ name = 'com.anthropic.claude_browser_extension'; path = $fake.manifestBinary } | ConvertTo-Json -Compress)
    }
    ${helpers}
    ${body}
  `)
}

windowsTest(
  'conditional restoration preserves registrations written by another application',
  async () => {
    const result = await branches({
      command: '"C:\\Other\\claude.exe" "%1"',
      manifestBinary: 'C:\\Other\\resources\\chrome-native-host.exe',
      browserValue: 'C:\\OtherProfile\\host.json',
    })
    expect(result).toEqual({
      restored: [],
      preserved: [protocol, ...CLAUDE_NATIVE_HOST_KEYS],
      errors: [],
    })
  },
)

windowsTest(
  'conditional restoration recognizes exact managed executable and exact profile host',
  async () => {
    const result = await branches({
      command: `"${binary}" "%1"`,
      manifestBinary: 'C:\\Managed Claude\\2.2553.1\\resources\\chrome-native-host.exe',
      browserValue: `${profile}\\ChromeNativeHost\\com.anthropic.claude_browser_extension.json`,
    })
    expect(result).toEqual({
      restored: [protocol, ...CLAUDE_NATIVE_HOST_KEYS],
      preserved: [],
      errors: [],
    })
  },
)

windowsTest(
  'prefix lookalike host cannot claim a registration, and ambiguous deletions are reported',
  async () => {
    const result = await branches({
      command: `"${binary}" "%1"`,
      manifestBinary: 'C:\\Managed Claude\\2.2553.1-other\\resources\\chrome-native-host.exe',
      browserValue: null,
      browserExisted: true,
    })
    expect(result.restored).toEqual([protocol])
    expect(result.preserved).toEqual(CLAUDE_NATIVE_HOST_KEYS)
    expect(result.errors).toEqual([
      `${CLAUDE_NATIVE_HOST_KEYS[0]}: registration disappeared; ownership is uncertain`,
    ])
  },
)
