// Who asked the server to restart or stop. The window marks its own requests with X-Desk-Caller: window, and the
// launcher's stop.ps1 (which restart.ps1 runs) marks its with launcher. Anything else is an agent or a script, and is
// refused; every ask is written to logs/restart.log with what the request said about itself.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type CallerKind = 'window' | 'launcher' | 'other'

export function callerKind(headers: Headers): CallerKind {
  const kind = headers.get('x-desk-caller')
  return kind === 'window' || kind === 'launcher' ? kind : 'other'
}

export function describeCaller(headers: Headers): string {
  const chat = headers.get('x-desk-chat') ?? 'none'
  const agent = headers.get('user-agent') ?? 'none'
  return `caller=${callerKind(headers)} chat=${chat} user-agent="${agent}"`
}

export function logRestartAsk(home: string, line: string): void {
  mkdirSync(join(home, 'logs'), { recursive: true })
  appendFileSync(join(home, 'logs', 'restart.log'), `${new Date().toISOString()} ${line}\n`)
}

export const OWNER_ONLY_RESTART =
  "Restarting or stopping this server is the owner's: an agent must not run it. Leave it to the owner's Menu > Restart to update, and carry on with the work."
