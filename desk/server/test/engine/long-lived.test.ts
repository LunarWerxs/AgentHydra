import { describe, expect, test } from 'bun:test'
import { isLongLived } from '../../src/engine/long-lived'

describe('long-lived background tasks', () => {
  test('a localhost server never ends, so it does not count', () => {
    expect(isLongLived({ command: 'npx serve -l 5180 # http://localhost:5180', description: '' })).toBe(true)
    expect(isLongLived({ command: 'python -m http.server --bind 127.0.0.1 8000', description: '' })).toBe(true)
    expect(isLongLived({ description: 'Serve the site on localhost' })).toBe(true)
  })

  test('work that finishes counts: a deploy, a test run, a build', () => {
    for (const command of ['bash scripts/deploy.sh', 'bun test', 'npm run build', 'curl -s https://nexascode.com'])
      expect(isLongLived({ command, description: '' })).toBe(false)
    expect(isLongLived({ description: 'Deploy the site to nexascode.com' })).toBe(false)
  })
})
