// When the window's keys came, from the moment it loads: a request card that docks while the owner types
// tells his typing burst from an answer by it (lib/requests.ts keyIsForCard). The capture phase on window
// runs before any other listener, so nothing can hide a key from it.

let last: number | null = null
let prev: number | null = null

function onKeydown() {
  prev = last
  last = performance.now()
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown, { capture: true })
  import.meta.hot?.dispose(() => window.removeEventListener('keydown', onKeydown, { capture: true }))
}

/** Inside a keydown listener: when the keydown before this one came (performance.now() time); null when none did. */
export function keyBefore(): number | null {
  return prev
}
