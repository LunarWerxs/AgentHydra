// The `resourceStatus()` object (composables/useData.ts) is a PLAIN object of refs, so Vue's
// template auto-unwrapping does not reach inside it: `sessionsStatus.stale` in a template is the
// Ref OBJECT, not the boolean.
//
// That produces two failures at once, and both are silent:
//   · `v-if="sessionsStatus.stale"` — a Ref object is always truthy, so the banner is permanently
//     on. Every stale/unavailable banner in the app was showing all the time.
//   · `{ reason: sessionsStatus.error }` — interpolates the ref itself, so the user reads
//     `{"dep":{...},"__v_isRef":true,"_rawValue":null,"_value":null}` in the middle of a sentence.
//     That is exactly what the owner reported on the Sessions tab, 2026-09-07.
//
// Neither is a type error (vue-tsc accepts a Ref in an interpolation), neither throws, and both
// look correct in review - the only thing that catches them is looking at the running app, or
// this. Fifteen sites across four components were wrong before this was written.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const COMPONENTS = join(import.meta.dir, '..', 'src', 'components')

/** A `<something>Status.<field>` that is NOT followed by `.value`. */
const BARE_STATUS_REF =
  /\b\w+Status\.(?:stale|unavailable|error|loading|lastSuccessAt)\b(?!\.value)/g

test('no component reads a resourceStatus field without .value', () => {
  const offenders: string[] = []
  for (const name of readdirSync(COMPONENTS)) {
    if (!name.endsWith('.vue')) continue
    const src = readFileSync(join(COMPONENTS, name), 'utf8')
    for (const m of src.matchAll(BARE_STATUS_REF)) {
      const line = src.slice(0, m.index).split('\n').length
      offenders.push(`${name}:${line}  ${m[0]}`)
    }
  }
  // Printed rather than counted, so a failure names the exact sites instead of a number.
  expect(offenders).toEqual([])
})
