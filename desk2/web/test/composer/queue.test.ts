import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatStatus, ImageRef, QueueItem, QueueItemState, QueueState } from '@shared/protocol'
import {
  aheadInLine,
  createHoverIntent,
  heldRows,
  imagesLabel,
  movedOrder,
  previewText,
  queueBadge,
  queueRows,
  queuedForChat,
  sendOrEnqueue,
  sendWords,
  trayText
} from '@/components/composer/queue'

type Over = { state?: QueueItemState; reason?: string | null; text?: string; images?: ImageRef[] }

function msg(id: string, chatId: string, over: Over = {}): QueueItem {
  return { id, rev: 1, createdAt: 0, updatedAt: 0, state: 'waiting', reason: null, text: `text ${id}`, kind: 'message', chatId, ...over }
}
function newChat(id: string, over: Over = {}): QueueItem {
  return { id, rev: 1, createdAt: 0, updatedAt: 0, state: 'waiting', reason: null, text: `text ${id}`, kind: 'chat', cwd: 'C:/work', startedChatId: null, ...over }
}
function state(items: QueueItem[], held: QueueState['held'] = {}): QueueState {
  return { items, paused: false, sendMode: 'immediate', maxNewChats: 2, held, rev: 1 }
}

describe('what Enter and Ctrl+Enter do', () => {
  const decide = (status: ChatStatus | null, queued: number, sendMode: 'immediate' | 'queue', ctrl: boolean) =>
    sendOrEnqueue({ status, queued, sendMode, ctrl })

  it('Ctrl+Enter queues while a turn runs or messages wait ahead; a chat with nothing to wait for sends', () => {
    for (const s of ['idle', 'closed', 'stopped', 'error', 'limited'] as ChatStatus[]) {
      expect(decide(s, 0, 'immediate', true)).toBe('send')
    }
    expect(decide('idle', 1, 'immediate', true)).toBe('enqueue')
    expect(decide('stopped', 1, 'immediate', true)).toBe('enqueue')
    for (const s of ['working', 'starting', 'needs_you'] as ChatStatus[]) {
      expect(decide(s, 0, 'immediate', true)).toBe('enqueue')
    }
  })

  it('a plain Enter queues behind waiting messages, so their order holds', () => {
    expect(decide('idle', 2, 'immediate', false)).toBe('enqueue')
    expect(decide('closed', 1, 'immediate', false)).toBe('enqueue')
  })

  it('a plain Enter while a turn runs follows the mode', () => {
    expect(decide('working', 0, 'immediate', false)).toBe('send')
    for (const s of ['working', 'starting', 'needs_you'] as ChatStatus[]) expect(decide(s, 0, 'queue', false)).toBe('enqueue')
    expect(decide('idle', 0, 'queue', false)).toBe('send')
    expect(decide('stopped', 0, 'queue', false)).toBe('send')
  })

  it('on the new-session screen Ctrl+Enter queues a new chat; Enter only in queue mode', () => {
    expect(decide(null, 0, 'immediate', true)).toBe('enqueue')
    expect(decide(null, 0, 'immediate', false)).toBe('send')
    expect(decide(null, 0, 'queue', false)).toBe('enqueue')
  })

  it("counts only this chat's messages that still wait their turn", () => {
    const q = state([msg('a1', 'A'), msg('a2', 'A', { state: 'failed' }), msg('a3', 'A', { state: 'held' }), msg('b1', 'B'), newChat('n1')])
    expect(queuedForChat(q, 'A').map((i) => i.id)).toEqual(['a1', 'a3'])
    expect(queuedForChat(q, null)).toEqual([])
    expect(queuedForChat(null, 'A')).toEqual([])
  })

  it('a held message waits for Resume, not its turn: a new one does not line up behind it', () => {
    const q = state([msg('a1', 'A', { state: 'held' }), msg('a2', 'A', { state: 'held' }), msg('b1', 'B')], { A: 'stopped' })
    expect(aheadInLine(q, 'A')).toBe(0)
    expect(decide('stopped', aheadInLine(q, 'A'), 'immediate', false)).toBe('send')
    const r = state([msg('a1', 'A', { state: 'sending' }), msg('a2', 'A'), msg('a3', 'A', { state: 'failed' }), msg('a4', 'A', { state: 'held' })])
    expect(aheadInLine(r, 'A')).toBe(2)
    expect(aheadInLine(r, null)).toBe(0)
  })
})

