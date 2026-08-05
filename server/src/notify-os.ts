// server/src/notify-os.ts — raise a NATIVE desktop notification, on whatever OS we're on.
//
// The daemon usually lives in the tray with no window in front of the user, so an in-app toast is
// invisible exactly when it matters ("your 5-hour window just reset" is only useful if it reaches
// you while you're doing something else). This module is the OS-level half of that.
//
// WINDOWS — the part with real traps, so they're written down:
//   · The notification is a WinRT toast raised from PowerShell. WinRT type activation
//     (`[Windows.UI.Notifications.ToastNotificationManager, …, ContentType=WindowsRuntime]`) works in
//     WINDOWS PowerShell 5.1 and NOT in PowerShell 7 (`pwsh`), which has no WinRT projection loaded.
//     So this deliberately spawns `powershell.exe`, never `pwsh`. Getting that wrong fails with a
//     type-not-found error that reads like the API is missing.
//   · A toast must be raised under an AppUserModelID that Windows recognises, or `.Show()` succeeds
//     and NOTHING appears. The usual fix is a Start-Menu shortcut carrying System.AppUserModel.ID,
//     which needs IPropertyStore COM work. The supported shortcut-free alternative for desktop apps
//     is registering the id under HKCU\SOFTWARE\Classes\AppUserModelId\<id> with a DisplayName —
//     no admin rights, no shortcut, and it makes AgentHydra a real entry in Windows' own
//     Settings → Notifications list (so the user can mute us the normal way). We register it
//     lazily on first send and then leave it alone.
//   · The script is passed as -EncodedCommand (base64 UTF-16LE), never as a file on disk: the
//     release build is a single compiled binary with no `misc/` sidecar to read (scripts/build.ts),
//     so an embedded string is the only form that survives packaging.
//
// macOS uses `osascript -e 'display notification …'`; Linux uses `notify-send`. Both are best-effort.
//
// EVERYTHING here is best-effort and never throws: a notification that fails to appear must not
// take down the watcher that raised it. Callers get a typed result so the UI can say "OS
// notification unavailable" instead of silently pretending it worked.

import { spawn } from 'node:child_process'

/** The AppUserModelID AgentHydra's toasts are attributed to (see the header note). */
export const WINDOWS_APP_ID = 'LunarWerx.AgentHydra'

export interface OsNotification {
  title: string
  body: string
  /** Keep the toast on screen until dismissed instead of auto-fading. Used by persistent mode. */
  sticky?: boolean
}

export type OsNotifyResult =
  | { ok: true; platform: NodeJS.Platform }
  | { ok: false; platform: NodeJS.Platform; error: string }

/** How long we wait on the helper process before giving up. A toast is instant; anything slower is
 *  a hung shell, and hanging the reset watcher on it would be worse than dropping the notification. */
const SPAWN_TIMEOUT_MS = 10_000

/**
 * Escape a string for embedding inside a PowerShell single-quoted literal. Single-quoted is the
 * only PowerShell string form with no expansion at all, so `$`, backticks and `"` are inert and
 * doubling `'` is the entire escape. Notification text is user-supplied (an instance label), so
 * this is a real injection boundary, not a formality.
 */
function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** XML-escape for the toast payload (the text lands inside a `<text>` element). */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The PowerShell program that registers the AUMID (idempotent) and shows one toast.
 *
 * `scenario="reminder"` is what makes a sticky toast STAY on screen until the user acts, which is
 * the whole point of persistent mode — a toast that fades after 5 seconds while you're away is
 * exactly the failure the user asked to fix.
 */
export function windowsToastScript(n: OsNotification, appId = WINDOWS_APP_ID): string {
  const scenario = n.sticky ? ' scenario="reminder"' : ''
  // A reminder-scenario toast REQUIRES at least one action, or Windows silently drops it.
  const actions = n.sticky
    ? '<actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions>'
    : ''
  const xml =
    `<toast${scenario}><visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(n.title)}</text><text>${xmlEscape(n.body)}</text>` +
    `</binding></visual>${actions}</toast>`
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$AppId = ${psSingleQuote(appId)}`,
    // Registering the id is what makes Windows accept (and display) the toast at all.
    `$key = "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\$AppId"`,
    `if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }`,
    `New-ItemProperty -Path $key -Name 'DisplayName' -Value 'AgentHydra' -PropertyType String -Force | Out-Null`,
    `New-ItemProperty -Path $key -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null`,
    `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`,
    `[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]`,
    `$doc = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$doc.LoadXml(${psSingleQuote(xml)})`,
    `$toast = New-Object Windows.UI.Notifications.ToastNotification $doc`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)`,
  ].join('\n')
}

/** PowerShell's -EncodedCommand wants base64 of UTF-16LE, not UTF-8. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Spawn a helper, resolve with its outcome. Never rejects; a non-zero exit is a typed failure. */
function run(cmd: string, args: string[]): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean, error: string) => {
      if (settled) return
      settled = true
      resolve({ ok, error })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      done(false, err instanceof Error ? err.message : String(err))
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      done(false, `${cmd} timed out after ${SPAWN_TIMEOUT_MS}ms`)
    }, SPAWN_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', (err) => {
      clearTimeout(timer)
      done(false, err.message)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0, code === 0 ? '' : stderr.trim() || `exit code ${code}`)
    })
  })
}

/**
 * Raise one native notification. Best-effort by contract: the returned result says whether it
 * landed, and no path throws.
 */
export async function sendOsNotification(n: OsNotification): Promise<OsNotifyResult> {
  const platform = process.platform
  try {
    if (platform === 'win32') {
      // powershell.exe (5.1), NOT pwsh — see the header note on WinRT activation.
      const encoded = encodePowerShellCommand(windowsToastScript(n))
      const r = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded,
      ])
      return r.ok ? { ok: true, platform } : { ok: false, platform, error: r.error }
    }
    if (platform === 'darwin') {
      // AppleScript string literals are double-quoted with backslash escapes.
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const r = await run('osascript', [
        '-e',
        `display notification "${esc(n.body)}" with title "${esc(n.title)}"`,
      ])
      return r.ok ? { ok: true, platform } : { ok: false, platform, error: r.error }
    }
    // Linux / BSD: notify-send is the de-facto interface and takes its arguments literally, so
    // there is no quoting hazard here.
    const r = await run('notify-send', [
      ...(n.sticky ? ['--urgency=critical', '--expire-time=0'] : []),
      n.title,
      n.body,
    ])
    return r.ok ? { ok: true, platform } : { ok: false, platform, error: r.error }
  } catch (err) {
    return { ok: false, platform, error: err instanceof Error ? err.message : String(err) }
  }
}
