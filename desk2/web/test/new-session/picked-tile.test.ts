import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickedFolder } from '../../src/components/shell/projects'

const BETA = 'C:/Users/me/Projects/Beta'
const ALPHA = 'C:/Users/me/Projects/Alpha'

describe('the picked project tile', () => {
  test('the folder the new chat starts in is the one tile marked picked', () => {
    expect([BETA, ALPHA].map((p) => pickedFolder({ kind: 'new', cwd: BETA }, p))).toEqual([true, false])
  })

  test('a differently-cased, backslashed path with a trailing separator still matches', () => {
    expect(pickedFolder({ kind: 'new', cwd: 'c:\\users\\me\\projects\\beta\\' }, BETA)).toBe(true)
  })

  test('moving the selection moves the highlight', () => {
    const picks = (view: Parameters<typeof pickedFolder>[0]) => [BETA, ALPHA].map((p) => pickedFolder(view, p))
    expect(picks({ kind: 'new', cwd: BETA })).toEqual([true, false])
    expect(picks({ kind: 'new', cwd: ALPHA })).toEqual([false, true])
    expect(picks({ kind: 'elsewhere' })).toEqual([false, false])
  })

  test('a new-chat view with no folder highlights none', () => {
    expect([BETA, ALPHA].map((p) => pickedFolder({ kind: 'new' }, p))).toEqual([false, false])
  })

  test('the tile binds aria-pressed and the picked classes to that one check', () => {
    const template = readFileSync(join(import.meta.dir, '../../src/components/shell/NewSessionScreen.vue'), 'utf8')
    expect(template).toContain(`const TILE_PICKED = 'bg-fill-hover ring-1 ring-inset ring-(--accent)'`)
    expect(template).toContain(`:aria-pressed="picked(p)"`)
    expect(template).toContain(`picked(p) ? TILE_PICKED : TILE_BG`)
  })
})
