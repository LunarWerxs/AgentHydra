import { describe, expect, test } from 'bun:test'
import { showMigratedCodexChat } from '../src/core/codex-migration-visibility'

function fixture() {
  const calls: string[] = []
  const target = { id: 'target', name: 'Destination', codexHome: 'C:/profiles/destination' }
  const state = {
    existing: false,
    placed: false,
    refuseReadback: false,
    refuseNavigation: false,
    refuseMove: false,
  }
  const section = () => ({
    sectionId: 'section-1',
    name: 'Migrated chats',
    itemKeys: state.placed && !state.refuseReadback ? ['codex:thread:local:imported-1'] : [],
  })
  const deps = {
    open: async () => ({
      ok: true,
      action: 'codex-desktop-open',
      dir: target.codexHome,
      message: 'already running',
    }),
    connect: async (actual: typeof target, callerId: string) => {
      expect(actual).toEqual(target)
      expect(callerId).toBe('imported-1')
      return {
        async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
          calls.push(method)
          if (method === 'navigate_to_codex_page')
            return { navigated: !state.refuseNavigation } as T
          if (method === 'list_threads') return { sections: state.existing ? [section()] : [] } as T
          if (method === 'create_sidebar_section') {
            state.existing = true
            return section() as T
          }
          if (method === 'move_thread_to_sidebar_section') {
            expect(args).toEqual({
              threadId: 'imported-1',
              hostId: 'local',
              source: 'codex',
              sectionId: 'section-1',
            })
            if (state.refuseMove) throw new Error('Move refused')
            state.placed = true
            return { threadId: 'imported-1', sectionId: 'section-1', hostId: 'local' } as T
          }
          throw new Error(`Unexpected tool ${method}`)
        },
      }
    },
  }
  return {
    calls,
    target,
    state,
    deps,
    show: () => showMigratedCodexChat(target, 'imported-1', deps),
  }
}

describe('Codex migration desktop visibility', () => {
  test('opens the imported chat, creates its section, and checks native sidebar membership', async () => {
    const f = fixture()
    await f.show()
    expect(f.calls).toEqual([
      'navigate_to_codex_page',
      'list_threads',
      'create_sidebar_section',
      'move_thread_to_sidebar_section',
      'list_threads',
    ])
  })
  test('reuses the existing section and membership on a retry', async () => {
    const f = fixture()
    f.state.existing = true
    f.state.placed = true
    await f.show()
    expect(f.calls).toEqual(['navigate_to_codex_page', 'list_threads', 'list_threads'])
  })
  test('a successful dispatch without sidebar membership is not a completed migration', async () => {
    const f = fixture()
    f.state.refuseReadback = true
    await expect(f.show()).rejects.toThrow('could not be verified')
  })
  test('does not retry an ambiguous/refused mutation', async () => {
    const f = fixture()
    f.state.refuseMove = true
    await expect(f.show()).rejects.toThrow('Move refused')
    expect(f.calls.filter((call) => call === 'move_thread_to_sidebar_section')).toHaveLength(1)
  })
  test('a failed launch or navigation cannot report visible chats', async () => {
    const f = fixture()
    await expect(
      showMigratedCodexChat(f.target, 'imported-1', {
        ...f.deps,
        open: async () => ({
          ok: false,
          action: 'codex-desktop-open',
          dir: f.target.codexHome,
          message: 'Launch failed',
        }),
      }),
    ).rejects.toThrow('Launch failed')
    expect(f.calls).toHaveLength(0)
    f.state.refuseNavigation = true
    await expect(f.show()).rejects.toThrow('did not open')
    expect(f.calls).toEqual(['navigate_to_codex_page'])
  })
})
