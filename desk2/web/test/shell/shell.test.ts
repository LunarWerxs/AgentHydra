import { describe, it, expect } from 'bun:test'
import type { AccountInfo, ChatSummary } from '@shared/protocol'
import { CHAT_DEFAULT, CHAT_KEY, CHAT_MIN, NavHistory, SIDE_MIN, computeStats, loadChatWidth, matchShortcut, modelName, splitChat, splitColumns } from '@/components/shell/logic'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTO_LABEL, accountRows, chooseAccount, headroom, rowTip } from '@/components/accounts/rows'
import { pctText, usageTone } from '@/components/accounts/format'

function chat(id: string, over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    sessionId: null,
    title: id,
    cwd: 'C:/work/alpha',
    account: { id: '68', label: '#68 eek', configDir: null, number: 68 },
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

function account(id: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    label: `#${id} sue someone@example.com (Max 5x)`,
    configDir: null,
    number: Number(id),
    email: 'someone@example.com',
    plan: 'Max 5x',
    signedIn: true,
    fiveHourPct: 10,
    weeklyPct: 20,
    fiveHourResetsAt: null,
    weeklyResetsAt: null,
    inUse: false,
    ...over
  }
}

describe('back and forward', () => {
  it('walks the visited views and drops the forward list on a new visit', () => {
    const h = new NavHistory()
    h.visit({ kind: 'new' })
    h.visit({ kind: 'chat', id: 'a' })
    h.visit({ kind: 'chat', id: 'a' }) // same view again: no new entry
    h.visit({ kind: 'settings' })
    expect(h.back()).toEqual({ kind: 'chat', id: 'a' })
    expect(h.back()).toEqual({ kind: 'new' })
    expect(h.canBack).toBe(false)
    h.visit({ kind: 'external', id: 'x' })
    expect(h.canForward).toBe(false)
  })

  it('forgets a deleted chat', () => {
    const h = new NavHistory()
    h.visit({ kind: 'new' })
    h.visit({ kind: 'chat', id: 'gone' })
    h.visit({ kind: 'settings' })
    h.forget('gone')
    expect(h.back()).toEqual({ kind: 'new' })
  })
})

describe('shortcuts', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
  it('maps Ctrl+N, Ctrl+B, Ctrl+K and Alt+arrows', () => {
    expect(matchShortcut(key('n', { ctrlKey: true }))).toBe('new')
    expect(matchShortcut(key('B', { ctrlKey: true }))).toBe('toggleSidebar')
    expect(matchShortcut(key('k', { metaKey: true }))).toBe('search')
    expect(matchShortcut(key('ArrowLeft', { altKey: true }))).toBe('back')
    expect(matchShortcut(key('n', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(matchShortcut(key('n'))).toBeNull()
  })
})

describe('new-session stats', () => {
  it('names models short and counts sessions, folders and cost in range', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName(null)).toBe('Default')
    const now = Date.UTC(2026, 9, 4, 12)
    const day = 86_400_000
    const s = computeStats(
      [
        chat('a', { updatedAt: now - day, createdAt: now - day, costUsd: 1.5, model: 'claude-opus-5-5' }),
        chat('b', { updatedAt: now - 40 * day, createdAt: now - 40 * day, cwd: 'C:/work/beta', costUsd: 2 })
      ],
      '30d',
      now
    )
    expect([s.sessions, s.folders, s.totalCost, s.favoriteModel]).toEqual([1, 1, '$1.50', 'Opus 5.5'])
  })
})

describe('account popup', () => {
  const accounts = [account('35', { inUse: true }), account('7', { signedIn: false })]
  const chats = [chat('x', { account: { id: '35', label: '#35', configDir: null } }), chat('y', { account: { id: '35', label: '#35', configDir: null }, status: 'closed' })]

  it('lists Auto first, then each account with its live chats; signed-out rows are disabled', () => {
    const rows = accountRows(accounts, chats, 'auto')
    expect(rows.map((r) => [r.label, r.checked, r.disabled, r.liveChats])).toEqual([
      [AUTO_LABEL, true, false, 0],
      ['#35 sue', false, false, 1],
      ['#7 sue', false, true, 0]
    ])
    expect(rows[1]!.inUse).toBe(true)
  })

  it('checks the saved default, and falls back to Auto when that account is gone', () => {
    expect(accountRows(accounts, [], '35').find((r) => r.checked)?.id).toBe('35')
    expect(accountRows(accounts, [], '99').find((r) => r.checked)?.id).toBe('auto')
  })

  it('choosing an account saves defaultAccountId', async () => {
    const saved: unknown[] = []
    const save = async (patch: unknown) => saved.push(patch)
    const rows = accountRows(accounts, [], 'auto')
    expect(await chooseAccount(rows[1]!, save)).toBe(true)
    expect(saved).toEqual([{ defaultAccountId: '35' }])
    // A signed-out row and the current choice save nothing.
    expect(await chooseAccount(rows[2]!, save)).toBe(false)
    expect(await chooseAccount(rows[0]!, save)).toBe(false)
    expect(saved).toHaveLength(1)
  })
})

