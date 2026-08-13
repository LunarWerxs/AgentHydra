// web/src/lib/find.ts — highlighting matches inside HTML we generated.
//
// The first block is the reason this file exists at all: a naive string replace over rendered HTML
// matches tag names, class attributes and href values, and splices a <mark> into the middle of a
// tag. It also searches the wrong text, because `a & b` is `a &amp; b` by the time it is HTML.
//
// The second block is the safety property inherited from lib/markdown.ts: the only tag this file
// adds is <mark>, wrapped around slices that are still escaped, so highlighting cannot turn inert
// transcript text into live markup.

import { describe, expect, test } from 'bun:test'
import { highlightHtml } from '../src/lib/find'
import { escapeHtml, renderMarkdown } from '../src/lib/markdown'

describe('matches are found in the text, never in the markup', () => {
  test('a tag name is not a match', () => {
    // "pre" appears in <pre class="md-pre"> several times and nowhere in the visible text.
    const html = renderMarkdown('```\nhello\n```')
    expect(highlightHtml(html, 'pre').count).toBe(0)
  })

  test('an attribute value is not a match', () => {
    const html = renderMarkdown('[docs](https://example.com/handbook)')
    // The URL is in the href only; the visible label is "docs".
    expect(highlightHtml(html, 'handbook').count).toBe(0)
    expect(highlightHtml(html, 'docs').count).toBe(1)
  })

  test('a match spanning into a tag is not a match', () => {
    const html = renderMarkdown('**bo**ld')
    // "bold" only exists if you ignore the </strong> between "bo" and "ld".
    expect(highlightHtml(html, 'bold').count).toBe(0)
  })

  test('the search sees what the reader sees, not the entity', () => {
    const html = escapeHtml('a & b')
    expect(html).toContain('&amp;')
    expect(highlightHtml(html, '&').count).toBe(1)
    // ...and the entity's own letters are not text on screen
    expect(highlightHtml(html, 'amp').count).toBe(0)
  })

  test('a match containing an escaped character is wrapped whole', () => {
    const r = highlightHtml(escapeHtml('a & b'), 'a & b')
    expect(r.count).toBe(1)
    expect(r.html).toBe('<mark class="find-hit" data-find="0">a &amp; b</mark>')
  })

  test('matching is case-insensitive', () => {
    expect(highlightHtml(escapeHtml('Hello hello HELLO'), 'hello').count).toBe(3)
  })

  test('an empty query changes nothing', () => {
    const html = renderMarkdown('# Title')
    expect(highlightHtml(html, '')).toEqual({ html, count: 0 })
  })
})

describe('highlighting cannot introduce markup', () => {
  test('the only tag added is mark, and the escaped text stays escaped', () => {
    const r = highlightHtml(escapeHtml('<script>alert(1)</script>'), 'script')
    expect(r.count).toBe(2)
    expect(r.html).not.toContain('<script')
    expect(r.html).toContain('&lt;')
    expect(r.html.replace(/<\/?mark[^>]*>/g, '')).toBe(escapeHtml('<script>alert(1)</script>'))
  })

  test('a query full of markup is neutered, because it is compared against escaped text', () => {
    // The query matches the visible characters; what gets wrapped is the escaped source slice.
    const r = highlightHtml(escapeHtml('x <img src=y> z'), '<img')
    expect(r.count).toBe(1)
    expect(r.html).not.toContain('<img')
    expect(r.html).toContain('&lt;img')
  })

  test('code inside a fence is searchable and still inert', () => {
    const html = renderMarkdown('```js\nconst secret = "</code></pre><script>x</script>"\n```')
    const r = highlightHtml(html, 'secret')
    expect(r.count).toBe(1)
    expect(r.html).not.toContain('<script>')
    expect(r.html.match(/<\/code><\/pre>/g)?.length).toBe(1)
  })
})

describe('numbering, which is what next/previous navigates by', () => {
  test('marks are numbered from the running offset the caller passes in', () => {
    const r = highlightHtml(escapeHtml('aa'), 'a', 7)
    expect(r.count).toBe(2)
    expect(r.html).toContain('data-find="7"')
    expect(r.html).toContain('data-find="8"')
  })

  test('exactly one mark carries the active class', () => {
    const r = highlightHtml(escapeHtml('a a a'), 'a', 0, 1)
    expect(r.html.match(/find-hit-active/g)?.length).toBe(1)
    expect(r.html).toContain('<mark class="find-hit find-hit-active" data-find="1">')
  })

  test('an active index outside this message leaves it unmarked', () => {
    expect(highlightHtml(escapeHtml('a'), 'a', 0, 5).html).not.toContain('find-hit-active')
  })

  test('matches in separate text runs are numbered in reading order', () => {
    const html = renderMarkdown('- alpha\n- alpha')
    const r = highlightHtml(html, 'alpha')
    expect(r.count).toBe(2)
    expect(r.html.indexOf('data-find="0"')).toBeLessThan(r.html.indexOf('data-find="1"'))
  })
})
