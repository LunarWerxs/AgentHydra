// server/tests/instance-numbers.test.ts — the permanent instance NUMBER registry.
//
// The number is a HANDLE A HUMAN WRITES DOWN ("check instance 7's usage"), so the properties worth
// guarding are the ones that make a written-down number keep meaning what it meant: it never moves,
// it is never reused, and it is unique across all three instance families rather than per-family.
// A renumbering bug would not throw — it would silently point a prompt at someone else's account.
//
// CONFIG_DIR is redirected to a temp dir by tests/setup.ts (AGENTHYDRA_HOME), so the registry file
// written here is a scratch one and never touches the developer's real ~/.agenthydra.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  allInstanceNumbers,
  instanceNumberFor,
  instanceNumbers,
  instanceRef,
  parseInstanceRef,
  refForNumber,
} from '../src/core/instance-numbers'
import { parseInstanceNumber } from '../src/core/instance-ref'
import { instanceNumbersFile } from '../src/core/paths'

/** Start every test from an empty registry — the assertions are about the SEQUENCE, so a file left
 *  behind by a previous test would shift every expected number. */
function resetRegistry() {
  const file = instanceNumbersFile()
  if (existsSync(file)) rmSync(file, { force: true })
}

afterEach(resetRegistry)

describe('instanceRef', () => {
  test('normalizes desktop dirs so one folder claims exactly one number', () => {
    // The same folder reaches the registry spelled three ways across the codebase. Each spelling
    // claiming its own number is the bug this normalization exists to prevent.
    const a = instanceRef('desktop', 'C:\\Users\\me\\.claude-instances\\3claude')
    const b = instanceRef('desktop', 'c:\\users\\me\\.claude-instances\\3claude')
    const c = instanceRef('desktop', 'C:/Users/me/.claude-instances/3claude')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test('leaves cli/codex ids untouched — they are opaque uuids, not paths', () => {
    expect(instanceRef('cli', 'Abc-123')).toBe('cli:Abc-123')
    expect(instanceRef('codex', 'default')).toBe('codex:default')
  })

  test('parseInstanceRef round-trips, and rejects anything else', () => {
    expect(parseInstanceRef('cli:abc')).toEqual({ kind: 'cli', id: 'abc' })
    // A desktop dir contains a drive-letter colon, so the split must be on the FIRST colon only.
    expect(parseInstanceRef('desktop:c:\\users\\me\\x')).toEqual({
      kind: 'desktop',
      id: 'c:\\users\\me\\x',
    })
    expect(parseInstanceRef('garbage:foo')).toBeNull()
    expect(parseInstanceRef('cli:')).toBeNull()
    expect(parseInstanceRef('nocolon')).toBeNull()
  })
})

describe('number assignment', () => {
  test('is stable: the same ref returns the same number forever', () => {
    const ref = instanceRef('cli', 'aaa')
    const first = instanceNumberFor('cli', 'aaa')
    expect(first).toBe(1)
    expect(instanceNumberFor('cli', 'aaa')).toBe(first)
    expect(instanceNumbers([ref]).get(ref)).toBe(first)
  })

  test('is ONE sequence across desktop, cli and codex', () => {
    // The point of a single sequence: a bare "7" never needs a kind beside it to be unambiguous.
    const refs = [
      instanceRef('desktop', 'c:\\i\\a'),
      instanceRef('cli', 'b'),
      instanceRef('codex', 'c'),
    ]
    const numbers = instanceNumbers(refs)
    expect([...numbers.values()].sort((x, y) => x - y)).toEqual([1, 2, 3])
    expect(new Set(numbers.values()).size).toBe(3)
  })

  test('assigns a cold-start fleet in sorted-ref order, deterministically', () => {
    // Enumeration order must not decide the numbering — restoring a backup on another machine has
    // to reproduce the same "#7", or every note referring to it becomes wrong.
    const shuffled = ['cli:zzz', 'cli:aaa', 'cli:mmm']
    const first = instanceNumbers(shuffled)
    expect(first.get('cli:aaa')).toBe(1)
    expect(first.get('cli:mmm')).toBe(2)
    expect(first.get('cli:zzz')).toBe(3)

    resetRegistry()
    const again = instanceNumbers([...shuffled].reverse())
    expect(again.get('cli:aaa')).toBe(1)
    expect(again.get('cli:mmm')).toBe(2)
    expect(again.get('cli:zzz')).toBe(3)
  })

  test('NEVER reuses a number freed by a deleted instance', () => {
    // The core guarantee. If #2 were recycled, a prompt written yesterday saying "instance 2" would
    // silently start addressing a different account today.
    instanceNumbers(['cli:a', 'cli:b', 'cli:c'])
    expect(instanceNumberFor('cli', 'b')).toBe(2)

    // 'b' is deleted: the fleet no longer contains it, and a NEW instance appears.
    const after = instanceNumbers(['cli:a', 'cli:c', 'cli:d'])
    expect(after.get('cli:d')).toBe(4)
    expect(after.get('cli:a')).toBe(1)
    expect(after.get('cli:c')).toBe(3)
    expect(after.has('cli:b')).toBe(false)
  })

  test('a deleted instance that comes back gets its ORIGINAL number', () => {
    // Same folder, same identity — the registry never dropped the entry, so re-listing it must not
    // mint a second number for the same account.
    instanceNumbers(['cli:a', 'cli:b'])
    instanceNumbers(['cli:a']) // 'b' gone for a while
    expect(instanceNumbers(['cli:a', 'cli:b']).get('cli:b')).toBe(2)
  })

  test('only writes when something is genuinely new', () => {
    // listInstances() runs on a refresh timer over the whole fleet; a write per refresh would churn
    // the disk for no reason.
    instanceNumbers(['cli:a'])
    const file = instanceNumbersFile()
    const before = readFileSync(file, 'utf8')
    instanceNumbers(['cli:a'])
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('refForNumber', () => {
  test('finds the ref behind a number, including a RETIRED one', () => {
    // A retired number must stay resolvable: that is what lets the error message say "instance #2
    // was deleted" instead of the far more confusing "no such instance".
    instanceNumbers(['cli:a', 'cli:b'])
    expect(refForNumber(2)).toEqual({ kind: 'cli', id: 'b', ref: 'cli:b' })
    // Nothing removes the entry when the instance goes away…
    instanceNumbers(['cli:a'])
    expect(refForNumber(2)).toEqual({ kind: 'cli', id: 'b', ref: 'cli:b' })
  })

  test('returns null for a number never handed out, and for nonsense input', () => {
    instanceNumbers(['cli:a'])
    expect(refForNumber(99)).toBeNull()
    expect(refForNumber(0)).toBeNull()
    expect(refForNumber(-1)).toBeNull()
    expect(refForNumber(Number.NaN)).toBeNull()
  })
})

describe('corrupt or hand-edited registry', () => {
  test('unreadable JSON degrades to empty instead of throwing into a list call', () => {
    writeFileSync(instanceNumbersFile(), '{ this is not json')
    expect(() => instanceNumbers(['cli:a'])).not.toThrow()
    expect(instanceNumberFor('cli', 'a')).toBe(1)
  })

  test('drops junk rows but keeps the sequence above every VALID number', () => {
    // A hand-edit that leaves a bad value must not cause a live number to be handed out twice.
    writeFileSync(
      instanceNumbersFile(),
      JSON.stringify({
        next: 1, // deliberately stale/wrong — the highest real number must win
        byRef: {
          'cli:good': 5,
          'cli:nan': 'seven',
          'cli:zero': 0,
          'garbage:bad': 3,
        },
      }),
    )
    const map = instanceNumbers(['cli:good', 'cli:nan', 'cli:fresh'])
    expect(map.get('cli:good')).toBe(5)
    // The junk rows were dropped, so these are treated as brand new — and must land ABOVE 5, in
    // sorted-ref order ('cli:fresh' before 'cli:nan'), never reusing a number a valid row holds.
    expect(map.get('cli:fresh')).toBe(6)
    expect(map.get('cli:nan')).toBe(7)
    expect(allInstanceNumbers()['garbage:bad']).toBeUndefined()
  })
})

describe('parseInstanceNumber', () => {
  test('accepts the forms a human actually types', () => {
    expect(parseInstanceNumber(7)).toBe(7)
    expect(parseInstanceNumber('7')).toBe(7)
    expect(parseInstanceNumber('#7')).toBe(7)
    expect(parseInstanceNumber('  #7  ')).toBe(7)
  })

  test('rejects anything that is not purely a number', () => {
    // '7claude' is a plausible INSTANCE NAME on this machine (2claude…6claude exist). Reading it as
    // "instance 7" would resolve to an unrelated account, so it must fall through to the name match.
    expect(parseInstanceNumber('7claude')).toBeNull()
    expect(parseInstanceNumber('claude7')).toBeNull()
    expect(parseInstanceNumber('0')).toBeNull()
    expect(parseInstanceNumber('-3')).toBeNull()
    expect(parseInstanceNumber('7.5')).toBeNull()
    expect(parseInstanceNumber('')).toBeNull()
    expect(parseInstanceNumber(null)).toBeNull()
    expect(parseInstanceNumber(undefined)).toBeNull()
  })
})
