import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatSummary, DeskSettings, ServerEvent } from '@shared/protocol'
import { ChatRuntime, type QueryImpl } from '../../src/engine/chat-runtime'
import { ClaudeCodeBinary, describeProgress, platformPackages, untarFile, type ClaudeCodeTarget } from '../../src/engine/claude-code-binary'
import { ChatStore } from '../../src/engine/store'
import { hostOptions } from '../../src/host/client'

const BINARY = process.platform === 'win32' ? 'claude.exe' : 'claude'
/** A stand-in for the 238 MB binary: more than one tar block, not a multiple of one. */
const STAND_IN = Buffer.from('#!stand-in claude\n'.repeat(80))

// A tar the test builds by hand, so the reader is checked against bytes it did not write itself.
function tarEntry(name: string, data: Uint8Array, o: { type?: string; prefix?: string } = {}): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000755\0', 100)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write(o.type ?? '0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  if (o.prefix) header.write(o.prefix, 345, 'utf8')
  const sum = header.reduce((a, b) => a + b, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  Buffer.from(data).copy(padded)
  return Buffer.concat([header, padded])
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`)
  return `${len}${body}`
}

const tarEnd = () => Buffer.alloc(1024)

/** The npm tarball of a platform package: package/package.json, a decoy, and the binary. */
function packageTgz(binary: Uint8Array = STAND_IN): Buffer {
  return gzipSync(
    Buffer.concat([
      tarEntry('package/', Buffer.alloc(0), { type: '5' }),
      tarEntry('package/package.json', Buffer.from('{"name":"stand-in"}')),
      tarEntry(`package/${BINARY}`, binary),
      tarEntry('package/README.md', Buffer.from('readme')),
      tarEnd(),
    ]),
  )
}

const integrityOf = (bytes: Uint8Array) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

/** A local npm registry: the version document, and the tarball it points at (held back by `gate` half way, when given). */
function startRegistry(o: { pkg: string; version: string; tgz: Buffer; integrity?: string; gate?: Promise<void> }) {
  const hits = { meta: 0, tarball: 0 }
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname
      if (path === `/${o.pkg}/${o.version}`) {
        hits.meta++
        return Response.json({ dist: { tarball: `http://127.0.0.1:${server.port}/tarballs/stand-in.tgz`, integrity: o.integrity ?? integrityOf(o.tgz) } })
      }
      if (path === '/tarballs/stand-in.tgz') {
        hits.tarball++
        const half = Math.floor(o.tgz.length / 2)
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(o.tgz.subarray(0, half))
            await o.gate
            controller.enqueue(o.tgz.subarray(half))
            controller.close()
          },
        })
        return new Response(body, { headers: { 'content-length': String(o.tgz.length) } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) }
}

const PKG = '@example/claude-code-stand-in'
const VERSION = '9.9.9'

function targetOf(installedPath: string | null = null): ClaudeCodeTarget {
  return { pkg: PKG, version: VERSION, claudeCodeVersion: '9.9.8', binary: BINARY, installed: () => installedPath }
}

let home: string
let stop: (() => void)[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'desk-claude-code-'))
  stop = []
})

afterEach(() => {
  for (const s of stop) s()
  rmSync(home, { recursive: true, force: true })
})

function registry(o: Partial<Parameters<typeof startRegistry>[0]> = {}) {
  const r = startRegistry({ pkg: PKG, version: VERSION, tgz: packageTgz(), ...o })
  stop.push(r.stop)
  return r
}

function resolver(url: string, installed: string | null = null) {
  return new ClaudeCodeBinary({ home, target: targetOf(installed), env: { NPM_CONFIG_REGISTRY: url }, fetch })
}

