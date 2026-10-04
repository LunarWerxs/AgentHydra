import { describe, it, expect } from 'bun:test'
import type { DeskSettings } from '@shared/protocol'
import { SETTINGS_SECTIONS, matchRows, settingsGroups, stepSection, switchPatch } from '@/components/panes/settings'
import { NavHistory, viewUnder, type View } from '@/components/shell/logic'

describe('settings search', () => {
  it('shows one section under its group headings when the box is empty', () => {
    expect(settingsGroups('general', '  ').map((g) => [g.heading, g.rows.map((r) => r.id)])).toEqual([
      ['New chats', ['model', 'effort', 'permission']],
      ['Behaviour', ['notifications', 'idle']]
    ])
  })

  it('filters every section by label and description, grouped under the section name', () => {
    expect(matchRows('CLIMAYTE').map((r) => r.id)).toEqual(['account', 'delegate', 'workers', 'bridge'])
    // Every word must match, in either the label or the description.
    expect(matchRows('model thinks').map((r) => r.id)).toEqual(['effort'])
    expect(settingsGroups('about', 'climayte').map((g) => g.heading)).toEqual(['Accounts', 'CliMayte'])
  })

  it('matches nothing for a setting Hydra Desk does not have', () => {
    expect(settingsGroups('general', 'billing')).toEqual([])
    expect(matchRows('')).toEqual([])
  })
})

describe('settings nav keys', () => {
  it('moves through the rows with the arrows, wrapping, and jumps with Home and End', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['general', 'accounts', 'climayte', 'about'])
    expect(stepSection('general', 'ArrowDown')).toBe('accounts')
    expect(stepSection('general', 'ArrowUp')).toBe('about')
    expect(stepSection('about', 'ArrowRight')).toBe('general')
    expect(stepSection('climayte', 'Home')).toBe('general')
    expect(stepSection('general', 'End')).toBe('about')
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
