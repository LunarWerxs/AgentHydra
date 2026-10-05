import { describe, it, expect } from 'bun:test'
import type { ChatSummary, ExternalSession } from '@shared/protocol'
import {
  accountFace,
  chatRow,
  elapsedLabel,
  entryRunning,
  externalGlyph,
  externalRename,
  externalRow,
  folderLabel,
  glyphDotClass,
  groupChats,
  groupChoices,
  groupOrderKey,
  moveInOrder,
  deskGlyphs,
  rowDropBefore,
  raiseNewlyOrange,
  recordOrder,
  parseFilter,
  resumeCommand,
  revealChat,
  rowMenu,
  rowPatch,
  runningSessionIds,
  shortcutItem,
  statusGlyph,
  type ChatGroup,
  type RowMenuEntry,
  type RowMenuItem
} from '@/components/sidebar/logic'
import { runShortcut } from '@/components/sidebar/menuClasses'

const ids = (g: ChatGroup | null | undefined) => g?.entries.map((e) => e.id)

function chat(id: string, over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    sessionId: null,
    title: `Chat ${id}`,
    cwd: 'C:/work/alpha',
    account: { id: '1', label: '#1', configDir: null, number: 1 },
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: true,
    status: 'idle',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...over
  }
}

describe('sidebar groups', () => {
  const chats = [
    chat('a1', { updatedAt: 10 }),
    chat('a2', { updatedAt: 30 }),
    chat('b1', { cwd: 'C:\\work\\Beta', updatedAt: 50, title: 'Shader cache' }),
    chat('p', { pinned: true, updatedAt: 5 }),
    chat('z', { archived: true, updatedAt: 99 })
  ]

  it('labels a folder by its basename with the case kept', () => {
    expect(folderLabel('C:\\work\\Beta')).toBe('Beta')
    expect(folderLabel('/home/j/nexuscode-2d/')).toBe('nexuscode-2d')
  })

  it('puts pinned chats in their own group and orders folders and rows newest first', () => {
    const g = groupChats(chats)
    expect(ids(g.pinned)).toEqual(['p'])
    expect(g.folders.map((f) => f.label)).toEqual(['Beta', 'alpha'])
    expect(ids(g.folders[1])).toEqual(['a2', 'a1'])
    expect(g.archived).toBeNull()
  })

  it('hides Pinned when empty; Active (the default) leaves archived chats out', () => {
    expect(groupChats([chat('a')]).pinned).toBeNull()
    const active = groupChats(chats, { filter: 'active' })
    expect(active.folders.flatMap((f) => ids(f))).not.toContain('z')
    expect(active.archived).toBeNull()
  })

  it('Archived lists only the archived chats, by folder, a pinned one included', () => {
    const list = [...chats, chat('zp', { archived: true, pinned: true, cwd: 'C:\\work\\Beta', updatedAt: 70 })]
    const g = groupChats(list, { filter: 'archived', external: [{ id: 'e', title: 'Ext', cwd: 'C:/work/alpha', source: 'desktop', instance: null, status: 'idle', activity: null, lastActivityAt: 1, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null }] })
    expect(g.pinned).toBeNull()
    expect(g.archived).toBeNull()
    expect(g.folders.map((f) => [f.label, ids(f)])).toEqual([
      ['alpha', ['z']],
      ['Beta', ['zp']]
    ])
  })

  it('Archived is empty when nothing is archived', () => {
    const g = groupChats([chat('a'), chat('p', { pinned: true })], { filter: 'archived' })
    expect([g.pinned, g.archived, g.folders]).toEqual([null, null, []])
  })

  it('All shows the active list with an Archived group last', () => {
    const g = groupChats(chats, { filter: 'all' })
    expect(ids(g.pinned)).toEqual(['p'])
    expect(g.folders.map((f) => f.label)).toEqual(['Beta', 'alpha'])
    expect(ids(g.archived)).toEqual(['z'])
  })

  it('unarchiving moves a chat back from Archived to Active', () => {
    const before = [chat('a', { archived: true })]
    const after = [chat('a', { archived: false })]
    expect(groupChats(before).folders).toEqual([])
    expect(ids(groupChats(before, { filter: 'archived' }).folders[0])).toEqual(['a'])
    expect(ids(groupChats(after).folders[0])).toEqual(['a'])
    expect(groupChats(after, { filter: 'archived' }).folders).toEqual([])
  })

  it('search drops rows and the groups left empty, in every filter', () => {
    expect(groupChats(chats, { query: 'shader' }).folders.map((f) => f.label)).toEqual(['Beta'])
    expect(groupChats(chats, { query: 'shader', filter: 'archived' }).folders).toEqual([])
    expect(ids(groupChats(chats, { query: 'chat z', filter: 'all' }).archived)).toEqual(['z'])
  })
})

