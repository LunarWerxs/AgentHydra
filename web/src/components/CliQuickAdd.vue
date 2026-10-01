<script setup lang="ts">
// Quick add: one email in, a browser sign-in out (server/src/core/cli-quick-add.ts, docs/CLIMAYTE.md).
// Lives in CliInstancesSection, on the CLI tab right above CliMayte, which runs on these accounts. Polls
// every 2 s only while a flow is waiting; emits 'signed-in' when a flow turns signed-in so the host
// can refresh its list.
//
// With a target set (a CLI row's "Log in", composables/useQuickAddTarget.ts) the next sign-in goes
// into THAT instance instead of a new one: a note says whose login it replaces, and the id rides along
// as startQuickAdd's second argument. Without one it adds a new instance, as it always did.
import { AppWindow, Copy, LoaderCircle, LogIn, Plus, X } from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
// biome-ignore lint/style/useImportType: a component used in the template. A type-only import erases it, the tag renders as a bare <input>, v-model never updates, and Add stays disabled (2026-09-30).
import { Input } from '@/components/ui/input'
import { useCliInstances } from '@/composables/useCliInstances'
import { useQuickAddTarget } from '@/composables/useQuickAddTarget'
import type { QuickAddFlow } from '@/lib/api'
import {
  cancelQuickAdd,
  listQuickAdds,
  reopenQuickAddWindow,
  startQuickAdd,
  submitQuickAddCode,
} from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'

const emit = defineEmits<{ 'signed-in': [] }>()

const { t } = useI18n()
const { refreshCliInstances, checkUsage: checkCliUsage } = useCliInstances()
const { target, clearQuickAddTarget } = useQuickAddTarget()

const rootEl = ref<HTMLElement | null>(null)
const qaEmail = ref('')
const qaInput = ref<InstanceType<typeof Input> | null>(null)
const qaStarting = ref(false)
const qaFlows = ref<QuickAddFlow[]>([])
/** Flows started from this window; the rest of the server's last-20 list is only shown while waiting.
 *  A ref, so Dismiss (which drops an id) re-renders the list. */
const qaMine = ref(new Set<string>())
const qaCodes = ref<Record<string, string>>({})
let qaTimer: number | null = null
let qaAlive = true

const qaVisible = computed(() =>
  qaFlows.value.filter((f) => f.state === 'waiting' || qaMine.value.has(f.id)),
)

