// server/tests/no-chats.ts — a PC with no desktop chats, for every test that sets up login sync. The chat
// half runs from setup on (owner, 2026-10-05: "sync desktop chat should be default on"), and the real
// ChatLocal reads this PC's own Claude Desktop profiles and ~/.claude/projects, and lands the store's
// chats in them. Importing this installs it; a test that brings its own puts this one back after.
import { setChatLocalForTests } from '../src/core/cli-login-sync'
import type { ChatLocal } from '../src/core/desktop-chat-types'

export const noChats: ChatLocal = {
  list: () => [],
  read: () => new Uint8Array(),
  size: () => 0,
  append: () => false,
  land: async () => ({ ok: false, reason: 'no desktop app in a test', retry: false }),
}
setChatLocalForTests(noChats)
