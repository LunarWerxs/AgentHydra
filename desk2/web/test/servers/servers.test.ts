import { describe, expect, it } from 'bun:test'
import { type DevWebProject, folderContains, processAddress, projectForCwd } from '@shared/devwebui'
import { clampPane, isUp, loadPaneWidth, needsSetup, openable, otherRunning, PANE_DEFAULT, PANE_KEY, PANE_MAX, PANE_MIN, paneView, parseAddress, statusDot, tailLines } from '../../src/components/servers/logic'

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
