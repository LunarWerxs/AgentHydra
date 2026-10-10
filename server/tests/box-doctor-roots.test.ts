// server/src/box-doctor-roots.ts - the listing child really answers, and a path that did not answer
// never resolves an open incident. Every folder is a scratch fixture.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { driveRoots, probeRoots, rootFindings } from '../src/box-doctor-roots'

const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-box-roots-test-${crypto.randomUUID()}`
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('probeRoots', () => {
  test('the child process lists each path and says absent, empty or listed', async () => {
    const empty = join(scratch, 'empty')
    const full = join(scratch, 'full')
    mkdirSync(empty, { recursive: true })
    mkdirSync(full, { recursive: true })
    writeFileSync(join(full, 'a.txt'), 'a')
    const probes = await probeRoots([
      { role: 'search root', path: empty },
      { role: 'search root', path: full },
      { role: 'search root', path: join(scratch, 'gone') },
    ])
    expect(probes?.map((p) => p.state)).toEqual(['empty', 'listed', 'absent'])
  })
})

describe('rootFindings', () => {
  test('an unreadable root is a problem; one that did not answer is a note and is left out of checked', () => {
    const r = rootFindings([
      { role: 'drive of recent agent work', path: 'Z:\\', state: 'unreadable', error: 'EPERM' },
      { role: 'drive of recent agent work', path: 'Y:\\', state: 'timeout' },
      { role: 'search root', path: 'D:\\NEWProjects', state: 'empty' },
      { role: 'search root', path: 'D:\\PublicProjects', state: 'listed' },
    ])
    expect(r?.findings.map((f) => `${f.level}:${f.key}`)).toEqual([
      'problem:root:z:\\',
      'note:root-slow:y:\\',
      'note:root-empty:d:\\newprojects',
    ])
    expect(r?.checked).toEqual(['root:z:\\', 'root:d:\\newprojects', 'root:d:\\publicprojects'])
    expect(rootFindings(null)).toBeNull()
  })
})

describe('driveRoots', () => {
  test('one root per drive or share, whatever the case or depth of the folders under it', () => {
    expect(
      driveRoots([
        'D:\\repo\\a',
        'd:/repo/b',
        'C:\\Users\\me',
        '\\\\nas\\work\\proj',
        '\\\\NAS\\work\\other',
        'relative',
      ]),
    ).toEqual(['D:\\', 'C:\\', '\\\\nas\\work\\'])
  })
})
