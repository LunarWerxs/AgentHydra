// The spend sources the analytics tab can filter by, in display order. Mirrors the kit's `source`
// column (server/src/kit/store.ts); the menu lists only those present in the data.
export const ANALYTICS_SOURCES = [
  'cli',
  'desktop',
  'climayte',
  'codex',
  'opencode',
  'dsh',
  'hermes',
  'hswarm',
] as const

export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number]

export const ANALYTICS_SOURCE_LABEL_KEY: Record<AnalyticsSource, string> = {
  cli: 'analytics.sourceCli',
  desktop: 'analytics.sourceDesktop',
  climayte: 'analytics.sourceClimayte',
  codex: 'analytics.sourceCodex',
  opencode: 'analytics.sourceOpencode',
  dsh: 'analytics.sourceDsh',
  hermes: 'analytics.sourceHermes',
  hswarm: 'analytics.sourceHswarm',
}
