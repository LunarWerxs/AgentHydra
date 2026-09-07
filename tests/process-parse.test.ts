// --user-data-dir extraction from a process command line (server/src/core/process.ts). The flag
// is quoted three different ways depending on how the instance was launched; discovery must parse
// all three, or an instance whose profile path contains a space shows up "stopped" / as a bogus
// external row. The whole-token-quoted case is the one the previous single-regex parser truncated
// at the first space — the string in that test is the exact CommandLine Bun.spawn/libuv produces
// for a space-containing argv element (verified live 2026-07).

import { describe, expect, test } from 'bun:test'
import { extractUserDataDir } from '../server/src/core/process'

const CLAUDE = 'C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.20186.1\\claude.exe'

describe('extractUserDataDir', () => {
  test('unquoted, space-free (openInstance, common case)', () => {
    const cmd = `"${CLAUDE}" --user-data-dir=C:\\Users\\me\\.claude-instances\\work`
    expect(extractUserDataDir(cmd)).toBe('C:\\Users\\me\\.claude-instances\\work')
  })

  test('value-quoted, space-free (desktop-shortcut .lnk form)', () => {
    const cmd = `"${CLAUDE}" --user-data-dir="c:\\users\\me\\.claude-instances\\work"`
    expect(extractUserDataDir(cmd)).toBe('c:\\users\\me\\.claude-instances\\work')
  })

  test('value-quoted WITH a space keeps the whole path', () => {
    const cmd = `"${CLAUDE}" --user-data-dir="C:\\Users\\Foo Bar\\.claude-instances\\my inst"`
    expect(extractUserDataDir(cmd)).toBe('C:\\Users\\Foo Bar\\.claude-instances\\my inst')
  })

  test('whole-token-quoted WITH a space is NOT truncated (the regression this fixes)', () => {
    // Exactly what Bun.spawn/libuv emits when the argv element contains a space.
    const cmd = `"${CLAUDE}" "--user-data-dir=C:\\Temp\\a b\\claude-instances\\my inst"`
    expect(extractUserDataDir(cmd)).toBe('C:\\Temp\\a b\\claude-instances\\my inst')
  })

  test('stops at the next flag when unquoted and followed by more switches', () => {
    const cmd = `"${CLAUDE}" --type=renderer --user-data-dir=C:\\x\\work --standard-schemes=app`
    expect(extractUserDataDir(cmd)).toBe('C:\\x\\work')
  })

  test('whole-token-quoted with a space, followed by more switches', () => {
    const cmd = `"${CLAUDE}" "--user-data-dir=C:\\a b\\c" --type=gpu-process --gpu-preferences=xyz`
    expect(extractUserDataDir(cmd)).toBe('C:\\a b\\c')
  })

  test('real child-process line (crashpad-handler, unquoted, trailing args)', () => {
    const cmd =
      `${CLAUDE} --type=crashpad-handler ` +
      '--user-data-dir=C:\\Users\\me\\AppData\\Local\\Temp\\cmui-verify-11348 ' +
      '/prefetch:4 --no-rate-limit --database=C:\\Users\\me\\AppData\\Local\\Temp\\cmui-verify-11348\\Crashpad'
    expect(extractUserDataDir(cmd)).toBe('C:\\Users\\me\\AppData\\Local\\Temp\\cmui-verify-11348')
  })

  test('returns null when the flag is absent', () => {
    expect(extractUserDataDir(`"${CLAUDE}" --some-other-flag=1`)).toBeNull()
    expect(extractUserDataDir('')).toBeNull()
  })
})
