// etsy.com is off limits to the browser tools: Etsy's API Terms of Use §9 ban automated software that reads its website,
// and this browser is CDP-driven Chrome that Etsy's edge has already flagged once. Ported from Connections' browser
// engine (local-mcp/src-impl/05-proc-and-module-loaders.mjs). Every tool's whole params object is walked, since a
// `goto` inside a script's steps arrives nested.

const ETSY_HOST = /(^|\.)etsy\.com$/i

export function etsyWebsiteHostIn(value: unknown, seen: Set<object> = new Set()): string | null {
  if (typeof value === 'string') {
    for (const token of value.match(/[\w.-]+\.[a-z]{2,}(?::\d+)?/gi) ?? []) {
      let host: string
      try {
        host = new URL(`https://${token.replace(/^.*?:\/\//, '')}`).hostname
      } catch {
        continue
      }
      if (ETSY_HOST.test(host)) return host
    }
    return null
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null
  seen.add(value)
  for (const nested of Object.values(value)) {
    const host = etsyWebsiteHostIn(nested, seen)
    if (host) return host
  }
  return null
}

export const etsyRefusal = (host: string): string =>
  `browser REFUSED: ${host} - Etsy's API Terms of Use §9 forbid automated software reading etsy.com, and this browser is CDP-driven Chrome that Etsy's edge already flagged once (2026-08-14, by IP). Use openapi.etsy.com over fetch/shell instead; a seller's OAuth consent belongs in their own browser.`
