import { describe, expect, test } from 'bun:test'
import type { ToolCaller } from '../../../src/browser/agent/contract'
import { ToolInputError } from '../../../src/browser/agent/errors'
import { navigate } from '../../../src/browser/agent/navigate'

const caller: ToolCaller = { chat: 'chat-1', cwd: 'C:/Users/me/proj' }

describe('browser_navigate refuses a call it cannot run before it touches a Chrome', () => {
  test('a missing url is a tool input error', async () => {
    await expect(navigate({}, caller)).rejects.toBeInstanceOf(ToolInputError)
    await expect(navigate({ url: '   ' }, caller)).rejects.toBeInstanceOf(ToolInputError)
  })

  test('an attachPort that is not a port is a tool input error', async () => {
    await expect(navigate({ url: 'https://example.com', attachPort: 70000 }, caller)).rejects.toBeInstanceOf(ToolInputError)
    await expect(navigate({ url: 'https://example.com', attachPort: 'x' }, caller)).rejects.toBeInstanceOf(ToolInputError)
  })
})
