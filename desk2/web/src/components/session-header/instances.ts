// AgentHydra's desktop instances, one list for the window: the session header's account chip and Migrate, and the
// row menu's first line and Move to account (sidebar/logic.ts). Read when one of them opens, at most every 15 s
// unless asked to; the address an instance was resolved to (ah.instanceAccount) is kept across reads, which do not
// carry it.
import { computed, ref } from 'vue'
import type { AccountChoice } from '@/components/sidebar/logic'
import { ah } from './ah'
import { instanceName, type AhInstance } from './logic'

const FRESH_MS = 15_000

/** null until AgentHydra first answers. */
export const ahInstances = ref<AhInstance[] | null>(null)
let reading: Promise<void> | null = null
let readAt = 0

/** Reads the list again unless it is fresh; `force` reads it anyway (running state moves while a menu stays open). */
export function refreshAhInstances(force = false): Promise<void> {
  if (reading) return reading
  if (!force && ahInstances.value && Date.now() - readAt < FRESH_MS) return Promise.resolve()
  reading = ah
    .instances()
    .then(
      (list) => {
        const known = new Map((ahInstances.value ?? []).map((x) => [x.dir, x.account]))
        ahInstances.value = list.map((x) => (x.account?.email || !known.get(x.dir) ? x : { ...x, account: known.get(x.dir) ?? null }))
        readAt = Date.now()
      },
      () => {}
    )
    .finally(() => (reading = null))
  return reading
}

/** The account an instance turned out to be signed into, kept for the next reads. */
export function setInstanceAccount(dir: string, account: AhInstance['account']): void {
  if (ahInstances.value) ahInstances.value = ahInstances.value.map((x) => (x.dir === dir ? { ...x, account } : x))
}

/** What Move to account offers, by the name the header's Migrate uses; null until the list is read. */
export const accountChoices = computed<AccountChoice[] | null>(
  () => ahInstances.value?.map((i) => ({ ref: `desktop:${i.dir}`, num: i.num, name: instanceName(i), running: i.isRunning })) ?? null
)
