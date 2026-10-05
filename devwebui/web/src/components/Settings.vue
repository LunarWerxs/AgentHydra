<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useTheme } from "@/lib/theme";
import { useTooltipConfig } from "@/lib/tooltip-config";
import { useI18n } from "vue-i18n";
import {
  Activity,
  AppWindow,
  Bell,
  Cpu,
  EyeOff,
  ExternalLink,
  FilterX,
  FolderX,
  Hourglass,
  Languages,
  MessageCircleQuestion,
  Moon,
  Plug,
  Power,
  RefreshCw,
  Search,
  Sun,
  Unplug,
} from "@lucide/vue";
import Sidebar from "@/shell/Sidebar.vue";
import SettingsTabs from "@/shell/SettingsTabs.vue";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import type { PushPanelSide } from "@/shell/usePushPanel";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "vue-sonner";
import InfoHint from "@/shell/InfoHint.vue";
import CloudSyncSection from "./settings/CloudSyncSection.vue";
import AlertsSection from "./settings/AlertsSection.vue";
import { getSettings, openPortableWindow, saveSettings, type RuntimePref } from "@/api";
import { useAppStore } from "@/store";
import { setLocale } from "@/i18n";
import { LOCALES, isMachineDraft, type LocaleCode } from "@/i18n/locales";

const open = defineModel<boolean>("open", { required: true });
const props = withDefaults(defineProps<{ side?: PushPanelSide; rightOffsetPx?: number }>(), {
  side: "right",
  rightOffsetPx: 0,
});
const store = useAppStore();
const { t, locale } = useI18n({ useScope: "global" });

// Light/dark/system lives here. Writable: assigning 'light' | 'dark' | 'system'
// persists to localStorage and toggles <html class="dark"> via the shared composable.
const { mode: theme } = useTheme();

// Kit-level tooltip kill-switch (localStorage-persisted, shared across the whole app via
// TooltipProvider). Bound directly here — no server round-trip, no shared/dto.ts change.
const { enabled: tooltipsEnabled } = useTooltipConfig();

// Language picker: reads/writes the global i18n locale via setLocale (which persists
// the choice and updates <html lang>). Only English ships today; the list grows from
// the LOCALES registry.
const currentLocale = computed<LocaleCode>({
  get: () => locale.value as LocaleCode,
  set: (v) => setLocale(v),
});

const runtime = ref<RuntimePref>("auto");
const freePortOnStart = ref(true);
const autoStartOnLaunch = ref(false);
const monitorResources = ref(true);
const linkHost = ref("");
const autoScan = ref(false);
const excludeText = ref("");
const skipWindows = ref(false);
const skipMac = ref(false);
const skipLinux = ref(false);
const restartNow = ref(true);
const autoUpdate = ref(false);
const updateNotify = ref(true);
const updateCooldownDays = ref(0);
const portableMode = ref(false);
const hideTrayIcon = ref(false);
// Pre-edit snapshot of portableMode as THIS panel loaded it. save() detects the
// off->on transition against this, not store.portableMode: the store hydrates from
// its own unawaited fetch and can still hold its default when the user hits Save,
// which would misread "already on" as "just turned on" and pop an unwanted window.
const loadedPortableMode = ref(false);
const saving = ref(false);

// Three tabs: everyday knobs under General, everything else (server startup, how the UI opens,
// project scanning) under Advanced, and threshold alert rules + fired-event history under
// Alerts (self-contained — AlertsSection.vue owns its own fetch/save, unlike the other two
// tabs which this panel hydrates itself). Sections stay mounted behind v-show (SettingsTabs
// rule): the panel-open watcher below hydrates every tab's fields in one go.
type TabId = "general" | "advanced" | "alerts";
const tab = ref<TabId>("general");
const tabs = computed<{ id: TabId; label: string }[]>(() => [
  { id: "general", label: t("settings.tabGeneral") },
  { id: "advanced", label: t("settings.tabAdvanced") },
  { id: "alerts", label: t("settings.tabAlerts") },
]);

// OS names are proper nouns — deliberately left untranslated.
const skipGroups = [
  { key: "skipWindows" as const, label: "Windows", model: skipWindows },
  { key: "skipMac" as const, label: "macOS", model: skipMac },
  { key: "skipLinux" as const, label: "Linux", model: skipLinux },
];

