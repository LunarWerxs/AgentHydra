import { describe, expect, test } from 'bun:test'
import { pathLike, revealTarget } from '../../src/components/transcript/lib/reveal'

describe('pathLike', () => {
  test('Windows drive paths with either slash, quoted or backticked', () => {
    expect(pathLike('C:/Users/me/.agenthydra/corch/handoffs/w-1234.md')).toBe('C:/Users/me/.agenthydra/corch/handoffs/w-1234.md')
    expect(pathLike('C:\\Users\\me\\out\\run.mp4')).toBe('C:\\Users\\me\\out\\run.mp4')
    expect(pathLike('`C:/Users/me/My Videos/clip.mp4`')).toBe('C:/Users/me/My Videos/clip.mp4')
    expect(pathLike('"C:\\Users\\me\\notes.txt"')).toBe('C:\\Users\\me\\notes.txt')
    expect(pathLike('C:/Users/me/app')).toBe('C:/Users/me/app')
    expect(pathLike('C:/Users/me/src/a.ts:42:7')).toBe('C:/Users/me/src/a.ts')
  })
  test('paths relative to the chat folder', () => {
    expect(pathLike('out/demo.mp4')).toBe('out/demo.mp4')
    expect(pathLike('..\\shots\\a.png')).toBe('..\\shots\\a.png')
    expect(pathLike('./build/')).toBe('./build/')
    expect(pathLike('README.md')).toBe('README.md')
  })
  test('not URLs, network paths or ordinary words', () => {
    for (const t of ['https://example.com/a/b.png', 'file:///C:/a/b.txt', '\\\\host\\share\\a.txt', '//host/share/a.txt', '/usr/bin/x', 'and/or', 'console.log', 'a.length', 'hello', 'npm run build', 'src/lib', '1/2', 'C:', 'a|b/c.txt', '']) {
      expect(pathLike(t)).toBeNull()
    }
  })
})

type Attrs = Record<string, string>
function el(opts: { matches?: Record<string, Attrs>; text?: string; href?: string; inPre?: boolean }) {
  const node: any = {
    textContent: opts.text ?? '',
    getAttribute: (n: string) => (n === 'href' ? (opts.href ?? null) : null),
    closest(sel: string) {
      for (const [key, attrs] of Object.entries(opts.matches ?? {})) {
        if (sel.includes(key)) return { ...node, getAttribute: (n: string) => attrs[n] ?? null }
      }
      if (sel === 'a[href]' && opts.href !== undefined) return node
      if (sel === 'code' && opts.text !== undefined && opts.href === undefined) return { ...node, closest: (s: string) => (s.includes('pre') && opts.inPre ? node : null) }
      return null
    },
  }
  return node
}

describe('revealTarget', () => {
  test('a cached video or picture without a known source still offers the media id', () => {
    expect(revealTarget(el({ matches: { 'video[src^': { src: '/api/media/abc.mp4' } } }))).toEqual({ media: '/api/media/abc.mp4', path: null })
  })
  test('a known source file wins', () => {
    expect(revealTarget(el({ matches: { 'data-reveal-path': { 'data-reveal-path': 'C:/Users/me/a.mp4' } } }))).toEqual({ media: null, path: 'C:/Users/me/a.mp4' })
  })
  test('an inline code span that is a path, not every code span', () => {
    expect(revealTarget(el({ text: 'C:/Users/me/a.md' }))).toEqual({ media: null, path: 'C:/Users/me/a.md' })
    expect(revealTarget(el({ text: 'const x = 1' }))).toBeNull()
    expect(revealTarget(el({ text: 'C:/Users/me/a.md', inPre: true }))).toBeNull()
  })
  test('a plain link to a local path, not a web link', () => {
    expect(revealTarget(el({ href: 'out/report.html', text: 'report' }))).toEqual({ media: null, path: 'out/report.html' })
    expect(revealTarget(el({ href: 'https://example.com/a.html', text: 'C:/Users/me/a.md' }))).toBeNull()
  })
  test('nothing else', () => {
    expect(revealTarget(null)).toBeNull()
    expect(revealTarget(el({}))).toBeNull()
  })
})
