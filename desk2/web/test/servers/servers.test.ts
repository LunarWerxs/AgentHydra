import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DevWebProcess, type DevWebProject, folderContains, processAddress, projectForCwd } from '@shared/devwebui'
import { allKey, clampPane, findServer, focusPlan, groupActions, groupServers, isUp, listView, loadPaneWidth, needsSetup, openable, openPlan, otherRunning, PANE_DEFAULT, PANE_KEY, PANE_MAX, PANE_MIN, paneView, parseAddress, type PaneTab, serverActions, serverPort, sortServers, statusDot, tailLines } from '../../src/components/servers/logic'

const project = (id: string, file: string): DevWebProject => ({ id, name: id, path: file, processes: [] })
const projects = [project('app', 'C:\\Users\\me\\Code\\App\\.devwebui'), project('inner', 'C:/Users/me/Code/App/packages/inner/.devwebui')]

describe('which project a chat folder belongs to', () => {
  it('matches the folder itself, ignoring case and slash direction', () => {
    expect(projectForCwd(projects, 'c:/users/ME/code/app')?.id).toBe('app')
    expect(projectForCwd(projects, 'C:\\Users\\me\\Code\\App\\')?.id).toBe('app')
  })
  it('matches a folder inside a project, and the deepest project wins', () => {
    expect(projectForCwd(projects, 'C:/Users/me/Code/App/src/lib')?.id).toBe('app')
    expect(projectForCwd(projects, 'C:/Users/me/Code/App/packages/inner/src')?.id).toBe('inner')
  })
  it('does not match a sibling that only shares a prefix, or a parent', () => {
    expect(folderContains('C:/Users/me/Code/App', 'C:/Users/me/Code/App2')).toBe(false)
    expect(projectForCwd(projects, 'C:/Users/me/Code')).toBeNull()
    expect(projectForCwd(projects, '')).toBeNull()
  })
})

describe('the pane for each state', () => {
  const base = { status: null, statusMissing: false, projects: null, projectsError: null, cwd: 'C:/Users/me/Code/App' }
  it('says restart when /dw/status is missing', () => {
    expect(paneView({ ...base, statusMissing: true })).toEqual({ kind: 'restart-desk' })
  })
  it('loads, then follows the daemon: starting, failed with its reason, stopped', () => {
    expect(paneView(base)).toEqual({ kind: 'loading' })
    expect(paneView({ ...base, status: { state: 'starting', url: null } })).toEqual({ kind: 'starting' })
    expect(paneView({ ...base, status: { state: 'failed', url: null, reason: 'bun install failed' } })).toEqual({ kind: 'failed', reason: 'bun install failed' })
    expect(paneView({ ...base, status: { state: 'stopped', url: null } })).toEqual({ kind: 'stopped' })
  })
  const running = { state: 'running' as const, url: 'http://127.0.0.1:4000' }
  it('with the daemon up: the list loading, unreadable, the folder being set up, or the chat project', () => {
    expect(paneView({ ...base, status: running })).toEqual({ kind: 'loading' })
    expect(paneView({ ...base, status: running, projectsError: 'boom' })).toEqual({ kind: 'unreachable', reason: 'boom' })
    expect(paneView({ ...base, status: running, projects: [] })).toEqual({ kind: 'looking' })
    expect(paneView({ ...base, status: running, projects }).kind).toBe('project')
  })
  it('sets a folder that is in no project up once, without an Add step, and shows what it answered', () => {
    const listed = { ...base, status: running, projects: [] }
    expect(needsSetup(listed)).toBe(true)
    expect(needsSetup({ ...listed, setup: { cwd: base.cwd, nothing: null } })).toBe(false)
    expect(paneView({ ...listed, setup: { cwd: base.cwd, nothing: null } })).toEqual({ kind: 'looking' })
    expect(paneView({ ...listed, setup: { cwd: base.cwd, nothing: 'Nothing to run here' } })).toEqual({ kind: 'nothing', reason: 'Nothing to run here' })
    // Asked about another folder: this one is asked about too.
    expect(needsSetup({ ...listed, setup: { cwd: 'C:/Users/me/Code/Other', nothing: 'Nothing to run here' } })).toBe(true)
    expect(needsSetup({ ...base, status: running, projects })).toBe(false)
    expect(needsSetup({ ...base, status: running })).toBe(false)
    expect(needsSetup({ ...base, status: { state: 'starting', url: null }, projects: [] })).toBe(false)
  })
})

