// server/tests/chat-store-label.test.ts - /api/chats maps an instance to the label collectChats
// actually files its chats under.
//
// ⛔ THE DEFAULT INSTALL IS NOT LABELLED BY ITS FOLDER. collectChats (chat-dossier.ts) files the
// non-isolated Claude Desktop install under the literal `default`, and every isolated instance
// under its folder name. The route took basename() for both, which is right for nine rows out of
// ten and wrong for the one everybody has: the default row's dir is `.../AppData/Roaming/Claude`,
// whose basename is `Claude` - a label no scan ever produces. `?instance=` for the regular install
// therefore answered 404 "no desktop instance matched", i.e. "that account does not exist", for the
// account most people are using. Found by review 2026-09-07, before the Instances "Chats" dialog
// shipped on top of it.
//
// The two halves are pinned together deliberately: this test is only meaningful while it agrees
// with collectChats, so it derives BOTH sides from the same helpers rather than hardcoding a path.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { defaultClaudeUserDataDir } from '../src/core/paths'
import { chatStoreLabel } from '../src/routes/sessions'

test('the default Claude Desktop install maps to the label collectChats files it under', () => {
  expect(chatStoreLabel(defaultClaudeUserDataDir())).toBe('default')
})

test('a trailing separator does not change the answer', () => {
  expect(chatStoreLabel(`${defaultClaudeUserDataDir()}\\`)).toBe('default')
  expect(chatStoreLabel(`${defaultClaudeUserDataDir()}/`)).toBe('default')
})

// Windows path comparison is case-insensitive, and the instance registry stores dirs lowercased
// while the paths helper builds them from %APPDATA% as the OS spells it. Comparing them literally
// would reintroduce the same 404 on exactly the machines this runs on.
test('the comparison folds case, as Windows paths do', () => {
  expect(chatStoreLabel(defaultClaudeUserDataDir().toLowerCase())).toBe('default')
  expect(chatStoreLabel(defaultClaudeUserDataDir().toUpperCase())).toBe('default')
})

test('an isolated instance is still labelled by its folder name', () => {
  expect(chatStoreLabel(join('C:\\Users\\me\\.claude-instances', 'carlos'))).toBe('carlos')
  expect(chatStoreLabel('C:\\Users\\me\\.claude-instances\\rando stuff\\')).toBe('rando stuff')
})

// A folder that happens to be CALLED "Claude" but is not the default user-data dir is an ordinary
// isolated instance, and must keep its own name.
test('a non-default folder named Claude is not the default install', () => {
  expect(chatStoreLabel('C:\\Users\\me\\.claude-instances\\Claude')).toBe('Claude')
})
