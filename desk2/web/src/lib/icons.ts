/**
 * The real Claude Desktop draws its icons from the proprietary Anthropicons font. This is the map from
 * each real control to the closest @lucide/vue icon (docs/reference/real/tokens.json `icons.map`).
 * Sizes are measured: 16px in chrome, rows and menus, 12px chevrons, 20px toolbar buttons.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Briefcase,
  Check,
  Star,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock,
  CodeXml,
  Copy,
  CornerDownLeft,
  Ellipsis,
  Folder,
  FolderPlus,
  GitBranch,
  GitCompare,
  GitFork,
  Gauge,
  GitPullRequest,
  Globe,
  Laptop,
  Menu,
  MessageSquareWarning,
  MessagesSquare,
  Mic,
  PanelLeft,
  PanelRight,
  Paperclip,
  Plug,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  Shapes,
  SlidersHorizontal,
  Square,
  SquareSlash,
  Undo2,
  Volume2,
  X,
  Zap
} from '@lucide/vue'

export const ICON_SIZE = { chrome: 16, row: 16, menu: 16, chevron: 12, toolbar: 20 } as const

/** Stroke width Hydra Desk draws every lucide icon with (set globally in style.css). */
export const ICON_STROKE = 1.5

export const icons = {
  // Window chrome
  menu: Menu,
  sidebarToggle: PanelLeft,
  back: ArrowLeft,
  forward: ArrowRight,
  modeChat: MessagesSquare,
  modeCode: CodeXml,
  // Sidebar
  new: Plus,
  projects: Folder,
  artifacts: Shapes,
  customize: Briefcase,
  more: ChevronDown,
  groupChevron: ChevronRight,
  newSessionInFolder: Plus,
  search: Search,
  filter: SlidersHorizontal,
  moreOptions: Ellipsis,
  newFromTemplate: Plus,
  routines: Clock,
  sendFeedback: MessageSquareWarning,
  // Title bar, right side
  changes: GitCompare,
  browser: Globe,
  viewOptions: PanelRight,
  // Transcript
  copy: Copy,
  rewind: Undo2,
  fork: GitFork,
  chapter: Bookmark,
  readAloud: Volume2,
  statusChevron: ChevronRight, // rotates to point down when open
  scrollToBottom: ArrowDown,
  // Composer
  add: Plus,
  record: Mic,
  dictationSettings: ChevronDown,
  send: CornerDownLeft,
  dismiss: X,
  morePrOptions: ChevronDown,
  aboutEffort: CircleHelp,
  // The send queue (Hydra Desk's own; the real app has no such controls)
  queueOptions: ChevronUp,
  queueEdit: Pencil,
  queueMoveUp: ArrowUp,
  queueMoveDown: ArrowDown,
  queueRetry: RotateCw,
  // Menus
  check: Check,
  star: Star,
  submenu: ChevronRight,
  addFiles: Paperclip,
  addFolder: FolderPlus,
  slashCommands: SquareSlash,
  connectors: Plug,
  addPlugins: Puzzle,
  // New session pills
  local: Laptop,
  folder: Folder,
  branch: GitBranch,
  addAnotherFolder: FolderPlus,
  // Not in the measured map (the real glyphs were not seen): closest lucide picks.
  stop: Square,
  effort: Gauge,
  fastMode: Zap,
  pullRequest: GitPullRequest
} as const

export type IconName = keyof typeof icons

// Shell (sidebar, chrome, title bar)
import { Archive, Bot, CircleDot, EllipsisVertical, MonitorSmartphone, Pencil, Pin, Settings, Terminal, Trash2 } from '@lucide/vue'

/** Hydra Desk's own shell controls, plus two title-bar glyphs the real app draws without a box. */
export const shellIcons = {
  climayte: Bot,
  elsewhere: MonitorSmartphone,
  settings: Settings,
  archive: Archive,
  pin: Pin,
  rename: Pencil,
  trash: Trash2,
  markUnread: CircleDot,
  terminalPlain: Terminal, // the real Terminal button is a bare ">_"
  viewOptionsDots: EllipsisVertical // the real View options button is three vertical dots
} as const

// Composer plus menu (docs/reference/real/menu-plus.png, zoomed): plain folder, blocks.
import { Blocks, Folder as ComposerFolder } from '@lucide/vue'

export const composerIcons = {
  addFolder: ComposerFolder,
  connectors: Blocks
} as const

// Sidebar and chrome bar: real glyphs lucide has no match for (docs/reference/real/sidebar.png, zoomed),
// drawn on lucide's 24 grid and stroke so they sit with the rest.
import { h, type FunctionalComponent } from 'vue'
import { BriefcaseBusiness } from '@lucide/vue'