describe("the send button's label and tip", () => {
  const words = (enqueue: boolean, busy: boolean, held = false, newChat = false) => sendWords({ enqueue, busy, newChat, held })

  it("read as a send into the running turn when Enter sends there ('immediate'), and as a queue when it queues", () => {
    expect(words(false, true)).toEqual({ label: 'Send', tip: 'Send (Enter): goes to the running turn now' })
    expect(words(true, true)).toEqual({ label: 'Queue', tip: 'Queue (Enter): sends when this chat finishes its turn' })
    expect(words(false, false)).toEqual({ label: 'Send', tip: 'Send (Enter)' })
    expect(words(true, false, false, true)).toEqual({ label: 'Queue', tip: 'Queue (Enter): starts when an account has room' })
  })

  it('say when this chat\'s queue is held, and where to resume it', () => {
    expect(words(false, false, true).tip).toBe("Send (Enter)\nThis chat's queued messages are held. Resume them in the queue (right-click)")
    expect(words(true, true, true)).toEqual({
      label: 'Queue',
      tip: "Queue (Enter): held with this chat's queued messages. Resume them in the queue (right-click)"
    })
  })
})

describe('the hover that shows the queue chevron', () => {
  function timers() {
    let next = 1
    const pending = new Map<number, { fn: () => void; ms: number }>()
    return {
      pending,
      set: (fn: () => void, ms: number) => {
        pending.set(next, { fn, ms })
        return next++
      },
      clear: (id: number) => {
        pending.delete(id)
      },
      fire() {
        for (const [id, t] of [...pending]) {
          pending.delete(id)
          t.fn()
        }
      }
    }
  }

  it('shows only after the pointer rests for the delay', () => {
    const t = timers()
    const seen: boolean[] = []
    const intent = createHoverIntent(1000, t.set, t.clear, (v) => seen.push(v))
    intent.enter()
    intent.enter() // still resting: no second timer
    expect([...t.pending.values()].map((p) => p.ms)).toEqual([1000])
    expect(seen).toEqual([])
    t.fire()
    expect(seen).toEqual([true])
  })

  it('a leave before the delay cancels it; a later enter arms it again', () => {
    const t = timers()
    const seen: boolean[] = []
    const intent = createHoverIntent(1000, t.set, t.clear, (v) => seen.push(v))
    intent.enter()
    intent.leave()
    expect(t.pending.size).toBe(0)
    expect(seen).toEqual([])
    intent.enter()
    t.fire()
    intent.leave()
    expect(seen).toEqual([true, false])
  })

  it('keyboard focus shows it at once; dispose drops a pending show', () => {
    const t = timers()
    const seen: boolean[] = []
    const intent = createHoverIntent(1000, t.set, t.clear, (v) => seen.push(v))
    intent.enter()
    intent.now()
    expect(t.pending.size).toBe(0)
    expect(seen).toEqual([true])
    intent.leave()
    intent.enter()
    intent.dispose()
    expect(t.pending.size).toBe(0)
    expect(seen).toEqual([true, false])
  })
})

describe('moving a queued item', () => {
  const items = [msg('a1', 'A'), msg('b1', 'B'), msg('a2', 'A'), newChat('n1'), msg('a3', 'A')]

  it("swaps with the neighbour of the same chat; other chats' items keep their places", () => {
    expect(movedOrder(items, 'a2', -1)).toEqual(['a2', 'b1', 'a1', 'n1', 'a3'])
    expect(movedOrder(items, 'a2', 1)).toEqual(['a1', 'b1', 'a3', 'n1', 'a2'])
  })

  it('does nothing at either end of its line, or for an unknown id', () => {
    expect(movedOrder(items, 'a1', -1)).toBeNull()
    expect(movedOrder(items, 'a3', 1)).toBeNull()
    expect(movedOrder(items, 'n1', -1)).toBeNull()
    expect(movedOrder(items, 'b1', 1)).toBeNull()
    expect(movedOrder(items, 'gone', 1)).toBeNull()
  })
})

