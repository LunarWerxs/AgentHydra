<script setup lang="ts">
// Settings → Alerts tab: the GUI half of threshold alerting (server/src/alerts.ts). Rules
// (list/add/remove) and fired-event history mirror the five MCP alert tools 1:1 (server/src/
// mcp.ts) and the `devwebui alerts ...` CLI (server/src/cli.ts) - see AI_GUIDE.md's GUI/CLI/MCP
// parity convention. Fired events reuse the store's existing SSE-fed `alertEvents`; rules have
// no live push (nothing else changes them), so they're fetched here on mount and kept in local
// state, refreshed optimistically on add/remove.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { AlertTriangle, Plus, Trash2 } from "@lucide/vue";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import IconButton from "@/components/IconButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addAlertRule, getAlertRules, removeAlertRule } from "@/api";
import { useAppStore } from "@/store";
import { formatAgo, formatBytes } from "@/lib/format";
import type { AlertMetric, AlertRule } from "@/types";

const { t } = useI18n({ useScope: "global" });
const store = useAppStore();

const rules = ref<AlertRule[]>([]);
const loading = ref(false);
const removingId = ref<string | null>(null);

async function loadRules() {
  loading.value = true;
  try {
    rules.value = await getAlertRules();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("alerts.loadFailed"));
  } finally {
    loading.value = false;
  }
}
onMounted(loadRules);

function processLabel(processId: string): string {
  const p = store.allProcesses.find((x) => x.id === processId);
  return p ? `${p.projectName} · ${p.name}` : processId;
}

/** Human-facing threshold text: percent for cpu, MB for memory (the API/CLI use raw bytes). */
function fmtThreshold(metric: AlertMetric, value: number): string {
  return metric === "cpu" ? `${value}%` : formatBytes(value);
}

// ── add-rule form ─────────────────────────────────────────────────────────────────────────────
const newProcessId = ref("");
const newMetric = ref<AlertMetric>("cpu");
const newThresholdText = ref("");
const newForSecondsText = ref("120");
const adding = ref(false);

const metricOptions = computed<{ value: AlertMetric; label: string }[]>(() => [
  { value: "cpu", label: t("alerts.cpu") },
  { value: "memory", label: t("alerts.memory") },
]);
const thresholdUnit = computed(() => (newMetric.value === "cpu" ? "%" : "MB"));
const parsedThreshold = computed(() => Number(newThresholdText.value));
const parsedForSeconds = computed(() => Number(newForSecondsText.value));
const canAdd = computed(
  () =>
    !!newProcessId.value &&
    Number.isFinite(parsedThreshold.value) &&
    parsedThreshold.value > 0 &&
    Number.isFinite(parsedForSeconds.value) &&
    parsedForSeconds.value >= 0,
);

async function add() {
  if (!canAdd.value) return;
  adding.value = true;
  try {
    const threshold =
      newMetric.value === "cpu" ? parsedThreshold.value : parsedThreshold.value * 1_048_576;
    const rule = await addAlertRule({
      processId: newProcessId.value,
      metric: newMetric.value,
      threshold,
      forMs: Math.round(parsedForSeconds.value * 1000),
    });
    rules.value = [rule, ...rules.value];
    newThresholdText.value = "";
    toast.success(t("alerts.added"));
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("alerts.addFailed"));
  } finally {
    adding.value = false;
  }
}

async function remove(id: string) {
  removingId.value = id;
  try {
    await removeAlertRule(id);
    rules.value = rules.value.filter((r) => r.id !== id);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("alerts.removeFailed"));
  } finally {
    removingId.value = null;
  }
}

function clearEvents() {
  store.clearAlertEventsLocal();
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <SettingsGroup :label="t('alerts.rulesTitle')" :description="t('alerts.rulesHelp')">
      <p v-if="!loading && !rules.length" class="px-3.5 py-3 text-sm text-muted-foreground">
        {{ t("alerts.noRules") }}
      </p>
      <div v-for="r in rules" :key="r.id" class="flex items-center gap-3 px-3.5 py-2.5">
        <AlertTriangle class="size-4.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate text-sm text-foreground">
          {{ processLabel(r.processId) }}
          <span class="text-muted-foreground">
            - {{ r.metric === "cpu" ? t("alerts.cpu") : t("alerts.memory") }}
            &gt; {{ fmtThreshold(r.metric, r.threshold) }}
            {{ t("alerts.forDuration", { secs: Math.round(r.forMs / 1000) }) }}
          </span>
        </span>
        <IconButton
          :tooltip="t('alerts.remove')"
          :disabled="removingId === r.id"
          @click="remove(r.id)"
        >
          <Trash2 class="size-4" />
        </IconButton>
      </div>

      <div class="flex flex-wrap items-end gap-2 px-3.5 py-3">
        <Select v-model="newProcessId">
          <SelectTrigger class="h-8 w-44" :aria-label="t('alerts.pickProcess')">
            <SelectValue :placeholder="t('alerts.pickProcess')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="p in store.allProcesses" :key="p.id" :value="p.id">
              {{ p.projectName }} · {{ p.name }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="newMetric">
          <SelectTrigger class="h-8 w-28" :aria-label="t('alerts.metric')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="o in metricOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <label class="flex items-center gap-1">
          <Input
            v-model="newThresholdText"
            inputmode="decimal"
            class="h-8 w-16"
            :placeholder="newMetric === 'cpu' ? '80' : '512'"
            :aria-label="t('alerts.thresholdLabel', { unit: thresholdUnit })"
          />
          <span class="text-xs text-muted-foreground">{{ thresholdUnit }}</span>
        </label>
        <span class="text-xs text-muted-foreground">{{ t("alerts.for") }}</span>
        <label class="flex items-center gap-1">
          <Input
            v-model="newForSecondsText"
            inputmode="numeric"
            class="h-8 w-16"
            :aria-label="t('alerts.forSecondsLabel')"
          />
          <span class="text-xs text-muted-foreground">{{ t("alerts.seconds") }}</span>
        </label>
        <Button size="sm" class="h-8" :disabled="!canAdd || adding" @click="add">
          <Plus class="size-4" />
          {{ t("alerts.add") }}
        </Button>
      </div>
    </SettingsGroup>

    <SettingsGroup :label="t('alerts.eventsTitle')">
      <p v-if="!store.alertEvents.length" class="px-3.5 py-3 text-sm text-muted-foreground">
        {{ t("alerts.noEvents") }}
      </p>
      <div v-for="e in store.alertEvents.slice(0, 20)" :key="e.id" class="px-3.5 py-2 text-sm">
        <span class="text-foreground">{{ e.processName }}</span>
        <span class="text-muted-foreground">
          -
          {{
            t("alerts.eventLine", {
              value: fmtThreshold(e.metric, e.value),
              threshold: fmtThreshold(e.metric, e.threshold),
              metric: e.metric === "cpu" ? t("alerts.cpu") : t("alerts.memory"),
              when: formatAgo(store.now, e.firedAt),
            })
          }}
        </span>
      </div>
      <div v-if="store.alertEvents.length" class="px-3.5 py-2">
        <Button variant="ghost" size="sm" @click="clearEvents">{{ t("alerts.clearEvents") }}</Button>
      </div>
    </SettingsGroup>
  </div>
</template>
