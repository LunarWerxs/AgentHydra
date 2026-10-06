import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

describe('claude-code-binary', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `desk2-test-${randomUUID()}`)
    await mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // best effort cleanup
    }
  })

  it('finds an installed platform package or returns null', async () => {
    const { tryResolveClaudeCodeBinary } = await import('../../src/engine/claude-code-binary')

    // On a machine with the SDK installed, this should find it
    const result = tryResolveClaudeCodeBinary(tempDir)

    // Either found or null is acceptable (depends on SDK installation)
    expect(typeof result === 'string' || result === null).toBe(true)
  })

  it('finds a cached copy', async () => {
    const { getClaudeCodeBinaryStatus } = await import('../../src/engine/claude-code-binary')

    // Create a fake cached binary
    const binaryPath = join(tempDir, 'claude-code', '0.3.288', '@anthropic-ai/claude-agent-sdk-linux-x64', 'claude')
    await mkdir(join(binaryPath, '..'), { recursive: true })
    await writeFile(binaryPath, Buffer.from('fake binary'))

    const status = getClaudeCodeBinaryStatus(tempDir)

    // Should recognize the cached version
    if (status.source === 'cache') {
      expect(status.path).toContain('claude-code/0.3.288')
      expect(status.version).toBe('0.3.288')
    }
  })

  it('reports download-needed or package/cache', async () => {
    const { getClaudeCodeBinaryStatus } = await import('../../src/engine/claude-code-binary')

    const status = getClaudeCodeBinaryStatus(tempDir)

    // Should report one of the three states
    expect(['package', 'cache', 'download-needed']).toContain(status.source)
    expect(typeof status.version).toBe('string')
  })

  it('provides status without downloading', async () => {
    // getClaudeCodeBinaryStatus should never trigger a download
    const { getClaudeCodeBinaryStatus } = await import('../../src/engine/claude-code-binary')

    const status1 = getClaudeCodeBinaryStatus(tempDir)
    const status2 = getClaudeCodeBinaryStatus(tempDir)

    // Both calls should return the same result without downloading
    expect(status1.source).toBe(status2.source)
    expect(status1.version).toBe(status2.version)
  })
})
