<script setup lang="ts">
// "An update is available — want it?"
//
// Raised by the daemon's scheduled check (SSE `update_available`, see server/src/auto-update.ts)
// whenever it finds a newer version while auto-apply is off (or blocked). This is the OFFER, not
// the act: nothing installs until the owner clicks "Update now" below. The separate `autoUpdate`
// setting is the one that installs unattended — when it's on, the daemon applies and relaunches
// instead of announcing, so this banner never appears.
//
// Dismissing just hides the banner until the next scheduled check re-announces it (see
// store.dismissUpdateAvailable) — it does not turn off notify; that's the Settings toggle.
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Loader2, Sparkles, TriangleAlert, X } from "@lucide/vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store";
import { WARNING_BANNER } from "@/lib/severity";

const store = useAppStore();
const { t } = useI18n({ useScope: "global" });

const applying = ref(false);

async function updateNow() {
  if (applying.value) return;
  applying.value = true;
  try {
    // The apply route re-checks the working tree itself (never updates a dirty one), so this is
    // safe to fire even though `canApply` was only a snapshot from the last scheduled check.
    const result = await store.applyUpdate();
    store.dismissUpdateAvailable();
    toast.success(t("actions.updateApplied"), {
      description: result.restartRequired ? t("actions.updateRestart") : undefined,
    });
  } catch (e) {
    toast.error(t("actions.updateFailed"), {
      description: e instanceof Error ? e.message : undefined,
    });
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <div
    v-if="store.updateAvailable"
    class="rounded-xl p-3 text-sm"
    :class="store.updateAvailableCanApply ? 'border border-primary/30 bg-primary/5' : WARNING_BANNER"
  >
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <TriangleAlert v-if="!store.updateAvailableCanApply" class="size-4 shrink-0 text-warning" />
        <Sparkles v-else class="size-4 shrink-0 text-primary" />
        <span class="min-w-0">
          <span class="font-medium">{{ t("actions.updateAvailable") }}</span>
          <span
            v-if="!store.updateAvailableCanApply && store.updateAvailableReason"
            class="text-muted-foreground"
          > — {{ store.updateAvailableReason }}</span>
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <Button size="sm" :disabled="applying || !store.updateAvailableCanApply" @click="updateNow">
          <Loader2 v-if="applying" class="size-4 animate-spin" />
          <Download v-else class="size-4" />
          {{ t("actions.updateNow") }}
        </Button>
        <button
          type="button"
          class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="t('notifications.dismiss')"
          @click="store.dismissUpdateAvailable"
        >
          <X class="size-4" />
        </button>
      </div>
    </div>
  </div>
</template>
