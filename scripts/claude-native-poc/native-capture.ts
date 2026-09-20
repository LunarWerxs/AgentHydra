import { closeSync, openSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { connectClaudeInspector } from './inspector-client'

interface CaptureRequest {
  pid: number
  profile: string
  port?: number
  output?: string
  list?: boolean
}

async function captureRuntime(request: CaptureRequest) {
  const proc = (globalThis as any).process
  const rootRequire = proc.mainModule.require.bind(proc.mainModule)
  const { app, webContents, BrowserWindow } = rootRequire('electron')
  const path = rootRequire('node:path')
  const normalize = (value: string) =>
    path.win32
      .normalize(value)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  const guard = () => {
    if (proc.pid !== request.pid || app.getVersion() !== '2.2553.1') {
      throw Error('Capture refused: unexpected PID or Claude version')
    }
    if (normalize(app.getPath('userData')) !== normalize(request.profile) || !app.isReady()) {
      throw Error('Capture refused: unexpected profile or app state')
    }
  }
  guard()
  const rows = webContents
    .getAllWebContents()
    .filter((contents: any) => !contents.isDestroyed())
    .map((contents: any) => ({
      id: contents.id,
      type: contents.getType(),
      url: contents.getURL(),
      hostWindowId: BrowserWindow.fromWebContents(contents)?.id ?? null,
    }))
  if (request.list) return { listing: rows }
  const candidates = rows.filter((row: any) => {
    try {
      const url = new URL(row.url)
      return (
        row.type === 'window' &&
        row.hostWindowId !== null &&
        url.origin === 'https://claude.ai' &&
        (url.pathname === '/epitaxy' || url.pathname.startsWith('/epitaxy/'))
      )
    } catch {
      return false
    }
  })
  if (candidates.length !== 1)
    throw Error(`Capture refused: expected one trusted Claude view, found ${candidates.length}`)
  const candidate = candidates[0]
  const contents = webContents.fromId(candidate.id)
  const image = await contents.capturePage()
  guard()
  if (contents.isDestroyed() || contents.getURL() !== candidate.url || image.isEmpty()) {
    throw Error('Capture refused: view changed or image empty')
  }
  return { webContents: candidate, size: image.getSize(), png: image.toPNG().toString('base64') }
}

export async function captureNativeClaude(request: CaptureRequest) {
  const started = performance.now()
  const output = request.output ? resolve(request.output) : undefined
  if (!request.list && !output) throw Error('Capture requires a new output PNG path')
  const descriptor = output ? openSync(output, 'wx') : undefined
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  try {
    client = await connectClaudeInspector({
      pid: request.pid,
      profile: request.profile,
      port: request.port,
    })
    const connectedAt = performance.now()
    const captured = await client.evaluate<any>(
      `(${captureRuntime.toString()})(${JSON.stringify(request)})`,
    )
    if (request.list) return { identity: client.identity, ...captured }
    if (typeof captured.png !== 'string' || !captured.size || descriptor === undefined) {
      throw Error('Malformed native capture response')
    }
    const bytes = Buffer.from(captured.png, 'base64')
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw Error('Native capture is not a PNG')
    writeFileSync(descriptor, bytes)
    return {
      ok: true,
      identity: client.identity,
      webContents: captured.webContents,
      size: captured.size,
      output,
      bytes: bytes.length,
      timingsMs: {
        connect: Math.round(connectedAt - started),
        captureAndSave: Math.round(performance.now() - connectedAt),
        total: Math.round(performance.now() - started),
      },
    }
  } finally {
    client?.close()
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      pid: { type: 'string' },
      profile: { type: 'string' },
      port: { type: 'string' },
      output: { type: 'string' },
      list: { type: 'boolean' },
    },
    strict: true,
  })
  if (!values.pid || !values.profile)
    throw Error('Required: --pid <PID> --profile <profile> [--list | --output <new.png>]')
  const result = await captureNativeClaude({
    pid: Number(values.pid),
    profile: values.profile,
    port: values.port ? Number(values.port) : undefined,
    output: values.output,
    list: values.list,
  })
  console.log(JSON.stringify(result, null, 2))
}
