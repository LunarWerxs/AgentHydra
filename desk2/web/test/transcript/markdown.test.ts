import { describe, expect, test } from 'bun:test'
import { createMarkdown, renderMarkdown } from '../../src/components/transcript/lib/markdown'

describe('markdown', () => {
  test('raw HTML in model output stays text', () => {
    const html = renderMarkdown('hi <script>alert(1)</script> <b>x</b>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('links open in a new tab with rel noopener', () => {
    const html = renderMarkdown('[docs](https://bun.sh/docs) and https://example.com')
    expect(html).toContain('<a href="https://bun.sh/docs" target="_blank" rel="noopener noreferrer">docs</a>')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">')
  })

  test('javascript: links are not made clickable', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript')
  })

  test('code blocks get a language label, a copy button and escaped code', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2\n```')
    expect(html).toContain('class="md-code"')
    expect(html).toContain('<span class="md-code-lang">ts</span>')
    expect(html).toContain('data-copy')
    expect(html).toContain('<pre><code>const a = 1 &lt; 2</code></pre>')
  })

  test('a highlighter replaces the plain block when it knows the language', () => {
    const md = createMarkdown(() => (code, lang) => (lang === 'ts' ? `<pre class="shiki">${code.length}</pre>` : null))
    expect(md.render('```ts\nabc\n```')).toContain('<pre class="shiki">3</pre>')
    expect(md.render('```zz\nabc\n```')).toContain('<pre><code>abc</code></pre>')
  })

  test('indented code blocks are rendered like fences', () => {
    expect(renderMarkdown('para\n\n    indented')).toContain('<span class="md-code-lang">text</span>')
  })
})
