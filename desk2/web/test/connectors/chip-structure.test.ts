// The Connections chip's menu must drop from under the chip. Tip swaps its subtree on the first hover (InterestSlot ->
// real Tooltip), which remounts everything inside it; a Tip placed between DropdownMenu and its trigger leaves the menu
// anchored to a detached button at 0,0 (top-left of the window). So Tip must wrap the WHOLE DropdownMenu, as in
// session-header/SessionHeader.vue. No DOM here: the template is read with Vue's own compiler.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'vue/compiler-sfc'

interface Node {
  type: number
  tag?: string
  children?: Node[]
}

const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'connectors', 'ConnectionsChip.vue'), 'utf8')
const root = parse(src).descriptor.template?.ast as unknown as Node

/** The tags from the root down to the first element named `tag`, or null. */
function pathTo(n: Node, tag: string, trail: string[] = []): string[] | null {
  for (const c of n.children ?? []) {
    if (c.type !== 1) continue
    const here = [...trail, c.tag as string]
    if (c.tag === tag) return here
    const found = pathTo(c, tag, here)
    if (found) return found
  }
  return null
}

test('the Tip wraps the whole DropdownMenu, so the first hover cannot detach the trigger the menu anchors to', () => {
  const trigger = pathTo(root, 'DropdownMenuTrigger')
  expect(trigger).not.toBeNull()
  const menu = trigger!.indexOf('DropdownMenu')
  expect(menu).toBeGreaterThanOrEqual(0)
  // no Tip between the DropdownMenu and its trigger
  expect(trigger!.slice(menu).includes('Tip')).toBe(false)
  // the Tip is above the DropdownMenu
  expect(trigger!.slice(0, menu).includes('Tip')).toBe(true)
})
