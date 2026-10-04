// The Settings dialog's rows as data, so the nav search and the content read one list (tested in
// web/test/shell/settings.test.ts). Only settings Hydra Desk really has: DeskSettings, the default
// account, and read-outs of CliMayte and this install.
import type { DeskSettings } from '@shared/protocol'

export type SettingsSection = 'general' | 'accounts' | 'climayte' | 'about'

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; caption: string }[] = [
  { id: 'general', label: 'General', caption: 'Settings' },
  { id: 'accounts', label: 'Accounts', caption: 'Settings' },
  { id: 'climayte', label: 'CliMayte', caption: 'Settings' },
  { id: 'about', label: 'About', caption: 'This computer' }
]

export type SettingsRowId =
  | 'model'
  | 'effort'
  | 'permission'
  | 'notifications'
  | 'idle'
  | 'account'
  | 'delegate'
  | 'workers'
  | 'bridge'
  | 'version'
  | 'home'

export interface SettingsRow {
  id: SettingsRowId
  section: SettingsSection
  /** The heading the row sits under on its own page. */
  group: string
  label: string
  description: string
}

export const SETTINGS_ROWS: SettingsRow[] = [
  { id: 'model', section: 'general', group: 'New chats', label: 'Default model', description: 'Used when a new chat starts.' },
  { id: 'effort', section: 'general', group: 'New chats', label: 'Effort', description: 'How hard the model thinks. Default leaves it to the model.' },
  { id: 'permission', section: 'general', group: 'New chats', label: 'Permission mode', description: 'What a new chat may do without asking.' },
  {
    id: 'notifications',
    section: 'general',
    group: 'Behaviour',
    label: 'Notifications',
    description: 'When a chat finishes, needs you or hits a limit while you look elsewhere.'
  },
  {
    id: 'idle',
    section: 'general',
    group: 'Behaviour',
    label: 'Close idle chats after',
    description: "An idle chat's process stops; your next message resumes it."
  },
  {
    id: 'account',
    section: 'accounts',
    group: 'Accounts',
    label: 'Account for new chats',
    description:
      'Auto picks the signed-in account with the most room. Your chat runs on the account chosen here; CliMayte sends its sub-agents to the others. Hover a row for its reset times.'
  },
  {
    id: 'delegate',
    section: 'climayte',
    group: 'Sub-agents',
    label: 'Delegate to CliMayte',
    description: 'New chats hand sub-agent work to CliMayte instead of the Agent tool.'
  },
  { id: 'workers', section: 'climayte', group: 'Sub-agents', label: 'Running now', description: 'CliMayte workers active across your chats.' },
  { id: 'bridge', section: 'climayte', group: 'AgentHydra bridge', label: 'Bridge status', description: 'The AgentHydra MCP bridge CliMayte runs through.' },
  { id: 'version', section: 'about', group: 'Hydra Desk', label: 'Version', description: 'The Hydra Desk server this window talks to.' },
  { id: 'home', section: 'about', group: 'Hydra Desk', label: 'Data folder', description: 'Chats, transcripts and these settings.' }
]

/** The DeskSettings field each switch row writes. */
export function switchPatch(id: 'notifications' | 'delegate', on: boolean): Partial<DeskSettings> {
  return id === 'notifications' ? { notifications: on } : { delegateToCliMayte: on }
}

/** Rows whose label or description holds every word of the query, in list order. */
export function matchRows(query: string, rows: SettingsRow[] = SETTINGS_ROWS): SettingsRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return rows.filter((r) => {
    const text = `${r.label} ${r.description}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/**
 * What the content column shows: one section's rows under their group headings, or, while searching,
 * the matching rows of every section under the section's name.
 */
export function settingsGroups(section: SettingsSection, query: string): { heading: string; rows: SettingsRow[] }[] {
  const searching = query.trim() !== ''
  const rows = searching ? matchRows(query) : SETTINGS_ROWS.filter((r) => r.section === section)
  const groups: { heading: string; rows: SettingsRow[] }[] = []
  for (const r of rows) {
    const heading = searching ? SETTINGS_SECTIONS.find((s) => s.id === r.section)!.label : r.group
    const last = groups.at(-1)
    if (last?.heading === heading) last.rows.push(r)
    else groups.push({ heading, rows: [r] })
  }
  return groups
}

/** Arrows (Down / Right forward, Up / Left back, wrapping), Home and End through the nav rows; null for any other key. */
export function stepSection(current: SettingsSection, key: string): SettingsSection | null {
  const ids = SETTINGS_SECTIONS.map((s) => s.id)
  const at = ids.indexOf(current)
  if (key === 'ArrowDown' || key === 'ArrowRight') return ids[(at + 1) % ids.length]!
  if (key === 'ArrowUp' || key === 'ArrowLeft') return ids[(at - 1 + ids.length) % ids.length]!
  if (key === 'Home') return ids[0]!
  if (key === 'End') return ids.at(-1)!
  return null
}