// `label` is the full descriptive text shown in the open list; `short` is what the
// closed trigger shows (the full text doesn't fit in the trigger's width).
const options = computed(() => [
  { label: t("settings.runtimeAuto"), short: t("settings.runtimeAutoShort"), value: "auto" },
  { label: t("settings.runtimeBun"), short: t("settings.runtimeBunShort"), value: "bun" },
  { label: t("settings.runtimeNode"), short: t("settings.runtimeNodeShort"), value: "node" },
]);

watch(open, async (v) => {
  if (!v) return;
  saving.value = false;
  restartNow.value = true; // reset to the default each open
  tab.value = "general"; // every open lands back on the everyday tab
  try {
    const s = await getSettings();
    runtime.value = s.runtime;
    freePortOnStart.value = s.freePortOnStart;
    autoStartOnLaunch.value = s.autoStartOnLaunch;
    monitorResources.value = s.monitorResources;
    linkHost.value = s.linkHost;
    autoScan.value = s.autoScan;
    excludeText.value = s.scanExclude.join("\n");
    skipWindows.value = s.skipWindows;
    skipMac.value = s.skipMac;
    skipLinux.value = s.skipLinux;
    autoUpdate.value = s.autoUpdate ?? false;
    updateNotify.value = s.updateNotify ?? true;
    updateCooldownDays.value = s.updateCooldownDays ?? 0;
    portableMode.value = s.portableMode ?? false;
    loadedPortableMode.value = portableMode.value;
    hideTrayIcon.value = s.hideTrayIcon ?? false;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("settings.loadFailed"));
  }
});

