<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { History, Search, X } from "@lucide/vue";
import RightDrawer from "./RightDrawer.vue";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store";
import { getProcessLogFile } from "@/api";

const { t } = useI18n({ useScope: "global" });

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ processId: string | null }>();

const store = useAppStore();
const { allProcesses, logs } = storeToRefs(store);

const scroller = useTemplateRef<HTMLElement>("scroller");
const lines = computed(() => (props.processId ? (logs.value[props.processId] ?? []) : []));
const proc = computed(() => allProcesses.value.find((p) => p.id === props.processId));

// Case-insensitive filter over both the live buffer and any loaded history.
const filterText = ref("");
const filteredLines = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  return q ? lines.value.filter((l) => l.line.toLowerCase().includes(q)) : lines.value;
});

/**
 * "Load older history" — reaches past the in-memory 500-line ring buffer into the
 * on-disk rotating log file (the Time-Travel Log Vault, api.getProcessLogFile), which
 * survives daemon restarts. The endpoint always returns a fresh TAIL of up to N lines
 * (not incremental pages), so each click just asks for a bigger tail and replaces the
 * local history with it.
 */
const HISTORY_PAGE = 500;
const historyRequested = ref(0);
const historyRaw = ref<string[]>([]);
const historyLoading = ref(false);
const historyExhausted = ref(false);

// Vault lines are formatted `<ISO timestamp> [stream] <text>` (see
// manager/monitoring.ts's addLog) — parsed back out to render + de-dupe against the
// live buffer below. A line that doesn't match the shape still renders, just undated.
const VAULT_LINE_RE = /^(\S+) \[(stdout|stderr)\] ([\s\S]*)$/;
function parseVaultLine(raw: string): {
  ts: number;
  stream: "stdout" | "stderr" | null;
  line: string;
} {
  const m = VAULT_LINE_RE.exec(raw);
  if (!m) return { ts: 0, stream: null, line: raw };
  const ts = Date.parse(m[1]);
  return { ts: Number.isFinite(ts) ? ts : 0, stream: m[2] as "stdout" | "stderr", line: m[3] };
}

// The vault and the live buffer overlap (every line is written to both) — keep only
// the portion strictly OLDER than the live buffer's earliest line so history never
// duplicates what's already on screen below it.
const earliestLiveTs = computed(() => lines.value[0]?.ts ?? Number.POSITIVE_INFINITY);
const history = computed(() =>
  historyRaw.value.map(parseVaultLine).filter((e) => e.ts > 0 && e.ts < earliestLiveTs.value),
);
const filteredHistory = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  return q ? history.value.filter((l) => l.line.toLowerCase().includes(q)) : history.value;
});

async function loadOlderHistory() {
  if (!props.processId || historyLoading.value || historyExhausted.value) return;
  historyLoading.value = true;
  // Prepending taller content shifts everything down — remember the scroll offset so
  // the lines the user was already looking at don't visually jump.
  const prevHeight = scroller.value?.scrollHeight ?? 0;
  const prevTop = scroller.value?.scrollTop ?? 0;
  try {
    const nextRequested = historyRequested.value + HISTORY_PAGE;
    const res = await getProcessLogFile(props.processId, nextRequested);
    historyRaw.value = res.lines;
    historyRequested.value = nextRequested;
    // Fewer lines came back than we asked for — the vault is exhausted.
    historyExhausted.value = res.lines.length < nextRequested;
  } catch {
    /* best-effort — the live buffer stays intact either way */
  } finally {
    historyLoading.value = false;
  }
  await nextTick();
  if (scroller.value)
    scroller.value.scrollTop = prevTop + (scroller.value.scrollHeight - prevHeight);
}

function resetHistory() {
  historyRaw.value = [];
  historyRequested.value = 0;
  historyExhausted.value = false;
}

function scrollToBottom() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

watch(open, async (v) => {
  if (v && props.processId) {
    resetHistory();
    filterText.value = "";
    await store.fetchLogs(props.processId);
    await nextTick();
    scrollToBottom();
  }
});

// Drawer already open and the caller switched processes — refetch for the new id.
watch(
  () => props.processId,
  async (id) => {
    if (open.value && id) {
      resetHistory();
      filterText.value = "";
      await store.fetchLogs(id);
      await nextTick();
      scrollToBottom();
    }
  },
);

watch(
  () => lines.value.length,
  async () => {
    await nextTick();
    scrollToBottom();
  },
);
</script>

<template>
  <RightDrawer v-model:open="open" :title="proc?.name ?? t('logs.title')">
    <template #header>
      <span class="font-semibold">{{ proc?.name ?? t("logs.title") }}</span>
      <code v-if="proc" class="truncate text-xs text-muted-foreground">{{ proc.command }}</code>
    </template>

    <div class="relative mt-3">
      <Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        v-model="filterText"
        type="search"
        leading="icon-sm"
        :trailing="filterText ? 'icon-sm' : 'none'"
        class="h-8"
        :placeholder="t('logs.filterPlaceholder')"
        :aria-label="t('logs.filterAriaLabel')"
      />
      <button
        v-if="filterText"
        type="button"
        class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        :aria-label="t('logs.filterClear')"
        @click="filterText = ''"
      >
        <X class="size-3.5" />
      </button>
    </div>

    <div
      ref="scroller"
      class="mt-3 min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed"
    >
      <div v-if="processId && !historyExhausted" class="mb-2 flex justify-center">
        <Button variant="ghost" size="sm" :disabled="historyLoading" @click="loadOlderHistory">
          <History class="size-3.5" :class="historyLoading ? 'animate-pulse' : ''" />
          {{ historyLoading ? t("logs.loadingOlder") : t("logs.loadOlder") }}
        </Button>
      </div>

      <div v-if="!filteredHistory.length && !filteredLines.length" class="text-muted-foreground">
        {{ filterText ? t("logs.noMatch") : t("logs.noOutput") }}
      </div>

      <!-- Vault history — older than anything in the live buffer, so it always leads. -->
      <div
        v-for="(l, i) in filteredHistory"
        :key="`h-${i}`"
        class="whitespace-pre-wrap break-all opacity-70"
        :class="l.stream === 'stderr' ? 'text-destructive' : 'text-foreground/80'"
      >
        {{ l.line }}
      </div>
      <div
        v-for="l in filteredLines"
        :key="l.seq"
        class="whitespace-pre-wrap break-all"
        :class="l.stream === 'stderr' ? 'text-destructive' : 'text-foreground/80'"
      >
        {{ l.line }}
      </div>
    </div>
  </RightDrawer>
</template>