describe('Claude Code binary', () => {
  test('(a) an installed platform package wins and nothing is fetched', async () => {
    const reg = registry()
    const installed = join(home, 'node_modules', BINARY)
    mkdirSync(join(home, 'node_modules'), { recursive: true })
    writeFileSync(installed, 'installed')
    const bin = resolver(reg.url, installed)
    expect(bin.status()).toEqual({ source: 'package', version: '9.9.8', path: installed })
    expect(await bin.resolve()).toBe(installed)
    expect(reg.hits).toEqual({ meta: 0, tarball: 0 })
    expect(existsSync(join(home, 'claude-code'))).toBe(false)
  }, 15_000)

  test('(b) a cached copy is used and nothing is fetched', async () => {
    const reg = registry()
    const cached = join(home, 'claude-code', VERSION, BINARY)
    mkdirSync(join(home, 'claude-code', VERSION), { recursive: true })
    writeFileSync(cached, 'cached')
    const bin = resolver(reg.url)
    expect(bin.status()).toEqual({ source: 'cache', version: '9.9.8', path: cached })
    expect(await bin.resolve()).toBe(cached)
    expect(reg.hits).toEqual({ meta: 0, tarball: 0 })
  }, 15_000)

  test('(c) a download is verified, extracted and cached, and a second resolve fetches nothing', async () => {
    const reg = registry()
    const bin = resolver(reg.url)
    expect(bin.status()).toEqual({ source: 'download-needed', version: '9.9.8' })
    const steps: number[] = []
    bin.onProgress((p) => p.percent !== null && steps.push(p.percent))
    const path = await bin.resolve()
    expect(path).toBe(join(home, 'claude-code', VERSION, BINARY))
    expect(readFileSync(path).equals(STAND_IN)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o111).toBe(0o111)
    // Only the finished binary is left in the cache: no tarball, no temp file another process could mistake for it.
    expect(readdirSync(join(home, 'claude-code', VERSION))).toEqual([BINARY])
    expect(steps.at(-1)).toBe(100)
    expect(bin.status()).toMatchObject({ source: 'cache', path })
    expect(await bin.resolve()).toBe(path)
    expect(reg.hits).toEqual({ meta: 1, tarball: 1 })
  }, 15_000)

  test('(d) a checksum mismatch is refused and nothing is cached, and the next resolve tries again', async () => {
    const reg = registry({ integrity: integrityOf(Buffer.from('some other tarball')) })
    const bin = resolver(reg.url)
    await expect(bin.resolve()).rejects.toThrow(/checksum/)
    expect(existsSync(join(home, 'claude-code', VERSION, BINARY))).toBe(false)
    expect(readdirSync(join(home, 'claude-code', VERSION))).toEqual([])
    expect(bin.status().source).toBe('download-needed')
    await expect(bin.resolve()).rejects.toThrow(/checksum/)
    expect(reg.hits).toEqual({ meta: 2, tarball: 2 })
  }, 15_000)

  test('(e) concurrent resolves share one download', async () => {
    let release!: () => void
    const reg = registry({ gate: new Promise<void>((r) => (release = r)) })
    const bin = resolver(reg.url)
    const all = Promise.all([bin.resolve(), bin.resolve(), bin.resolve()])
    const again = bin.resolve()
    while (bin.status().source !== 'downloading' || !bin.status().progress) await new Promise((r) => setTimeout(r, 5))
    expect(bin.status().progress).toMatchObject({ phase: 'download' })
    release()
    const paths = [...(await all), await again]
    expect(new Set(paths).size).toBe(1)
    expect(reg.hits).toEqual({ meta: 1, tarball: 1 })
  }, 15_000)

  test('a mirror named in npm_config_registry is used, and a tarball without the binary is refused', async () => {
    const reg = registry({ tgz: gzipSync(Buffer.concat([tarEntry('package/package.json', Buffer.from('{}')), tarEnd()])) })
    const bin = new ClaudeCodeBinary({ home, target: targetOf(), env: { npm_config_registry: `${reg.url}/` }, fetch })
    await expect(bin.resolve()).rejects.toThrow(new RegExp(`package/${BINARY.replace('.', '\\.')}`))
    expect(reg.hits.meta).toBe(1)
    expect(existsSync(join(home, 'claude-code', VERSION, BINARY))).toBe(false)
  }, 15_000)
})