describe('sessions running elsewhere in the same list', () => {
  function ext(id: string, over: Partial<ExternalSession> = {}): ExternalSession {
    return { id, title: `Ext ${id}`, cwd: 'C:/work/alpha', source: 'desktop', instance: null, status: 'idle', activity: null, lastActivityAt: 20, model: null, accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null, ...over }
  }

  it('merges them into the folder groups by activity, newest first', () => {
    const g = groupChats([chat('a1', { updatedAt: 10 }), chat('a2', { updatedAt: 30 })], { external: [ext('e', { lastActivityAt: 20 })] })
    expect(g.folders[0]!.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['chat:a2', 'external:e', 'chat:a1'])
  })

  it("a folded group's green count is the rows whose turn runs, ours and elsewhere's, never one waiting on you; the cloud list draws every desk row's dot by session", () => {
    const chats = [chat('w', { status: 'working', sessionId: 's-w' }), chat('s', { status: 'starting' }), chat('q', { status: 'needs_you', sessionId: 's-q' }), chat('i')]
    const external = [ext('e-run', { status: 'working' }), ext('e-ask', { status: 'needs_you' }), ext('e-idle')]
    expect(groupChats(chats, { external }).folders[0]!.entries.filter(entryRunning).map((e) => e.id).sort()).toEqual(['e-run', 's', 'w'])
    // The cloud list knows a row by its session: a running chat with none yet has nothing to match.
    expect([...runningSessionIds(chats, external)].sort()).toEqual(['e-run', 's-w'])
    // Its dot is the desk row's: gray blinking while it runs, orange pulsing while it waits on you, a hollow ring when idle.
    expect([...deskGlyphs(chats, [...external, ext('cm', { source: 'climayte' })])].map(([id, g]) => `${id}:${g.shape}:${g.tone}:${g.motion}`).sort()).toEqual([
      'e-ask:dot:warning:pulse',
      'e-idle:ring:muted:none',
      'e-run:dot:muted:blink',
      's-q:dot:warning:pulse',
      's-w:dot:muted:blink'
    ])
  })

  it('a dragged row lands before the row it is dropped on, or after it on its lower half; no change is no drop', () => {
    const keys = ['a', 'b', 'c', 'd']
    expect(rowDropBefore(keys, 'd', 'b', false)).toBe('b')
    expect(rowDropBefore(keys, 'a', 'c', true)).toBe('d')
    expect(rowDropBefore(keys, 'a', 'd', true)).toBeNull()
    expect(rowDropBefore(keys, 'b', 'c', false)).toBeUndefined()
    expect(rowDropBefore(keys, 'b', 'a', true)).toBeUndefined()
    expect(rowDropBefore(keys, 'b', 'b', true)).toBeUndefined()
    expect(rowDropBefore(keys, 'b', 'other', true)).toBeUndefined()
  })

  it('skips CliMayte workers and sessions that already are one of our chats; no cwd goes under No folder', () => {
    const g = groupChats([chat('a', { sessionId: 'same' })], {
      external: [ext('same'), ext('cm', { source: 'climayte' }), ext('loose', { cwd: null, lastActivityAt: 99 })]
    })
    expect(g.folders.map((f) => [f.label, f.cwd, ids(f)])).toEqual([
      ['No folder', null, ['loose']],
      ['alpha', 'C:/work/alpha', ['a']]
    ])
  })

  it('puts two spellings of one folder in one group, labelled as its newest row spells it', () => {
    const g = groupChats([chat('a', { cwd: 'C:\\Work\\Connections', updatedAt: 10 })], {
      external: [ext('e', { cwd: 'c:/work/connections/', lastActivityAt: 20 })]
    })
    expect(g.folders.map((f) => [f.label, ids(f)])).toEqual([['connections', ['e', 'a']]])
  })

  it('shows them under Active and All, never under Archived', () => {
    const external = [ext('run', { status: 'working', lastActivityAt: 30 }), ext('idle')]
    expect(groupChats([], { external, filter: 'active' }).folders.flatMap((f) => ids(f))).toEqual(['run', 'idle'])
    expect(groupChats([], { external, filter: 'all' }).folders.flatMap((f) => ids(f))).toEqual(['run', 'idle'])
    expect(groupChats([], { external, filter: 'archived' }).folders).toEqual([])
  })

  it('draws their dot in the same language, stale dim, marked unread orange', () => {
    expect(externalGlyph({ status: 'working', unread: false })).toMatchObject({ shape: 'dot', motion: 'blink' })
    expect(externalGlyph({ status: 'stale', unread: false })).toMatchObject({ shape: 'ring', dim: true })
    expect(externalGlyph({ status: 'idle', unread: true })).toMatchObject({ shape: 'dot', tone: 'warning', label: 'Unread' })
  })

  it('takes Hydra Desk marks: pinned to Pinned, archived to Archived, a moved-to group', () => {
    const external = [ext('pin', { pinned: true }), ext('arc', { archived: true }), ext('grp', { group: 'Ops', lastActivityAt: 40 }), ext('plain')]
    const g = groupChats([], { external, filter: 'all' })
    expect(ids(g.pinned)).toEqual(['pin'])
    expect(ids(g.archived)).toEqual(['arc'])
    expect(g.folders.map((f) => [f.key, f.label, f.cwd, ids(f)])).toEqual([
      ['group:ops', 'Ops', null, ['grp']],
      ['C:/work/alpha', 'alpha', 'C:/work/alpha', ['plain']]
    ])
    expect(groupChats([], { external, filter: 'archived' }).folders.flatMap((f) => ids(f))).toEqual(['arc'])
  })
})

