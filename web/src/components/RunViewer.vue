<script setup lang="ts">
import { ChevronRight, Terminal, Wrench } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Switch } from '@/components/ui/switch'
import { useData } from '@/composables/useData'
import type { RunEvent } from '@/lib/api'
import { streamUrl } from '@/lib/api'

const props = defineProps<{ itemId: string }>()
const events = ref<RunEvent[]>([])
const showTools = ref(false)
const scroller = ref<HTMLElement | null>(null)
let es: EventSource | null = null

function connect(id: string) {
  disconnect()
  events.value = []
  es = new EventSource(streamUrl(id))
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'event') {
        events.value.push(msg.data as RunEvent)
        nextTick(() => {
          if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
        })
      }
    } catch {
      /* ignore keepalive */
    }
  }
  es.onerror = () => {
    /* browser auto-reconnects; nothing to do */
  }
}
function disconnect() {
  es?.close()
  es = null
}

// How the run ended, from the queue's own record. A log that simply stops looks identical whether
// the run finished, crashed or was killed, and the daemon knows which from the child's exit code —
// so the panel says so rather than leaving the reader to guess from the last line.
const { queue } = useData()
const item = computed(() => queue.value.find((q) => q.id === props.itemId) ?? null)
const finished = computed(
  () => !!item.value && item.value.status !== 'queued' && item.value.status !== 'running',
)

onMounted(() => connect(props.itemId))
watch(() => props.itemId, connect)
onBeforeUnmount(disconnect)
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between border-b border-border px-3 py-2">
      <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Terminal class="size-3.5" /> {{ $t('run.liveOutput') }}
      </div>
      <div class="flex items-center gap-2.5">
        <template v-if="item && finished">
          <StatusBadge :status="item.status" />
          <span
            v-if="item.exit_code !== null"
            class="text-[11px] text-muted-foreground"
            :title="item.exit_code === -1 ? $t('queue.exitLostHint') : undefined"
          >
            {{ item.exit_code === -1 ? $t('queue.exitLost') : $t('queue.exitCode', { code: item.exit_code }) }}
          </span>
        </template>
        <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Wrench class="size-3.5" /> {{ $t('run.toolActivity') }}
          <Switch v-model="showTools" />
        </label>
      </div>
    </div>

    <div ref="scroller" class="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
      <p v-if="events.length === 0" class="text-xs text-muted-foreground italic">
        {{ $t('run.noOutputYet') }}
      </p>

      <template v-for="ev in events" :key="ev.id">
        <!-- assistant / user text -->
        <div
          v-if="ev.kind === 'text'"
          class="rounded-lg border px-3 py-2"
          :class="
            ev.role === 'assistant'
              ? 'border-border bg-accent'
              : 'border-border bg-muted/40'
          "
        >
          <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {{ ev.role }}
          </div>
          <div class="whitespace-pre-wrap break-words">{{ ev.text }}</div>
        </div>

        <!-- meta -->
        <div v-else-if="ev.kind === 'meta'" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ChevronRight class="size-3" /> {{ ev.text }}
        </div>

        <!-- tool activity (collapsed by default) -->
        <div
          v-else-if="showTools"
          class="flex items-start gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        >
          <Wrench class="mt-0.5 size-3 shrink-0" />
          <span class="break-all">
            <span v-if="ev.tool_name" class="text-foreground">{{ ev.tool_name }}</span>
            {{ ev.text }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
