<script setup lang="ts">
// "Stop the server too?" — shown when closing the focused shortcut window while its
// process is still running.
//
// This dialog exists because the obvious implementation is impossible: the focus window
// is a chromeless Chromium `--app=` window, so its titlebar X belongs to Edge, and the
// only close hook a page gets is `beforeunload` — whose prompt is Chromium's generic,
// non-customizable "Leave site?" with just Leave/Cancel. It cannot be reworded to ask
// about the server and has no room for a third answer. So the window offers its own
// Close button, which asks here, properly, with all three real outcomes.
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { stop } from "@/api";
import { useGroupActionToast } from "@/lib/groupToast";
import type { ProcessView } from "@/types";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ process: ProcessView }>();

const { t } = useI18n({ useScope: "global" });
const showGroupToast = useGroupActionToast();
const stopping = ref(false);

/**
 * Stop, THEN close — and only if the stop actually succeeded.
 *
 * Two things matter here and both are easy to get wrong. Awaiting: `window.close()`
 * tears the page down, and an in-flight fetch dies with it, so fire-and-forget would
 * leave the server running exactly when the user asked for the opposite. And checking
 * the OUTCOME: `stop()` genuinely can fail (the daemon 404s a process that a hard
 * reload has purged; a restart or a blip rejects the fetch). Closing anyway would
 * destroy the error toast along with the window and tell the user, by implication,
 * that a still-running server had stopped. On failure we stay open so the toast is
 * readable and "Leave running" is still one click away.
 *
 * This deliberately does NOT use useRunAction: that helper swallows the error into a
 * toast and returns void, which is precisely the signal this function needs.
 */
async function stopAndClose() {
  stopping.value = true;
  try {
    const res = await stop(props.process.id);
    showGroupToast("stopped", res.coStopped);
    open.value = false;
    window.close();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("focus.stopFailed"));
  } finally {
    stopping.value = false;
  }
}

function leaveRunning() {
  open.value = false;
  window.close();
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :aria-busy="stopping">
      <DialogHeader>
        <DialogTitle>{{ t("focus.closeTitle", { name: process.name }) }}</DialogTitle>
        <DialogDescription>{{ t("focus.closeDescription") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" :disabled="stopping" @click="open = false">
          {{ t("focus.closeCancel") }}
        </Button>
        <Button variant="outline" :disabled="stopping" @click="leaveRunning">
          {{ t("focus.leaveRunning") }}
        </Button>
        <Button variant="destructive" :disabled="stopping" @click="stopAndClose">
          {{ t("focus.stopAndClose") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