describe('moved-to groups', () => {
  it('groups a chat by its group when set, else by its folder; Pinned stays its own', () => {
    const g = groupChats([
      chat('a', { updatedAt: 10 }),
      chat('m', { group: 'Launch', updatedAt: 20 }),
      chat('n', { group: 'launch', cwd: 'C:/work/other', updatedAt: 5 }),
      chat('p', { group: 'Launch', pinned: true, updatedAt: 30 })
    ])
    expect(ids(g.pinned)).toEqual(['p'])
    expect(g.folders.map((f) => [f.label, f.cwd, ids(f)])).toEqual([
      ['Launch', null, ['m', 'n']],
      ['alpha', 'C:/work/alpha', ['a']]
    ])
  })

  it('a group named like a folder group joins it, keeping the folder as its path', () => {
    const g = groupChats([chat('a', { cwd: 'C:/work/Beta', updatedAt: 10 }), chat('m', { group: 'beta', updatedAt: 20 })])
    expect(g.folders.map((f) => [f.label, f.cwd, ids(f)])).toEqual([['Beta', 'C:/work/Beta', ['m', 'a']]])
  })

  it('lists every group once, folders and moved-to ones, A-Z, CliMayte workers left out', () => {
    const chats = [chat('a'), chat('b', { cwd: 'C:/work/Beta', group: 'Launch' }), chat('c', { cwd: 'c:/work/alpha' })]
    const external = [{ cwd: 'C:/x/Gamma', group: null, source: 'desktop' as const }, { cwd: 'C:/x/Worker', group: null, source: 'climayte' as const }]
    expect(groupChoices(chats, external)).toEqual(['alpha', 'Beta', 'Gamma', 'Launch'])
  })
})

