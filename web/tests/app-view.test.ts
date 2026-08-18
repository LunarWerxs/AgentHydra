// web/tests/app-view.test.ts — two windows of the app can be on two different tabs (src/lib/app-view).
//
// The regression this guards is the one that made a duplicated tab useless: `agenthydra.app.view`
// was a single localStorage key with vueuse's cross-window listener on it, so both windows are the
// same origin and clicking Instances in one dragged the other one off Sessions in real time. The
// cases below are therefore mostly about a window NOT moving — the thing that is easy to break
// again by "helpfully" re-syncing something.
//
// Storage is a hand-rolled stub rather than jsdom's, matching storage-rebrand.test.ts: the factory
// takes its Storage by parameter precisely so this needs no DOM, and a stub can be made to throw.

import { describe, expect, test } from 'bun:test'
import { ref } from 'vue'
import { APP_VIEW_KEY, type AppView, createTabView, parseAppView } from '../src/lib/app-view'

/** Minimal Storage over a Map. `throwOn` exercises the private-browsing path. */
function stubStorage(
  initial: Record<string, string> = {},
  throwOn?: 'getItem' | 'setItem',
): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => {
      if (throwOn === 'getItem') throw new Error('storage disabled')
      return map.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (throwOn === 'setItem') throw new Error('quota exceeded')
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => map.clear(),
  } as Storage
}

describe('parseAppView', () => {
  test('accepts the tabs that exist and refuses everything else', () => {
    expect(parseAppView('sessions')).toBe('sessions')
    expect(parseAppView('instances')).toBe('instances')
    expect(parseAppView('analytics')).toBe('analytics')
    // A downgrade-era or hand-edited value must not render a tab the app does not have.
    expect(parseAppView('quantum')).toBeNull()
    expect(parseAppView(null)).toBeNull()
    expect(parseAppView(undefined)).toBeNull()
    expect(parseAppView('')).toBeNull()
  })
})

describe('createTabView', () => {
  test('a brand-new window opens where the app was left off', () => {
    // Nothing in this window's own session yet, so the durable memory is all there is — the case a
    // fresh launch, or a launch on a port this browser has never seen, actually hits.
    const stored = ref<AppView>('instances')
    const view = createTabView(stored, stubStorage())
    expect(view.value).toBe('instances')
  })

  test('a window that has been somewhere keeps its own tab, whatever the durable value says', () => {
    // Both a reload of a window and a DUPLICATED tab arrive here: the browser copies sessionStorage
    // into the duplicate, so the duplicate opens on what you were looking at rather than on
    // whatever the other window happened to write last.
    const stored = ref<AppView>('sessions')
    const view = createTabView(stored, stubStorage({ [APP_VIEW_KEY]: 'analytics' }))
    expect(view.value).toBe('analytics')
  })

  test('switching records it for this window and for the next fresh one', () => {
    const stored = ref<AppView>('sessions')
    const session = stubStorage()
    const view = createTabView(stored, session)

    view.value = 'instances'

    expect(session.getItem(APP_VIEW_KEY)).toBe('instances')
    expect(stored.value).toBe('instances')
  })

  test('TWO WINDOWS ARE INDEPENDENT — the whole point', () => {
    // One `stored` ref for both, which is stricter than reality (each window has its own) and
    // models the cross-window storage event exactly: even when the durable value moves under it,
    // a window that has a tab of its own stays on it.
    const stored = ref<AppView>('sessions')
    const left = createTabView(stored, stubStorage({ [APP_VIEW_KEY]: 'sessions' }))
    const right = createTabView(stored, stubStorage({ [APP_VIEW_KEY]: 'sessions' }))

    left.value = 'instances'

    expect(left.value).toBe('instances')
    expect(right.value).toBe('sessions')

    // ...and the other direction, so this is not passing by watcher-registration order.
    right.value = 'analytics'
    expect(right.value).toBe('analytics')
    expect(left.value).toBe('instances')
  })

  test('a fresh window still takes the daemon correction that lands after first paint', () => {
    // The mirror hydrates asynchronously by design (nothing waits on a round trip), so on a hopped
    // port the window paints from an empty localStorage and the real answer arrives a beat later.
    const stored = ref<AppView>('sessions')
    const view = createTabView(stored, stubStorage())
    expect(view.value).toBe('sessions')

    stored.value = 'analytics'
    expect(view.value).toBe('analytics')
  })

  test('...but a click beats a correction still in flight', () => {
    // The lost-choice bug useSharedPrefs is built around, in its other half: the window paints from
    // defaults, the user picks a tab immediately, and hydrate must not undo it.
    const stored = ref<AppView>('sessions')
    const view = createTabView(stored, stubStorage())

    view.value = 'instances'
    // The correction the in-flight read was already carrying when the click happened.
    stored.value = 'analytics'

    expect(view.value).toBe('instances')
  })

  test('a duplicated tab is not moved by a correction either', () => {
    // It has been somewhere by definition, so nothing external gets to relocate it — not the
    // sibling window, not the store.
    const stored = ref<AppView>('sessions')
    const view = createTabView(stored, stubStorage({ [APP_VIEW_KEY]: 'instances' }))

    stored.value = 'analytics'

    expect(view.value).toBe('instances')
  })

  test('a nonsense value in this window falls back to the durable one', () => {
    const stored = ref<AppView>('analytics')
    const view = createTabView(stored, stubStorage({ [APP_VIEW_KEY]: 'quantum' }))
    expect(view.value).toBe('analytics')
  })

  test('storage that refuses to work costs the memory, not the app', () => {
    // Private browsing throws on the access itself. Switching tabs must still switch tabs.
    for (const session of [
      null,
      stubStorage({}, 'getItem'),
      stubStorage({ [APP_VIEW_KEY]: 'analytics' }, 'setItem'),
    ]) {
      const stored = ref<AppView>('sessions')
      const view = createTabView(stored, session)
      view.value = 'instances'
      expect(view.value).toBe('instances')
      expect(stored.value).toBe('instances')
    }
  })
})