describe('tar reader', () => {
  /** The archive in 97-byte pieces, so no header or file body lines up with a chunk. */
  async function* pieces(bytes: Buffer): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < bytes.length; at += 97) yield bytes.subarray(at, at + 97)
  }
  async function read(archive: Buffer, wanted = 'package/claude.exe'): Promise<Buffer | null> {
    const got: Buffer[] = []
    const found = await untarFile(pieces(archive), wanted, async (c) => void got.push(Buffer.from(c)))
    return found ? Buffer.concat(got) : null
  }

  test.each([
    ['a ustar prefix', Buffer.concat([tarEntry('claude.exe', STAND_IN, { prefix: 'package' }), tarEnd()])],
    ['a pax path longer than the name field', Buffer.concat([tarEntry('PaxHeader/x', Buffer.from(paxRecord('path', 'package/claude.exe')), { type: 'x' }), tarEntry('package/cla', STAND_IN), tarEnd()])],
    ['a GNU long name', Buffer.concat([tarEntry('././@LongLink', Buffer.from('package/claude.exe\0'), { type: 'L' }), tarEntry('package/cla', STAND_IN), tarEnd()])],
    ['Windows separators and a leading ./', Buffer.concat([tarEntry('.\\package\\claude.exe', STAND_IN), tarEnd()])],
  ])('finds the file by %s', async (_name, archive) => {
    expect((await read(archive))?.equals(STAND_IN)).toBe(true)
  })

  test('skips what is not the file, and says so when it is not there', async () => {
    const other = Buffer.concat([tarEntry('package/claude.exe.sig', Buffer.alloc(700, 1)), tarEntry('package/claude.exe', STAND_IN), tarEnd()])
    expect((await read(other))?.equals(STAND_IN)).toBe(true)
    expect(await read(other, 'package/missing')).toBeNull()
  })

  test('a download that ends inside the file is an error, not a short binary', async () => {
    const cut = tarEntry('package/claude.exe', STAND_IN).subarray(0, 700)
    await expect(read(cut)).rejects.toThrow(/ended/)
  })
})

describe('which package', () => {
  test('is the one sdk.mjs names, musl included', () => {
    expect(platformPackages('win32', 'x64', false)).toEqual(['@anthropic-ai/claude-agent-sdk-win32-x64'])
    expect(platformPackages('darwin', 'arm64', false)).toEqual(['@anthropic-ai/claude-agent-sdk-darwin-arm64'])
    expect(platformPackages('linux', 'x64', false)).toEqual(['@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64-musl'])
    expect(platformPackages('linux', 'arm64', true)).toEqual(['@anthropic-ai/claude-agent-sdk-linux-arm64-musl', '@anthropic-ai/claude-agent-sdk-linux-arm64'])
  })

  test('the status line reads like the chat shows it', () => {
    expect(describeProgress('2.1.288', { phase: 'download', receivedBytes: 38e6, totalBytes: 104e6, percent: 37 })).toBe('Getting Claude Code 2.1.288 (104 MB): 37%')
    expect(describeProgress('2.1.288', null)).toBe('Getting Claude Code 2.1.288')
  })
})