function qaSchedule() {
  if (qaTimer !== null) window.clearTimeout(qaTimer)
  qaTimer = null
  if (qaAlive && qaFlows.value.some((f) => f.state === 'waiting'))
    qaTimer = window.setTimeout(() => void qaPoll(), 2000)
}
async function qaPoll() {
  const prev = new Map(qaFlows.value.map((f) => [f.id, f.state]))
  try {
    qaFlows.value = await listQuickAdds()
  } catch {
    // Transient; try again on the next tick.
  }
  const justAdded = qaFlows.value.filter(
    (f) => f.state === 'signed-in' && prev.get(f.id) === 'waiting',
  )
  if (justAdded.length) {
    emit('signed-in')
    // Owner, 2026-09-30: a newly added account should show its usage without a manual Refresh.
    // One check per account, right after it signs in; the list refreshes with it.
    await refreshCliInstances({ silent: true })
    for (const f of justAdded) void checkCliUsage(f.instanceId)
  }
  qaSchedule()
}
async function onQuickAdd() {
  const email = qaEmail.value.trim()
  if (!email || qaStarting.value) return
  qaStarting.value = true
  try {
    const r = await startQuickAdd(email, target.value?.id)
    if ('error' in r) toast.error(r.error || t('climayte.qaStartFailed'))
    else {
      // The flow carries the instance now; the next Add is a new account again.
      clearQuickAddTarget()
      qaMine.value = new Set(qaMine.value).add(r.id)
      qaFlows.value = [r, ...qaFlows.value.filter((f) => f.id !== r.id)]
      qaEmail.value = ''
      qaSchedule()
    }
  } catch {
    toast.error(t('climayte.qaStartFailed'))
  } finally {
    qaStarting.value = false
    ;(qaInput.value?.$el as HTMLInputElement | undefined)?.focus()
  }
}
/** The flow whose code is on its way to the server: its Send button is busy until the answer. */
const qaSendingCode = ref<string | null>(null)
async function onQuickAddCode(flow: QuickAddFlow) {
  const code = qaCodes.value[flow.id]?.trim()
  if (!code || qaSendingCode.value === flow.id) return
  qaSendingCode.value = flow.id
  try {
    const r = await submitQuickAddCode(flow.id, code)
    if (!r.ok) toast.error(r.message)
    else qaCodes.value[flow.id] = ''
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    qaSendingCode.value = null
  }
  void qaPoll()
}
async function onQuickAddCancel(flow: QuickAddFlow) {
  try {
    const r = await cancelQuickAdd(flow.id)
    if (!r.ok) toast.error(r.message)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
  void qaPoll()
}

async function qaCopyLink(flow: QuickAddFlow) {
  if (!flow.url) return
  try {
    await navigator.clipboard.writeText(flow.url)
    toast.success(t('climayte.qaCopied'))
  } catch {
    toast.error(t('climayte.qaCopyFailed'))
  }
}

async function qaReopen(flow: QuickAddFlow) {
  try {
    const r = await reopenQuickAddWindow(flow.id)
    if (!r.ok) toast.error(r.message)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
  void qaPoll()
}

/** Hide a finished flow from this window. The server keeps its record; nothing is undone. */
function qaDismiss(flow: QuickAddFlow) {
  const next = new Set(qaMine.value)
  next.delete(flow.id)
  qaMine.value = next
}

/** Bring the box into view and put the cursor in the email field (a CLI row's "Log in" asks). */
function focusEmail() {
  rootEl.value?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  ;(qaInput.value?.$el as HTMLInputElement | undefined)?.focus({ preventScroll: true })
}
defineExpose({ focusEmail })

/** A finished result leaves by itself after a few seconds (owner, 2026-09-30); a failure stays
 *  longer, so its reason can be read. Dismiss still closes one at once. */
const AUTO_DISMISS_MS: Record<Exclude<QuickAddFlow['state'], 'waiting'>, number> = {
  'signed-in': 5_000,
  cancelled: 5_000,
  failed: 12_000,
}
const dismissTimers = new Map<string, number>()
watch(
  qaVisible,
  (flows) => {
    for (const f of flows) {
      if (f.state === 'waiting' || dismissTimers.has(f.id)) continue
      dismissTimers.set(
        f.id,
        window.setTimeout(() => {
          dismissTimers.delete(f.id)
          qaDismiss(f)
        }, AUTO_DISMISS_MS[f.state]),
      )
    }
  },
  { immediate: true },
)

onMounted(() => void qaPoll())
onUnmounted(() => {
  qaAlive = false
  if (qaTimer !== null) window.clearTimeout(qaTimer)
  qaTimer = null
  for (const t of dismissTimers.values()) window.clearTimeout(t)
  dismissTimers.clear()
})
</script>

<template>
  <!-- Type an email, approve in the browser, the new CLI instance lands in the CLI table. No padding
       of its own: each host places it (a class on the tag falls through to this root). Input and
       buttons share one height (h-7), and each flow's state text is the only live region, so a
       poll does not re-announce the whole row. -->
  <div ref="rootEl" class="flex flex-col gap-2">
    <p v-if="target" class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <LogIn class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="min-w-0">{{ $t('cliInstances.quickAddTarget', { num: target.num, name: target.name }) }}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :aria-label="$t('cliInstances.quickAddTargetClear')"
        :title="$t('cliInstances.quickAddTargetClear')"
        @click="clearQuickAddTarget"
      >
        <X />
      </Button>
    </p>
    <form class="flex items-center gap-2" @submit.prevent="onQuickAdd">
      <Input
        ref="qaInput"
        v-model="qaEmail"
        type="email"
        autocomplete="email"
        class="max-w-sm"
        :placeholder="$t('climayte.qaPlaceholder')"
        :aria-label="$t('climayte.qaEmailLabel')"
      />
      <Button type="submit" :disabled="qaStarting || !qaEmail.trim()">
        <LoaderCircle v-if="qaStarting" class="animate-spin" />
        <Plus v-else />
        {{ $t('climayte.qaAdd') }}
      </Button>
      <InfoHint :text="$t('climayte.qaHint')" />
    </form>
    <div
      v-for="flow in qaVisible"
      :key="flow.id"
      class="flex flex-col gap-1.5 rounded-md border bg-background/40 px-3 py-2 text-xs"
    >
      <div class="flex min-w-0 items-center gap-2">
        <LoaderCircle
          v-if="flow.state === 'waiting'"
          class="size-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
        <span class="shrink-0 font-medium">{{ flow.email }}</span>
        <span
          role="status"
          class="min-w-0 flex-1"
          :class="{
            'text-muted-foreground': flow.state === 'waiting' || flow.state === 'cancelled',
            'text-success': flow.state === 'signed-in',
            'text-destructive': flow.state === 'failed',
          }"
        >
          <template v-if="flow.state === 'waiting'">{{
            flow.window ? $t('climayte.qaWindowOpen') : $t('climayte.qaConfirm')
          }}</template>
          <template v-else-if="flow.state === 'signed-in'">{{
            flow.account?.plan
              ? $t('climayte.qaSignedIn', { email: flow.account?.email ?? flow.email, plan: flow.account.plan })
              : $t('climayte.qaSignedInNoPlan', { email: flow.account?.email ?? flow.email })
          }}</template>
          <template v-else-if="flow.state === 'failed'">{{ $t('climayte.qaFailed', { reason: flow.message }) }}</template>
          <template v-else>{{ $t('climayte.qaCancelled') }}</template>
        </span>
        <Button
          v-if="flow.state !== 'waiting'"
          variant="ghost"
          size="icon-xs"
          class="shrink-0"
          :aria-label="$t('climayte.qaDismiss')"
          :title="$t('climayte.qaDismiss')"
          @click="qaDismiss(flow)"
        >
          <X />
        </Button>
      </div>
      <div v-if="flow.state === 'waiting'" class="flex flex-wrap items-center gap-2">
        <!-- Copy, never open: this page may be running in the owner's own browser, which is signed
             in to another Claude account (owner, 2026-09-30; see cli-quick-add.ts). -->
        <Button v-if="flow.url && !flow.window" variant="outline" @click="qaReopen(flow)">
          <AppWindow /> {{ $t('climayte.qaReopen') }}
        </Button>
        <Button v-if="flow.url" :variant="flow.window ? 'ghost' : 'outline'" @click="qaCopyLink(flow)">
          <Copy /> {{ $t('climayte.qaCopyLink') }}
        </Button>
        <form
          class="flex items-center gap-2"
          :aria-busy="qaSendingCode === flow.id"
          @submit.prevent="onQuickAddCode(flow)"
        >
          <label :for="`qa-code-${flow.id}`" class="text-muted-foreground">{{ $t('climayte.qaCodeHint') }}</label>
          <Input
            :id="`qa-code-${flow.id}`"
            v-model="qaCodes[flow.id]"
            class="w-32"
            autocomplete="one-time-code"
            :placeholder="$t('climayte.qaCodePlaceholder')"
          />
          <Button
            type="submit"
            variant="outline"
            :disabled="qaSendingCode === flow.id || !qaCodes[flow.id]?.trim()"
            :aria-busy="qaSendingCode === flow.id"
          >
            <LoaderCircle v-if="qaSendingCode === flow.id" class="animate-spin" />
            {{ $t('climayte.qaSendCode') }}
          </Button>
        </form>
        <Button variant="ghost" class="ms-auto" @click="onQuickAddCancel(flow)">
          {{ $t('climayte.qaCancel') }}
        </Button>
      </div>
    </div>
  </div>
</template>
