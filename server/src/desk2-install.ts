// What the daemon tells a person while AgentHydra's window (desk2/) is being installed, or could not be.
// A leaf module on purpose: github-updater.ts (which sets it) and desk2.ts (whose pages and status route
// read it) both import it, and neither can import the other.

export interface Desk2InstallNotice {
  /** installing: the repair is downloading it. failed / opted-out: nothing more will happen on its own. */
  state: 'installing' | 'failed' | 'opted-out'
  /** One or two plain sentences for a person, saying what to do when it is not going to fix itself. */
  message: string
}

let notice: Desk2InstallNotice | null = null

export function desk2InstallNotice(): Desk2InstallNotice | null {
  return notice
}

export function setDesk2InstallNotice(next: Desk2InstallNotice | null): void {
  notice = next
}