describe('servers running elsewhere', () => {
  it("lists other projects' servers that answer, by name, and not this folder's own", () => {
    const proc = (id: string, status: 'running' | 'stopped', port?: number) => ({ id, name: id, command: 'npm run dev', cwd: '', port, status, exitCode: null, projectId: '' })
    const here = { ...project('here', 'C:/Users/me/Code/Here/.devwebui'), processes: [proc('mine', 'running', 3000)] }
    const there = { ...project('there', 'C:/Users/me/Code/There/.devwebui'), processes: [proc('web', 'running', 5173), proc('off', 'stopped', 4000), proc('worker', 'running'), proc('api', 'running', 8080)] }
    expect(otherRunning([here, there], here).map((r) => `${r.project.id}/${r.proc.id}`)).toEqual(['there/api', 'there/web'])
    expect(otherRunning([here], here)).toEqual([])
    expect(otherRunning(null, null)).toEqual([])
  })
  it("offers the browser's empty page this folder's answering servers first, then the others'", () => {
    const proc = (id: string, status: 'running' | 'stopped' | 'starting', port?: number) => ({ id, name: id, command: 'npm run dev', cwd: '', port, status, exitCode: null, projectId: '' })
    const here = { ...project('here', 'C:/Users/me/Code/Here/.devwebui'), processes: [proc('off', 'stopped', 3001), proc('mine', 'running', 3000), proc('coming', 'starting', 3002), proc('worker', 'running')] }
    const there = { ...project('there', 'C:/Users/me/Code/There/.devwebui'), processes: [proc('web', 'running', 5173)] }
    expect(openable([here, there], here).map((p) => p.id)).toEqual(['mine', 'web'])
    expect(openable([here, there], null).map((p) => p.id)).toEqual(['mine', 'web'])
    expect(openable(null, null)).toEqual([])
  })
})

describe('servers and the address bar', () => {
  it('dots and what a button does', () => {
    expect(statusDot('running')).toBe('run')
    expect(statusDot('crashed')).toBe('bad')
    expect(statusDot('waiting')).toBe('wait')
    expect(statusDot('stopped')).toBe('off')
    expect(isUp('starting')).toBe(true)
    expect(isUp('crashed')).toBe(false)
  })
  it('a server address comes from its url or its port', () => {
    expect(processAddress({ port: 3000 })).toBe('http://localhost:3000')
    expect(processAddress({ port: 3000, url: '/admin' })).toBe('http://localhost:3000/admin')
    expect(processAddress({ port: 3000, url: 'http://app.example.test/' })).toBe('http://app.example.test/')
    expect(processAddress({})).toBeNull()
  })
  it("a stopped server's Start goes to its page at once and starts it; one with no address waits until it answers", () => {
    expect(openPlan({ status: 'stopped', port: 1213 })).toEqual({ show: 'http://localhost:1213', start: true })
    expect(openPlan({ status: 'crashed', port: 1213, url: '/play' })).toEqual({ show: 'http://localhost:1213/play', start: true })
    expect(openPlan({ status: 'starting', port: 1213 })).toEqual({ show: 'http://localhost:1213', start: false })
    expect(openPlan({ status: 'running', port: 1213 })).toEqual({ show: 'http://localhost:1213', start: false })
    expect(openPlan({ status: 'stopped' })).toEqual({ show: null, start: true })
    const newTab = readFileSync(join(import.meta.dir, '../../src/components/servers/NewTab.vue'), 'utf8')
    expect(newTab).toContain(`@click="isUp(p.status) ? emit('toggle', p) : emit('server', p)"`)
  })
  it('reads what is typed: an address, host:port, a bare port, and refuses other schemes', () => {
    expect(parseAddress('localhost:5173/x')).toBe('http://localhost:5173/x')
    expect(parseAddress('3000')).toBe('http://localhost:3000/')
    expect(parseAddress('https://app.example.test')).toBe('https://app.example.test/')
    expect(parseAddress('javascript:alert(1)')).toBeNull()
    expect(parseAddress('  ')).toBeNull()
  })
  it('keeps the last non-empty output lines without colour codes', () => {
    expect(tailLines([{ line: '\x1b[31mboom\x1b[0m' }, { line: '' }, { line: 'again' }], 2)).toEqual(['boom', 'again'])
  })
})

describe('the pane width', () => {
  it('stays between the limits and a default when nothing sensible is saved', () => {
    expect(clampPane(100)).toBe(PANE_MIN)
    expect(clampPane(5000)).toBe(PANE_MAX)
    expect(clampPane(800, 600)).toBe(600)
    expect(loadPaneWidth({ getItem: () => null })).toBe(PANE_DEFAULT)
    expect(loadPaneWidth({ getItem: (k) => (k === PANE_KEY ? '640' : null) })).toBe(640)
    expect(loadPaneWidth({ getItem: () => '10' })).toBe(PANE_DEFAULT)
  })
})

