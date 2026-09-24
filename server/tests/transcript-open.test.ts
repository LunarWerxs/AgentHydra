// Regression guard for the "Open the session file" fix: .jsonl has no OS file association, so the
// old bare `cmd /c start "" <path>` popped Windows' "Pick an app" dialog instead of opening. These
// pin buildTranscriptOpenArgv's per-OS argv shape (esp. the win32 `start` TITLE '' argument, whose
// absence silently opens a blank console instead of the editor) and the auto-detect/floor chain.
import { expect, test } from 'bun:test'
import {
  buildTranscriptOpenArgv,
  detectWindowsEditor,
  resolveEditor,
  windowsEditorCandidates,
} from '../src/transcript-open'

const ENV = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }
const FILE = 'C:\\Users\\me\\.claude\\projects\\proj\\abc123.jsonl'

const VSCODE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
const CURSOR = 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe'
const NOTEPADPP = 'C:\\Program Files\\Notepad++\\notepad++.exe'
const SUBLIME = 'C:\\Program Files\\Sublime Text\\subl.exe'

function existsOnly(...paths: string[]) {
  const set = new Set(paths)
  return (p: string) => set.has(p)
}

test('windowsEditorCandidates: VS Code (user install) leads, in the documented order', () => {
  expect(windowsEditorCandidates(ENV)).toEqual([
    VSCODE,
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    CURSOR,
    NOTEPADPP,
    SUBLIME,
  ])
})

test('detectWindowsEditor: picks VS Code when its path exists', () => {
  expect(detectWindowsEditor(ENV, existsOnly(VSCODE, NOTEPADPP))).toBe(VSCODE)
})

test('detectWindowsEditor: falls back through the list when earlier candidates are missing', () => {
  expect(detectWindowsEditor(ENV, existsOnly(SUBLIME))).toBe(SUBLIME)
  expect(detectWindowsEditor(ENV, existsOnly(NOTEPADPP, SUBLIME))).toBe(NOTEPADPP)
})

test('detectWindowsEditor: floors at notepad when nothing on the list exists', () => {
  expect(detectWindowsEditor(ENV, () => false)).toBe('notepad')
})

test('win32: a whitespace-only editor setting counts as empty (falls through to auto-detect)', () => {
  const argv = buildTranscriptOpenArgv('win32', FILE, '   ', ENV, existsOnly(VSCODE))
  expect(argv).toEqual(['cmd', '/c', 'start', '', VSCODE, FILE])
})

test('win32: auto-detect floors at notepad, and the argv never asks the OS to guess', () => {
  const argv = buildTranscriptOpenArgv('win32', FILE, '', ENV, () => false)
  expect(argv).toEqual(['cmd', '/c', 'start', '', 'notepad', FILE])
})

test("win32: the `start` TITLE '' argument sits between 'start' and the editor, always", () => {
  const argv = buildTranscriptOpenArgv('win32', FILE, '', ENV, () => false)
  expect(argv[2]).toBe('start')
  expect(argv[3]).toBe('') // TITLE. Omitting this makes `start` treat the editor path as the
  // title and open a blank console instead of the editor.
  expect(argv[4]).toBe('notepad')
})

test('darwin: explicit editor uses `open -a`', () => {
  const argv = buildTranscriptOpenArgv(
    'darwin',
    FILE,
    '/Applications/TextMate.app',
    ENV,
    () => true,
  )
  expect(argv).toEqual(['open', '-a', '/Applications/TextMate.app', FILE])
})

const PER_OS: [string, NodeJS.Platform, string, string[]][] = [
  [
    'win32: explicit editor setting overrides auto-detection entirely',
    'win32',
    'D:\\tools\\subl.exe',
    ['cmd', '/c', 'start', '', 'D:\\tools\\subl.exe', FILE],
  ],
  [
    'darwin: no editor uses `open -t` (default text editor, never a picker)',
    'darwin',
    '',
    ['open', '-t', FILE],
  ],
  ['linux: explicit editor is spawned directly', 'linux', '/usr/bin/code', ['/usr/bin/code', FILE]],
  ['linux: no editor falls back to xdg-open', 'linux', '', ['xdg-open', FILE]],
]
test.each(PER_OS)('%s', (_case, platform, editor, argv) => {
  expect(buildTranscriptOpenArgv(platform, FILE, editor, ENV, () => true)).toEqual(argv)
})

// A dead override is the ONE way this plain text field can bite: `start` reports "cannot find the
// file" on the console the daemon deliberately hides, so it exits 0, the spawn succeeds, the route
// answers ok, and the button silently does nothing forever. Falling back keeps it working, and
// resolveEditor is what Settings shows so the fallback is visible rather than a lie.
test('win32: an override pointing at nothing falls back to auto-detect, never a silent no-op', () => {
  const argv = buildTranscriptOpenArgv(
    'win32',
    FILE,
    'C:\\Users\\me\\Typo\\Code.exe',
    ENV,
    existsOnly(VSCODE),
  )
  expect(argv).toEqual(['cmd', '/c', 'start', '', VSCODE, FILE])
})

test('win32: a bare command name is passed through unchecked (start resolves it on PATH)', () => {
  // `exists('notepad')` is false for a PATH name, so an existence check would wrongly discard it.
  const argv = buildTranscriptOpenArgv('win32', FILE, 'notepad', ENV, existsOnly(VSCODE))
  expect(argv[4]).toBe('notepad')
})

test('win32: an override that DOES exist is honoured', () => {
  const mine = 'C:\\Tools\\ed.exe'
  expect(resolveEditor('win32', mine, ENV, existsOnly(mine, VSCODE))).toBe(mine)
})

test('resolveEditor reports what will actually run, so Settings can surface a discarded override', () => {
  expect(resolveEditor('win32', '', ENV, existsOnly(VSCODE))).toBe(VSCODE)
  expect(resolveEditor('win32', 'C:\\gone\\x.exe', ENV, existsOnly(VSCODE))).toBe(VSCODE)
  expect(resolveEditor('win32', '   ', ENV, existsOnly(VSCODE))).toBe(VSCODE)
  // non-win32 never path-checks: `open -a` takes an app NAME, and a linux editor may be on PATH.
  expect(resolveEditor('darwin', 'Visual Studio Code', ENV, () => false)).toBe('Visual Studio Code')
  expect(resolveEditor('linux', 'gedit', ENV, () => false)).toBe('gedit')
})
