import { describe, expect, test } from 'bun:test'
import { type CdpSend, createPageSnapshot } from '../../../src/browser/agent/snapshot'

interface FakeNode {
  id: number
  role: string
  name: string
}

// A page the fake CDP answers for: the accessibility tree is its nodes, and each node's box sits at id * 10.
function fakeBrowser(initialLoader: string) {
  let loaderId = initialLoader
  let nodes: FakeNode[] = []
  const send: CdpSend = async (method, params = {}) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId } } }
    if (method === 'Accessibility.getFullAXTree')
      return {
        nodes: [
          {
            nodeId: 'root',
            role: { value: 'RootWebArea' },
            name: { value: '' },
            childIds: nodes.map((n) => `n${n.id}`),
            ignored: false,
            properties: [],
          },
          ...nodes.map((n) => ({
            nodeId: `n${n.id}`,
            parentId: 'root',
            backendDOMNodeId: n.id,
            role: { value: n.role },
            name: { value: n.name },
            childIds: [],
            ignored: false,
            properties: [],
          })),
        ],
      }
    if (method === 'DOM.resolveNode') {
      const id = params.backendNodeId as number
      if (!nodes.some((n) => n.id === id)) throw new Error('No node with given id found')
      return { object: { objectId: `obj-${id}` } }
    }
    if (method === 'DOM.getContentQuads') {
      const x = Number(String(params.objectId).replace('obj-', '')) * 10
      return { quads: [[x, 0, x + 10, 0, x + 10, 10, x, 10]] }
    }
    return {}
  }
  return {
    send,
    render(next: FakeNode[]) {
      nodes = next
    },
    navigate(nextLoader: string, next: FakeNode[]) {
      loaderId = nextLoader
      nodes = next
    },
  }
}

// The refs the agent would cite for buttons with this name, in the order the outline lists them.
const refsNamed = (outline: string, name: string) =>
  [...outline.matchAll(new RegExp(`button "${name}" \\[ref=(e\\d+)\\]`, 'g'))].map((m) => m[1]!)

const GONE = 'that element is gone (the page changed)'

describe('stale ref recovery', () => {
  test('a ref whose node was re-rendered under the same role and name resolves to the new node', async () => {
    const browser = fakeBrowser('loader-rerender')
    browser.render([{ id: 10, role: 'button', name: 'Save' }])
    const outline = await createPageSnapshot(browser.send).aria()
    const [ref] = refsNamed(outline, 'Save')

    // The page re-renders Save as a new node; the click is a later tool call, so it gets its own instance.
    browser.render([{ id: 20, role: 'button', name: 'Save' }])
    const click = createPageSnapshot(browser.send)
    await click.aria()
    expect((await click.resolveRef(ref!)).x).toBe(205)
  })

  test('after a navigation the old error is kept, even with a same-named node on the new page', async () => {
    const browser = fakeBrowser('loader-before-nav')
    browser.render([{ id: 10, role: 'button', name: 'Save' }])
    const snap = createPageSnapshot(browser.send)
    const [ref] = refsNamed(await snap.aria(), 'Save')

    browser.navigate('loader-after-nav', [{ id: 20, role: 'button', name: 'Save' }])
    await snap.aria()
    await expect(snap.resolveRef(ref!)).rejects.toThrow(GONE)
  })

  test('with two same-named buttons the nth one is chosen', async () => {
    const browser = fakeBrowser('loader-nth')
    browser.render([
      { id: 10, role: 'button', name: 'Delete' },
      { id: 11, role: 'button', name: 'Delete' },
    ])
    const [, second] = refsNamed(await createPageSnapshot(browser.send).aria(), 'Delete')

    // Both re-render; the second one is 31, so a first-match pick would land on 30 instead.
    browser.render([
      { id: 30, role: 'button', name: 'Delete' },
      { id: 31, role: 'button', name: 'Delete' },
    ])
    const click = createPageSnapshot(browser.send)
    await click.aria()
    expect((await click.resolveRef(second!)).x).toBe(315)
  })

  // A row was removed: the second Delete of three may now be the old third row's, so it is never guessed.
  test('once the same-named nodes grew or shrank, the old error is kept rather than a guess', async () => {
    const browser = fakeBrowser('loader-shrunk')
    browser.render([
      { id: 10, role: 'button', name: 'Delete' },
      { id: 11, role: 'button', name: 'Delete' },
      { id: 12, role: 'button', name: 'Delete' },
    ])
    const [, second] = refsNamed(await createPageSnapshot(browser.send).aria(), 'Delete')

    browser.render([
      { id: 30, role: 'button', name: 'Delete' },
      { id: 31, role: 'button', name: 'Delete' },
    ])
    const click = createPageSnapshot(browser.send)
    await click.aria()
    await expect(click.resolveRef(second!)).rejects.toThrow(GONE)
  })

  test('when no same-named node exists the old error is kept', async () => {
    const browser = fakeBrowser('loader-no-match')
    browser.render([{ id: 10, role: 'button', name: 'Save' }])
    const snap = createPageSnapshot(browser.send)
    const [ref] = refsNamed(await snap.aria(), 'Save')

    browser.render([{ id: 20, role: 'button', name: 'Cancel' }])
    await snap.aria()
    await expect(snap.resolveRef(ref!)).rejects.toThrow(GONE)
  })
})