describe('status glyph language', () => {
  it('idle is a ring, running a blinking dot', () => {
    expect(statusGlyph({ status: 'idle', unread: false })).toMatchObject({ shape: 'ring', tone: 'muted', motion: 'none' })
    expect(statusGlyph({ status: 'working', unread: false })).toMatchObject({ shape: 'dot', tone: 'muted', motion: 'blink' })
  })

  it('a finished turn unread is a solid green dot; a question is orange and pulsing', () => {
    expect(statusGlyph({ status: 'idle', unread: true })).toMatchObject({ shape: 'dot', tone: 'success', motion: 'none', label: 'Done, unread' })
    expect(statusGlyph({ status: 'stopped', unread: true })).toMatchObject({ shape: 'dot', tone: 'success' })
    expect(statusGlyph({ status: 'closed', unread: true })).toMatchObject({ shape: 'dot', tone: 'success', dim: true })
    expect(statusGlyph({ status: 'needs_you', unread: true })).toMatchObject({ shape: 'dot', tone: 'warning', motion: 'pulse' })
  })

  it('a replied chat whose background tasks still run stays orange, read or not', () => {
    for (const status of ['idle', 'stopped', 'closed'] as const)
      expect(statusGlyph({ status, unread: false, climayteActive: 2 })).toMatchObject({ shape: 'dot', tone: 'warning', label: 'Replied, background tasks running' })
    expect(statusGlyph({ status: 'idle', unread: true, climayteActive: 1 })).toMatchObject({ tone: 'warning' })
  })

  it("a replied chat whose own background commands still run stays orange, with no CliMayte worker", () => {
    // The NexusCode chat, 2026-10-04: read, deploy still building, a gray ring.
    expect(statusGlyph({ status: 'idle', unread: false, climayteActive: 0, backgroundActive: 2 })).toMatchObject({ shape: 'dot', tone: 'warning' })
  })

  it('once read, a finished chat is the calm idle ring again', () => {
    expect(statusGlyph({ status: 'idle', unread: false })).toMatchObject({ shape: 'ring', tone: 'muted' })
    expect(statusGlyph({ status: 'closed', unread: false })).toMatchObject({ shape: 'ring', dim: true })
  })

  it('a usage limit is its own pink ring, unread or not; error stays red', () => {
    for (const unread of [true, false]) expect(statusGlyph({ status: 'limited', unread })).toMatchObject({ shape: 'ring', tone: 'limited' })
    expect(statusGlyph({ status: 'error', unread: true })).toMatchObject({ shape: 'dot', tone: 'danger' })
  })

  it('draws each glyph with its own token', () => {
    expect(glyphDotClass(statusGlyph({ status: 'idle', unread: true }))).toBe('bg-[var(--status-done)]')
    expect(glyphDotClass(statusGlyph({ status: 'idle', unread: false, climayteActive: 1 }))).toBe('bg-[var(--status-needs-you)]')
    expect(glyphDotClass(statusGlyph({ status: 'needs_you', unread: true }))).toBe('bg-[var(--status-needs-you)] animate-dot-pulse')
    expect(glyphDotClass(statusGlyph({ status: 'working', unread: false }))).toBe('bg-[var(--status-working)] animate-dot-blink')
    expect(glyphDotClass(statusGlyph({ status: 'limited', unread: true }))).toBe('border-[1.5px] border-[var(--status-limited)]')
    expect(glyphDotClass(statusGlyph({ status: 'error', unread: true }))).toBe('bg-[var(--status-error)]')
  })

  it('formats elapsed time short', () => {
    expect(elapsedLabel(1000, 13_000)).toBe('12s')
    expect(elapsedLabel(0, 4 * 60_000 + 5000)).toBe('4m')
    expect(elapsedLabel(0, 65 * 60_000)).toBe('1h 5m')
    expect(elapsedLabel(null)).toBe('')
  })
})

