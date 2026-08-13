// web/src/lib/chart.ts — the arithmetic behind the charts, with no drawing in it.
//
// The charts are hand-written SVG (see components/charts/). That is a deliberate choice and not a
// heroic one: this app's whole dependency list is eight packages, the plan flagged "no charting
// library — budget for it", and what these charts actually need is a scale, a tick generator and a
// path builder. A charting library brings a layout engine, an animation system and its own theming
// to solve a problem that is four functions long.
//
// Splitting the maths out of the components is what makes any of it testable: a bar chart component
// can only be checked by looking at it, but "does this scale put 0 at the baseline" is a unit test.

/** A rounded, human tick step: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(rough))
  const norm = rough / mag
  if (norm <= 1) return mag
  if (norm <= 2) return 2 * mag
  if (norm <= 2.5) return 2.5 * mag
  if (norm <= 5) return 5 * mag
  return 10 * mag
}

/**
 * Axis ticks from 0 to at least `max`.
 *
 * ALWAYS FROM ZERO. A bar chart whose axis starts anywhere else exaggerates every difference on it,
 * which is the single most common way a chart lies, so the option to do it is simply not offered.
 */
export function ticks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const step = niceStep(max / count)
  const out: number[] = []
  // Runs until the last tick is at or ABOVE the data, not until it passes it. Stopping at `<= max`
  // put the top tick below the tallest value whenever the nice step did not divide it (max 7, step
  // 2 → 0,2,4,6), and a bar scaled against that axis draws straight out of the plot.
  for (let v = 0; ; v += step) {
    out.push(Number(v.toFixed(10)))
    if (v >= max - step * 1e-9) break
    // A guard, not an expectation: a pathological step could otherwise loop forever.
    if (out.length > 64) break
  }
  return out
}

/** The axis top: the first tick at or above the data, so the tallest bar never touches the frame. */
export function axisMax(max: number, count = 4): number {
  const t = ticks(max, count)
  return t[t.length - 1] || 1
}

/**
 * A polyline through the points, as an SVG path.
 *
 * Straight segments, not a spline: a smoothed line invents values between the points it was given,
 * and for "how many sessions were running at 3am" those invented values are simply wrong.
 */
export function linePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
}

/** The same line closed down to the baseline, for the area fill under it. */
export function areaPath(points: Array<{ x: number; y: number }>, baseline: number): string {
  if (points.length === 0) return ''
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''
  return `${linePath(points)} L${last.x.toFixed(2)} ${baseline.toFixed(2)} L${first.x.toFixed(2)} ${baseline.toFixed(2)} Z`
}

/** The fixed categorical slots. Six, in order, keyed by entity — never cycled to a seventh. */
export const VIZ_SLOTS = 6

/**
 * Stable colour for a named series.
 *
 * Keyed by the NAME, so adding or filtering out a series never repaints the others — the property
 * the skill calls "colour follows the entity, never its rank". Past six distinct names the caller is
 * expected to have folded the tail into "Other" rather than asking for a seventh hue; if it has
 * not, the extra names share the last slot instead of inventing colours nobody validated.
 */
export function seriesColor(name: string, order: readonly string[]): string {
  const i = order.indexOf(name)
  const slot = i < 0 || i >= VIZ_SLOTS ? VIZ_SLOTS : i + 1
  return `var(--viz-${slot})`
}

/**
 * Keep the biggest `keep` entries and sum the rest into one "Other" row.
 *
 * The alternative to this is a chart with fourteen colours in it, which is not a chart anyone reads.
 */
export function topNWithOther<T extends { key: string }>(
  rows: T[],
  keep: number,
  value: (row: T) => number,
  makeOther: (total: number, count: number) => T,
): T[] {
  if (rows.length <= keep) return rows
  const head = rows.slice(0, keep)
  const tail = rows.slice(keep)
  const total = tail.reduce((n, r) => n + value(r), 0)
  return [...head, makeOther(total, tail.length)]
}

/** Compact money for an axis or a chip. Full precision belongs in the tooltip, not the axis. */
export function shortUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  if (n >= 10) return `$${n.toFixed(0)}`
  if (n >= 0.01) return `$${n.toFixed(2)}`
  return n === 0 ? '$0' : '<$0.01'
}

/**
 * Who actually makes a model, from its id.
 *
 * Two different naming conventions arrive here. OpenCode qualifies a model with the provider it
 * routed through (`deepseek/deepseek-v4-pro`, `dashscope2/glm-5.2`), which is the more useful
 * grouping because it is where the money went. Claude and Codex write a bare id (`claude-opus-5`,
 * `gpt-5.6-sol`), so those are matched on their prefix.
 *
 * An unrecognised id becomes 'other' rather than a guess: a wrong vendor label on a cost chart is
 * worse than an honest bucket.
 */
export function modelVendor(model: string): string {
  const id = model.trim().toLowerCase()
  if (!id) return 'other'
  // A qualified id names its route: keep that, since two providers serving one model are different
  // rows to anyone deciding where to spend.
  const slash = id.indexOf('/')
  if (slash > 0) {
    const provider = id.slice(0, slash)
    return VENDOR_ALIAS[provider] ?? provider
  }
  for (const [prefix, vendor] of VENDOR_PREFIXES) if (id.startsWith(prefix)) return vendor
  return 'other'
}

/** Route names that are worth showing under a recognisable vendor instead of their own brand. */
const VENDOR_ALIAS: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
}

const VENDOR_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['codex', 'openai'],
  ['gemini', 'google'],
  ['grok', 'xai'],
  ['deepseek', 'deepseek'],
  ['kimi', 'moonshot'],
  ['glm', 'zhipu'],
  ['qwen', 'alibaba'],
  ['llama', 'meta'],
  ['mistral', 'mistral'],
]

/** Display name for a vendor bucket. Kept here so the chart and the filter agree. */
export function vendorLabel(vendor: string): string {
  const NAMES: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    xai: 'xAI',
    deepseek: 'DeepSeek',
    moonshot: 'Moonshot',
    zhipu: 'Zhipu',
    alibaba: 'Alibaba',
    meta: 'Meta',
    mistral: 'Mistral',
    dashscope: 'DashScope',
    dashscope2: 'DashScope',
    opencode: 'OpenCode',
    other: 'Other',
  }
  return NAMES[vendor] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1)
}