describe('a chat without the binary', () => {
  const SETTINGS: DeskSettings = {
    defaultModel: null,
    defaultEffort: null,
    defaultPermissionMode: 'bypassPermissions',
    defaultAccountId: 'auto',
    delegateToCliMayte: true,
    idleCloseMinutes: 30,
    notifications: true,
    projectFolders: [],
    projectRoots: [],
    hiddenProjects: [],
    babysitter: true, orchestrator: false,
  }

  /** A Query that does nothing until it is closed. */
  class IdleQuery {
    private end!: () => void
    private ended = new Promise<void>((r) => (this.end = r))
    constructor(readonly options: Options) {}
    [Symbol.asyncIterator]() {
      return { next: async () => (await this.ended, { value: undefined, done: true as const }) }
    }
    close() {
      this.end()
    }
  }

  function chat(): ChatSummary {
    return {
      id: 'chat-1',
      sessionId: null,
      title: 'Test chat',
      cwd: 'C:/Users/me/project',
      account: { id: 'default', label: 'Default', configDir: null },
      accountAuto: false,
      model: null,
      effort: null,
      permissionMode: 'default',
      delegateToCliMayte: false,
      status: 'closed',
      activity: null,
      turnStartedAt: null,
      lastError: null,
      limitResetsAt: null,
      unread: false,
      pinned: false,
      archived: false,
      group: null,
      forkedFrom: null,
      createdAt: 1,
      updatedAt: 1,
      costUsd: 0,
      contextPct: null,
      pendingCount: 0,
      queuedCount: 0,
      climayteActive: 0,
    }
  }

  function setup(bin: ClaudeCodeBinary) {
    const events: ServerEvent[] = []
    const started: IdleQuery[] = []
    const queryImpl: QueryImpl = ({ options }) => {
      const q = new IdleQuery(options ?? {})
      started.push(q)
      return q as unknown as Query
    }
    const store = new ChatStore(home, { debounceMs: 1 })
    const rt = new ChatRuntime({ chat: chat(), store, emit: (e) => events.push(e), queryImpl, env: { PATH: '/bin' }, settings: SETTINGS, agentHydraMcp: null, claudeCode: bin })
    const items = () => events.flatMap((e) => (e.type === 'item.upsert' ? [e.item] : []))
    return { rt, started, items }
  }

  const until = async (done: () => boolean) => {
    for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5))
    expect(done()).toBe(true)
  }

  test('(f) waits for the download, shows it, then starts with pathToClaudeCodeExecutable', async () => {
    let release!: () => void
    const reg = registry({ gate: new Promise<void>((r) => (release = r)) })
    const bin = resolver(reg.url)
    const t = setup(bin)
    t.rt.send('hello')
    // The process is not started while the download runs, and the chat says what it waits for.
    await until(() => t.rt.chat.activity?.startsWith('Getting Claude Code 9.9.8') === true)
    expect(t.rt.chat.status).toBe('starting')
    expect(t.started).toHaveLength(0)
    release()
    await until(() => t.started.length === 1)
    const cached = join(home, 'claude-code', VERSION, BINARY)
    expect(t.started[0]!.options.pathToClaudeCodeExecutable).toBe(cached)
    expect(existsSync(cached)).toBe(true)
    // A hosted chat is sent these same options, so its process finds the binary too.
    expect(hostOptions(t.started[0]!.options).pathToClaudeCodeExecutable).toBe(cached)
    // A second chat on this home finds the cache and starts at once.
    const next = setup(bin)
    next.rt.send('again')
    expect(next.started[0]!.options.pathToClaudeCodeExecutable).toBe(cached)
    await t.rt.close()
    await next.rt.close()
  }, 15_000)

  test('a failed download shows why with a Retry, and Retry starts it again and goes on with the message', async () => {
    const tgz = packageTgz()
    const bad = registry({ tgz, integrity: integrityOf(Buffer.from('other')) })
    const bin = resolver(bad.url)
    const t = setup(bin)
    t.rt.send('hello')
    await until(() => t.rt.chat.status === 'error')
    expect(t.rt.chat.lastError).toMatch(/^Could not get Claude Code 9\.9\.8: .*checksum/)
    expect(t.items().find((i) => i.kind === 'system')).toMatchObject({ level: 'error', retry: true })
    expect(t.started).toHaveLength(0)
    // The mirror is fixed; Retry downloads again.
    const good = registry({ tgz })
    const fixed = resolver(good.url)
    const again = setup(fixed)
    again.rt.send('hello')
    await until(() => again.started.length === 1)
    expect(good.hits.tarball).toBe(1)
    // And on the chat that failed, Retry finds the binary another chat fetched.
    expect(t.rt.retryBinary()).toBe(true)
    await until(() => t.started.length === 1)
    expect(t.rt.retryBinary()).toBe(false)
    await t.rt.close()
    await again.rt.close()
  }, 15_000)
})