describe('how the popover and the tray show the queue', () => {
  const titles = new Map([['B', 'Bugs']])

  it("lists the open chat's line first, then the others by their first item, each in server order", () => {
    const q = state([msg('b1', 'B'), msg('a1', 'A'), newChat('n1'), msg('a2', 'A'), msg('c1', 'C'), msg('b2', 'B')])
    const rows = queueRows(q, 'A', titles)
    expect(rows.map((r) => [r.item.id, r.position, r.chip, r.first, r.last])).toEqual([
      ['a1', 1, null, true, false],
      ['a2', 2, null, false, true],
      ['b1', 1, 'Bugs', true, false],
      ['b2', 2, 'Bugs', false, true],
      ['n1', 1, 'New chat', true, true],
      ['c1', 1, 'Another chat', true, true]
    ])
    // Grouping never changes the order within a line.
    expect(queueRows(q, null, titles).map((r) => r.item.id)).toEqual(['b1', 'b2', 'a1', 'a2', 'n1', 'c1'])
    expect(queueRows(null, 'A', titles)).toEqual([])
  })

  it('a badge only when an item is not plainly waiting', () => {
    const held = { A: 'stopped' as const }
    expect(queueBadge(msg('a1', 'A'), held)).toBeNull()
    expect(queueBadge(msg('a1', 'A', { state: 'sending' }), held)).toEqual({ label: 'Sending…', reason: null, tone: 'muted' })
    expect(queueBadge(msg('a1', 'A', { state: 'held' }), held)).toEqual({ label: 'Held', reason: 'you stopped it', tone: 'warn' })
    expect(queueBadge(msg('a1', 'A', { state: 'held', reason: 'Stopped, resume to continue' }), held)!.reason).toBe('Stopped, resume to continue')
    expect(queueBadge(msg('a1', 'A', { state: 'failed', reason: 'chat deleted' }), held)).toEqual({ label: 'Failed', reason: 'chat deleted', tone: 'warn' })
  })

  it('a banner per held chat says why', () => {
    const q = state([], { B: 'error', C: 'restart', A: 'stopped' })
    expect(heldRows(q, titles)).toEqual([
      { chatId: 'B', text: 'Bugs: it failed' },
      { chatId: 'C', text: 'A chat: the server restarted' },
      { chatId: 'A', text: 'A chat: you stopped it' }
    ])
  })

  it('texts are trimmed and cut long before the clamp; pictures are counted', () => {
    expect(previewText('  fix it \n')).toBe('fix it')
    const long = previewText('x'.repeat(500), 280)
    expect(long).toHaveLength(280)
    expect(long.endsWith('…')).toBe(true)
    expect(imagesLabel(0)).toBeNull()
    expect(imagesLabel(1)).toBe('1 image')
    expect(imagesLabel(3)).toBe('3 images')
    const row = queueRows(state([msg('a1', 'A', { images: [{ mediaType: 'image/png', url: '/x' }] })]), 'A', titles)[0]!
    expect(row.images).toBe('1 image')
  })

  it('a tray row of pictures only shows their count, not a blank', () => {
    const png = { mediaType: 'image/png' as const, url: '/x' }
    expect(trayText(msg('a1', 'A', { text: '', images: [png, png] }))).toBe('2 images')
    expect(trayText(msg('a1', 'A', { text: ' fix it ', images: [png] }))).toBe('fix it')
    expect(trayText(msg('a1', 'A', { text: '' }))).toBe('')
  })
})

