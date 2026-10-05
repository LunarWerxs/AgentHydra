// How the browser may keep the built windows' files (web/dist at /, hydra/dist at /ah/). Vite names every
// file under assets/ after a hash of its content, so a new build is a new name: the window keeps those for
// good and never asks for them again, which also lets the browser keep their compiled code between starts.
// index.html (which names the current build's files) is asked for again on every load. Other non-hashed
// files like favicon.ico are cached for a day.

const IMMUTABLE = 'public, max-age=31536000, immutable'
const DAY_CACHE = 'public, max-age=86400'

/** The Cache-Control for a built file at this URL path. */
export function cacheControl(path: string): string {
  if (/\/assets\/[^/]+$/.test(path)) return IMMUTABLE
  if (/\/(favicon\.ico|robots\.txt|manifest\.json|sitemap\.xml)$/.test(path)) return DAY_CACHE
  return 'no-cache'
}
