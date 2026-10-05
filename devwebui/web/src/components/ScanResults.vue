<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { EyeOff, FolderOpen, Sparkles, Undo2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import IconButton from "./IconButton.vue";
import type { ScanResult } from "@/api";

const { t } = useI18n({ useScope: "global" });

const props = defineProps<{
  result: ScanResult;
  deepening?: boolean; // tier-1 results shown; tier-2 deep sweep still running
  busy?: boolean;
  compact?: boolean; // shorter list (inline in the add form vs. the focused scan view)
  ignoredPaths?: string[]; // absolute dirs the user dismissed
  showIgnored?: boolean; // reveal (dimmed) the ignored ones instead of hiding them
}>();
const emit = defineEmits<{
  select: [path: string];
  ignore: [path: string];
  unignore: [path: string];
}>();

const ignoredSet = computed(() => new Set((props.ignoredPaths ?? []).map((p) => p.toLowerCase())));
const isIgnored = (path: string) => ignoredSet.value.has(path.toLowerCase());
// Detected list hides ignored folders unless "show ignored" is on.
const detected = computed(() => {
  const all = props.result.detected ?? [];
  return props.showIgnored ? all : all.filter((p) => !isIgnored(p.path));
});
const total = computed(() => props.result.files.length + detected.value.length);
</script>

<template>
  <div class="min-w-0 rounded-xl border border-border bg-muted/30 p-2">
    <p class="px-1 pb-1 text-xs text-muted-foreground">
      {{ t("scanResults.summary", { count: total + (result.truncated ? "+" : ""), ms: result.ms, dirs: result.scannedDirs }) }}{{ result.timedOut ? " " + t("scanResults.stoppedEarly") : "" }}
      <span v-if="deepening" class="text-primary">{{ t("scanResults.stillScanning") }}</span>
    </p>
    <!-- overflow-y-auto (NOT overflow-auto): a horizontal scroll container would
         give every row unbounded width, so the path <code> never truncates and
         blows the dialog wide. Confine to the vertical axis and let truncate work. -->
    <ul
      v-if="total"
      class="flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden"
      :class="compact ? 'max-h-44' : 'max-h-[min(60vh,28rem)]'"
    >
      <li v-for="f in result.files" :key="f.path" class="min-w-0">
        <Button
          variant="ghost"
          size="row"
          class="w-full min-w-0"
          :disabled="busy"
          @click="emit('select', f.path)"
        >
          <FolderOpen class="size-3.5 shrink-0 text-primary" />
          <span class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase text-primary">
            {{ t("scanResults.configuredBadge") }}
          </span>
          <span class="shrink-0 text-sm">{{ f.name }}</span>
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ t("scanResults.procCount", { count: f.processes }) }}</span>
          <code class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ f.path }}</code>
        </Button>
      </li>
      <li
        v-for="p in detected"
        :key="`detected:${p.path}`"
        class="group/detected flex min-w-0 items-center gap-1"
      >
        <!-- The ignored dim rides on a plain wrapper: the Button owns its own appearance. -->
        <span class="flex min-w-0 flex-1" :class="isIgnored(p.path) ? 'opacity-45' : ''">
          <Button
            variant="ghost"
            size="row"
            class="min-w-0 flex-1"
            :disabled="busy"
            @click="emit('select', p.path)"
          >
            <Sparkles class="size-3.5 shrink-0 text-primary" />
            <span class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase text-primary">
              {{ t("scanResults.detectedBadge") }}
            </span>
            <span
              v-if="isIgnored(p.path)"
              class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs font-medium uppercase text-muted-foreground"
            >
              {{ t("scanResults.ignoredBadge") }}
            </span>
            <span class="shrink-0 text-sm">{{ p.name }}</span>
            <span v-if="p.framework" class="shrink-0 text-xs text-muted-foreground">{{ p.framework }}</span>
            <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ t("scanResults.procCount", { count: p.processes }) }}</span>
            <code class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ p.path }}</code>
          </Button>
        </span>
        <!-- Hover/focus reveal belongs to the row, so it lives on a plain wrapper, not the button. -->
        <span
          class="flex shrink-0 transition-opacity"
          :class="isIgnored(p.path) ? 'opacity-100' : 'opacity-0 group-hover/detected:opacity-100 has-focus-visible:opacity-100'"
        >
          <IconButton
            :disabled="busy"
            :tooltip="isIgnored(p.path) ? t('scanResults.unignore') : t('scanResults.ignore')"
            @click.stop="isIgnored(p.path) ? emit('unignore', p.path) : emit('ignore', p.path)"
          >
            <Undo2 v-if="isIgnored(p.path)" class="size-3.5" />
            <EyeOff v-else class="size-3.5" />
          </IconButton>
        </span>
      </li>
    </ul>
    <div v-else class="flex flex-col items-start gap-2 p-1">
      <p class="text-xs text-muted-foreground">{{ t("scanResults.emptyHint") }}</p>
      <!-- Lets the focused scan view drop a "Add manually" escape hatch right here. -->
      <slot name="empty" />
    </div>
  </div>
</template>
