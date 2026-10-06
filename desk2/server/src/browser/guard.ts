// The own-page rule of plugins/50-devwebui.ts: a browser request must come from Desk 2's own page. Desk's localOnly
// guard (index.ts) has already refused other sites and names; this one also refuses another local page, such as a
// dev server on a different port, from driving a signed-in browser.

/** Why a request is not from Desk 2's own page, or null. */
export function notOwnPage(headers: Headers): string | null {
  const origin = headers.get('origin')
  if (origin !== null) {
    let host: string | null = null
    try {
      host = new URL(origin).host
    } catch {
      // floor-ok: an Origin that is not a URL is refused below like any other
    }
    if (host === null || host !== headers.get('host')) return `the browser pane's API is only for Desk 2's own page, not ${origin}`
  }
  const site = headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return `the browser pane's API is only for Desk 2's own page (${site})`
  return null
}
