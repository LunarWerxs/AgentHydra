import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatGptContextPack } from '../src/context-pack'

test('ChatGPT context pack is bounded, useful, and omits likely secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenthydra-context-pack-'))
  try {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'README.md'), '# Example repository')
    writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = true\n```nested```')
    writeFileSync(join(root, '.env'), 'API_TOKEN=never-send-this')
    writeFileSync(join(root, 'secret.ts'), 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz1234"')
    writeFileSync(join(root, 'node_modules', 'dependency.js'), 'do not include')
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))

    const pack = createChatGptContextPack(root, 'Review the feature implementation')

    expect(pack.filename).toEndWith('-chatgpt-context.md')
    expect(pack.prompt).toContain('Review the feature implementation')
    expect(pack.content).toContain('README.md')
    expect(pack.content).toContain('src/feature.ts')
    expect(pack.content).toContain('````ts')
    expect(pack.content).not.toContain('never-send-this')
    expect(pack.content).not.toContain('sk-proj-')
    expect(pack.content).not.toContain('node_modules/dependency.js')
    expect(pack.includedFiles).toContain('src/feature.ts')
    expect(pack.omittedFiles).toBeGreaterThanOrEqual(3)
    expect(pack.estimatedTokens).toBeGreaterThan(0)
    expect(pack.warnings.join(' ')).toContain('sensitive')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ChatGPT context pack rejects a missing working directory', () => {
  expect(() =>
    createChatGptContextPack(join(tmpdir(), crypto.randomUUID()), 'Review this project'),
  ).toThrow('Working directory does not exist.')
})
