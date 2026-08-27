// server/src/screenshot.ts - capture what is actually on screen, so a claim can be LOOKED at.
//
// WHY. Everything else in this codebase reads disk, and disk is not the screen. The gap between
// them is where this feature's worst failures lived: titles written correctly and wiped by the
// app seconds later; an archive flag flipped under a running app that never repainted, so the
// endpoint reported success for a chat still sitting in the sidebar. Both were invisible to
// every automated check and obvious in one glance.
//
// So this exists to make that glance cheap and repeatable. It writes a PNG and returns the
// path; the CALLER looks at it - an AI session can read the image directly, and a human can
// open it. Nothing here interprets pixels, which is the point: it is a camera, not a judge.
//
// LIMITS, stated because a screenshot that silently captured nothing would be worse than none:
//   · Windows only (GDI CopyFromScreen via PowerShell). Other platforms report unsupported
//     rather than returning an empty file.
//   · It captures the CONSOLE session's desktop. Over Remote Desktop that is the session the
//     daemon runs in; if the console is locked or the RDP session has been disconnected, the
//     capture can be black or stale. The result carries the byte size so an implausibly small
//     image is visible as such rather than being read as "the screen is empty".

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ScreenshotResult {
  ok: boolean
  /** Absolute path to the PNG, when one was written. */
  path?: string
  bytes?: number
  width?: number
  height?: number
  reason?: string
  /** Repeated on every result: this tool proves nothing by itself, it just gives you something
   *  to look at. A caller that reports "verified" without reading the image has verified nothing. */
  note: string
}

const NOTE =
  'a capture, not a verdict - read the image before claiming anything about what is on screen'

/**
 * Capture the whole virtual desktop to a PNG.
 *
 * PowerShell rather than a native binding: it is already how this codebase talks to Windows
 * (process enumeration, instance control), it needs no new dependency, and one spawn per
 * capture is irrelevant for something invoked by hand or once per verification.
 */
export async function captureScreen(outPath?: string): Promise<ScreenshotResult> {
  if (process.platform !== 'win32')
    return {
      ok: false,
      reason: `screen capture is Windows-only (this is ${process.platform})`,
      note: NOTE,
    }

  const dir = join(tmpdir(), 'agenthydra-screenshots')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // A missing temp dir is reported by the write failing below, with the real error.
  }
  const target = outPath ?? join(dir, `screen-${Date.now()}.png`)

  // Single-quoted PowerShell string for the path: the only metacharacter that matters there is
  // the quote itself, doubled the way session-launch.ts does it for the same reason.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)',
    `$bmp.Save('${target.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
    'Write-Output "$($b.Width)x$($b.Height)"',
  ].join('; ')

  try {
    const proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      windowsHide: true,
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0 || !existsSync(target))
      return {
        ok: false,
        reason: (err || out).trim().slice(0, 400) || 'capture failed',
        note: NOTE,
      }
    const [w, h] = out.trim().split('x').map(Number)
    const bytes = statSync(target).size
    return { ok: true, path: target, bytes, width: w, height: h, note: NOTE }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      note: NOTE,
    }
  }
}
