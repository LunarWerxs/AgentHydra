// A plain project folder's own logo, shown on the New screen's grid in place of a Project Hydra logo. The cascade
// (conventional icon files, then an HTML icon link) follows stablyai/orca's repo icon detection (MIT); written fresh
// here. LOCAL FILES ONLY: no network, no GitHub avatar, no package.json homepage.
//
// The answer is a file inside the folder that icon-cache.ts can serve (PNG, WEBP, ICO or SVG, by its bytes as well as
// its name), no larger than ICON_MAX_BYTES. Work is bounded: a fixed list of paths is stat'ed, at most the first
// HTML_HEAD_BYTES of each HTML file is read, and a folder is never walked.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The largest icon taken: the grid draws it at 28 px, and icon-cache reads a PNG whole to make its thumbnail. */
export const ICON_MAX_BYTES = 1024 * 1024
/** How long a folder's answer is trusted before it is probed again. A new icon can take this long to appear. */
const TTL_MS = 5 * 60_000
/** Bytes read to sniff a file's type (enough for an SVG's opening tag behind a comment or doctype). */
const SNIFF_BYTES = 64 * 1024
/** Bytes read of each HTML file: its <head> is near the top. */
const HTML_HEAD_BYTES = 8 * 1024
/** HTML files that may hold the icon link, best first. */
const HTML_FILES = ['index.html', 'public/index.html', 'src/index.html']

/** Conventional icon files, relative to the folder, best first: the first valid one wins. */
export const ICON_CANDIDATES = [
  'icon.png',
  'logo.png',
  'logo.svg',
  'favicon.png',
  'favicon.svg',
  'favicon.ico',
  'public/favicon.svg',
  'public/favicon.png',
  'public/favicon.ico',
  'public/logo.svg',
  'public/logo.png',
  'public/icon.png',
  'static/favicon.svg',
  'static/favicon.png',
  'static/favicon.ico',
  'assets/icon.png',
  'assets/logo.png',
  'assets/logo.svg',
  'src/assets/logo.png',
  'src/assets/logo.svg',
  'app/icon.png',
  'app/icon.svg',
  'app/favicon.ico',
  'src-tauri/icons/icon.png',
  'build/icon.png',
  'resources/icon.png',
]

type IconType = 'png' | 'webp' | 'ico' | 'svg'

const TYPE_OF_EXT: Record<string, IconType> = { '.png': 'png', '.webp': 'webp', '.ico': 'ico', '.svg': 'svg' }
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICO_HEADER = Buffer.from([0x00, 0x00, 0x01, 0x00])
const LINK = /<link\b[^>]*>/gi
/** A link's attributes; the lookbehind keeps `data-href` and the like out. */
const ATTR = /\s(rel|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const ICON_RELS = new Set(['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'])

const answers = new Map<string, { at: number; file: string | null }>()

/** An absolute path to the folder's logo file, or null when it has none (or it is not a local folder). */
export function detectFolderIcon(folder: string): string | null {
  const dir = resolve(folder)
  const now = Date.now()
  const hit = answers.get(dir)
  if (hit && now - hit.at < TTL_MS) return hit.file
  const file = findIcon(dir)
  answers.set(dir, { at: now, file })
  return file
}

/** A project whose app sits one folder down (a monorepo's web app, a product's site), and that app's own icon files.
 *  Measured 2026-10-10 on one PC's 64 project folders: the top-level cascade found 1 icon, this step 12 more. */
const APP_FOLDERS = ['app', 'web', 'site', 'frontend', 'client']
const APP_ICON_CANDIDATES = [
  'public/favicon.svg',
  'public/favicon.png',
  'public/favicon.ico',
  'public/logo.svg',
  'public/logo.png',
  'favicon.svg',
  'favicon.ico',
  'logo.png',
]

function findIcon(dir: string): string | null {
  // Most candidates sit in folders a project does not have: each folder is looked at once, and its files only when
  // it is there. This runs on the server's thread, so the stats it saves are its cost.
  const folders = new Map<string, boolean>()
  const inFolderThere = (rel: string): boolean => {
    const parent = dirname(rel)
    if (parent === '.') return true
    let there = folders.get(parent)
    if (there === undefined) {
      there = statSync(join(dir, parent), { throwIfNoEntry: false })?.isDirectory() ?? false
      folders.set(parent, there)
    }
    return there
  }
  const first = (rels: string[]): string | null => {
    for (const rel of rels) {
      const file = inFolderThere(rel) ? validIcon(join(dir, rel)) : null
      if (file) return file
    }
    return null
  }
  return (
    first(ICON_CANDIDATES) ??
    fromHtml(dir) ??
    first(APP_FOLDERS.flatMap((app) => APP_ICON_CANDIDATES.map((rel) => `${app}/${rel}`)))
  )
}

/** The file when it is a regular file no larger than the cap, its bytes are an image of the type its name says. */
function validIcon(file: string): string | null {
  const type = TYPE_OF_EXT[extname(file).toLowerCase()]
  if (!type) return null
  try {
    // Most candidates are missing: answered without an exception, which is most of a cold pass's cost.
    const st = statSync(file, { throwIfNoEntry: false })
    if (!st || !st.isFile() || st.size === 0 || st.size > ICON_MAX_BYTES) return null
    return sniff(readHead(file, SNIFF_BYTES)) === type ? file : null
  } catch {
    return null
  }
}

/** The image type of a file's first bytes, or null when they are none of the four. */
function sniff(head: Buffer): IconType | null {
  if (head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (head.subarray(0, ICO_HEADER.length).equals(ICO_HEADER)) return 'ico'
  if (/<svg[\s>]/i.test(head.toString('utf8'))) return 'svg'
  return null
}

/** The first valid icon an HTML file's icon link points at. The href resolves against the HTML file (a leading '/' is
 *  the folder's public/ when it has one, else the folder); anything that leaves the folder, or is a URL, is refused. */
function fromHtml(dir: string): string | null {
  const publicDir = isDirectory(join(dir, 'public')) ? join(dir, 'public') : null
  for (const rel of HTML_FILES) {
    const html = join(dir, rel)
    let text: string
    try {
      text = readHead(html, HTML_HEAD_BYTES).toString('utf8')
    } catch {
      continue
    }
    for (const tag of text.match(LINK) ?? []) {
      const attrs = attributes(tag)
      const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/)
      if (!rels.some((r) => ICON_RELS.has(r)) || !attrs.href) continue
      const file = hrefFile(dir, publicDir, html, attrs.href)
      const icon = file ? validIcon(file) : null
      if (icon) return icon
    }
  }
  return null
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase()
    out[name] ??= (m[2] ?? m[3] ?? m[4] ?? '').trim()
  }
  return out
}

/** The file an href names inside the folder, or null for a URL, a protocol-relative link or a path that leaves the folder. */
function hrefFile(dir: string, publicDir: string | null, html: string, href: string): string | null {
  const clean = href.split(/[?#]/)[0]!
  if (!clean || clean.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null
  let path: string
  try {
    path = decodeURIComponent(clean)
  } catch {
    return null
  }
  const base = path.startsWith('/') ? (publicDir ?? dir) : join(html, '..')
  const file = resolve(base, path.replace(/^[/\\]+/, ''))
  const rel = relative(dir, file)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return null
  return file
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The first `max` bytes of a file (fewer when it is shorter). */
function readHead(file: string, max: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    const n = readSync(fd, buf, 0, max, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}
