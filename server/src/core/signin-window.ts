// server/src/core/signin-window.ts — the sign-in window Quick add opens (cli-quick-add.ts).
//
// Owner, 2026-09-30: clicking Add account should open the sign-in page in a window, take the code
// the page ends on by itself, and close. So this opens Chrome (else Edge) as a SEPARATE browser: a
// fresh throwaway profile, never the person's own, which is signed in to a different Claude account.
// The person does the human part there - "Continue with email", the code from their inbox,
// Authorize - and this only watches which page the window is on. When it reaches the sign-in's
// callback page, the code in that page's address is handed to the CLI (the same "code#state" the
// page shows for pasting) and the window is closed.
//
// Watching goes through the browser's own local debugging endpoint (/json/list: each tab's address,
// nothing else). No script runs in the page and nothing is clicked or typed for the person; the
// human check and the email code stay theirs. A headless browser would not work anyway: claude.ai
// answers one with a Cloudflare challenge (measured 2026-09-30).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree } from './process'

export interface SigninWindow {
  close(): void
}

/** Chrome, else Edge. Null where neither is installed, and off Windows/macOS. */
export function findChromium(): string | null {
  const env = process.env
  const candidates =
    process.platform === 'win32'
      ? [
          env.ProgramFiles && join(env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
          env['ProgramFiles(x86)'] &&
            join(env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
          env['ProgramFiles(x86)'] &&
            join(env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
          env.ProgramFiles && join(env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : []
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null
}

/**
 * Open `url` in a throwaway browser window and call `onCode("code#state")` once the window reaches
 * an address starting with `callbackPrefix` that carries both. `onClosed` fires if the person closes
 * the window first. Returns null when no browser could be started (the caller falls back to "copy
 * the link").
 */
export function openSigninWindow(
  url: string,
  opts: {
    callbackPrefix: string
    onCode: (code: string) => void
    onClosed?: () => void
    /** More browser flags; the plumbing check runs it with --headless=new so no window shows. */
    extraArgs?: string[]
  },
): SigninWindow | null {
  const exe = findChromium()
  if (!exe) return null
  const profile = mkdtempSync(join(tmpdir(), 'ah-signin-'))
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(
      [
        exe,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        '--window-size=520,780',
        ...(opts.extraArgs ?? []),
        `--app=${url}`,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    )
  } catch {
    rmSync(profile, { recursive: true, force: true })
    return null
  }

  let port: number | null = null
  let handedOver = false
  let closed = false
  // One poll at a time: the fetch may outlast the 1 s tick, and two in flight could both find the
  // callback page and hand the same code to the CLI twice.
  let polling = false
  const poll = setInterval(async () => {
    if (handedOver || closed || polling) return
    polling = true
    try {
      await pollOnce()
    } finally {
      polling = false
    }
  }, 1000)

  async function pollOnce(): Promise<void> {
    if (handedOver || closed) return
    if (port === null) {
      try {
        // Chrome writes the port it picked for --remote-debugging-port=0 here.
        port =
          Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null
      } catch {
        return
      }
      if (port === null) return
    }
    try {
      const tabs = (await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      }).then((r) => r.json())) as Array<{ type?: string; url?: string }>
      if (handedOver || closed) return
      for (const tab of tabs) {
        if (tab.type !== 'page' || !tab.url?.startsWith(opts.callbackPrefix)) continue
        const at = new URL(tab.url)
        const code = at.searchParams.get('code')
        const state = at.searchParams.get('state')
        if (!code || !state) continue
        handedOver = true
        opts.onCode(`${code}#${state}`)
        return
      }
    } catch {
      // Still starting, or between pages.
    }
  }

  void proc.exited.then(() => {
    clearInterval(poll)
    if (!closed && !handedOver) opts.onClosed?.()
    closed = true
    // The browser holds its profile until it exits; remove it once it has.
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 2000)
  })

  return {
    close() {
      if (closed) return
      closed = true
      clearInterval(poll)
      if (proc.exitCode === null) killProcessTree(proc.pid)
    },
  }
}