type Shape = [tag: 'path' | 'circle', attrs: Record<string, string | number>]
function glyph(shapes: Shape[]): FunctionalComponent {
  return () =>
    h(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width: 24,
        height: 24,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true'
      },
      shapes.map(([tag, attrs]) => h(tag, attrs))
    )
}

export const sidebarIcons = {
  menu: glyph([['path', { d: 'M3 6h18' }], ['path', { d: 'M3 12h18' }], ['path', { d: 'M3 18h9' }]]),
  projects: glyph([['path', { d: 'M6 4h12' }], ['path', { d: 'M3 8h18v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z' }]]),
  customize: BriefcaseBusiness,
  viewOptions: glyph([
    ['path', { d: 'M8 3v3' }],
    ['path', { d: 'M8 12v9' }],
    ['circle', { cx: 8, cy: 9, r: 3 }],
    ['path', { d: 'M16 3v9' }],
    ['path', { d: 'M16 18v3' }],
    ['circle', { cx: 16, cy: 15, r: 3 }]
  ]),
  footer: Settings // the real settings gear (Jacob, 2026-10-04): eight teeth, a circle inside
} as const

// The chrome bar's AgentHydra button, in place of the colour logo (Michael, 2026-10-04: "a fun, like,
// outline-y version like the other ones"): the logo's big head with its open jaw and eye, and a smaller
// head facing back off its neck, on the grid and stroke of the Cloud and Bot beside it.
export const agentHydraIcon = glyph([
  ['path', { d: 'M11 11c0-4 3-7 7-7h3.5l-2.5 2.5' }],
  ['path', { d: 'M16 9.5h4.5' }],
  ['path', { d: 'M17.5 6.5h.01' }],
  ['path', { d: 'M11 11c0 3 4 4.5 4 7.5a2.5 2.5 0 0 1-5 0' }],
  ['path', { d: 'M11.5 13.5C8 13.5 6.5 12 6.5 10c0-2-1.5-3.5-3.5-3.5H2l1.5 1.5' }],
  ['path', { d: 'M5 10H2.5' }]
])

// Settings dialog nav, as the real Settings nav draws them: 16px outline glyphs.
import { Activity, BellRing, CloudDownload, Info, Monitor, Server } from '@lucide/vue'

export const settingsIcons = {
  general: Settings,
  alerts: BellRing,
  climayte: Bot,
  connections: Plug,
  connectors: Blocks,
  devservers: Server,
  diagnostics: Activity,
  updates: CloudDownload,
  about: Info,
  // Instances: the AgentHydra pane's three tables, with the icons of their tabs.
  cli: Terminal,
  desktop: Monitor,
  free: MessagesSquare,
  search: Search
} as const

// Shell, header and sidebar: the real app draws these from an icon font as 1px hairlines on a 16 grid.
// Coordinates are read off docs/reference/real/{sidebar,top-bar-header}.png pixel by pixel.
function hairline(shapes: Shape[], strokeWidth = 1): FunctionalComponent {
  return () =>
    h(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': strokeWidth,
        'stroke-linecap': 'butt',
        'stroke-linejoin': 'miter',
        'aria-hidden': 'true'
      },
      shapes.map(([tag, attrs]) => h(tag, attrs))
    )
}

