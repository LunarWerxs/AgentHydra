import { describe, it, expect } from 'bun:test'
import { PEEK_CLOSE_MS, PEEK_OPEN_MS, SidebarPeek } from '@/components/shell/logic'

// Real timers: the delays are 120 / 200 ms, so each check sits well clear of them.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function make(overlay = () => false) {
  const changes: boolean[] = []
  const peek = new SidebarPeek((open) => changes.push(open), overlay)
  return { peek, changes }
}

describe('the collapsed sidebar hover flyout', () => {
  it('opens after the hover delay and closes after the leave delay', async () => {
    const { peek, changes } = make()
    peek.hover(true)
    peek.hover(true) // every pointer move repeats it; the timer is not restarted
    await sleep(PEEK_OPEN_MS / 2)
    expect(peek.open).toBe(false)
    await sleep(PEEK_OPEN_MS)
    expect(peek.open).toBe(true)

    peek.hover(false)
    await sleep(PEEK_CLOSE_MS / 2)
    expect(peek.open).toBe(true)
    await sleep(PEEK_CLOSE_MS)
    expect(peek.open).toBe(false)
    expect(changes).toEqual([true, false])
    peek.dispose()
  })

  it('does not open for a pointer that only passes over the toggle', async () => {
    const { peek, changes } = make()
    peek.hover(true)
    await sleep(PEEK_OPEN_MS / 3)
    peek.hover(false)
    await sleep(PEEK_OPEN_MS * 2)
    expect(changes).toEqual([])
    peek.dispose()
  })

  it('stays open when the pointer comes back before the leave delay', async () => {
    const { peek, changes } = make()
    peek.hover(true)
    await sleep(PEEK_OPEN_MS + 60)
    peek.hover(false)
    await sleep(PEEK_CLOSE_MS / 3)
    peek.hover(true)
    await sleep(PEEK_CLOSE_MS + 60)
    expect(changes).toEqual([true])
    peek.dispose()
  })

  it('keyboard focus inside keeps it open after the pointer left', async () => {
    const { peek } = make()
    peek.hover(true)
    await sleep(PEEK_OPEN_MS + 60)
    peek.focused(true)
    peek.hover(false)
    await sleep(PEEK_CLOSE_MS + 60)
    expect(peek.open).toBe(true)
    peek.focused(false)
    await sleep(PEEK_CLOSE_MS + 60)
    expect(peek.open).toBe(false)
    peek.dispose()
  })

  it('waits while a menu or dialog is open, then follows the pointer', async () => {
    let overlay = true
    const { peek } = make(() => overlay)
    peek.hover(true)
    await sleep(PEEK_OPEN_MS * 2 + 60)
    expect(peek.open).toBe(false)
    overlay = false
    await sleep(PEEK_OPEN_MS + 60)
    expect(peek.open).toBe(true)
    peek.dispose()
  })

  it('closes at once when a chat is chosen or Escape is pressed', async () => {
    const { peek, changes } = make()
    peek.hover(true)
    await sleep(PEEK_OPEN_MS + 60)
    peek.close()
    expect(peek.open).toBe(false)
    expect(changes).toEqual([true, false])
    peek.dispose()
  })
})
