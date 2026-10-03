<script setup lang="ts">
// The Instances tab's own settings, behind the gear on its toolbar (owner, 2026-10-01: "move all
// the settings that make sense to their pages"): which tables the tab draws, whether any account
// may bill paid extra usage, and Claude native control for the desktop accounts. They were three
// sections of the Settings panel.
import { CreditCard } from '@lucide/vue'
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ClaudeNativeSettings from '@/components/ClaudeNativeSettings.vue'
import ProviderRows from '@/components/ProviderRows.vue'
import { Switch } from '@/components/ui/switch'
import { useAppSettings } from '@/composables/useAppSettings'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsGroup from '@/shell/SettingsGroup.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
const { allowExtraUsage, loaded, load, update } = useAppSettings()
onMounted(() => {
  if (!loaded.value) void load()
})

async function setExtraUsage(value: boolean) {
  if (!(await update({ allowExtraUsage: value }))) toast.error(t('settings.providerToastFailed'))
}
</script>

<template>
  <SettingsGroup :label="$t('settings.providersTitle')" :description="$t('settings.providersHint')">
    <ProviderRows />
  </SettingsGroup>
  <SettingsGroup>
    <!-- ⛔ SPENDS MONEY, NOT JUST QUOTA. Some Claude accounts keep working past their 5-hour limit on
         paid extra usage (usage credits). Off by default: nothing AgentHydra manages may bill it -
         CliMayte moves a task first, and the guard stops any session on an account that could bill. -->
    <SettingsRow :icon="CreditCard" :label="$t('settings.extraUsageLabel')">
      <template #info>
        <InfoHint :text="$t('settings.extraUsageHint')" />
      </template>
      <template #control>
        <Switch :model-value="allowExtraUsage" @update:model-value="setExtraUsage" />
      </template>
    </SettingsRow>
  </SettingsGroup>
  <SettingsGroup
    :label="$t('settings.claudeNativeTitle')"
    :description="$t('settings.claudeNativeHint')"
  >
    <ClaudeNativeSettings />
  </SettingsGroup>
</template>
