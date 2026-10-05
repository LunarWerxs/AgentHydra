// server/src/plans.ts — the three Claude plans, how big each is, and how a plan label names one.
// One copy for the cost model (routing-cost.ts) and CliMayte's placement (climayte-placement.ts).

export const PLANS = ['Pro', 'Max 5×', 'Max 20×'] as const
export type Plan = (typeof PLANS)[number]

/** Window size in Pro 5-hour windows. Measured by the owner, 2026-10-05: a Max 5x window holds 4.75
 *  Pro windows and a Max 20x window 19 (not the 5 and 20 the plan names suggest). */
export const PLAN_SIZE: Record<Plan, number> = { Pro: 1, 'Max 5×': 4.75, 'Max 20×': 19 }

/** The plan a CLI instance's planLabel names, or null when it is none of the three. */
export function planOf(label: string | null | undefined): Plan | null {
  const l = (label ?? '').toLowerCase()
  if (/max\s*20/.test(l)) return 'Max 20×'
  if (/max\s*5/.test(l)) return 'Max 5×'
  if (/pro/.test(l)) return 'Pro'
  return null
}

/** How many Pro windows the labelled plan's 5-hour window holds; an unknown label counts as Pro. */
export function planSizeOf(label: string | null | undefined): number {
  const plan = planOf(label)
  return plan ? PLAN_SIZE[plan] : 1
}
