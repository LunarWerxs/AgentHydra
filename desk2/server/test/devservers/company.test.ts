// The company the sidebar's Dev servers list groups a folder under (company.ts), on an invented tree, and the project
// folder a server's command line names. No real folder is read.

import { expect, test } from 'bun:test'
import { commandDir, companyFrom, type CompanyChecks } from '../../src/devservers/company'

// Folders with a project file, and how many folders each listed folder holds (anything else: none, no project file).
const MARKED = new Set(['D:/Code/AgentHydra', 'D:/Code/AgentHydra/app', 'D:/Code/AgentHydra/copy-2', 'D:/Work/active/Shop', 'C:/Users/me', 'D:/Big/one'])
const FOLDERS: Record<string, number> = { 'D:/Code': 3, 'D:/Code/Example Social': 2, 'D:/Work': 4, 'D:/Work/active': 3, 'D:/Big': 20, 'C:/Users': 3 }
const checks: CompanyChecks = { marked: (d) => MARKED.has(d), folders: (d) => FOLDERS[d] ?? 0, home: 'C:/Users/me' }
const of = (dir: string) => companyFrom(dir, checks)

test("a project folder is its own company, and every copy or app inside it is that company's", () => {
  expect(of('D:/Code/AgentHydra')).toEqual({ name: 'AgentHydra', dir: 'D:/Code/AgentHydra' })
  expect(of('D:\\Code\\AgentHydra\\copy-2\\server\\examples')).toEqual({ name: 'AgentHydra', dir: 'D:/Code/AgentHydra' })
  expect(of('D:/Code/AgentHydra/app/').dir).toBe('D:/Code/AgentHydra')
})

test('a folder named like a container, or holding a dozen folders, is passed through to the folder below it', () => {
  expect(of('D:/Work/active/Shop/web').name).toBe('Shop')
  expect(of('D:/Big/one/web').name).toBe('one')
})

test('a folder with no project file that holds a few projects is the company they share', () => {
  expect(of('D:/Code/Example Social/website').name).toBe('Example Social')
})

test('the home folder and the folders above it are never a company, though the home folder holds a project file', () => {
  expect(of('C:/Users/me/runner/_work/site')).toEqual({ name: 'runner', dir: 'C:/Users/me/runner' })
  expect(of('C:\\Users\\me')).toEqual({ name: 'Home', dir: 'C:/Users/me' })
})

test('a folder that is all containers is its own company', () => {
  expect(of('D:/Work/active')).toEqual({ name: 'active', dir: 'D:/Work/active' })
})

test('a drive root, a lower-case drive letter and a network share are walked from their root', () => {
  expect(of('D:/')).toEqual({ name: 'D:', dir: 'D:' })
  expect(of('D:\\')).toEqual({ name: 'D:', dir: 'D:' })
  expect(of('d:\\code\\agenthydra\\web')).toEqual({ name: 'agenthydra', dir: 'D:/code/agenthydra' })
  expect(of('\\\\nas\\share\\Shop\\web')).toEqual({ name: 'Shop', dir: '//nas/share/Shop' })
})

const DISK: Record<string, 'file' | 'dir'> = {
  'C:\\Program Files\\nodejs\\node.exe': 'file',
  'D:\\Code\\site\\server.js': 'file',
  'D:/Code/site/node_modules/vite/bin/vite.js': 'file',
  'D:/Code/site': 'dir',
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\serve\\build\\main.js': 'file'
}
const kind = (p: string) => DISK[p] ?? null

test("a server's folder is the first path after its program that is on disk, raised out of node_modules", () => {
  expect(commandDir('"C:\\Program Files\\nodejs\\node.exe" D:\\Code\\site\\server.js --port 3000', kind)).toBe('D:/Code/site')
  expect(commandDir('node D:/Code/site/node_modules/vite/bin/vite.js', kind)).toBe('D:/Code/site')
  expect(commandDir('python -m http.server --directory=D:/Code/site 8000', kind)).toBe('D:/Code/site')
  expect(commandDir('node --env-file=C:/Users/me/.env D:\\Code\\site\\server.js', (p) => (p.endsWith('.env') ? 'file' : kind(p)))).toBe('D:/Code/site')
})

test('no folder when the command line names none on disk, or only a tool of its own', () => {
  expect(commandDir('bun run dev', kind)).toBeNull()
  expect(commandDir('node D:/Code/gone/server.js', kind)).toBeNull()
  expect(commandDir('node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\serve\\build\\main.js', kind)).toBeNull()
  expect(commandDir(null, kind)).toBeNull()
})
