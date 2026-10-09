// What Hydra Desk 2 and its copy of AgentHydra's window (hydra/, in a frame at /ah/?embed=desk) say to each
// other, as postMessage on the one origin. Desk owns the sidebar (Michael, 2026-10-04: "the left sidebar
// needs to essentially be the sidebar that exists for everything ... we only have two things, the sidebar
// and the content"): a tab of the copy that had a sidebar of its own (HSwarm's tree, CliMayte and Routing
// among its nodes) describes it as a SidebarModel instead, Desk draws it in its own sidebar in its own
// look, and the clicks come back as DeskMessages. The copy keeps every rule of what a row says; Desk only
// draws.

/** The icons a model may name; Desk maps each to its lucide icon (web/src/components/hydra/HydraSidebar.vue). */
export type EmbedIcon =
  | 'network'
  | 'refresh'
  | 'pip'
  | 'info'
  | 'plus'
  | 'grid'
  | 'piggy-bank'
  | 'server'
  | 'cpu'
  | 'route'
  | 'plug'
  | 'layers'
  | 'cloud'
  | 'cloud-off'
  | 'check'
  | 'retry'
  | 'x'
  | 'alert'
  | 'clock'
  | 'loader'
  | 'hourglass'
  | 'list-checks'
  | 'circle-check'
  | 'circle-x'
  | 'ban'

export type EmbedTone = 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

export interface SidebarRow {
  /** Unique in the model; what a click sends back. */
  key: string
  label: string
  /** Nesting level, 0 at the top. */
  depth?: number
  /** The part of the label a search matched, [start, end). */
  hit?: [number, number]
  /** It has rows under it: open or closed (the chevron toggles it). */
  branch?: 'open' | 'closed'
  /** The leading mark: an icon (spinning while it runs) or a coloured dot ('hollow': a ring). */
  status?: { icon?: EmbedIcon; dot?: EmbedTone | 'hollow'; tone?: EmbedTone; spin?: boolean; pulse?: boolean; label?: string }
  icon?: EmbedIcon
  /** A small picture before the label: an image, else the text on a tile. */
  avatar?: { src?: string; text: string }
  /** A small icon after the label (another PC's task: a cloud). */
  badge?: { icon: EmbedIcon; label: string }
  chip?: { text: string; hint?: string }
  count?: number
  tag?: { text: string; tone?: EmbedTone }
  time?: string
  meta?: string
  /** A trailing mark with its own hover (a verdict). */
  mark?: { icon: EmbedIcon; tone: EmbedTone; label: string; hint?: string }
  /** A trailing toggle (HSwarm's model star): clicking it sends `star`, not `select`. */
  star?: { text: string; on: boolean; label: string; busy?: boolean }
  dim?: boolean
  italic?: boolean
  /** The row's hover, in full. */
  hint?: string
}

export interface SidebarButton {
  id: string
  icon: EmbedIcon
  label: string
  on?: boolean
  spin?: boolean
  disabled?: boolean
}

export interface SidebarModel {
  /** The tab it belongs to; a click on a model from another tab is dropped. */
  view: string
  title: string
  icon?: EmbedIcon
  count?: number
  /** Behind an info mark beside the title. */
  info?: string
  /** Behind a warning mark beside the title. */
  warn?: string
  buttons?: SidebarButton[]
  banner?: { text: string; tone: EmbedTone; icon?: EmbedIcon }
  switches?: { id: string; label: string; note?: string; on: boolean }[]
  search?: { value: string; placeholder: string; label: string }
  legend?: { dot: EmbedTone | 'hollow'; label: string }[]
  legendNote?: string
  /** Groups of rows; a group's label is a small header over them. */
  sections: { key: string; label?: string; hint?: string; rows: SidebarRow[] }[]
  selected?: string | null
  /** Said where the rows would be when there are none. */
  empty?: string
  loading?: boolean
  footer?: SidebarButton[]
}

/** The Settings pages the copy opens Desk's Settings on: Updates, and each Instances table's page. */
export const AH_SETTINGS_PAGES = ['updates', 'cli', 'desktop', 'free'] as const
export type AhSettingsPage = (typeof AH_SETTINGS_PAGES)[number]

/** The copy to Desk. */
export type AhMessage =
  /** The copy is listening (sent on start): Desk sends what it held back. */
  | { type: 'ah:ready' }
  /** Desk opens this session in its own view. */
  | { type: 'ah:open-session'; session_id: string; source?: string }
  /** Desk shows its cloud list, every session of both PCs. */
  | { type: 'ah:show-sessions' }
  /** Desk opens its Settings, which hold AgentHydra's: on Updates, or on a table's page (its gear). */
  | { type: 'ah:open-settings'; section?: AhSettingsPage }
  /** Whether a newer AgentHydra is waiting: a dot on Desk's Settings gear, the copy's own gear being gone. */
  | { type: 'ah:update-dot'; on: boolean }
  /** The current tab's sidebar, or null for a tab without one. */
  | { type: 'ah:sidebar'; model: SidebarModel | null }
  /** The copy's top bar is the window's title bar there: an empty part was pressed (`drag`, the button still down, so
   *  Desk starts the window's move) or pressed a second time (`maximize`, which also restores). */
  | { type: 'ah:window'; action: 'drag' | 'maximize' }

/** Desk to the copy. */
export type DeskMessage =
  | { type: 'desk:sidebar'; view: string; action: 'select' | 'toggle' | 'star'; key: string }
  | { type: 'desk:sidebar'; view: string; action: 'button'; id: string }
  | { type: 'desk:sidebar'; view: string; action: 'switch'; id: string; on: boolean }
  | { type: 'desk:sidebar'; view: string; action: 'search'; value: string }
  /** Show this instance's row in Instances (its desktop or CLI table) and mark it. */
  | { type: 'desk:show-instance'; num: number; kind: 'desktop' | 'cli' | 'free' }
  /** Open this CliMayte task on the CliMayte node of the HSwarm tab; `pc` (that PC's name) for another PC's, whose id may repeat one here. */
  | { type: 'desk:open-worker'; id: string; pc?: string }
  /** Open the HSwarm tab, on that job of its Jobs node when one is named. */
  | { type: 'desk:open-hswarm'; job?: string }
  /** Whether the pane is in view. Out of view the copy's page counts as hidden (document.hidden), so its
   *  polls rest until it slides back in; the frame stays loaded either way. Desk says it when the frame
   *  is ready and each time the pane slides in or out; on true the copy sends its current sidebar again. */
  | { type: 'desk:visible'; visible: boolean }
  /** Desk's Settings saved an AgentHydra setting: the copy reads its settings again (a table shown or
   *  hidden, the keepalive switched). */
  | { type: 'desk:settings-changed' }
