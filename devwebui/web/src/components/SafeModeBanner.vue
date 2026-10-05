<script setup lang="ts">
// "DevWebUI crashed last time, so it started quietly."
//
// The daemon comes up in safe mode when its crash sentinel finds a run that never reached a clean
// shutdown (server/src/crash-sentinel.ts), or when launched with --safe-mode. Projects are loaded
// but nothing auto-started, so a server that takes the daemon down on start cannot loop it through
// the tray's revive. "View crash" opens the de-duplicated error entry the daemon recorded for it;
// "Leave safe mode" runs the skipped auto-start. There is no dismiss: the banner is the only
// sign that the servers the owner expects to be up were deliberately left down.
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Play, ShieldAlert, TriangleAlert } from "@lucide/vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store";
import { WARNING_BANNER } from "@/lib/severity";

const emit = defineEmits<{ viewCrash: [processId: string] }>();
const store = useAppStore();
const { t } = useI18n({ useScope: "global" });

const status = computed(() => (store.safeMode?.active ? store.safeMode : null));
const restarting = ref(false);

async function leaveSafeMode() {
  if (restarting.value) return;
  restarting.value = true;
  try {
    const result = await store.exitSafeMode();
    toast.success(t("safeMode.restarted"), {
      description: result.started.length
        ? t("safeMode.restartedStarted", { count: result.started.length }, result.started.length)
        : undefined,
    });
  } catch (e) {
    toast.error(t("safeMode.restartFailed"), {
      description: e instanceof Error ? e.message : undefined,
    });
  } finally {
    restarting.value = false;
  }
}
</script>

<template>
  <div v-if="status" class="rounded-xl p-3 text-sm" :class="WARNING_BANNER" role="status">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <ShieldAlert class="size-4 shrink-0" />
        <span class="min-w-0">
          <span class="font-medium">{{ t("safeMode.title") }}</span>
          <span class="text-muted-foreground">
            - {{ status.trigger === "crash" ? t("safeMode.crashed") : t("safeMode.requested") }}
          </span>
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <Button
          v-if="status.crashProcessId"
          size="sm"
          variant="ghost"
          @click="emit('viewCrash', status.crashProcessId)"
        >
          <TriangleAlert class="size-4" />
          {{ t("safeMode.viewCrash") }}
        </Button>
        <Button size="sm" :disabled="restarting" @click="leaveSafeMode">
          <Loader2 v-if="restarting" class="size-4 animate-spin" />
          <Play v-else class="size-4" />
          {{ t("safeMode.leaveSafeMode") }}
        </Button>
      </div>
    </div>
  </div>
</template>