describe('row menu', () => {
  const show = (entries: RowMenuEntry[]) =>
    entries.map((e) => (e === 'separator' ? '-' : 'items' in e ? `${e.label} >` : `${e.label}${e.shortcut ? ` ${e.shortcut}` : ''}${e.disabled ? ' (off)' : ''}`))
  const sub = (entries: RowMenuEntry[], label: string) => {
    const found = entries.find((e): e is Extract<RowMenuEntry, { items: unknown }> => e !== 'separator' && 'items' in e && e.label === label)!
    return found.items.map((e) => (e === 'separator' ? '-' : `${e.label}${e.checked ? ' *' : ''}${e.disabled ? ' (off)' : ''}`))
  }
  const ext = (over: Partial<ExternalSession> = {}): ExternalSession => ({
    id: 'sess-1',
    title: 'Outside',
    cwd: 'C:/work/alpha',
    source: 'desktop',
    instance: null,
    status: 'idle',
    activity: null,
    lastActivityAt: 1,
    model: null,
    accountId: null,
    canResume: true,
    fromPc: null,
    pinned: false,
    archived: false,
    unread: false,
    group: null,
    ...over
  })

  it('is the real menu for an idle chat: Open in, Pin, Mark as unread, Rename, Fork, Move to group, Archive, Delete', () => {
    expect(show(rowMenu(chatRow(chat('a', { sessionId: 's1' }))))).toEqual([
      'Open in >',
      '-',
      'Pin P',
      'Mark as unread U',
      'Rename R',
      'Fork F',
      '-',
      'Move to group >',
      '-',
      'Archive A',
      'Delete D'
    ])
    expect(sub(rowMenu(chatRow(chat('a', { sessionId: 's1' }))), 'Open in')).toEqual(['File Explorer', 'Copy resume command', 'Copy session ID'])
  })

  it('follows the state: Stop above Pin while working, Unpin, Mark as read, Unarchive', () => {
    expect(show(rowMenu(chatRow(chat('a', { sessionId: 's1', status: 'working', pinned: true, unread: true, archived: true }))))).toEqual([
      'Open in >',
      '-',
      'Stop',
      'Unpin P',
      'Mark as read U',
      'Rename R',
      'Fork F',
      '-',
      'Move to group >',
      '-',
      'Unarchive A',
      'Delete D'
    ])
  })

  it('a chat with no session yet cannot be forked or copied; a fork not started yet can be forked again', () => {
    const fresh = rowMenu(chatRow(chat('a')))
    expect(show(fresh)).toContain('Fork F (off)')
    expect(sub(fresh, 'Open in')).toEqual(['File Explorer', 'Copy resume command (off)', 'Copy session ID (off)'])
    expect(show(rowMenu(chatRow(chat('f', { forkedFrom: 's1' }))))).toContain('Fork F')
  })

  it('an outside session has the same menu without Delete, and Archive says why', () => {
    const entries = rowMenu(externalRow(ext()))
    expect(show(entries)).toEqual(['Open in >', '-', 'Pin P', 'Mark as unread U', 'Rename R', 'Fork F', '-', 'Move to group >', '-', 'Archive A'])
    const archive = entries.find((e) => e !== 'separator' && !('items' in e) && e.action === 'archive') as RowMenuItem
    expect(archive.title).toMatch(/never deleted here/)
    expect(sub(entries, 'Open in')).toEqual(['File Explorer', 'Copy resume command', 'Copy session ID'])
    // a Codex session has no claude --resume and no fork
    const codex = rowMenu(externalRow(ext({ source: 'codex', cwd: null })))
    expect(show(codex)).toContain('Fork F (off)')
    expect(sub(codex, 'Open in')).toEqual(['File Explorer (off)', 'Copy resume command (off)', 'Copy session ID'])
  })

  it('Move to group lists every group with a check on the current one, then New group and Remove from group', () => {
    const groups = ['alpha', 'Beta', 'Launch']
    expect(sub(rowMenu(chatRow(chat('a')), groups), 'Move to group')).toEqual(['alpha *', 'Beta', 'Launch', '-', 'New group…'])
    expect(sub(rowMenu(chatRow(chat('a', { group: 'launch' })), groups), 'Move to group')).toEqual(['alpha', 'Beta', 'Launch *', '-', 'New group…', 'Remove from group'])
    expect(sub(rowMenu(chatRow(chat('a'))), 'Move to group')).toEqual(['New group…'])
  })

  it('letter keys run their item while the menu is open; disabled and unknown keys run nothing', () => {
    const entries = rowMenu(chatRow(chat('a', { sessionId: 's1' })))
    const action = (key: string) => shortcutItem(entries, key)?.action ?? null
    expect(['p', 'U', 'r', 'f', 'a', 'd'].map(action)).toEqual(['pin', 'markUnread', 'rename', 'fork', 'archive', 'delete'])
    expect(action('x')).toBeNull()
    expect(action('Enter')).toBeNull()
    expect(shortcutItem(rowMenu(chatRow(chat('a'))), 'f')).toBeNull()
    expect(shortcutItem(rowMenu(chatRow(chat('a', { pinned: true, unread: true, archived: true }))), 'p')?.action).toBe('unpin')
    expect(shortcutItem(rowMenu(externalRow(ext())), 'd')).toBeNull()
  })

  it('maps an item to its patch; moving to the row own folder group is back to the folder', () => {
    const row = chatRow(chat('a'))
    const item = (action: RowMenuItem['action'], label = '') => ({ action, label })
    expect(rowPatch(item('pin'), row)).toEqual({ pinned: true })
    expect(rowPatch(item('unarchive'), row)).toEqual({ archived: false })
    expect(rowPatch(item('markUnread'), row)).toEqual({ unread: true })
    expect(rowPatch(item('markRead'), row)).toEqual({ unread: false })
    expect(rowPatch(item('moveTo', 'Launch'), row)).toEqual({ group: 'Launch' })
    expect(rowPatch(item('moveTo', 'ALPHA'), row)).toEqual({ group: null })
    expect(rowPatch(item('removeFromGroup'), row)).toEqual({ group: null })
    expect(rowPatch(item('delete'), row)).toBeNull()
    expect(resumeCommand('abc-123')).toBe('claude --resume abc-123')
  })
})

