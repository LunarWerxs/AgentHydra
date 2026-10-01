// server/src/core/signin-window.ts — the sign-in window Quick add opens (cli-quick-add.ts).
//
// Owner, 2026-09-30: clicking Add account opens the sign-in page in a new private window, takes the
// code the page ends on by itself, and closes it. The engine is zendriver, the owner's choice: this
// runs orchestrator/scripts/lib/signin_window.py, which opens the page on a fresh throwaway profile
// (never the person's own browser, which is signed in to a different Claude account) and reports,
// one JSON line at a time, when a tab reaches the sign-in's callback page with its code.
//
// The person completes Cloudflare and opens their email link in this window. The script submits
// the prefilled email, relays the link page's verification code and authorizes this OAuth request.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '../config'
import { orchestratorDir, pythonBinary } from '../orchestrator'
import { killProcessTree } from './process'

export interface SigninWindow {
  close(): void
}

export const SIGNIN_WINDOW_SCRIPT = (): string =>
  join(orchestratorDir(), 'scripts', 'lib', 'signin_window.py')

/**
 * Open `url` in a new private window and call `onCode("code#state")` once a tab reaches an address
 * starting with `callbackPrefix` that carries both. `onClosed` fires if the person closes the window
 * first; `onFailed` if the window could not be opened (zendriver missing, no browser). Returns null
 * when the script is not there at all (the caller falls back to "copy the link").
 */
export function openSigninWindow(
  url: string,
  opts: {
    callbackPrefix: string
    /** Submit this prefilled email once after the person completes any human check. */
    email?: string
    onCode: (code: string) => void
    onClosed?: () => void
    onFailed?: (why: string) => void
    /** The plumbing check only: no window on the owner's screen. */
    headless?: boolean
  },
): SigninWindow | null {
  const script = SIGNIN_WINDOW_SCRIPT()
  if (!existsSync(script)) return null
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(
      [
        pythonBinary(),
        script,
        url,
        opts.callbackPrefix,
        '--position-file',
        join(CONFIG_DIR, 'signin-window-position.json'),
        ...(opts.email ? ['--email', opts.email] : []),
        ...(opts.headless ? ['--headless'] : []),
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
        // Hides python's own console only; the browser window it opens is the point.
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      },
    )
  } catch {
    return null
  }

  let settled = false // a code was handed over, or the window closed / failed
  let closing = false
  const onLine = (raw: string) => {
    let msg: { code?: string; closed?: boolean; error?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (settled || closing) return
    if (typeof msg.code === 'string') {
      settled = true
      opts.onCode(msg.code)
    } else if (msg.closed) {
      settled = true
      opts.onClosed?.()
    } else if (typeof msg.error === 'string') {
      settled = true
      opts.onFailed?.(msg.error)
    }
  }
  const readerDone = (async () => {
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLine(line)
      }
    } catch {
      // The script ended.
    }
  })()
  // After BOTH the exit and the last stdout line: the script prints its closed/error line and exits
  // at once, and an exit seen first would bury the real reason under "stopped unexpectedly".
  void Promise.all([readerDone, proc.exited]).then(() => {
    if (!settled && !closing) {
      settled = true
      opts.onFailed?.('The sign-in window stopped unexpectedly.')
    }
  })

  return {
    close() {
      if (closing) return
      closing = true
      // Ask the script to stop its browser (which also removes the throwaway profile); if it has
      // not gone within a few seconds, take the whole tree down.
      try {
        const stdin = proc.stdin as import('bun').FileSink
        stdin.write('close\n')
        stdin.flush()
        stdin.end()
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        if (proc.exitCode === null) killProcessTree(proc.pid)
      }, 5000)
    },
  }
}
