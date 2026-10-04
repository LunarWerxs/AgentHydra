// Copying a message with its pictures. The clipboard's text/plain stays the message text, so any paste
// target gets the words; text/html carries the same text plus each picture as a marked <img> with a
// data: URL, which Hydra Desk's composer reads back on paste and attaches as images.

const MARK = 'data-hydra-desk'
const IMG_MARK = 'data-hydra-desk-image'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The text/html a copy writes: the text (line breaks kept) and one marked <img> per data: URL. */
export function buildCopyHtml(text: string, dataUrls: string[]): string {
  const body = escapeHtml(text).replace(/\r?\n/g, '<br>')
  const imgs = dataUrls.map((u) => `<img ${IMG_MARK}="" src="${escapeHtml(u)}">`).join('')
  return `<div ${MARK}="">${body ? `<p>${body}</p>` : ''}${imgs}</div>`
}

/** The data: URLs of the pictures in HTML that buildCopyHtml wrote; [] for any other HTML. */
export function parseCopiedImages(html: string): string[] {
  if (!html.includes(MARK)) return []
  const out: string[] = []
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!tag.includes(IMG_MARK)) continue
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1]
    if (src?.startsWith('data:image/')) out.push(src.replace(/&amp;/g, '&'))
  }
  return out
}

/** A data: URL as a File the composer's image checks accept. */
export function dataUrlToFile(dataUrl: string, name: string): File {
  const comma = dataUrl.indexOf(',')
  const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'application/octet-stream'
  const bin = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type })
}
