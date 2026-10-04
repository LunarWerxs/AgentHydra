// The TCP ports listening on this machine (SPEC "Localhost"): netstat on Windows (43 ms, where
// Get-NetTCPConnection takes 2-3 s), Get-NetTCPConnection's JSON as its fallback, lsof elsewhere; the owning
// processes from one Win32_Process query (name, parent, command line, start time). Parsers are pure so the
// tests feed them captured samples.

import { spawn } from 'node:child_process'

export interface Listener {
  address: string
  port: number
  pid: number
}

export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  command: string | null
  /** Epoch ms the process started; null when unknown. */
  created: number | null
}

/** An address loopback reaches: 127.x, ::1, or a wildcard bind. */
export function reachableFromLoopback(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '::1' || address.startsWith('127.') || address === '*'
}

/** "0.0.0.0:135" / "[::1]:7795" / "[fe80::1%5]:80" -> address and port; null for anything else. */
export function splitHostPort(s: string): { address: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:\s]+):(\d+)$/.exec(s)
  if (!m) return null
  const port = Number(m[2])
  return port > 0 && port < 65536 ? { address: m[1]!.replace(/%.*$/, ''), port } : null
}

/**
 * `netstat -ano` (any of -p TCP / TCPv6, any language): the listening rows are the TCP ones whose foreign
 * address is the any-port placeholder (0.0.0.0:0, [::]:0), so the localized state word ("LISTENING", "ABHÖREN")
 * is never read. One row per address and port; only addresses loopback reaches.
 */
export function parseNetstat(text: string): Listener[] {
  const out: Listener[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 5 || cols[0]!.toUpperCase() !== 'TCP') continue
    const local = splitHostPort(cols[1]!)
    if (!local || !/^(0\.0\.0\.0|\[::\]|\*):0$/.test(cols[2]!)) continue
    const pid = Number(cols[cols.length - 1])
    if (!Number.isInteger(pid) || pid < 0) continue
    if (!reachableFromLoopback(local.address)) continue
    const key = `${local.address}|${local.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ address: local.address, port: local.port, pid })
  }
  return out
}

/** `Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | ConvertTo-Json`: one
 *  object when there is a single row, an array otherwise. */
export function parseNetTcpJson(text: string): Listener[] {
  let data: unknown
  try {
    data = JSON.parse(text.trim() || '[]')
  } catch {
    return []
  }
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  const out: Listener[] = []
  const seen = new Set<string>()
  for (const r of rows as Record<string, unknown>[]) {
    const address = typeof r.LocalAddress === 'string' ? r.LocalAddress : null
    const port = Number(r.LocalPort)
    const pid = Number(r.OwningProcess)
    if (!address || !Number.isInteger(port) || port <= 0 || !Number.isInteger(pid)) continue
    if (!reachableFromLoopback(address)) continue
    const key = `${address}|${port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ address, port, pid })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN` (macOS, Linux). */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    const name = cols.find((c, i) => i > 7 && /:\d+$/.test(c))
    const pid = Number(cols[1])
    if (!name || !Number.isInteger(pid)) continue
    const hp = splitHostPort(name.replace(/^\*:/, '0.0.0.0:'))
    if (!hp || !reachableFromLoopback(hp.address)) continue
    const key = `${hp.address}|${hp.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...hp, pid })
  }
  return out
}

/** The Win32_Process query's JSON (ProcessId, ParentProcessId, Name, CommandLine, c = start in epoch ms). */
export function parseProcJson(text: string): Map<number, ProcInfo> {
  const map = new Map<number, ProcInfo>()
  let data: unknown
  try {
    data = JSON.parse(text.trim() || '[]')
  } catch {
    return map
  }
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  for (const r of rows as Record<string, unknown>[]) {
    const pid = Number(r.ProcessId)
    if (!Number.isInteger(pid)) continue
    const name = typeof r.Name === 'string' ? r.Name.replace(/\.exe$/i, '') : ''
    const created = Number(r.c)
    map.set(pid, {
      pid,
      ppid: Number(r.ParentProcessId) || 0,
      name,
      command: typeof r.CommandLine === 'string' && r.CommandLine ? r.CommandLine : null,
      created: Number.isFinite(created) && created > 0 ? created : null,
    })
  }
  return map
}

const PS_PROCS =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='c';e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }}} | ConvertTo-Json -Compress"
const PS_NETTCP = 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress'

/** A command's stdout, or null when it failed or ran past the timeout. Async: a scan never blocks the server. */
export function run(cmd: string, args: string[], timeout = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeout)
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (d: string) => {
      if (out.length < 32 * 1024 * 1024) out += d
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
  })
}

export const powershell = (script: string) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 15000)

export interface Scan {
  listeners: Listener[]
  procs: Map<number, ProcInfo>
  error: string | null
}

/** Every process on this machine (Windows: Win32_Process; elsewhere: ps). */
export async function readProcs(): Promise<Map<number, ProcInfo>> {
  if (process.platform === 'win32') return parseProcJson((await powershell(PS_PROCS)) ?? '')
  const map = new Map<number, ProcInfo>()
  const text = (await run('ps', ['-axo', 'pid=,ppid=,lstart=,comm=,args='])) ?? ''
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const created = Date.parse(m[3]!)
    map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: m[4]!.split('/').pop()!, command: m[5]!, created: Number.isFinite(created) ? created : null })
  }
  return map
}

/** The listening ports and the processes behind them. */
export async function scanPorts(): Promise<Scan> {
  let listeners: Listener[] = []
  let error: string | null = null
  if (process.platform === 'win32') {
    const [tcp, tcp6] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])])
    if (tcp !== null || tcp6 !== null) listeners = parseNetstat(`${tcp ?? ''}\n${tcp6 ?? ''}`)
    else {
      const json = await powershell(PS_NETTCP)
      if (json === null) error = 'could not read the listening ports (netstat and Get-NetTCPConnection both failed)'
      else listeners = parseNetTcpJson(json)
    }
  } else {
    const text = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
    if (text === null) error = 'could not read the listening ports (lsof failed)'
    else listeners = parseLsof(text)
  }
  return { listeners, procs: listeners.length ? await readProcs() : new Map(), error }
}

/** The title of an HTML page, entities for the common five decoded, whitespace folded, at most 120 chars. */
export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return null
  const t = m[1]!
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return t ? t.slice(0, 120) : null
}

/** Does the port answer HTTP (a GET with a short timeout, the first 64 KB read for its <title>)? */
export async function probeHttp(port: number, address: string, timeoutMs = 800): Promise<{ status: number; title: string | null } | null> {
  const host = address === '::1' ? '[::1]' : '127.0.0.1'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: ctrl.signal, redirect: 'manual', headers: { accept: 'text/html,*/*' } })
    let title: string | null = null
    if ((res.headers.get('content-type') ?? '').includes('html') && res.body) {
      const reader = res.body.getReader()
      let html = ''
      while (html.length < 65536) {
        const { value, done } = await reader.read()
        if (done) break
        html += new TextDecoder().decode(value)
        if (/<\/title>/i.test(html)) break
      }
      void reader.cancel().catch(() => {})
      title = htmlTitle(html)
    } else void res.body?.cancel().catch(() => {})
    return { status: res.status, title }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
