import { spawn } from 'node:child_process'

export interface BrowserCommand {
  command: string
  args: string[]
  detached: boolean
}

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserCommand {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', url],
      detached: false,
    }
  }
  if (platform === 'darwin') return { command: 'open', args: [url], detached: true }
  return { command: 'xdg-open', args: [url], detached: true }
}

export function openUi(url: string): boolean {
  try {
    const plan = browserCommand(url)
    const child = spawn(plan.command, plan.args, {
      detached: plan.detached,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
