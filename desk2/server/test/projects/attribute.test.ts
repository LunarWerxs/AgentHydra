import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { SpotIndex } from '../../src/projects/attribute'

const root = resolve('/work')
const inventory = { path: join(root, 'inventory'), name: 'Inventory' }
const billing = { path: join(root, 'billing'), name: 'Billing Service' }
const shop = { path: join(root, 'shop', 'app'), name: 'Shop' }
const admin = { path: join(root, 'admin', 'app'), name: 'Admin' }
const labels = { path: join(inventory.path, 'packages', 'labels'), name: 'Labels' }
const index = new SpotIndex([inventory, billing, shop, admin, labels])

/** A transcript's text naming these paths the way its tool calls do (JSON-escaped). */
const transcript = (...paths: string[]) => paths.map((p) => JSON.stringify({ type: 'tool_use', input: { file_path: p } })).join('\n')
const files = (spot: { path: string }, n: number) => Array.from({ length: n }, (_, i) => join(spot.path, 'src', `f${i}.ts`))

describe('SpotIndex', () => {
  test('a path belongs to the nearest project up from it', () => {
    expect(index.holding(join(inventory.path, 'src', 'a.ts'))).toBe(inventory)
    expect(index.holding(join(root, 'other', 'a.ts'))).toBeNull()
  })

  test.each([
    ['three paths in one project and one in another', [...files(inventory, 3), ...files(billing, 1)], inventory, true],
    ['paths in no project do not count against one', [...files(inventory, 3), ...Array.from({ length: 5 }, (_, i) => join(root, 'other', `${i}.ts`))], inventory, true],
    ['a nested project with most of them', [...files(labels, 3), ...files(inventory, 1)], labels, true],
    ['a nested project short of most counts for the one holding it', [...files(labels, 2), ...files(inventory, 2)], inventory, true],
    ['two paths are too few to say', files(inventory, 2), null, false],
    ['no project has a clear majority', [...files(inventory, 3), ...files(billing, 3)], null, true],
  ])('paths: %s', (_, paths, spot, enough) => {
    expect(index.fromPaths(transcript(...paths))).toEqual({ spot, enough })
  })

  test.each([
    ['one project named', 'Inventory: fix the CSV export', inventory],
    ['a name with spaces, in any case', 'billing service retries', billing],
    ['two projects named', 'Move inventory into billing service', null],
    ['a folder name two projects share, and short names', 'Fix the app header in Shop', null],
  ])('title: %s', (_, title, want) => {
    expect(index.fromTitle(title)).toBe(want)
  })
})
