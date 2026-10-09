// The sidebar row that says an update can be done, and what one click does (owner, 2026-10-09: "click here to
// restart and update"). Pure: the state it reads lives in ah-release.ts and server-update.ts.

import { ref } from 'vue'
import type { UpdateOffer } from './server-update'

/** A click is running: the row shows Restarting… from the click on, before any network answer. */
export const updateClicking = ref(false)

/** The daemon's GET /api/update/available, as the row reads it. */
export interface ReleaseWaiting {
  updateAvailable: boolean
  canApply: boolean
  latestVersion: string | null
}

export type UpdateStep = 'apply' | 'restart'

export interface FooterUpdate {
  label: string
  /** One click, in order: apply the waiting release, then restart Desk's server if it is still stale. */
  steps: UpdateStep[]
  clickable: boolean
  busy: boolean
  error: string | null
}

export interface FooterInput {
  release: ReleaseWaiting | null
  server: UpdateOffer | null
  applying: boolean
  applyError: string | null
  clicking?: boolean
}

const VERSION = /^v?(\d+\.\d+\.\d+)$/

/** The row's content, or null when there is nothing to offer. A blocked release is left to the gear's dot. */
export function footerUpdate({ release, server, applying, applyError, clicking }: FooterInput): FooterUpdate | null {
  if (release?.updateAvailable && !release.canApply) return null
  const apply = !!release?.updateAvailable
  if (!apply && !server) return null
  if (applying) return { label: 'Updating…', steps: [], clickable: false, busy: true, error: null }
  if (clicking || server?.restarting) return { label: 'Restarting…', steps: [], clickable: false, busy: true, error: null }
  if (!apply && server && !server.restartable) {
    return { label: 'Server out of date: run launcher/restart.ps1', steps: [], clickable: false, busy: false, error: null }
  }
  const version = release?.latestVersion?.match(VERSION)?.[1]
  return {
    label: apply && version ? `Click to restart and update to v${version}` : 'Click to restart and update',
    steps: apply ? ['apply', 'restart'] : ['restart'],
    clickable: true,
    busy: false,
    error: applyError ?? server?.error ?? null,
  }
}

export interface StepDeps {
  /** Resolves true when the release was applied. */
  apply(): Promise<boolean>
  /** Restarts Desk's server only if it is still stale and restartable at this moment. */
  restartIfStale(): Promise<void>
}

export async function runUpdateSteps(steps: UpdateStep[], deps: StepDeps): Promise<void> {
  for (const step of steps) {
    if (step === 'apply') {
      if (!(await deps.apply())) return
    } else {
      await deps.restartIfStale()
    }
  }
}

/** The row's click: the What's new marker is written first, then the steps run. A click while they run does nothing. */
export async function clickUpdate(steps: UpdateStep[], deps: StepDeps & { remember(): Promise<void> }): Promise<void> {
  if (updateClicking.value) return
  updateClicking.value = true
  try {
    await deps.remember()
    await runUpdateSteps(steps, deps)
  } finally {
    updateClicking.value = false
  }
}
