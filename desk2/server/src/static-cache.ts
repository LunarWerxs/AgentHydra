// How the browser may keep the built windows' files (web/dist at /, hydra/dist at /ah/). Vite names every
// file under assets/ after a hash of its content, so a new build is a new name: the window keeps those for
// good and never asks for them again, which also lets the browser keep their compiled code between starts.
// Anything else (index.html, which names the current build's files) is asked for again on every load.

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** The Cache-Control for a built file at this URL path. */
export function cacheControl(path: string): string {
  return /\/assets\/[^/]+$/.test(path) ? IMMUTABLE : 'no-cache'
}