// The sidebar's Dev servers list and its click, on the same logic as the pane.
describe('the Dev servers list', () => {
  const proc = (id: string, status: DevWebProcess['status'], port?: number, name = id): DevWebProcess => ({ id, name, command: 'npm run dev', cwd: '', port, status, exitCode: null, projectId: '' })
  const withProcs = (id: string, processes: DevWebProcess[], name = id): DevWebProject => ({ ...project(id, `C:/Users/me/Code/${id}/.devwebui`), name, processes })
  const running = { state: 'running' as const, url: 'http://127.0.0.1:4000' }
  const base = { status: null, statusMissing: false, projects: null, projectsError: null }

  it('shows each daemon state the pane does, and a list only once the projects are read', () => {
    expect(listView({ ...base, statusMissing: true })).toEqual({ kind: 'restart-desk' })
    expect(listView(base)).toEqual({ kind: 'loading' })
    expect(listView({ ...base, status: { state: 'starting', url: null } })).toEqual({ kind: 'starting' })
    expect(listView({ ...base, status: { state: 'failed', url: null } })).toEqual({ kind: 'failed', reason: 'it did not start' })
    expect(listView({ ...base, status: { state: 'stopped', url: null } })).toEqual({ kind: 'stopped' })
    expect(listView({ ...base, status: running })).toEqual({ kind: 'loading' })
    expect(listView({ ...base, status: running, projectsError: 'boom' })).toEqual({ kind: 'unreachable', reason: 'boom' })
    expect(listView({ ...base, status: running, projects: [] })).toEqual({ kind: 'empty' })
    expect(listView({ ...base, status: running, projects: [withProcs('a', [])] }).kind).toBe('list')
  })

  it('puts running servers first, then coming up, going down, crashed and stopped, by name inside each', () => {
    const procs = [proc('s1', 'stopped', 1, 'zeta'), proc('c1', 'crashed', 2, 'beta'), proc('r2', 'running', 3, 'web'), proc('w1', 'waiting', 4, 'db'), proc('r1', 'running', 5, 'api'), proc('x1', 'stopping', 6, 'queue'), proc('t1', 'starting', 7, 'cache')]
    expect(sortServers(procs).map((p) => p.name)).toEqual(['api', 'web', 'cache', 'db', 'queue', 'beta', 'zeta'])
  })

  it('groups by project: ones with a server running first, then by name, each with its running count', () => {
    const groups = groupServers([withProcs('p1', [proc('a', 'stopped')], 'Zulu'), withProcs('p2', [proc('b', 'running'), proc('c', 'stopped')], 'Mike'), withProcs('p3', [], 'Alpha'), withProcs('p4', [proc('d', 'crashed')], 'Bravo'), withProcs('p5', [proc('e', 'running')], 'Charlie')])
    expect(groups.map((g) => g.project.name)).toEqual(['Charlie', 'Mike', 'Alpha', 'Bravo', 'Zulu'])
    expect(groups.map((g) => g.running)).toEqual([1, 1, 0, 0, 0])
    expect(groups[1]?.servers.map((p) => p.id)).toEqual(['b', 'c'])
  })

  it('offers each row the buttons its status allows', () => {
    expect(serverActions('running')).toEqual(['stop', 'restart'])
    expect(serverActions('starting')).toEqual(['stop', 'restart'])
    expect(serverActions('waiting')).toEqual(['stop', 'restart'])
    expect(serverActions('stopped')).toEqual(['start'])
    expect(serverActions('crashed')).toEqual(['start', 'restart'])
    expect(serverActions('stopping')).toEqual([])
  })

  it("offers a header Start all / Stop all only for several servers, each while a server would act on it", () => {
    expect(groupActions([])).toEqual({ start: false, stop: false })
    expect(groupActions([proc('a', 'stopped')])).toEqual({ start: false, stop: false })
    expect(groupActions([proc('a', 'running'), proc('b', 'running')])).toEqual({ start: false, stop: true })
    expect(groupActions([proc('a', 'stopped'), proc('b', 'crashed')])).toEqual({ start: true, stop: false })
    expect(groupActions([proc('a', 'running'), proc('b', 'stopped')])).toEqual({ start: true, stop: true })
    expect(groupActions([proc('a', 'stopping'), proc('b', 'stopping')])).toEqual({ start: false, stop: false })
  })

  it('writes a port as :port, and nothing without one; a project keeps its own busy key', () => {
    expect(serverPort({ port: 5173 })).toBe(':5173')
    expect(serverPort({})).toBe('')
    expect(allKey({ id: 'p1' })).toBe('all:p1')
  })

  it('finds a server and its project in the shared list', () => {
    const list = [withProcs('p1', [proc('a', 'running')]), withProcs('p2', [proc('b', 'stopped')])]
    expect(findServer(list, 'b')?.project.id).toBe('p2')
    expect(findServer(list, 'nope')).toBeNull()
    expect(findServer(null, 'a')).toBeNull()
  })

  it('shows a clicked server: its tab when one is open, else the page of one that answers, else a started one', () => {
    const tabs: PaneTab[] = [{ id: 't1', kind: 'new', target: null, proc: null }, { id: 't2', kind: 'page', target: 'http://localhost:3000', proc: 'web' }]
    expect(focusPlan(proc('web', 'running', 3000), tabs)).toEqual({ kind: 'pick', tab: 't2' })
    // An open tab wins even when the server stopped since: the tab says so over its page.
    expect(focusPlan(proc('web', 'stopped', 3000), tabs)).toEqual({ kind: 'pick', tab: 't2' })
    expect(focusPlan(proc('api', 'running', 8080), tabs)).toEqual({ kind: 'open', url: 'http://localhost:8080' })
    expect(focusPlan(proc('api', 'stopped', 8080), tabs)).toEqual({ kind: 'start' })
    expect(focusPlan(proc('api', 'starting', 8080), tabs)).toEqual({ kind: 'start' })
    expect(focusPlan(proc('worker', 'running'), tabs)).toEqual({ kind: 'start' })
  })
})
