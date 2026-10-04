import { describe, expect, it } from 'bun:test'
import { buildCopyHtml, dataUrlToFile, parseCopiedImages } from '../../src/lib/clipboard-images'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const JPG = 'data:image/jpeg;base64,/9j/4AAQ'

describe('copying a message with its pictures', () => {
  it('pastes back every picture the copy wrote, even inside the Windows HTML fragment wrapper', () => {
    const html = buildCopyHtml('look <here> & "there"\nline two', [PNG, JPG])
    const wrapped = `<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`
    expect(parseCopiedImages(wrapped)).toEqual([PNG, JPG])
    expect(html).toContain('look &lt;here&gt; &amp; &quot;there&quot;<br>line two')
  })

  it('ignores pictures in HTML copied from anywhere else', () => {
    expect(parseCopiedImages(`<p>hi</p><img src="${PNG}">`)).toEqual([])
  })

  it('turns a pasted data URL into a File with its type and bytes', () => {
    const f = dataUrlToFile(PNG, 'Pasted image 1')
    expect(f.type).toBe('image/png')
    expect(f.size).toBe(8)
  })
})
