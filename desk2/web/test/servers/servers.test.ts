import { describe, expect, it } from 'bun:test'
import { type DevWebProject, folderContains, processAddress, projectForCwd } from '@shared/devwebui'
import { clampPane, isUp, loadPaneWidth, PANE_DEFAULT, PANE_KEY, PANE_MAX, PANE_MIN, paneView, parseAddress, statusDot, tailLines } from '../../src/components/servers/logic'

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
  it('with the daemon up: the list loading, unreadable, no project, or the chat project', () => {
    const running = { state: 'running' as const, url: 'http://127.0.0.1:4000' }
    expect(paneView({ ...base, status: running })).toEqual({ kind: 'loading' })
    expect(paneView({ ...base, status: running, projectsError: 'boom' })).toEqual({ kind: 'unreachable', reason: 'boom' })
    expect(paneView({ ...base, status: running, projects: [] })).toEqual({ kind: 'not-a-project' })
    expect(paneView({ ...base, status: running, projects }).kind).toBe('project')
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
