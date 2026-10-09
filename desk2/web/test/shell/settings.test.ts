import { describe, it, expect } from 'bun:test'
import type { DeskSettings } from '@shared/protocol'
import { SETTINGS_SECTIONS, matchRows, settingsGroups, stepSection, switchPatch } from '@/components/panes/settings'
import { pairingSummary } from '@/components/panes/instances'
import { NavHistory, viewUnder, type View } from '@/components/shell/logic'

describe('settings search', () => {
  it('shows one section under its group headings when the box is empty', () => {
    expect(settingsGroups('general', '  ').map((g) => [g.heading, g.rows.map((r) => r.id)])).toEqual([
      ['New chats', ['model', 'effort', 'permission']],
      ['Behaviour', ['notifications', 'idle']],
      ['Watching chats', ['babysitter', 'orchestrator', 'orchestratorModel']],
      ['AgentHydra pages', ['ahTooltips', 'ahPrivacy']]
    ])
    // The working animation is no longer a setting: the window picks a look itself (lib/working-mark.ts).
    expect(matchRows('working animation')).toEqual([])
  })

  it('leaves a row off its page while the switch it depends on is off, but a search finds it', () => {
    const on = new Set(['alerts'])
    const page = settingsGroups('alerts', '', (c) => on.has(c)).flatMap((g) => g.rows.map((r) => r.id))
    expect(page).toContain('ahEmail')
    expect(page).not.toContain('ahSmtpHost')
    expect(page).not.toContain('ahInterval')
    expect(settingsGroups('alerts', 'smtp host', () => false).flatMap((g) => g.rows.map((r) => r.id))).toEqual(['ahSmtpHost'])
  })

  it('filters every section by label and description, grouped under the section name', () => {
    expect(matchRows('CLIMAYTE').map((r) => r.id)).toEqual(['ahAlerts', 'delegate', 'workers', 'bridge'])
    // Every word must match, in either the label or the description.
    expect(matchRows('model thinks').map((r) => r.id)).toEqual(['effort'])
    expect(settingsGroups('about', 'climayte').map((g) => g.heading)).toEqual(['Usage alerts', 'CliMayte'])
  })

  it('matches nothing for a setting Hydra Desk does not have', () => {
    expect(settingsGroups('general', 'billing')).toEqual([])
    expect(matchRows('')).toEqual([])
  })
})

describe('settings nav keys', () => {
  it('moves through the rows with the arrows, wrapping, and jumps with Home and End', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'general', 'alerts', 'climayte', 'connections', 'connectors', 'devservers', 'diagnostics', 'updates', 'about', 'cli', 'desktop', 'free'
    ])
    expect(stepSection('general', 'ArrowDown')).toBe('alerts')
    expect(stepSection('about', 'ArrowDown')).toBe('cli')
    expect(stepSection('general', 'ArrowUp')).toBe('free')
    expect(stepSection('free', 'ArrowRight')).toBe('general')
    expect(stepSection('climayte', 'Home')).toBe('general')
    expect(stepSection('general', 'End')).toBe('free')
    expect(stepSection('general', 'a')).toBeNull()
  })
})

describe('settings switches', () => {
  it('a switch writes its own DeskSettings field', () => {
    let saved: Partial<DeskSettings> = { notifications: true, delegateToCliMayte: true }
    const save = (patch: Partial<DeskSettings>) => (saved = { ...saved, ...patch })
    save(switchPatch('delegate', false))
    expect(saved).toEqual({ notifications: true, delegateToCliMayte: false })
    save(switchPatch('notifications', false))
    expect(saved).toEqual({ notifications: false, delegateToCliMayte: false })
  })
})

describe('closing settings', () => {
  it('Esc or the X returns to the view the dialog was opened over, which stays under it while open', () => {
    const chat: View = { kind: 'chat', id: 'a' }
    const settings: View = { kind: 'settings' }
    expect(viewUnder(settings, chat)).toEqual(chat)
    expect(viewUnder({ kind: 'new' }, chat)).toEqual({ kind: 'new' })
    // The view under it is what history records, so closing adds no Back step.
    const h = new NavHistory()
    h.visit(chat)
    h.visit(viewUnder(settings, chat))
    expect(h.canBack).toBe(false)
  })
})

describe('CLI login pairing', () => {
  it('is found by the search on the Desktop page', () => {
    expect(matchRows('cli login').map((r) => r.id)).toContain('ahDesktopCliPair')
    expect(settingsGroups('desktop', '').map((g) => g.heading)).toContain('CLI logins')
  })

  it('summarises what was added, who signs in later and each failure', () => {
    const p = (n: number, signedIn: boolean) => ({ desktopNum: n, desktopLabel: `Example ${n}`, cliId: `c${n}`, cliNum: n, signedIn })
    const r = { created: [p(1, true)], linked: [p(2, false)], failed: [{ desktopNum: 3, desktopLabel: 'Example 3', error: 'no space' }] }
    expect(pairingSummary(r)).toEqual(['Added 1, linked 1 existing.', '1 sign in once that account opens Claude Code in Desktop.', '#3 Example 3: no space'])
    expect(pairingSummary(r, true)[2]).toBe('#3: no space')
  })
})
