// The Settings dialog's rows as data, so the nav search and the content read one list (tested in
// web/test/shell/settings.test.ts). Only settings Hydra Desk really has: DeskSettings, read-outs of
// CliMayte and this install, and AgentHydra's own settings (the `ah` rows, agenthydra.ts), which moved
// here from the AgentHydra pane's settings sidebar (owner, 2026-10-06). Instances holds the settings of
// the pane's three tables, CLI, Desktop and Free, which were behind each table's gear: the gear now opens
// this dialog on its page (owner, 2026-10-06). The account for new chats is picked in the sidebar's
// account menu, so Settings has no Accounts page.
import type { DeskSettings } from '@shared/protocol'

export type SettingsSection = 'general' | 'alerts' | 'climayte' | 'connections' | 'connectors' | 'devservers' | 'diagnostics' | 'updates' | 'about' | 'cli' | 'desktop' | 'free'

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; caption: string }[] = [
  { id: 'general', label: 'General', caption: 'Settings' },
  { id: 'alerts', label: 'Usage alerts', caption: 'Settings' },
  { id: 'climayte', label: 'CliMayte', caption: 'Settings' },
  { id: 'connections', label: 'Connections', caption: 'Settings' },
  { id: 'connectors', label: 'Connectors', caption: 'Settings' },
  { id: 'devservers', label: 'Dev servers', caption: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics', caption: 'This computer' },
  { id: 'updates', label: 'Updates', caption: 'This computer' },
  { id: 'about', label: 'About', caption: 'This computer' },
  { id: 'cli', label: 'CLI', caption: 'Instances' },
  { id: 'desktop', label: 'Desktop', caption: 'Instances' },
  { id: 'free', label: 'Free', caption: 'Instances' }
]

export type SettingsRowId =
  | 'model'
  | 'effort'
  | 'permission'
  | 'notifications'
  | 'idle'
  | 'ahTooltips'
  | 'ahPrivacy'
  | 'ahAlerts'
  | 'ahSessionReset'
  | 'ahWeeklyReset'
  | 'ahMinPct'
  | 'ahSessionMaxWeekly'
  | 'ahDesktop'
  | 'ahPersistent'
  | 'ahInterval'
  | 'ahRepeats'
  | 'ahTest'
  | 'ahQuickShortcut'
  | 'ahEmail'
  | 'ahEmailTo'
  | 'ahEmailFrom'
  | 'ahSmtpHost'
  | 'ahSmtpPort'
  | 'ahSmtpSecure'
  | 'ahSmtpUser'
  | 'ahSmtpPass'
  | 'delegate'
  | 'workers'
  | 'bridge'
  | 'ahMcp'
  | 'ahRepair'
  | 'ahSync'
  | 'ahSyncNow'
  | 'ahDisconnect'
  | 'ahVersion'
  | 'ahAutoUpdate'
  | 'version'
  | 'home'
  | 'ahTray'
  | 'ahShowCli'
  | 'ahKeepalive'
  | 'ahKeepaliveFloor'
  | 'ahShowDesktop'
  | 'ahShowCodexDesktop'
  | 'ahShowCodexCli'
  | 'ahShowDsh'
  | 'ahDesktopProcess'
  | 'ahExtraUsage'
  | 'ahNativeAccount'
  | 'ahNativeAuto'
  | 'ahNativeReset'
  | 'ahDesktopCliPair'
  | 'ahFreeKeepalive'
  | 'ahFreeFloor'
  | 'dwService'
  | 'dwRuntime'
  | 'dwAutoStart'
  | 'dwFreePort'
  | 'dwRestartRunning'
  | 'dwMonitor'
  | 'dwLinkHost'
  | 'dwAutoScan'
  | 'dwSkip'
  | 'dwExclude'
  | 'dwScanNow'
  | 'dwIgnored'
  | 'dwForgetFound'
  | 'dwAlerts'

/** An AgentHydra state a row only makes sense under; agenthydra.ts says which hold. */
export type SettingsCondition = 'alerts' | 'persistent' | 'email' | 'missing' | 'connected' | 'syncing' | 'keepalive' | 'native' | 'freeKeepalive'

export interface SettingsRow {
  id: SettingsRowId
  section: SettingsSection
  /** The heading the row sits under on its own page. */
  group: string
  label: string
  description: string
  /** Shown on its page only while all of these hold (a search lists it anyway). */
  when?: SettingsCondition[]
}

// In section order: a search groups consecutive rows under their section's name.
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
    id: 'ahTooltips',
    section: 'general',
    group: 'AgentHydra pages',
    label: 'Show tooltips',
    description: 'Hover help on the buttons of the AgentHydra pages. Info icons stay on.'
  },
  {
    id: 'ahPrivacy',
    section: 'general',
    group: 'AgentHydra pages',
    label: 'Privacy mode',
    description:
      'For screenshots and screen-shares: masks account addresses, handles and profile names on the AgentHydra pages. Copy still copies the real address.'
  },
  {
    id: 'ahAlerts',
    section: 'alerts',
    group: 'Quota resets',
    label: 'Reset notifications',
    description:
      'Tell me when a quota window rolls over. Only windows you used announce a reset; CLI accounts are left out, since CliMayte runs them around the clock.'
  },
  {
    id: 'ahSessionReset',
    section: 'alerts',
    group: 'Quota resets',
    label: 'Notify on 5-hour reset',
    description: "When an account's 5-hour window comes back.",
    when: ['alerts']
  },
  {
    id: 'ahWeeklyReset',
    section: 'alerts',
    group: 'Quota resets',
    label: 'Notify on weekly reset',
    description: "When an account's weekly window comes back.",
    when: ['alerts']
  },
  {
    id: 'ahMinPct',
    section: 'alerts',
    group: 'Quota resets',
    label: 'Only if usage was at least',
    description: 'Skips a reset whose window was barely used. 0 announces every rollover.',
    when: ['alerts']
  },
  {
    id: 'ahSessionMaxWeekly',
    section: 'alerts',
    group: 'Quota resets',
    label: 'Skip 5-hour reset if weekly is at least',
    description: 'A 5-hour window coming back changes nothing on an account out of weekly quota. Weekly resets are never skipped.',
    when: ['alerts']
  },
  {
    id: 'ahDesktop',
    section: 'alerts',
    group: 'Delivery',
    label: 'Desktop notification',
    description: 'A Windows notification, so it reaches you with every window minimised.',
    when: ['alerts']
  },
  {
    id: 'ahPersistent',
    section: 'alerts',
    group: 'Delivery',
    label: 'Keep reminding me',
    description: 'Raises it again until you acknowledge it, and the desktop one stays on screen.',
    when: ['alerts']
  },
  { id: 'ahInterval', section: 'alerts', group: 'Delivery', label: 'Remind every', description: 'Minutes between reminders.', when: ['alerts', 'persistent'] },
  {
    id: 'ahRepeats',
    section: 'alerts',
    group: 'Delivery',
    label: 'Stop after',
    description: 'Reminders before it gives up. 0 keeps going until acknowledged.',
    when: ['alerts', 'persistent']
  },
  {
    id: 'ahTest',
    section: 'alerts',
    group: 'Delivery',
    label: 'Send a test notification',
    description: 'Proves the delivery works now, not in five hours.',
    when: ['alerts']
  },
  {
    id: 'ahEmail',
    section: 'alerts',
    group: 'Email',
    label: 'Also send an email',
    description: 'Through your own SMTP server. The password is stored encrypted for this Windows account and never shown again.',
    when: ['alerts']
  },
  { id: 'ahEmailTo', section: 'alerts', group: 'Email', label: 'Send to', description: 'The address the alerts go to.', when: ['alerts', 'email'] },
  { id: 'ahEmailFrom', section: 'alerts', group: 'Email', label: 'From address', description: 'The sender the email shows.', when: ['alerts', 'email'] },
  { id: 'ahSmtpHost', section: 'alerts', group: 'Email', label: 'SMTP host', description: 'Your mail server.', when: ['alerts', 'email'] },
  { id: 'ahSmtpPort', section: 'alerts', group: 'Email', label: 'Port', description: '587 or 25 with STARTTLS, 465 with implicit TLS.', when: ['alerts', 'email'] },
  {
    id: 'ahSmtpSecure',
    section: 'alerts',
    group: 'Email',
    label: 'Implicit TLS (port 465)',
    description: 'Off upgrades a plain connection with STARTTLS, which ports 587 and 25 expect.',
    when: ['alerts', 'email']
  },
  { id: 'ahSmtpUser', section: 'alerts', group: 'Email', label: 'Username', description: 'The SMTP login.', when: ['alerts', 'email'] },
  {
    id: 'ahSmtpPass',
    section: 'alerts',
    group: 'Email',
    label: 'Password',
    description: 'Type a new one to replace the stored one; leaving it empty keeps it.',
    when: ['alerts', 'email']
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
  {
    id: 'ahMcp',
    section: 'connections',
    group: 'MCP server',
    label: 'Register with Claude Code',
    description:
      "Keeps an agenthydra entry in Claude Code's user config pointing at AgentHydra, so every chat gets its tools. Off removes the entry; an open chat keeps the tools it started with."
  },
  {
    id: 'ahRepair',
    section: 'connections',
    group: 'MCP server',
    label: 'Repair install',
    description: 'Re-applies the current version, which restores the folders a release ships beside the executable.',
    when: ['missing']
  },
  {
    id: 'ahSync',
    section: 'connections',
    group: 'Cloud sync',
    label: 'Sync settings with Connections',
    description: 'Scheduler preferences and the theme follow you to AgentHydra on another machine. Never accounts, secrets or queue data.'
  },
  {
    id: 'ahSyncNow',
    section: 'connections',
    group: 'Cloud sync',
    label: 'Sync now',
    description: "Pulls the synced settings, then pushes this machine's.",
    when: ['connected', 'syncing']
  },
  { id: 'ahDisconnect', section: 'connections', group: 'Cloud sync', label: 'Disconnect', description: 'Signs this machine out of Connections.', when: ['connected'] },
  {
    id: 'ahVersion',
    section: 'updates',
    group: 'AgentHydra',
    label: 'Version',
    description: 'The AgentHydra engine behind every account page. Click the number to check again, or to install a waiting update.'
  },
  {
    id: 'ahAutoUpdate',
    section: 'updates',
    group: 'AgentHydra',
    label: 'Auto-update',
    description:
      'On by default. Installs a newer AgentHydra on its own and restarts it, waiting while work a restart would stop is running. A checkout with local changes is never touched.'
  },
  { id: 'version', section: 'about', group: 'AgentHydra', label: 'Window version', description: 'The server this window talks to (desk2/, port 7798).' },
  { id: 'home', section: 'about', group: 'AgentHydra', label: 'Data folder', description: "This window's chats, transcripts and settings." },
  {
    id: 'ahTray',
    section: 'about',
    group: 'AgentHydra',
    label: 'Hide tray icon',
    description: 'Removes the AgentHydra icon from the notification area; AgentHydra keeps running. Only when it was started from its tray shortcut.'
  },
  {
    id: 'ahShowCli',
    section: 'cli',
    group: 'Table',
    label: 'Claude CLI logins',
    description: 'Show the Claude CLI table. Hiding it signs nothing out.'
  },
  {
    id: 'ahKeepalive',
    section: 'cli',
    group: 'Keepalive',
    label: 'Keep windows running',
    description: "Starts an idle account's 5-hour window with one tiny prompt, so it resets sooner. A dot on the counter marks it."
  },
  {
    id: 'ahKeepaliveFloor',
    section: 'cli',
    group: 'Keepalive',
    label: 'Skip above weekly',
    description: 'Accounts past this share of their weekly cap are left alone.',
    when: ['keepalive']
  },
  { id: 'ahShowDesktop', section: 'desktop', group: 'Tables', label: 'Claude Desktop', description: 'Show the Claude Desktop table.' },
  { id: 'ahShowCodexDesktop', section: 'desktop', group: 'Tables', label: 'Codex Desktop', description: 'Show the Codex Desktop table.' },
  { id: 'ahShowCodexCli', section: 'desktop', group: 'Tables', label: 'Codex CLI', description: 'Show the Codex CLI table.' },
  { id: 'ahShowDsh', section: 'desktop', group: 'Tables', label: 'DeepSeek', description: 'Show the DeepSeek Harness table.' },
  {
    id: 'ahDesktopProcess',
    section: 'desktop',
    group: 'Tables',
    label: 'Show process columns',
    description: 'PID, uptime, memory and usage in place of the quota bars.'
  },
  {
    id: 'ahDesktopCliPair',
    section: 'desktop',
    group: 'CLI logins',
    label: 'Give each account a CLI login',
    description: 'On by default. Every Claude account signed in to Desktop on this PC gets a linked CLI login that signs in from Desktop. Delete one and it stays deleted.'
  },
  {
    id: 'ahQuickShortcut',
    section: 'desktop',
    group: 'Quick Instances',
    label: 'Quick Instances shortcut',
    description: 'Adds a small launcher to your Desktop that opens only the account chooser. Windows only.'
  },
  {
    id: 'ahExtraUsage',
    section: 'desktop',
    group: 'Paid extra usage',
    label: 'Allow paid extra usage',
    description: 'Let work run past a limit on paid usage credits. Off, AgentHydra moves or stops it first.'
  },
  {
    id: 'ahNativeAccount',
    section: 'desktop',
    group: 'Claude native control',
    label: 'Account',
    description: 'Archives chats and cleans up after a move through a direct connection.'
  },
  {
    id: 'ahNativeAuto',
    section: 'desktop',
    group: 'Claude native control',
    label: 'Start debugger automatically',
    description: 'From the next time AgentHydra opens this account, through a verified copy of Claude.'
  },
  {
    id: 'ahNativeReset',
    section: 'desktop',
    group: 'Claude native control',
    label: 'Use standard controls',
    description: "Removes this account's native control settings.",
    when: ['native']
  },
  {
    id: 'ahFreeKeepalive',
    section: 'free',
    group: 'Keepalive',
    label: 'Keep windows running',
    description: "Claude logins only: a one-word chat starts the next 5-hour window when the last one ends."
  },
  {
    id: 'ahFreeFloor',
    section: 'free',
    group: 'Keepalive',
    label: 'Skip above weekly',
    description: 'Logins past this share of their weekly cap are left alone.',
    when: ['freeKeepalive']
  },
  {
    id: 'dwService',
    section: 'devservers',
    group: 'Server manager',
    label: 'Service status',
    description: 'The dev-servers service that runs and monitors your projects.'
  },
  { id: 'dwRuntime', section: 'devservers', group: 'Starting servers', label: 'Runtime', description: 'How bun and node scripts are run when their project has no choice.' },
  { id: 'dwAutoStart', section: 'devservers', group: 'Starting servers', label: 'Start on launch', description: 'Start every enabled server when the dev-servers service starts.' },
  { id: 'dwFreePort', section: 'devservers', group: 'Starting servers', label: 'Free a port on start', description: 'End a program holding the port if it is not a tool daemon or OS service.' },
  { id: 'dwRestartRunning', section: 'devservers', group: 'Starting servers', label: 'Restart running servers', description: 'Restart servers to apply a changed runtime or new settings.' },
  { id: 'dwMonitor', section: 'devservers', group: 'Monitoring', label: 'Resource monitoring', description: 'Sample CPU and memory of every running server.' },
  { id: 'dwLinkHost', section: 'devservers', group: 'Monitoring', label: 'Link host', description: 'A LAN name or IP to open server links on (blank is localhost).' },
  { id: 'dwAutoScan', section: 'devservers', group: 'Finding projects', label: 'Scan on launch', description: 'Scan for projects each time the dev-servers service starts.' },
  {
    id: 'dwSkip',
    section: 'devservers',
    group: 'Finding projects',
    label: 'Skip operating systems',
    description: 'Do not scan folders that match an OS-specific name.'
  },
  {
    id: 'dwExclude',
    section: 'devservers',
    group: 'Finding projects',
    label: 'Exclude folders',
    description: 'Folder names or absolute paths a scan skips (one per line).'
  },
  { id: 'dwScanNow', section: 'devservers', group: 'Finding projects', label: 'Scan now', description: 'Run a quick or deep scan for projects on this computer.' },
  { id: 'dwIgnored', section: 'devservers', group: 'Finding projects', label: 'Ignored folders', description: 'Folders a scan found that you do not want to add.' },
  { id: 'dwForgetFound', section: 'devservers', group: 'Finding projects', label: 'Forget found projects', description: 'Clear the list of projects a scan found.' },
  { id: 'dwAlerts', section: 'devservers', group: 'Alerts', label: 'Alert rules', description: 'Alert when a server stays over a threshold for a time.' }
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
 * the matching rows of every section under the section's name. A row whose `when` does not hold is
 * left off its page (the email fields while email is off) but still found by a search.
 */
export function settingsGroups(
  section: SettingsSection,
  query: string,
  holds: (c: SettingsCondition) => boolean = () => true
): { heading: string; rows: SettingsRow[] }[] {
  const searching = query.trim() !== ''
  const rows = searching
    ? matchRows(query)
    : SETTINGS_ROWS.filter((r) => r.section === section && (r.when ?? []).every(holds))
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

