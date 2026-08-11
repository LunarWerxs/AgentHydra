import { afterEach, describe, expect, test } from 'bun:test'
import { getSetting, setSetting } from '../src/db'
import {
  assetForThisPlatform,
  buildLatestReleaseRequest,
  coarseOsTag,
  currentTarget,
  formatWindowsTag,
  installId,
  isNewer,
  pingOptedOut,
} from '../src/github-updater'

describe('github-updater version logic', () => {
  test('isNewer: strictly-greater semver only', () => {
    expect(isNewer('0.3.0', '0.2.1')).toBe(true)
    expect(isNewer('0.2.2', '0.2.1')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
    expect(isNewer('0.2.1', '0.2.1')).toBe(false)
    expect(isNewer('0.2.0', '0.2.1')).toBe(false)
    expect(isNewer('0.1.9', '0.2.1')).toBe(false)
  })

  test('isNewer: tolerates a leading v and pre-release/build suffixes', () => {
    expect(isNewer('v0.3.0', '0.2.1')).toBe(true)
    expect(isNewer('0.3.0', 'v0.2.1')).toBe(true)
    // A pre-release/build suffix past the patch number is ignored (compares the numeric triple).
    expect(isNewer('0.3.0-rc1', '0.2.1')).toBe(true)
    expect(isNewer('0.2.1', '0.2.1+build9')).toBe(false)
  })

  test('currentTarget: os-arch matching the release-asset naming', () => {
    const t = currentTarget()
    expect(t).toMatch(/^(windows|darwin|linux)-(x64|arm64)$/)
    // never leaks node's raw 'win32'
    expect(t.startsWith('win32')).toBe(false)
  })

  test('asset selection prefers the compressed updater bundle when a direct exe is also present', () => {
    const target = currentTarget()
    const extension = process.platform === 'win32' ? '.zip' : '.tar.gz'
    const directExtension = process.platform === 'win32' ? '.exe' : ''
    const direct = {
      name: `AgentHydra-9.9.9-${target}${directExtension}`,
      browser_download_url: 'https://example.test/direct',
      size: 100,
    }
    const compressed = {
      name: `AgentHydra-9.9.9-${target}${extension}`,
      browser_download_url: 'https://example.test/compressed',
      size: 40,
    }

    expect(assetForThisPlatform([direct, compressed])).toEqual(compressed)
    expect(assetForThisPlatform([compressed, direct])).toEqual(compressed)
  })
})

describe('anonymous install ping', () => {
  // These tests deliberately override CI/NODE_ENV so the "opted-in" assertions are deterministic
  // whether run locally or under GitHub Actions (where CI=true would otherwise always opt out).
  const savedNoPing = process.env.AGENTHYDRA_NO_PING
  const savedCi = process.env.CI
  const savedNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    for (const [key, value] of [
      ['AGENTHYDRA_NO_PING', savedNoPing],
      ['CI', savedCi],
      ['NODE_ENV', savedNodeEnv],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setSetting('app_install_id', '')
    setSetting('app_ping_reported', '0')
  })

  test('formatWindowsTag: build-number threshold picks win10 vs win11', () => {
    expect(formatWindowsTag('10.0.19045.3693')).toBe('win10-19045')
    expect(formatWindowsTag('10.0.22000.100')).toBe('win11-22000')
    expect(formatWindowsTag('10.0.26100.1')).toBe('win11-26100')
    expect(formatWindowsTag('not-a-version')).toBe('windows')
  })

  test('coarseOsTag: never leaks anything beyond OS family / Windows build', () => {
    const tag = coarseOsTag()
    expect(tag).toMatch(/^(win(10|11)-\d+|macos|linux|win32|darwin|freebsd|openbsd|sunos|aix)$/)
  })

  test('installId: generated once, then persists across calls', () => {
    setSetting('app_install_id', '')
    const a = installId()
    const b = installId()
    expect(a).toBe(b)
    // A v4 UUID — random, never derived from hostname/MAC/username.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  test('AGENTHYDRA_NO_PING=1 opts out', () => {
    delete process.env.CI
    delete process.env.NODE_ENV
    process.env.AGENTHYDRA_NO_PING = '1'
    expect(pingOptedOut()).toBe(true)
  })

  test('NODE_ENV=test and CI both opt out even without the env var', () => {
    delete process.env.AGENTHYDRA_NO_PING
    process.env.NODE_ENV = 'test'
    delete process.env.CI
    expect(pingOptedOut()).toBe(true)

    process.env.NODE_ENV = 'production'
    process.env.CI = 'true'
    expect(pingOptedOut()).toBe(true)
  })

  test('opted in: pings Studio with the install id header and v/os/new params', () => {
    delete process.env.AGENTHYDRA_NO_PING
    delete process.env.NODE_ENV
    delete process.env.CI
    setSetting('app_install_id', '')
    setSetting('app_ping_reported', '0')

    const { url, headers } = buildLatestReleaseRequest()
    expect(url.startsWith('https://studio.connections.icu/v1/app/agenthydra/latest?')).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get('v')).toBeTruthy()
    expect(params.get('os')).toBeTruthy()
    expect(params.get('new')).toBe('1') // first ping this install ever makes
    expect(headers['X-Install-Id']).toBe(getSetting('app_install_id'))

    setSetting('app_ping_reported', '1')
    const second = buildLatestReleaseRequest()
    expect(new URL(second.url).searchParams.get('new')).toBeNull() // never resent after success
  })

  test('opted out: falls back to GitHub directly, no install id, no telemetry params', () => {
    delete process.env.NODE_ENV
    delete process.env.CI
    process.env.AGENTHYDRA_NO_PING = '1'

    const { url, headers } = buildLatestReleaseRequest()
    expect(url).toBe('https://api.github.com/repos/LunarWerxs/agenthydra/releases/latest')
    expect(headers['X-Install-Id']).toBeUndefined()
  })
})