export const shellGlyphs = {
  menu: hairline([['path', { d: 'M1.5 3.5H14.5M1.5 8H14.5M1.5 12.5H8.5' }]]),
  sidebarToggle: hairline([['path', { d: 'M2.5 2.5H13.5V13.5H2.5ZM6.5 2.5V13.5' }]]),
  // The chrome bar's Clean sidebar button: rows of a dot and a title, nothing after them.
  cleanSidebar: hairline([
    ['circle', { cx: 2.75, cy: 4, r: 0.75 }],
    ['circle', { cx: 2.75, cy: 8, r: 0.75 }],
    ['circle', { cx: 2.75, cy: 12, r: 0.75 }],
    ['path', { d: 'M5.5 4H13.5M5.5 8H11.5M5.5 12H12.5' }]
  ]),
  modeChat: hairline([
    ['path', { d: 'M2.5 10.5H6A3.5 3.5 0 1 0 2.5 7Z' }],
    ['path', { d: 'M11 6.7A3.5 3.5 0 0 1 13.5 10V13.5H10A3.5 3.5 0 0 1 7.6 12.5' }]
  ]),
  modeCode: hairline([['path', { d: 'M5 4.2L1.6 8L5 11.8M11 4.2L14.4 8L11 11.8M8.6 3L7 13' }]], 1.4),
  newPlus: hairline([['path', { d: 'M8 4V12.5M3.5 8.5H12.5' }]]),
  projects: hairline([['path', { d: 'M4 2.5H12M2.5 5.5H13.5V10.5A2 2 0 0 1 11.5 12.5H4.5A2 2 0 0 1 2.5 10.5Z' }]]),
  artifacts: hairline([
    ['path', { d: 'M11.46 6.5A3.5 3.5 0 1 0 9.5 9.16' }],
    ['circle', { cx: 4.5, cy: 10.5, r: 2 }],
    ['path', { d: 'M9.5 6.5H13.5V12.5H9.5Z' }]
  ]),
  customize: hairline([['path', { d: 'M5.5 5.5V3.5H10.5V5.5M2.5 5.5H13.5V12.5H2.5ZM2.5 8.5H13.5' }]]),
  more: hairline([['path', { d: 'M3.5 5.5L8 10L12.5 5.5' }]], 1.1),
  groupNew: hairline([['path', { d: 'M8 3V13M2.5 8H13.5' }]]),
  search: hairline([
    ['circle', { cx: 7, cy: 7, r: 4.5 }],
    ['path', { d: 'M10.2 10.2L13.6 13.6' }]
  ]),
  viewOptions: hairline([
    ['path', { d: 'M4.5 2V4.5M4.5 8.5V14M11.5 2V8.5M11.5 12.5V14' }],
    ['circle', { cx: 4.5, cy: 6.5, r: 2 }],
    ['circle', { cx: 11.5, cy: 10.5, r: 2 }]
  ]),
  local: hairline([['path', { d: 'M3 10V3H13V10M1.5 10H14.5V12A1 1 0 0 1 13.5 13H2.5A1 1 0 0 1 1.5 12Z' }]]),
  terminal: hairline([['path', { d: 'M2.5 3.5L6.5 8L2.5 12.5M7.2 12H14.5' }]]),
  changes: hairline([['path', { d: 'M4 3H12A1 1 0 0 1 13 4V12A1 1 0 0 1 12 13H4A1 1 0 0 1 3 12V4A1 1 0 0 1 4 3ZM8 4.2V9.2M5.5 6.7H10.5M5.5 10.7H10.5' }]]),
  browser: hairline([
    ['circle', { cx: 8, cy: 8, r: 6 }],
    ['path', { d: 'M8 2A2.6 6 0 0 1 8 14A2.6 6 0 0 1 8 2Z' }],
    ['path', { d: 'M2 8H14' }]
  ]),
  groupChevron: hairline([['path', { d: 'M6 3.5L10.5 8L6 12.5' }]], 1.1),
  rowMore: hairline([
    ['circle', { cx: 3, cy: 8, r: 1.15, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 8, cy: 8, r: 1.15, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 13, cy: 8, r: 1.15, fill: 'currentColor', stroke: 'none' }]
  ]),
  viewOptionsDots: hairline([
    ['circle', { cx: 8, cy: 3, r: 1.25, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 8, cy: 8, r: 1.25, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 8, cy: 13, r: 1.25, fill: 'currentColor', stroke: 'none' }]
  ])
} as const

// New-session screen: the env pills and the tip banner, read off new-session-tip-and-composer.png.
export const newSessionGlyphs = {
  folder: hairline([['path', { d: 'M3 12.5V2.5H7.2L8.2 4.5H13V12.5Z' }]], 1.2),
  branch: hairline([
    ['circle', { cx: 4, cy: 4, r: 1.7 }],
    ['circle', { cx: 12, cy: 4, r: 1.7 }],
    ['circle', { cx: 4, cy: 12, r: 1.7 }],
    ['path', { d: 'M4 5.7V10.3M12 5.7V6.2A1.5 1.5 0 0 1 10.5 7.7H4' }]
  ], 1.2),
  addFolder: hairline([['path', { d: 'M2.5 12.5V2.5H6.8L7.8 4.5H13.5V12.5ZM8 6.3V10.7M5.8 8.5H10.2' }]], 1.2),
  tip: hairline([
    ['path', { d: 'M6.6 10.6C5.4 9.9 4.6 8.7 4.6 7.2A3.4 3.4 0 0 1 11.4 7.2C11.4 8.7 10.6 9.9 9.4 10.6V11.6H6.6Z' }],
    ['path', { d: 'M6.6 13H9.4' }]
  ], 1.1),
  dismiss: hairline([['path', { d: 'M4 4L12 12M12 4L4 12' }]], 1.1)
} as const
