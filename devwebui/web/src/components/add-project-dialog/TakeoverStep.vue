<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Check, ShieldCheck, TriangleAlert } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store";
import type { AutostartTrigger, TakeOverResult } from "@/api";
import { WARNING_BANNER } from "@/lib/severity";

const open = defineModel<boolean>("open", { required: true });
// Set after a load when the repo ALSO auto-starts its dev server outside DevWebUI
// (VS Code tasks.json folderOpen / the "Vite" extension) — offer to retire those.
const takeover = defineModel<{
  dir: string;
  triggers: AutostartTrigger[];
  result?: TakeOverResult;
} | null>("takeover", { required: true });
const busy = defineModel<boolean>("busy", { required: true });
const error = defineModel<string>("error", { required: true });

const store = useAppStore();
const { t } = useI18n({ useScope: "global" });

async function takeOver() {
  const tk = takeover.value;
  if (!tk || busy.value) return;
  error.value = "";
  busy.value = true;
  try {
    takeover.value = { ...tk, result: await store.takeOverAutostart(tk.dir) };
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("addProject.requestFailed");
  } finally {
    busy.value = false;
  }
}

// Close out the take-over step (after retiring, or "Keep as is").
function finishTakeOver() {
  takeover.value = null;
  open.value = false;
}
</script>

<template>
  <!-- Take over — the added repo also auto-starts its dev server outside DevWebUI -->
  <div v-if="takeover" v-auto-animate class="flex min-w-0 flex-col gap-4">
    <Alert v-if="error" variant="destructive" class="whitespace-pre-line">
      <TriangleAlert />
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Offer to retire the triggers -->
    <div
      v-if="!takeover.result"
      class="rounded-xl p-3 text-sm"
      :class="WARNING_BANNER"
    >
      <div class="flex items-center gap-2 font-medium text-warning">
        <ShieldCheck class="size-4" />
        {{ t("addProject.takeoverHeading") }}
      </div>
      <p class="mt-1 text-muted-foreground" v-html="t('addProject.takeoverBody')" />
      <ul class="mt-2 flex flex-col gap-1.5">
        <li v-for="(trg, i) in takeover.triggers" :key="i" class="flex min-w-0 items-start gap-2">
          <span class="mt-1.5 size-2 shrink-0 rounded-full bg-warning" />
          <span class="min-w-0">
            <span class="text-foreground">{{ trg.label }}</span>
            <span class="text-muted-foreground"> — {{ trg.detail }}</span>
            <code class="block truncate text-xs text-muted-foreground">{{ trg.file }}</code>
          </span>
        </li>
      </ul>
      <div class="mt-3 flex gap-2">
        <Button size="sm" :disabled="busy" @click="takeOver">
          <ShieldCheck class="size-4" /> {{ t("addProject.takeOver") }}
        </Button>
        <Button size="sm" variant="ghost" :disabled="busy" @click="finishTakeOver">{{ t("addProject.keepAsIs") }}</Button>
      </div>
    </div>

    <!-- Result of taking over -->
    <div v-else class="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <div class="flex items-center gap-2 font-medium">
        <Check class="size-4 text-primary" />
        {{
          takeover.result.disabled.length
            ? t("addProject.retired", takeover.result.disabled.length)
            : t("addProject.nothingRetired")
        }}
      </div>
      <p v-if="takeover.result.backups.length" class="mt-1 text-muted-foreground">
        {{ t("addProject.backedUp", takeover.result.backups.length) }}
      </p>
      <ul
        v-if="takeover.result.skipped.length"
        class="mt-2 flex flex-col gap-1 text-xs text-muted-foreground"
      >
        <li v-for="(s, i) in takeover.result.skipped" :key="i" class="truncate">
          <i18n-t keypath="addProject.skipped" tag="span" scope="global">
            <template #file>{{ s.file }}</template>
            <template #reason>{{ s.reason }}</template>
          </i18n-t>
        </li>
      </ul>
      <div class="mt-3">
        <Button size="sm" :disabled="busy" @click="finishTakeOver">
          <Check class="size-4" /> {{ t("addProject.done") }}
        </Button>
      </div>
    </div>
  </div>
</template>
