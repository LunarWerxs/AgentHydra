// Read-only harvester for the running Claude Desktop instance 'eek'.
// Usage: bun docs/reference/tools/harvest.ts <script.js> [outfile]
//   The script file is the BODY of an async function evaluated in the Electron MAIN process
//   (awaitPromise, returnByValue). Provided: `electron`, `fs`, `all` (every webContents), `WC` (the
//   claude.ai Code-tab webContents), `js(code)` (executeJavaScript in the page), `png(path, rect?)`
//   (webContents.capturePage, works while the window is covered). The connection identity
//   (pid + userData) is checked first and the socket is always closed in a finally block.
//   Any debugger attach inside a script must detach itself in its own finally.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = 19330
const PID = 64264
const PROFILE = join(homedir(), '.claude-instances', 'eek').split('\\').join('/').toLowerCase()

const [script, out] = process.argv.slice(2)
if (!script) throw new Error('usage: harvest.ts <script.js> [outfile]')

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as any[]
if (list.length !== 1) throw new Error('expected exactly one inspector target')
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = () => res(null)
  ws.onerror = () => rej(new Error('connect failed'))
})
let id = 0
const pending = new Map<number, (m: any) => void>()
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) pending.get(m.id)!(m)
}
function evaluate(expression: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const i = ++id
    const t = setTimeout(() => reject(new Error('timeout')), 90000)
    pending.set(i, (m) => {
      clearTimeout(t)
      if (m.error) return reject(new Error(JSON.stringify(m.error)))
      const r = m.result
      if (r.exceptionDetails) return reject(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      resolve(r.result.value)
    })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}
try {
  const req = `(process.mainModule?.require?.bind(process.mainModule) ?? require)`
  const ident = await evaluate(`(() => { const app = ${req}('electron').app; return { pid: process.pid, profile: app.getPath('userData') } })()`)
  if (ident.pid !== PID || String(ident.profile).split('\\').join('/').toLowerCase() !== PROFILE) {
    throw new Error('identity mismatch ' + JSON.stringify(ident))
  }
  const body = readFileSync(script, 'utf8')
  const prelude = `(async () => {
    const electron = ${req}('electron');
    const fs = ${req}('fs');
    const all = electron.webContents.getAllWebContents();
    const WC = all.filter(w => !w.isDestroyed() && w.getURL().startsWith('https://claude.ai'))[0];
    const png = async (p, rect) => { const img = rect ? await WC.capturePage(rect) : await WC.capturePage(); fs.writeFileSync(p, img.toPNG()); return img.getSize(); };
    const js = (code) => WC.executeJavaScript(code, true);
    const LIB = ${JSON.stringify(readFileSync(new URL('./page-lib.js', import.meta.url), 'utf8'))};
    // jsl(expr): evaluate an expression with the page-lib helpers in scope (function-scoped, no page globals)
    const jsl = (code) => WC.executeJavaScript('(async () => {' + LIB + '\\n return (' + code + '); })()', true);
    return await (async () => { ${body}
    })();
  })()`
  const result = await evaluate(prelude)
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  if (out) writeFileSync(out, text)
  else console.log(text)
} finally {
  try {
    ws.close()
  } catch {}
}