describe('the queue wiring in the composer', () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, '../../src/components/composer', file), 'utf8')
  const split = read('SendSplit.vue')
  const popover = read('QueuePopover.vue')
  const composer = read('Composer.vue')

  it('the popover is anchored to the send group with no trigger, and the Tips sit inside the anchor', () => {
    expect(split).toContain('<PopoverAnchor as-child>')
    expect(split).not.toContain('PopoverTrigger')
    const anchor = split.indexOf('<PopoverAnchor as-child>')
    expect(anchor).toBeGreaterThan(-1)
    expect(split.indexOf('<Tip')).toBeGreaterThan(anchor)
    expect(split.indexOf('<Tip')).toBeLessThan(split.indexOf('</PopoverAnchor>'))
    // The Tips close while the chevron or the popover shows: a blanked label left an open one as an empty pill.
    expect(split).toContain(`<Tip v-if="showStop" label="Stop (Esc)" :disabled="chevron"`)
    expect(split).toContain(`<Tip v-else :label="sendTip" :disabled="chevron"`)
    expect(split).not.toContain(`chevron ? ''`)
  })

  it('a Tip that turns disabled or loses its label closes, not only stops the next open', () => {
    const tip = readFileSync(join(import.meta.dir, '../../src/components/ui/tooltip/Tip.vue'), 'utf8')
    expect(tip).toContain('const off = computed(() => props.disabled || !props.label)')
    expect(tip).toMatch(/watch\(off, \(v\) => \{\s*if \(v\) open\.value = false/)
    expect(tip).toContain(':disabled="off"')
    expect(tip).toContain('<Tooltip v-model:open="open">')
  })

  it('the popover closes when a request docks or the chat changes, so it never sits at the window corner', () => {
    expect(split).toContain('watch(() => props.chatId, () => (open.value = false))')
    expect(read('QueueChip.vue')).toContain('watch(() => props.chatId, () => (open.value = false))')
    expect(composer).toMatch(/\(\) => !!request\.value,\s*\(docked\) => \{\s*if \(docked\) queueOpen\.value = false/)
  })

  it('an edit saves against the rev it was started from', () => {
    expect(popover).toMatch(/function startEdit[\s\S]*?editRev = item\.rev/)
    expect(popover).toContain('ifRev: editRev')
    expect(popover).not.toContain('ifRev: item.rev')
  })

  it('Up re-checks the box after the remove, and puts the message back if it was typed into', () => {
    const pull = composer.slice(composer.indexOf('async function pullQueued'), composer.indexOf('async function pendingImage'))
    const removed = pull.indexOf('await shell.queueRemove')
    expect(removed).toBeGreaterThan(-1)
    const after = pull.slice(removed)
    expect(after.indexOf('if (moved())')).toBeGreaterThan(-1)
    expect(after.indexOf('if (moved())')).toBeLessThan(after.indexOf('text.value = item.text'))
    expect(after).toContain("await shell.queueAdd?.({ kind: 'message', chatId: item.chatId")
  })

  it('the send button is aria-disabled, never disabled, so the queue opens from an empty box', () => {
    expect(split).toContain(':aria-disabled="!canSend"')
    expect(split).not.toContain(':disabled="!canSend"')
    expect(split).toContain('if (!props.canSend) return')
  })

  it('the chevron is placed outside the button box, so it takes no width', () => {
    expect(split).toMatch(/v-if="chevron"[\s\S]*?class="absolute bottom-0 right-full /)
    expect(split).toContain('aria-haspopup="dialog"')
    expect(split).toContain('@contextmenu.capture="onContextMenu"')
  })

  it('a press in the anchor is not outside, and Esc in an edit cancels the edit, not the popover', () => {
    expect(popover).toContain('@interact-outside="onOutside"')
    expect(popover).toContain('@escape-key-down="onEscape"')
    expect(popover).toContain('@close-auto-focus="onCloseFocus"')
    const editKey = popover.slice(popover.indexOf('function onEditKey'), popover.indexOf('function onEscape'))
    expect(editKey).toContain('e.stopPropagation()')
    expect(popover).toContain('role="dialog"')
    expect(popover).toContain('aria-label="Message queue"')
  })

  it('demo composers (Gallery, parity) show no queue, and the tray only when this chat has items', () => {
    expect(composer).toContain('const queue = computed(() => (props.demo ? null : (shell.queue?.value ?? null)))')
    expect(composer).toContain('<QueueTray v-if="!request && queue && trayItems.length"')
    expect(composer).toContain('<QueueChip v-if="request && queue && trayItems.length"')
  })
})
