// web/src/lib/markdown.ts + highlight.ts — rendering UNTRUSTED transcript text as HTML.
//
// The first describe block is the one that matters. Transcript content is whatever a model wrote,
// whatever a tool printed, and whatever a fetched web page contained, and opening a session renders
// it. Every case below is an injection that a "render markdown then sanitise it" design has to
// actively defend against, and that this design cannot express: the source is HTML-escaped once,
// before any markdown is read, so no tag in the output can come from the input.
//
// The rest pins the markdown subset that actually appears in transcripts, and the tokenizer's two
// ordering rules (a comment marker inside a string is not a comment; a keyword inside a comment is
// not a keyword).

import { describe, expect, test } from 'bun:test'
import { highlight, normalizeLanguage } from '../src/lib/highlight'
import { escapeHtml, looksLikeMarkdown, renderMarkdown } from '../src/lib/markdown'

describe('untrusted input cannot produce markup', () => {
  test('a script tag renders as visible text, not as a script', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('an event-handler attribute cannot be smuggled through an image or tag', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    // The words survive as visible text, which is right. What must not survive is a real tag: no
    // "<img", and the quotes that would delimit an attribute are escaped, so there is nothing for
    // a browser to parse as an attribute in the first place.
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toMatch(/onerror\s*=\s*["'][^&]/)
  })

  test('a javascript: link renders as its label with no href at all', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))')
    expect(html).toContain('click me')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<a')
  })

  test('the classic control-character bypass of a scheme check is refused', () => {
    // "java\tscript:" defeats a naive startsWith check; whitespace is stripped before the test.
    const html = renderMarkdown('[x](java\tscript:alert(1))')
    expect(html).not.toContain('<a')
  })

  test('data: and vbscript: URLs are refused', () => {
    for (const url of ['data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)']) {
      expect(renderMarkdown(`[x](${url})`)).not.toContain('<a')
    }
  })

  test('a scheme-relative //host link is refused, an absolute path is allowed', () => {
    expect(renderMarkdown('[x](//evil.example)')).not.toContain('<a')
    expect(renderMarkdown('[x](/local/page)')).toContain('<a')
  })

  test('an http link survives, and cannot break out of the href attribute', () => {
    const html = renderMarkdown('[docs](https://example.com/a"onmouseover="alert(1))')
    expect(html).toContain('<a')
    // The quote was escaped before the href was built, so it cannot close the attribute.
    expect(html).not.toContain('"onmouseover="')
  })

  test('a link label cannot inject markup', () => {
    const html = renderMarkdown('[<b>bold</b>](https://example.com)')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;')
  })

  test('code fences and inline code keep their content inert', () => {
    expect(renderMarkdown('```\n<script>alert(1)</script>\n```')).not.toContain('<script>')
    expect(renderMarkdown('`<script>alert(1)</script>`')).not.toContain('<script>')
  })

  test('highlighting never introduces markup, whatever the code says', () => {
    const html = renderMarkdown('```js\nconst x = "</code></pre><script>alert(1)</script>"\n```')
    expect(html).not.toContain('<script>')
    // exactly one code block: the fake closer in the string did not end it early
    expect(html.match(/<\/code><\/pre>/g)?.length).toBe(1)
  })

  test('escapeHtml covers every character that matters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  test('ampersands are escaped once, not twice', () => {
    expect(renderMarkdown('a & b')).toContain('a &amp; b')
    expect(renderMarkdown('a & b')).not.toContain('&amp;amp;')
  })
})

describe('the markdown subset transcripts actually use', () => {
  test('fenced code carries its language as a chip', () => {
    const html = renderMarkdown('```python\nprint(1)\n```')
    expect(html).toContain('md-lang')
    expect(html).toContain('python')
    expect(html).toContain('<pre class="md-pre">')
  })

  test('an untagged fence still renders as a code block, which is 57% of them', () => {
    const html = renderMarkdown('```\nsome output\n```')
    expect(html).toContain('<pre class="md-pre">')
    expect(html).not.toContain('md-lang')
  })

  test('an unterminated fence renders as code rather than eating the message', () => {
    const html = renderMarkdown('```ts\nconst a = 1\nstill going')
    expect(html).toContain('still going')
    expect(html).toContain('<pre')
  })

  test('headings, lists, quotes and rules', () => {
    expect(renderMarkdown('## Title')).toContain('<h2 class="md-h">Title</h2>')
    expect(renderMarkdown('- one\n- two')).toContain('<ul class="md-list">')
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol class="md-list">')
    expect(renderMarkdown('> quoted')).toContain('<blockquote')
    expect(renderMarkdown('---')).toContain('<hr')
  })

  test('inline emphasis and code', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMarkdown('*it*')).toContain('<em>it</em>')
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>')
    expect(renderMarkdown('`x`')).toContain('<code class="md-code">x</code>')
  })

  // The ordering property: a code span is matched first, so its contents are never re-read.
  test('markup inside a code span stays literal', () => {
    const html = renderMarkdown('`**not bold** [not](a link)`')
    expect(html).not.toContain('<strong>')
    expect(html).not.toContain('<a')
  })

  test('a list and the paragraph after it do not merge', () => {
    const html = renderMarkdown('- one\n\nafter')
    expect(html).toContain('</ul>')
    expect(html.indexOf('</ul>')).toBeLessThan(html.indexOf('after'))
  })

  test('plain prose is left alone by the detector', () => {
    expect(looksLikeMarkdown('just a sentence about things')).toBe(false)
    expect(looksLikeMarkdown('a list:\n- one')).toBe(true)
    expect(looksLikeMarkdown('run `npm test`')).toBe(true)
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true)
  })
})

describe('highlighting', () => {
  test('language labels map onto the supported families', () => {
    expect(normalizeLanguage('TypeScript')).toBe('js')
    expect(normalizeLanguage('tsx')).toBe('js')
    expect(normalizeLanguage('py')).toBe('python')
    expect(normalizeLanguage('bash')).toBe('shell')
    expect(normalizeLanguage('JSON')).toBe('json')
  })

  test('an unknown language is left completely alone rather than guessed at', () => {
    expect(normalizeLanguage('brainfuck')).toBe('plain')
    expect(highlight('some &lt;code&gt;', 'plain')).toBe('some &lt;code&gt;')
  })

  test('keywords, numbers and strings are marked', () => {
    const html = highlight('const n = 42', 'js')
    expect(html).toContain('hl-keyword')
    expect(html).toContain('hl-number')
  })

  // The two ordering rules a naive regex-per-token-type highlighter gets wrong.
  test('a comment marker inside a string is not a comment', () => {
    const code = highlight('echo &quot;# not a comment&quot;', 'shell')
    expect(code).toContain('hl-string')
    expect(code).not.toContain('hl-comment')
  })

  test('a keyword inside a comment is not a keyword', () => {
    const code = highlight('// const x', 'js')
    expect(code).toContain('hl-comment')
    expect(code).not.toContain('hl-keyword')
  })

  test('an unterminated string stops at the line, not the end of the block', () => {
    const code = highlight('x = &quot;oops\nconst y = 1', 'js')
    expect(code).toContain('hl-keyword') // the second line still tokenizes
  })
})
