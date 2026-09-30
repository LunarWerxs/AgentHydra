<script setup lang="ts">
// Quick add: one email in, a browser sign-in out (server/src/core/cli-quick-add.ts, docs/CORCH.md).
// Self-contained so it can live both in CliInstancesSection and in CorchView — the owner may hide
// the CLI Instances section, and Corch runs on these accounts. Polls every 2 s only while a flow is
// waiting; emits 'signed-in' when a flow turns signed-in so the host can refresh its list.
import { ExternalLink, Plus } from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
// biome-ignore lint/style/useImportType: a component used in the template. A type-only import erases it, the tag renders as a bare <input>, v-model never updates, and Add stays disabled (2026-09-30).
import { Input } from '@/components/ui/input'
import type { QuickAddFlow } from '@/lib/api'
import { cancelQuickAdd, listQuickAdds, startQuickAdd, submitQuickAddCode } from '@/lib/api'

const emit = defineEmits<{ 'signed-in': [] }>()

const { t } = useI18n()

const qaEmail = ref('')
const qaInput = ref<InstanceType<typeof Input> | null>(null)
const qaStarting = ref(false)
const qaFlows = ref<QuickAddFlow[]>([])
/** Flows started from this window; the rest of the server's last-20 list is only shown while waiting. */
const qaMine = new Set<string>()
const qaCodes = ref<Record<string, string>>({})
let qaTimer: number | null = null
let qaAlive = true

const qaVisible = computed(() =>
  qaFlows.value.filter((f) => f.state === 'waiting' || qaMine.has(f.id)),
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
      qaMine.add(r.id)
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

onMounted(() => void qaPoll())
onUnmounted(() => {
  qaAlive = false
  if (qaTimer !== null) window.clearTimeout(qaTimer)
  qaTimer = null
})
</script>

<template>
  <!-- Type an email, confirm in the browser, the new CLI instance lands in the CLI table. No padding
       of its own: each host places it (a class on the tag falls through to this root). -->
  <div class="flex flex-col gap-1.5">
    <form class="flex items-center gap-2" @submit.prevent="onQuickAdd">
      <Input
        ref="qaInput"
        v-model="qaEmail"
        type="email"
        class="max-w-sm"
        :placeholder="$t('corch.qaPlaceholder')"
        :aria-label="$t('corch.qaPlaceholder')"
      />
      <Button type="submit" size="sm" :disabled="qaStarting || !qaEmail.trim()">
        <Plus /> {{ $t('corch.qaAdd') }}
      </Button>
    </form>
    <div
      v-for="flow in qaVisible"
      :key="flow.id"
      class="flex flex-wrap items-center gap-2 text-xs"
      role="status"
    >
      <span class="font-medium">{{ flow.email }}</span>
      <template v-if="flow.state === 'waiting'">
        <span class="text-muted-foreground">{{ $t('corch.qaConfirm') }}</span>
        <Button v-if="flow.url" as="a" :href="flow.url" target="_blank" rel="noopener" variant="link" size="sm">
          <ExternalLink /> {{ $t('corch.qaOpenPage') }}
        </Button>
        <form class="flex items-center gap-1" @submit.prevent="onQuickAddCode(flow)">
          <Input
            v-model="qaCodes[flow.id]"
            class="h-7 w-36"
            :placeholder="$t('corch.qaCodePlaceholder')"
            :aria-label="$t('corch.qaCodePlaceholder')"
          />
          <Button type="submit" variant="outline" size="sm" :disabled="!qaCodes[flow.id]?.trim()">
            {{ $t('corch.qaSendCode') }}
          </Button>
        </form>
        <Button variant="ghost" size="sm" @click="onQuickAddCancel(flow)">
          {{ $t('corch.qaCancel') }}
        </Button>
      </template>
      <span v-else-if="flow.state === 'signed-in'" class="text-success">
        {{
          flow.account?.plan
            ? $t('corch.qaSignedIn', { email: flow.account?.email ?? flow.email, plan: flow.account.plan })
            : $t('corch.qaSignedInNoPlan', { email: flow.account?.email ?? flow.email })
        }}
      </span>
      <span v-else-if="flow.state === 'failed'" class="text-destructive">
        {{ $t('corch.qaFailed', { reason: flow.message }) }}
      </span>
      <span v-else class="text-muted-foreground">{{ $t('corch.qaCancelled') }}</span>
    </div>
  </div>
</template>
