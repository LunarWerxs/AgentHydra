// server/src/box-doctor.ts - the machine doctor: which PATH shims, console hosts, memory readings and
// reaper alerts become incidents, and which never do. Every folder is a scratch fixture; nothing here
// reads the real PATH or records into the real incidents table.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-box-doctor-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = join(scratch, 'home')

const { hoardFindings, leakedPtyHosts, memoryFindings, pathShimFindings, syncBoxIncidents } =
  await import('../src/box-doctor')

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const NPM_NATIVE_SHIM = (rel: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${rel}"   %*\r\n`
const NPM_NODE_SHIM = `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\typescript\\bin\\tsc" %*\r\n`

function folder(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

describe('pathShimFindings', () => {
  test('flags a command whose first match on PATH is a shim fronting a native exe, and nothing PATH order or PATHEXT order already sends to an exe', () => {
    const npm = folder('npm', {
      'bun.cmd': NPM_NATIVE_SHIM('node_modules\\bun\\bin\\bun.exe'),
      'node_modules/bun/bin/bun.exe': 'MZ',
      'esbuild.cmd': NPM_NATIVE_SHIM('node_modules\\esbuild\\esbuild.exe'),
      'node_modules/esbuild/esbuild.exe': 'MZ',
      'tsc.cmd': NPM_NODE_SHIM,
      'gone.cmd': NPM_NATIVE_SHIM('node_modules\\gone\\gone.exe'),
      'twin.cmd': NPM_NATIVE_SHIM('node_modules\\twin\\twin.exe'),
      'node_modules/twin/twin.exe': 'MZ',
      'twin.exe': 'MZ',
    })
    const earlier = folder('tools', { 'esbuild.exe': 'MZ' })
    const keys = (dirs: string[]) => pathShimFindings(dirs).map((f) => f.key)

    // esbuild: an earlier folder's exe wins. tsc: runs a script through node, no exe to point at.
    // gone: the exe it fronts is missing. twin: its own folder's exe outranks the .cmd.
    expect(keys([earlier, npm])).toEqual(['path-shim:bun'])
    // The same shim AFTER the folder holding the real exe never runs.
    expect(keys([join(npm, 'node_modules', 'bun', 'bin'), npm, earlier])).toEqual([
      'path-shim:esbuild',
    ])
    expect(pathShimFindings([earlier, npm])[0]?.message).toContain(
      join(npm, 'node_modules', 'bun', 'bin'),
    )
  })
})

describe('leakedPtyHosts', () => {
  test("counts headless hosts beyond the live shells under Claude's NodeService only", () => {
    const table = [
      { pid: 1, ppid: 0, name: 'claude.exe' }, // main
      { pid: 2, ppid: 1, name: 'claude.exe' }, // NodeService utility
      { pid: 3, ppid: 1, name: 'claude.exe' }, // GPU process: its conhost is not a terminal
      ...[10, 11, 12, 13, 14].map((pid) => ({ pid, ppid: 2, name: 'conhost.exe' })),
      { pid: 20, ppid: 2, name: 'pwsh.exe' },
      { pid: 21, ppid: 2, name: 'bash.exe' },
      { pid: 30, ppid: 3, name: 'conhost.exe' },
      { pid: 31, ppid: 3, name: 'conhost.exe' },
    ]
    const cmd = new Map<number, string>([
      [2, 'claude.exe --type=utility --utility-sub-type=node.mojom.NodeService'],
      [3, 'claude.exe --type=gpu-process'],
      ...[10, 11, 12, 13].map(
        (pid) =>
          [pid, '\\??\\C:\\WINDOWS\\system32\\conhost.exe --headless --width 80'] as [
            number,
            string,
          ],
      ),
      [14, 'C:\\WINDOWS\\system32\\conhost.exe 0xffffffff -ForceV1'],
      [30, 'C:\\WINDOWS\\system32\\conhost.exe --headless'],
      [31, 'C:\\WINDOWS\\system32\\conhost.exe --headless'],
    ])
    // Four headless hosts under the NodeService, two live shells: two leaked. The GPU process's
    // headless hosts and the NodeService's non-headless one are not counted.
    expect(leakedPtyHosts(table, (pid) => cmd.get(pid))).toBe(2)
  })
})

describe('memoryFindings', () => {
  const at = (share: number) => ({
    freeBytes: 1,
    totalBytes: 1,
    commitFreeBytes: share * 1000,
    commitLimitBytes: 1000,
  })
  const read = (share: number, open: boolean) =>
    memoryFindings(at(share), open)!.map((f) => `${f.level}:${f.key}`)

  test('the commit incident opens under 5%, holds until 8% once open, and 5-12% is only a note', () => {
    expect(read(0.04, false)).toEqual(['problem:commit'])
    expect(read(0.06, false)).toEqual(['note:commit-low'])
    expect(read(0.06, true)).toEqual(['problem:commit'])
    expect(read(0.09, true)).toEqual(['note:commit-low'])
    expect(read(0.2, true)).toEqual([])
    // Unreadable is "could not look", never "fine": the open incident must not resolve on it.
    expect(memoryFindings({ ...at(0.01), commitLimitBytes: null }, true)).toBeNull()
  })
})

describe('hoardFindings', () => {
  test('reports a pile the reaper wrote only while its parent lives', () => {
    const doc = JSON.stringify({
      at: '2026-10-10T01:00:00',
      hoards: [
        {
          key: 'claude.exe:7:conhost.exe',
          parent: 'claude.exe',
          parentPid: 7,
          child: 'conhost.exe',
        },
        { key: 'node.exe:8:cmd.exe', parent: 'node.exe', parentPid: 8, child: 'cmd.exe' },
      ],
    })
    expect(hoardFindings(doc, new Set([7]))!.map((f) => f.key)).toEqual([
      'hoard:claude.exe:7:conhost.exe',
    ])
    expect(hoardFindings('{not json', new Set([7]))).toBeNull()
  })
})

describe('syncBoxIncidents', () => {
  test('records each problem, never a note, and resolves a gone problem only where its check ran', async () => {
    const recorded: string[] = []
    const resolved: string[] = []
    const deps = {
      record: (async (o: { key: string }) => {
        recorded.push(o.key)
        if (o.key === 'reaper') throw new Error('database is locked')
        return { id: `i-${o.key}`, isNew: true }
      }) as never,
      notify: (async () => ({})) as never,
      openKeys: () => [
        { id: 'i-commit', key: 'commit' },
        { id: 'i-old', key: 'path-shim:bun' },
        { id: 'i-pile', key: 'hoard:node.exe:8:cmd.exe' },
        { id: 'i-hosts', key: 'pty-hosts' },
      ],
      resolve: (id: string) => {
        resolved.push(id)
        return true
      },
    }
    const n = await syncBoxIncidents(
      {
        findings: [
          { key: 'reaper', level: 'problem', message: 'x' },
          { key: 'commit', level: 'problem', message: 'x' },
          { key: 'processes', level: 'note', message: '1 processes running.' },
        ],
        // The process table could not be read this pass: no pty-hosts or hoard check ran.
        checked: ['path-shim:', 'commit', 'reaper'],
      },
      deps,
    )
    // The reaper's failed write did not stop commit's, nor the resolving after it.
    expect(recorded).toEqual(['reaper', 'commit'])
    expect(resolved).toEqual(['i-old'])
    expect(n).toBe(1)
  })
})
