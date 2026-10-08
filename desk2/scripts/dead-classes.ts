// The static classes in an app's templates that its built CSS has no rule for. Tailwind generates only the classes it
// knows, so a made-up one does nothing and reports nothing: `size-screen` (no such utility) took the window's height
// rule away on 2026-10-07, and the page ended wherever its content did, with typecheck, lint, tests and gestures all green.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Names that carry no rule of their own on purpose. */
const UNSTYLED = new Set([
  // shadcn-vue's right-to-left marker on submenu chevrons; this window is left-to-right only.
  'cn-rtl-flip',
])
// A Tailwind group or peer name (`group/row`) is a target for variants, never a rule itself.
const MARKER = /^(?:group|peer)(?:\/[\w-]+)?$/

function filesUnder(dir: string, ext: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(ext)).map((f) => join(dir, f))
}

/** Every class name a selector in these stylesheets names, unescaped (`gap-1\.5` -> `gap-1.5`). */
function styledClasses(cssFiles: string[]): Set<string> {
  const names = new Set<string>()
  for (const file of cssFiles) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\.((?:\\.|[\w-])+)/g)) names.add(m[1].replace(/\\(.)/g, '$1'))
  }
  return names
}

/** `{ file, cls }` for each static `class="..."` token under `srcDir` with no rule in `distDir`'s CSS. */
export function deadClasses(srcDir: string, distDir: string): Array<{ file: string; cls: string }> {
  const styled = styledClasses(filesUnder(distDir, '.css'))
  const dead: Array<{ file: string; cls: string }> = []
  for (const file of filesUnder(srcDir, '.vue')) {
    // A bound `:class` is an expression, not a list of names.
    for (const m of readFileSync(file, 'utf8').matchAll(/(?<![:\w-])class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls && !styled.has(cls) && !MARKER.test(cls) && !UNSTYLED.has(cls)) dead.push({ file, cls })
      }
    }
  }
  return dead
}
