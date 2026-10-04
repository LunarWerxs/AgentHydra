<script setup lang="ts">
// Which tables the Instances tab draws: Claude desktop and CLI, Codex desktop and CLI, DeepSeek.
// Rendered in the Instances tab's own settings (InstanceSettings.vue), the page these switches
// change. The ChatGPT handoff moved to the Sessions list's settings, Keep windows running to the
// CLI table's gear, and paid extra usage beside these in InstanceSettings.
import { AppWindow, Monitor, Terminal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Switch } from '@/components/ui/switch'
import { useAppSettings } from '@/composables/useAppSettings'
import type { ProviderSettings, UsageSettings } from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
const {
  showDesktopInstances,
  showCliInstances,
  codexDesktopEnabled,
  codexCliEnabled,
  dshEnabled,
  update: updateAppSettings,
} = useAppSettings()

// Two patch helpers because the two halves live in different server-side settings blocks
// (UsageSettings vs ProviderSettings) and report their own failure copy — see SettingsView.
async function patchUsage(value: Partial<UsageSettings>) {
  if (!(await updateAppSettings(value))) toast.error(t('settings.usageToastFailed'))
}
async function patchProvider(value: Partial<ProviderSettings>) {
  if (!(await updateAppSettings(value))) toast.error(t('settings.providerToastFailed'))
}
</script>

<template>
  <SettingsRow :icon="Monitor" :label="$t('settings.claudeDesktopProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.claudeDesktopProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="showDesktopInstances"
        @update:model-value="(v: boolean) => patchUsage({ showDesktopInstances: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow :icon="Terminal" :label="$t('settings.claudeCliProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.claudeCliProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="showCliInstances"
        @update:model-value="(v: boolean) => patchUsage({ showCliInstances: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow :icon="AppWindow" :label="$t('settings.codexDesktopProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.codexDesktopProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="codexDesktopEnabled"
        @update:model-value="(v: boolean) => patchProvider({ codexDesktopEnabled: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow :icon="Terminal" :label="$t('settings.codexCliProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.codexCliProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="codexCliEnabled"
        @update:model-value="(v: boolean) => patchProvider({ codexCliEnabled: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow :icon="Terminal" :label="$t('settings.dshProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.dshProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="dshEnabled"
        @update:model-value="(v: boolean) => patchProvider({ dshEnabled: v })"
      />
    </template>
  </SettingsRow>
</template>