describe('row menu letter keys', () => {
  // A stand-in DOM: closest() walks up the parents, as the real one does for these two selectors.
  type Node = { role?: string; tag?: string; parent?: Node; closest(selector: string): Node | null }
  function node(over: { role?: string; tag?: string }, parent?: Node): Node {
    const n: Node = {
      ...over,
      parent,
      closest(selector) {
        for (let at: Node | undefined = n; at; at = at.parent) if (selector.includes('role') ? at.role === 'menu' : at.tag === 'input') return at
        return null
      }
    }
    return n
  }
  const entries = rowMenu(chatRow(chat('a', { sessionId: 's1' })))

  function press(key: string, target: Node, opts: { ctrlKey?: boolean } = {}) {
    const clicked: string[] = []
    const root = Object.assign(menu, { querySelector: (selector: string) => ({ click: () => clicked.push(selector) }) })
    let stopped = false
    const e = { key, ctrlKey: false, metaKey: false, altKey: false, ...opts, target, currentTarget: root, preventDefault() {}, stopPropagation: () => (stopped = true) }
    runShortcut(e as unknown as KeyboardEvent, entries)
    return { clicked, stopped }
  }
  const menu = node({ role: 'menu' })
  const item = node({}, menu)
  const subItem = node({}, node({ role: 'menu' }, menu))
  const field = node({ tag: 'input' }, menu)

  it('a letter typed in the menu runs its item', () => {
    expect(press('a', item)).toEqual({ clicked: ['[data-shortcut="A"]'], stopped: true })
    expect(press('P', menu).clicked).toEqual(['[data-shortcut="P"]'])
  })

  it('a letter typed in a submenu (Move to group, Account) or a text field is left to them', () => {
    expect(press('a', subItem)).toEqual({ clicked: [], stopped: false })
    expect(press('a', field)).toEqual({ clicked: [], stopped: false })
    expect(press('a', item, { ctrlKey: true }).clicked).toEqual([])
  })
})

describe('remembered filter, hidden chats, outside renames', () => {
  it('reads a stored filter back, anything unknown as Active', () => {
    expect(['active', 'archived', 'all'].map(parseFilter)).toEqual(['active', 'archived', 'all'])
    expect([null, undefined, '', 'Archived', 'toString', '"all"'].map(parseFilter)).toEqual(['active', 'active', 'active', 'active', 'active', 'active'])
  })

  it('a chat the filter or the search hides comes back with the list that shows it', () => {
    const fresh = chat('n', { updatedAt: 100, title: 'New one' })
    const chats = [chat('z', { archived: true }), fresh]
    const shown = revealChat(fresh, 'archived')
    expect(shown).toEqual({ query: '', filter: 'active' })
    expect(groupChats(chats, { query: 'shader', filter: 'archived' }).folders).toEqual([])
    expect(ids(groupChats(chats, shown).folders[0])).toEqual(['n'])
    expect(revealChat(fresh, 'all')).toEqual({ query: '', filter: 'all' })
    expect(revealChat(chat('z', { archived: true }), 'active')).toEqual({ query: '', filter: 'all' })
  })

  it('renaming an outside session: an emptied field is its own name again, an unchanged one sends nothing', () => {
    expect(externalRename('  Ops board ', 'Outside')).toBe('Ops board')
    expect(externalRename('Outside', 'Outside')).toBeUndefined()
    expect(externalRename('   ', 'Renamed here')).toBeNull()
  })
})