describe('condensed account popup', () => {
  it('puts Auto, then Default login, then the most headroom first and signed-out accounts last', () => {
    const accounts = [
      account('9', { signedIn: false }),
      account('5', { fiveHourPct: 90, weeklyPct: 10 }),
      account('default', { label: 'Default login', plan: null, fiveHourPct: null, weeklyPct: null }),
      account('3', { fiveHourPct: 5, weeklyPct: 30 }),
      account('4', { fiveHourPct: null, weeklyPct: null }),
      account('6', { fiveHourPct: null, weeklyPct: 20 })
    ]
    expect(accountRows(accounts, [], 'auto').map((r) => r.id)).toEqual(['auto', 'default', '6', '3', '5', '4', '9'])
    expect([headroom(accounts[1]!), headroom(accounts[0]!), headroom(accounts[4]!)]).toEqual([10, -Infinity, -1])
  })

  it('colours a window green under 60, amber 60 to 85, red over 85, and shows a dash without a reading', () => {
    expect([59, 60, 85, 86, null].map(usageTone)).toEqual(['ok', 'warn', 'warn', 'full', 'unknown'])
    expect([pctText(42.6), pctText(null)]).toEqual(['43%', '–'])
  })

  it('moves the reset times into the tooltip and names no email', () => {
    const now = Date.UTC(2026, 9, 4, 12)
    const a = account('35', { fiveHourPct: 6, weeklyPct: 43, fiveHourResetsAt: now + 47 * 60_000, inUse: true })
    const [row] = accountRows([a], [chat('x', { account: { id: '35', label: '#35', configDir: null } })], 'auto').slice(1)
    const tip = rowTip(row!, now)
    expect(tip).toBe('5-hour 6%, resets in 47m\nWeekly 43%\nIn use by a person or another session\n1 live chat in this window')
    expect(row!.label).toBe('#35 sue')
    expect(tip + row!.label).not.toContain('@')
    expect(rowTip(accountRows([account('7', { signedIn: false })], [], 'auto')[1]!, now)).toStartWith('Signed out')
  })
})

describe('sidebar footer', () => {
  const sidebar = readFileSync(join(import.meta.dir, '../../src/components/sidebar/Sidebar.vue'), 'utf8')
  const footer = sidebar.slice(sidebar.indexOf('<footer'), sidebar.indexOf('</footer>'))

  it('opens Settings from the gear directly, outside the account popup', () => {
    const popupEnd = footer.indexOf('</AccountsPopover>')
    const gear = footer.indexOf('aria-label="Settings"')
    expect(popupEnd).toBeGreaterThan(0)
    expect(gear).toBeGreaterThan(popupEnd)
    expect(footer.slice(gear)).toContain('@click="src.openSettings()"')
  })

  it('has no Projects, Artifacts, Customize or More rows and no mode switch', () => {
    const chrome = readFileSync(join(import.meta.dir, '../../src/components/shell/ChromeBar.vue'), 'utf8')
    for (const gone of ['Projects', 'Artifacts', 'Customize', 'More navigation items']) expect(sidebar).not.toContain(`>${gone}<`)
    expect(sidebar).not.toContain('aria-label="More navigation items"')
    expect(chrome).not.toContain('role="radiogroup"')
  })
})

describe('settings dialog', () => {
  const settings = readFileSync(join(import.meta.dir, '../../src/components/panes/SettingsView.vue'), 'utf8')
  const frame = readFileSync(join(import.meta.dir, '../../src/components/shell/DeskFrame.vue'), 'utf8')

  // No Accounts page since 2026-10-06 (owner): the account for new chats is the sidebar's account menu.
  it('reads the store only through the source', () => {
    expect(settings).not.toContain('useDesk')
  })

  it('opens as a dialog over the window, not in the main column, and closing it selects the view under it', () => {
    expect(frame).toContain('<Dialog :open="settingsOpen" @update:open="(o: boolean) => !o && closeSettings()">')
    expect(frame).toContain('const closeSettings = () => src.select(under.value)')
    expect(frame).not.toContain("view.kind === 'settings'")
  })
})

