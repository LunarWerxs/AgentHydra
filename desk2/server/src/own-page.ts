// The own-page rule shared by plugins whose API is only for Desk 2's own window (like /ah/ and /dw/, the dev-servers
// service's): a browser request must come from Desk 2's own page. Desk's localOnly guard (index.ts) runs first on every route.

/** Why a request is not from Desk 2's own page, or null. `what` names the API in the refusal. */
export function notOwnPage(headers: Headers, what = "the server manager's API"): string | null {
  const origin = headers.get('origin')
  if (origin !== null) {
    let host: string | null = null
    try {
      host = new URL(origin).host
    } catch {
      // floor-ok: an Origin that is not a URL is refused below like any other
    }
    if (host === null || host !== headers.get('host')) return `${what} is only for Desk 2's own page, not ${origin}`
  }
  const site = headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return `${what} is only for Desk 2's own page (${site})`
  return null
}
