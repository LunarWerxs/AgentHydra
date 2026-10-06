// The Routing page's data (Hydra Desk 2): AgentHydra's cost model (GET /api/routing/cost-model) and its
// settings (PUT /api/routing/settings). One shared store; the warm-data kind 'routing' refreshes it and
// the page only reads it. An edit is kept in `draft` at once and saved after a short pause, one request
// for a burst of changes; a refresh that lands meanwhile never overwrites what was just typed.
import { computed, ref, shallowRef } from 'vue'
import { j } from '@/lib/api'

export interface RoutingDiscounts {
  anthropic: number
  deepseek: number
  openrouter: number
  other: number
}
export type DiscountKey = keyof RoutingDiscounts
export const DISCOUNT_KEYS: readonly DiscountKey[] = ['anthropic', 'deepseek', 'openrouter', 'other']

export interface RoutingSettings {
  enabled: boolean
  apiPreferencePct: number
  closeRatio: number
  discounts: RoutingDiscounts
  sessionOverheadPct: number
  planPrices: Record<string, number>
}

export interface RoutingPlanRow {
  plan: string
  instances: number
  price: number
  windowsPerWeek: number
  windowsMeasuredFrom: number
  windowsFellBack: boolean
  sizeInProWindows: number
  effectiveFraction: number
  dollarsPerProWindow: number
}

export interface RoutingModelRow {
  model: string
  provider: string
  listIn: number
  listOut: number
  afterDiscountIn: number
  afterDiscountOut: number
  subscriptionIn: number
  subscriptionOut: number
}

export interface RoutingCostModel {
  dollarsPerProWindow: { value: number; fellBack: boolean }
  plans: RoutingPlanRow[]
  fleetFraction: number
  models: RoutingModelRow[]
  pricesAsOf?: string
  settings: RoutingSettings
}

type Change = Partial<Omit<RoutingSettings, 'discounts'>> & { discounts?: Partial<RoutingDiscounts> }

const SAVE_MS = 600

const model = shallowRef<RoutingCostModel | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const saveError = ref<string | null>(null)
const saving = ref(false)
/** Edits not yet confirmed by the daemon; they win over the daemon's settings while they exist. */
const draft = ref<Partial<RoutingSettings>>({})
let timer: number | null = null
let pending: Change = {}

export async function refreshRouting(): Promise<void> {
  loading.value = true
  try {
    model.value = await j<RoutingCostModel>('/api/routing/cost-model')
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function flush(): Promise<void> {
  timer = null
  const body = pending
  pending = {}
  saving.value = true
  try {
    const saved = await j<RoutingSettings>('/api/routing/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    saveError.value = null
    // The answer is the stored settings, so the draft can go even if the read below fails; prices after
    // a discount come from the daemon, so read them again.
    if (model.value) model.value = { ...model.value, settings: saved }
    await refreshRouting()
    if (timer === null) draft.value = {}
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
    // Keep the unsaved edits for the next change to try again.
    pending = { ...body, ...pending, discounts: { ...body.discounts, ...pending.discounts } }
  } finally {
    saving.value = false
  }
}

/** Records a change and saves it after a pause. `discounts` merges per provider. */
export function saveRouting(change: Change): void {
  const { discounts, ...rest } = change
  draft.value = { ...draft.value, ...rest }
  pending = { ...pending, ...rest }
  if (discounts) {
    const base = draft.value.discounts ?? model.value?.settings.discounts
    draft.value = { ...draft.value, discounts: { ...base, ...discounts } as RoutingDiscounts }
    pending = { ...pending, discounts: { ...pending.discounts, ...discounts } }
  }
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => void flush(), SAVE_MS)
}

export function useRoutingCost() {
  /** The daemon's settings with the unsaved edits on top. */
  const settings = computed<RoutingSettings | null>(() =>
    model.value ? { ...model.value.settings, ...draft.value } : null,
  )
  return { model, settings, error, loading, saving, saveError, refresh: refreshRouting }
}