// DeskFrame mounts nothing under bun:test, so these pin the wiring; the store side is in test/stores/outside-sessions.
describe('the frame and the open view', () => {
  const frame = readFileSync(join(import.meta.dir, '../../src/components/shell/DeskFrame.vue'), 'utf8')
  const between = (from: string, to: string) => frame.slice(frame.indexOf(from), frame.indexOf(to))

  it('a pointer move with a button held (a drag reaching the edge) never opens the flyout', () => {
    expect(between('function onPeekPointer', 'function onPeekPointerOut')).toContain('if (!flyout.value || e.buttons !== 0) return')
  })

  it('coming back to the window clears the open chat or outside session unread mark, and the listeners go on unmount', () => {
    for (const s of ["window.addEventListener('focus', markOpenRead)", "document.addEventListener('visibilitychange', onVisibility)"]) {
      expect(between('onMounted(', 'onBeforeUnmount(')).toContain(s)
      expect(between('onBeforeUnmount(', '</script>')).toContain(s.replace('addEventListener', 'removeEventListener'))
    }
    const read = between('function markOpenRead', 'const onVisibility')
    expect(read).toContain('src.updateChat(chat.value.id, { unread: false })')
    expect(read).toContain('src.updateSessionMeta(external.value.id, { unread: false })')
  })

  it('an outside session opened any way (row, search hit, Back) clears its unread mark through the meta action', () => {
    const watcher = between('() => [external.value?.id, external.value?.unread] as const', 'function markOpenRead')
    expect(watcher).toContain("if (id !== before?.[0] || document.hasFocus()) void src.updateSessionMeta(id, { unread: false })")
  })

  it('an outside session the list lacks is fetched on its own and titled Loading session… meanwhile', () => {
    expect(frame).toContain('await src.ensureExternal(id)')
    expect(frame).toContain("(fetchingSession.value === v.id ? 'Loading session…' : 'Session')")
  })
})

describe('the split beside a wide pane', () => {
  it('keeps the chat at the width it was dragged to whatever the window, and the pane takes the rest', () => {
    expect(splitChat(700, 1400)).toBe(700)
    expect(splitChat(700, 2400)).toBe(700)
    expect(splitChat(700, 1000)).toBe(700)
  })
  it('lets the chat go as wide or as narrow as leaves each side usable, with no other limit', () => {
    expect(splitChat(5000, 2400)).toBe(2400 - SIDE_MIN)
    expect(splitChat(1800, 2400)).toBe(1800)
    expect(splitChat(50, 2400)).toBe(CHAT_MIN)
    expect(splitChat(CHAT_MIN + 1, 2400)).toBe(CHAT_MIN + 1)
  })
  it('narrows the chat only when the window leaves the pane less than its minimum, and the chat keeps its own first', () => {
    expect(splitChat(900, 1000)).toBe(1000 - SIDE_MIN)
    expect(splitChat(900, 500)).toBe(CHAT_MIN)
  })
  it('gives the grid the same rule, so the window resizes the pane before anything is measured', () => {
    expect(splitColumns(712.4)).toBe(`max(${CHAT_MIN}px, min(712px, calc(100% - ${SIDE_MIN}px))) minmax(0, 1fr)`)
  })
  it('remembers the width last dragged to, a default when nothing usable is saved', () => {
    expect(loadChatWidth({ getItem: (k) => (k === CHAT_KEY ? '1800' : null) })).toBe(1800)
    expect(loadChatWidth({ getItem: () => null })).toBe(CHAT_DEFAULT)
    expect(loadChatWidth({ getItem: () => '' })).toBe(CHAT_DEFAULT)
    expect(loadChatWidth({ getItem: () => '40' })).toBe(CHAT_DEFAULT)
    expect(loadChatWidth({ getItem: () => 'wide' })).toBe(CHAT_DEFAULT)
    expect(loadChatWidth(null)).toBe(CHAT_DEFAULT)
  })
  it('the frame lays the split out with that rule and owns the divider; the servers pane has no width of its own', () => {
    const frame = readFileSync(join(import.meta.dir, '../../src/components/shell/DeskFrame.vue'), 'utf8')
    expect(frame).toContain(':style="split ? { gridTemplateColumns: splitColumns(chatWidth) } : undefined"')
    expect(frame).toContain('const move = (ev: PointerEvent) => setChatWidth(ev.clientX - left)')
    const pane = readFileSync(join(import.meta.dir, '../../src/components/servers/ServersPane.vue'), 'utf8')
    expect(pane).not.toContain('role="separator"')
    expect(pane).not.toContain('width: number')
  })
})