async function save() {
  saving.value = true;
  const turningPortableOn = portableMode.value && !loadedPortableMode.value;
  try {
    const scanExclude = excludeText.value
      .split(/[\n,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const saved = await saveSettings({
      runtime: runtime.value,
      freePortOnStart: freePortOnStart.value,
      autoStartOnLaunch: autoStartOnLaunch.value,
      monitorResources: monitorResources.value,
      linkHost: linkHost.value,
      autoScan: autoScan.value,
      scanExclude,
      skipWindows: skipWindows.value,
      skipMac: skipMac.value,
      skipLinux: skipLinux.value,
      restart: restartNow.value,
      autoUpdate: autoUpdate.value,
      updateNotify: updateNotify.value,
      updateCooldownDays: updateCooldownDays.value,
      portableMode: portableMode.value,
      hideTrayIcon: hideTrayIcon.value,
    });
    // Reflect into the store so the CPU/Mem columns and process links update immediately.
    store.monitorResources = saved.monitorResources;
    store.linkHost = saved.linkHost;
    store.autoUpdate = saved.autoUpdate;
    store.autoUpdateIntervalSecs = saved.autoUpdateIntervalSecs;
    store.updateNotify = saved.updateNotify;
    updateCooldownDays.value = saved.updateCooldownDays;
    store.portableMode = saved.portableMode;
    loadedPortableMode.value = saved.portableMode;
    // Saving keeps the panel open (owner request); the store reflects the change live and the
    // sr-only "saving" announcement provides feedback.
    toast.success(t("settings.saved"));
    // Portable mode just turned ON: open this tab's own UI in a chromeless app window now,
    // same as the tray/desktop launcher would on its next open. Own try/catch: the save
    // already succeeded, so a transport failure here must not toast "save failed".
    if (turningPortableOn && saved.portableMode) {
      try {
        const result = await openPortableWindow();
        if (result.ok) toast.success(t("settings.portableOpened"));
        else toast.error(t("settings.portableNoBrowser"));
      } catch {
        toast.error(t("settings.portableOpenFailed"));
      }
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("settings.saveFailed"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Sidebar
    :open="open"
    :side="props.side"
    :right-offset-px="props.rightOffsetPx"
    :title="t('settings.title')"
    :description="t('settings.description')"
    @update:open="(v: boolean) => { if (!saving) open = v }"
  >
    <!-- Theme is a light/dark toggle icon in the panel header (next to the ✕), not a settings row. -->
    <template #header>
      <span class="text-xs font-semibold">{{ t("settings.title") }}</span>
      <button
        type="button"
        class="ms-auto grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        :aria-label="t('settings.theme')"
        :title="tooltipsEnabled ? t('settings.theme') : undefined"
        @click="theme = theme === 'dark' ? 'light' : 'dark'"
      >
        <Sun v-if="theme === 'dark'" class="size-4" />
        <Moon v-else class="size-4" />
      </button>
    </template>

    <span aria-live="polite" class="sr-only">{{ saving ? t("settings.saving") : "" }}</span>

    <div class="flex flex-col gap-5">
      <SettingsTabs v-model="tab" :tabs="tabs" />

      <!-- General: appearance, resource monitoring, app updates, cloud sync ──── -->
      <div v-show="tab === 'general'" class="flex flex-col gap-5">
      <SettingsGroup :label="t('settings.appearance')">
        <SettingsRow v-if="LOCALES.length > 1" :icon="Languages" :label="t('settings.displayLanguage')" :description="isMachineDraft(currentLocale) ? t('settings.languageReview') : undefined">
          <template #control>
            <Select v-model="currentLocale">
              <SelectTrigger id="sd-locale" class="h-8 w-40" :aria-label="t('settings.displayLanguage')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="l in LOCALES" :key="l.code" :value="l.code">{{ l.endonym }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>
        <SettingsRow :icon="MessageCircleQuestion" :label="t('settings.showTooltips')">
          <template #info><InfoHint>{{ t('settings.showTooltipsHelp') }}</InfoHint></template>
          <template #control><Switch id="sd-show-tooltips" v-model="tooltipsEnabled" /></template>
        </SettingsRow>
      </SettingsGroup>

      <!-- App updates -->
      <SettingsGroup :label="t('settings.appUpdates')">
        <SettingsRow :icon="Bell" :label="t('settings.updateNotify')">
          <template #info><InfoHint><span v-html="t('settings.updateNotifyHelp')" /></InfoHint></template>
          <template #control><Switch id="sd-update-notify" v-model="updateNotify" /></template>
        </SettingsRow>
        <SettingsRow :icon="RefreshCw" :label="t('settings.autoUpdate')">
          <template #info><InfoHint><span v-html="t('settings.autoUpdateHelp')" /></InfoHint></template>
          <template #control><Switch id="sd-auto-update" v-model="autoUpdate" /></template>
        </SettingsRow>
        <!-- Cooldown: only releases public for N days are offered or installed (0 = off). -->
        <SettingsRow :icon="Hourglass" :label="t('settings.updateCooldown')">
          <template #info><InfoHint><span v-html="t('settings.updateCooldownHelp')" /></InfoHint></template>
          <template #control>
            <Input
              id="sd-update-cooldown"
              type="number"
              min="0"
              max="90"
              class="w-20"
              :model-value="updateCooldownDays"
              @update:model-value="(v) => (updateCooldownDays = v === '' || v == null ? 0 : Number(v))"
            />
          </template>
        </SettingsRow>
      </SettingsGroup>

      <!-- Resource monitoring -->
      <SettingsGroup :label="t('settings.resourceMonitoring')">
        <SettingsRow :icon="Activity" :label="t('settings.monitor')">
          <template #info><InfoHint><span v-html="t('settings.monitorHelp')" /></InfoHint></template>
          <template #control><Switch id="sd-monitor" v-model="monitorResources" /></template>
        </SettingsRow>
      </SettingsGroup>

      <!-- Cloud sync -->
      <CloudSyncSection />
      </div>

      <!-- Advanced: server startup, how the UI opens, and project scanning ───── -->
      <div v-show="tab === 'advanced'" class="flex flex-col gap-5">
      <!-- Starting servers -->
      <SettingsGroup :label="t('settings.startingServers')">
        <SettingsRow :icon="Cpu" :label="t('settings.defaultRuntime')">
          <template #info><InfoHint><span v-html="t('settings.runtimeHelp')" /></InfoHint></template>
          <template #control>
            <Select v-model="runtime">
              <SelectTrigger id="sd-runtime" class="h-8 w-28" :aria-label="t('settings.defaultRuntime')">
                <SelectValue>{{ options.find((o) => o.value === runtime)?.short }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>
        <SettingsRow :icon="Power" :label="t('settings.restartNow')">
          <template #info><InfoHint>{{ t('settings.restartNowHint') }}</InfoHint></template>
          <template #control><Switch id="sd-restart-now" v-model="restartNow" /></template>
        </SettingsRow>
        <SettingsRow :icon="Plug" :label="t('settings.autoStart')">
          <template #info><InfoHint><span v-html="t('settings.autoStartHelp')" /></InfoHint></template>
          <template #control><Switch id="sd-autostart" v-model="autoStartOnLaunch" /></template>
        </SettingsRow>
        <SettingsRow :icon="Unplug" :label="t('settings.freePort')">
          <template #info><InfoHint><span v-html="t('settings.freePortHelp')" /></InfoHint></template>
          <template #control><Switch id="sd-free-port" v-model="freePortOnStart" /></template>
        </SettingsRow>
      </SettingsGroup>

      <!-- Open in browser -->
      <SettingsGroup :label="t('settings.openInBrowser')">
        <SettingsRow :icon="AppWindow" :label="t('settings.portableMode')">
          <template #info><InfoHint>{{ t('settings.portableModeHelp') }}</InfoHint></template>
          <template #control><Switch id="sd-portable-mode" v-model="portableMode" /></template>
        </SettingsRow>
        <SettingsRow :icon="EyeOff" :label="t('settings.hideTrayIcon')">
          <template #info><InfoHint>{{ t('settings.hideTrayIconHelp') }}</InfoHint></template>
          <template #control><Switch id="sd-hide-tray-icon" v-model="hideTrayIcon" /></template>
        </SettingsRow>
        <div class="px-3.5 py-2.5">
          <div class="mb-1.5 flex items-center gap-1.5">
            <ExternalLink class="size-4.5 shrink-0 text-muted-foreground" />
            <Label for="sd-link-host"><span class="text-sm font-normal">{{ t("settings.linkHost") }}</span></Label>
            <InfoHint><span v-html="t('settings.linkHostHelp')" /></InfoHint>
          </div>
          <Input id="sd-link-host" v-model="linkHost" variant="mono" :placeholder="t('settings.linkHostPlaceholder')" />
        </div>
      </SettingsGroup>
      <!-- Project scanning (folded in from the old Projects tab) -->
      <SettingsGroup :label="t('settings.projectScanning')">
        <SettingsRow :icon="Search" :label="t('settings.autoScan')">
          <template #info><InfoHint>{{ t('settings.autoScanHint') }}</InfoHint></template>
          <template #control><Switch id="sd-auto-scan" v-model="autoScan" /></template>
        </SettingsRow>
        <div class="px-3.5 py-2.5">
          <div class="mb-2 flex items-center gap-1.5">
            <FolderX class="size-4.5 shrink-0 text-muted-foreground" />
            <span class="text-sm">{{ t("settings.skipSystem") }}</span>
            <InfoHint>{{ t("settings.skipSystemHelp") }}</InfoHint>
          </div>
          <div class="flex flex-wrap gap-2">
            <label
              v-for="g in skipGroups"
              :key="g.key"
              :for="`sd-skip-${g.key}`"
              class="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm transition-colors hover:bg-muted/60"
            >
              <Switch :id="`sd-skip-${g.key}`" v-model="g.model.value" />
              {{ g.label }}
            </label>
          </div>
        </div>
        <div class="px-3.5 py-2.5">
          <div class="mb-1.5 flex items-center gap-1.5">
            <FilterX class="size-4.5 shrink-0 text-muted-foreground" />
            <Label for="sd-exclude"><span class="text-sm font-normal">{{ t("settings.alsoExclude") }}</span></Label>
            <InfoHint><span v-html="t('settings.alsoExcludeHelp')" /></InfoHint>
          </div>
          <Textarea
            id="sd-exclude"
            v-model="excludeText"
            rows="3"
            variant="mono"
            text-size="xs"
            :placeholder="t('settings.excludePlaceholder')"
          />
        </div>
      </SettingsGroup>
      </div>

      <!-- Alerts: threshold rules on process CPU/memory + fired-event history ─────────── -->
      <div v-show="tab === 'alerts'">
        <AlertsSection />
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" :disabled="saving" @click="open = false">{{ t("settings.cancel") }}</Button>
        <Button :disabled="saving" @click="save">{{ t("settings.save") }}</Button>
      </div>
    </template>
  </Sidebar>
</template>
