<script setup lang="ts">
/**
 * CloudSyncSection — the opt-in "Sync my settings with Connections" control.
 * Four states: not connected (sign-in CTA), loading (spinner), enabled+connected
 * (compact status row + sync-now/disconnect), and a non-blocking inline error.
 * Signing in is a full-page navigation (`/oauth/login`); there is no session/SSE
 * for sync, so status is (re)loaded on mount, after actions, and on `?connected=1`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Cloud, CloudCheck, CloudOff, ExternalLink, LogOut, RefreshCw, User } from "@lucide/vue";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import { Button } from "@/components/ui/button";
import IconButton from "@/components/IconButton.vue";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAppStore } from "@/store";
import { formatAgo } from "@/lib/relativeTime";

const { t } = useI18n({ useScope: "global" });
const store = useAppStore();

const now = ref(Date.now());
const nowTimer = setInterval(() => (now.value = Date.now()), 30_000);
onBeforeUnmount(() => clearInterval(nowTimer));

const status = computed(() => store.syncStatus);
const enabled = computed(() => status.value?.enabled ?? false);
const connected = computed(() => status.value?.connected ?? false);

// Two-step confirm for the destructive "forget this connection" action.
const confirmingDisconnect = ref(false);
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

const syncedLabel = computed(() => {
  const iso = status.value?.lastSyncedAt;
  if (!iso) return t("cloudSync.neverSynced");
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return t("cloudSync.neverSynced");
  const seconds = Math.round((now.value - ts) / 1000);
  if (seconds < 10) return t("cloudSync.syncedNow");
  return t("cloudSync.syncedAgo", { when: formatAgo(now.value, ts) });
});

function goSignIn() {
  // Open the OAuth flow in a NEW tab so the current app state isn't lost (the new tab lands on
  // /?connected=1 after auth). Sync status is refreshed when the user returns to this tab.
  window.open("/oauth/login", "_blank", "noopener");
}
function onWindowFocus() {
  if (!connected.value) void store.loadSyncStatus();
}
onMounted(() => window.addEventListener("focus", onWindowFocus));
onBeforeUnmount(() => window.removeEventListener("focus", onWindowFocus));

async function onToggleEnable(next: boolean) {
  confirmingDisconnect.value = false;
  if (next) await store.enableSync();
  else await store.disableSync(false);
}

async function onSyncNow() {
  await store.pullSync();
  if (!store.syncError) await store.pushSync();
}

async function onDisconnectClick() {
  if (!confirmingDisconnect.value) {
    confirmingDisconnect.value = true;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => (confirmingDisconnect.value = false), 4000);
    return;
  }
  confirmingDisconnect.value = false;
  clearTimeout(confirmTimer);
  await store.disableSync(true);
}
</script>

<template>
  <SettingsGroup :label="t('cloudSync.title')">
    <!-- Loading -->
    <SettingsRow v-if="store.syncLoading && !status">
      <template #icon><RefreshCw class="size-4.5 shrink-0 animate-spin text-muted-foreground" /></template>
      <template #label>{{ t("cloudSync.loading") }}</template>
    </SettingsRow>

    <!-- Not connected: sign-in CTA -->
    <div v-else-if="!connected" class="px-3.5 py-2.5">
      <Button variant="outline" class="w-full" @click="goSignIn">
        <Cloud class="size-3.5 text-info" />
        {{ t("cloudSync.connectButton") }}
        <ExternalLink class="size-3.5 opacity-70" />
      </Button>
    </div>

    <!-- Enabled + connected: compact status row -->
    <template v-else>
      <SettingsRow :icon="CloudCheck" :label="t('cloudSync.enableToggle')">
        <template #control>
          <Switch id="sd-sync-enable" :model-value="enabled" @update:model-value="onToggleEnable" />
        </template>
      </SettingsRow>
      <SettingsRow v-if="enabled" :label="status?.name || status?.email || ''">
        <template #icon>
          <img v-if="status?.picture" :src="status.picture" alt="" class="size-4.5 rounded-full object-cover shrink-0" />
          <User v-else class="size-4.5 shrink-0 text-muted-foreground" />
        </template>
        <template #control>
          <!-- live sync status stays visible (not tucked behind the info icon like static help) -->
          <span class="text-xs text-muted-foreground">{{ syncedLabel }}</span>
          <IconButton :tooltip="t('cloudSync.syncNow')" :disabled="store.syncLoading" @click="onSyncNow">
            <RefreshCw class="size-3.5" :class="{ 'animate-spin': store.syncLoading }" />
          </IconButton>
        </template>
      </SettingsRow>
      <SettingsRow>
        <template #icon><LogOut class="size-4.5 shrink-0 text-muted-foreground" /></template>
        <template #label>
          {{ confirmingDisconnect ? t("cloudSync.confirmDisconnect") : t("cloudSync.stopSyncing") }}
        </template>
        <template #control>
          <Button
            :variant="confirmingDisconnect ? 'destructive' : 'ghost'"
            size="sm"
            :disabled="store.syncLoading"
            @click="onDisconnectClick"
          >
            <CloudOff class="size-3.5" />
            {{ t("cloudSync.disconnect") }}
          </Button>
        </template>
      </SettingsRow>
    </template>

    <!-- Inline, non-blocking error -->
    <div v-if="store.syncError" class="px-3.5 py-2.5">
      <Alert variant="destructive">
        <AlertDescription>{{ store.syncError }}</AlertDescription>
      </Alert>
    </div>

  </SettingsGroup>
</template>
