// The .vue files under an app's src that the Vue compiler refuses. The dev server answers such a file with a 500 and the
// page never starts, yet `vite build` let one through: on 2026-10-08 two `:class` bindings on one element of DeskFrame.vue
// ("Duplicate attribute") built green while every dev-server probe timed out on a blank page.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

type Parse = (source: string, options: { filename: string }) => { errors: Array<Error & { loc?: { start: { line: number } } }> }

/** `{ file, line, message }` for each compile error in the `.vue` files under `srcDir`, read with the app's own Vue. */
export function sfcErrors(app: string, srcDir: string): Array<{ file: string; line: number; message: string }> {
  const { parse } = createRequire(join(app, 'package.json'))('vue/compiler-sfc') as { parse: Parse }
  const errors: Array<{ file: string; line: number; message: string }> = []
  for (const name of (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.vue'))) {
    const file = join(srcDir, name)
    for (const e of parse(readFileSync(file, 'utf8'), { filename: file }).errors) errors.push({ file, line: e.loc?.start.line ?? 0, message: e.message })
  }
  return errors
}