describe('footer account', () => {
  const accounts = [{ id: '68', label: '#68 eek someone@example.com (Max 20x)', plan: 'Max 20x' }]
  it('shows the short name and the plan family, never the email', () => {
    expect(accountFace('68', accounts)).toEqual({ initial: 'E', name: 'eek', plan: 'Max' })
  })
  it('falls back to Auto with the account count', () => {
    expect(accountFace('auto', accounts)).toEqual({ initial: 'A', name: 'Auto', plan: '1 accounts' })
  })
})

describe('sidebar order', () => {
  // Jacob, 2026-10-04: sending into Connections shot it to the top; groups and rows keep their place.
  it('a message sent later moves neither its group nor its row; a new group joins at the top; a drag reorders', () => {
    const before = [chat('a1', { cwd: 'C:/work/alpha', updatedAt: 30 }), chat('a2', { cwd: 'C:/work/alpha', updatedAt: 20 }), chat('c1', { cwd: 'C:/work/conn', updatedAt: 10 })]
    const first = groupChats(before, { order: { groups: [], rows: [] } })
    let order = {
      groups: recordOrder([], first.folders.map(groupOrderKey), 'top'),
      rows: recordOrder([], first.folders.flatMap((f) => f.entries.map((e) => e.id)), 'top'),
    }
    expect(first.folders.map((f) => f.label)).toEqual(['alpha', 'conn'])

    const sent = [chat('a1', { cwd: 'C:/work/alpha', updatedAt: 30 }), chat('a2', { cwd: 'C:/work/alpha', updatedAt: 99 }), chat('c1', { cwd: 'C:/work/conn', updatedAt: 100 })]
    const after = groupChats(sent, { order })
    expect(after.folders.map((f) => f.label)).toEqual(['alpha', 'conn'])
    expect(ids(after.folders[0])).toEqual(['a1', 'a2'])
    // without a saved order it is still by activity
    expect(groupChats(sent).folders.map((f) => f.label)).toEqual(['conn', 'alpha'])

    const added = groupChats([...sent, chat('n1', { cwd: 'C:/work/new', updatedAt: 1 })], { order })
    expect(added.folders.map((f) => f.label)).toEqual(['new', 'alpha', 'conn'])

    order = { ...order, groups: moveInOrder(order.groups, 'c:/work/conn', 'c:/work/alpha') }
    expect(groupChats(sent, { order }).folders.map((f) => f.label)).toEqual(['conn', 'alpha'])
  })

  // Owner, 2026-10-04: the desk list and the cloud list share one order, so one recording what it shows
  // must not push the rows only the other shows to the end (they drifted with every toggle).
  it('recording what a list shows never moves a saved key: the desk adds its new ones at the top, the cloud its own at the end', () => {
    const saved = ['desk-a', 'cloud-x', 'desk-b', 'cloud-y']
    expect(recordOrder(saved, ['desk-b', 'desk-a'], 'top')).toEqual(saved)
    expect(recordOrder(saved, ['desk-n', 'desk-b', 'desk-m'], 'top')).toEqual(['desk-n', 'desk-m', ...saved])
    expect(recordOrder(saved, ['cloud-y', 'cloud-z', 'cloud-z'], 'end')).toEqual([...saved, 'cloud-z'])
  })
})

describe('a chat that turns orange', () => {
  it('goes to the top of its group, the latest finish first; finishing again unread does not move it', () => {
    const working = (id: string) => chat(id, { status: 'working', unread: false })
    const done = (id: string) => chat(id, { status: 'idle', unread: true })
    const rows = ['a', 'b', 'c']
    const was = new Map([['a', false], ['b', false], ['c', false]])
    const entries = (list: ReturnType<typeof chat>[]) => groupChats(list).folders[0]!.entries

    const afterC = raiseNewlyOrange(rows, entries([working('a'), working('b'), done('c')]), was)
    expect(afterC).toEqual(['c', 'a', 'b'])
    was.set('c', true)
    const afterB = raiseNewlyOrange(afterC, entries([working('a'), done('b'), done('c')]), was)
    expect(afterB).toEqual(['b', 'c', 'a'])
    was.set('b', true)
    // nothing new turned orange: nothing moves
    expect(raiseNewlyOrange(afterB, entries([working('a'), done('b'), done('c')]), was)).toEqual(['b', 'c', 'a'])
  })
})
