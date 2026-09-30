<script setup lang="ts">
// Quick add: one email in, a browser sign-in out (server/src/core/cli-quick-add.ts, docs/CORCH.md).
// Self-contained so it can live both in CliInstancesSection and in CorchView — the owner may hide
// the CLI Instances section, and Corch runs on these accounts. Polls every 2 s only while a flow is
// waiting; emits 'signed-in' when a flow turns signed-in so the host can refresh its list.
import { AppWindow, Copy, LoaderCircle, Plus, X } from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
// biome-ignore lint/style/useImportType: a component used in the template. A type-only import erases it, the tag renders as a bare <input>, v-model never updates, and Add stays disabled (2026-09-30).
import { Input } from '@/components/ui/input'
import type { QuickAddFlow } from '@/lib/api'
import {
  cancelQuickAdd,
  listQuickAdds,
  reopenQuickAddWindow,
  startQuickAdd,
  submitQuickAddCode,
} from '@/lib/api'

const emit = defineEmits<{ 'signed-in': [] }>()

const { t } = useI18n()

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
  if (qaFlows.value.some((f) => f.state === 'signed-in' && prev.get(f.id) === 'waiting'))
    emit('signed-in')
  qaSchedule()
}
async function onQuickAdd() {
  const email = qaEmail.value.trim()
  if (!email || qaStarting.value) return
  qaStarting.value = true
  try {
    const r = await startQuickAdd(email)
    if ('error' in r) toast.error(r.error || t('corch.qaStartFailed'))
    else {
      qaMine.value = new Set(qaMine.value).add(r.id)
      qaFlows.value = [r, ...qaFlows.value.filter((f) => f.id !== r.id)]
      qaEmail.value = ''
      qaSchedule()
    }
  } catch {
    toast.error(t('corch.qaStartFailed'))
  } finally {
    qaStarting.value = false
    ;(qaInput.value?.$el as HTMLInputElement | undefined)?.focus()
  }
}
async function onQuickAddCode(flow: QuickAddFlow) {
  const code = qaCodes.value[flow.id]?.trim()
  if (!code) return
  try {
    const r = await submitQuickAddCode(flow.id, code)
    if (!r.ok) toast.error(r.message)
    else qaCodes.value[flow.id] = ''
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
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
    toast.success(t('corch.qaCopied'))
  } catch {
    toast.error(t('corch.qaCopyFailed'))
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

onMounted(() => void qaPoll())
onUnmounted(() => {
  qaAlive = false
  if (qaTimer !== null) window.clearTimeout(qaTimer)
  qaTimer = null
})
</script>

<template>
  <!-- Type an email, approve in the browser, the new CLI instance lands in the CLI table. No padding
       of its own: each host places it (a class on the tag falls through to this root). Input and
       buttons share one height (h-7), and each flow's state text is the only live region, so a
       poll does not re-announce the whole row. -->
  <div class="flex flex-col gap-2">
    <form class="flex items-center gap-2" @submit.prevent="onQuickAdd">
      <Input
        ref="qaInput"
        v-model="qaEmail"
        type="email"
        autocomplete="email"
        class="max-w-sm"
        :placeholder="$t('corch.qaPlaceholder')"
        :aria-label="$t('corch.qaEmailLabel')"
      />
      <Button type="submit" :disabled="qaStarting || !qaEmail.trim()">
        <LoaderCircle v-if="qaStarting" class="animate-spin" />
        <Plus v-else />
        {{ $t('corch.qaAdd') }}
      </Button>
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
            flow.window ? $t('corch.qaWindowOpen') : $t('corch.qaConfirm')
          }}</template>
          <template v-else-if="flow.state === 'signed-in'">{{
            flow.account?.plan
              ? $t('corch.qaSignedIn', { email: flow.account?.email ?? flow.email, plan: flow.account.plan })
              : $t('corch.qaSignedInNoPlan', { email: flow.account?.email ?? flow.email })
          }}</template>
          <template v-else-if="flow.state === 'failed'">{{ $t('corch.qaFailed', { reason: flow.message }) }}</template>
          <template v-else>{{ $t('corch.qaCancelled') }}</template>
        </span>
        <Button
          v-if="flow.state !== 'waiting'"
          variant="ghost"
          size="icon-xs"
          class="shrink-0"
          :aria-label="$t('corch.qaDismiss')"
          :title="$t('corch.qaDismiss')"
          @click="qaDismiss(flow)"
        >
          <X />
        </Button>
      </div>
      <div v-if="flow.state === 'waiting'" class="flex flex-wrap items-center gap-2">
        <!-- Copy, never open: this page may be running in the owner's own browser, which is signed
             in to another Claude account (owner, 2026-09-30; see cli-quick-add.ts). -->
        <Button v-if="flow.url && !flow.window" variant="outline" @click="qaReopen(flow)">
          <AppWindow /> {{ $t('corch.qaReopen') }}
        </Button>
        <Button v-if="flow.url" :variant="flow.window ? 'ghost' : 'outline'" @click="qaCopyLink(flow)">
          <Copy /> {{ $t('corch.qaCopyLink') }}
        </Button>
        <form class="flex items-center gap-2" @submit.prevent="onQuickAddCode(flow)">
          <label :for="`qa-code-${flow.id}`" class="text-muted-foreground">{{ $t('corch.qaCodeHint') }}</label>
          <Input
            :id="`qa-code-${flow.id}`"
            v-model="qaCodes[flow.id]"
            class="w-32"
            autocomplete="one-time-code"
            :placeholder="$t('corch.qaCodePlaceholder')"
          />
          <Button type="submit" variant="outline" :disabled="!qaCodes[flow.id]?.trim()">
            {{ $t('corch.qaSendCode') }}
          </Button>
        </form>
        <Button variant="ghost" class="ms-auto" @click="onQuickAddCancel(flow)">
          {{ $t('corch.qaCancel') }}
        </Button>
      </div>
    </div>
  </div>
</template>
