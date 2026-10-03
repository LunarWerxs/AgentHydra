<script setup lang="ts">
// The Instances tab's own settings, behind the gear on its toolbar (owner, 2026-10-01: "move all
// the settings that make sense to their pages"): which tables the tab draws, whether any account
// may bill paid extra usage, and Claude native control for the desktop accounts. They were three
// sections of the Settings panel.
import { CreditCard, ScrollText } from '@lucide/vue'
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ClaudeNativeSettings from '@/components/ClaudeNativeSettings.vue'
import ProviderRows from '@/components/ProviderRows.vue'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAppSettings } from '@/composables/useAppSettings'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsGroup from '@/shell/SettingsGroup.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
const { allowExtraUsage, climayteWorkerPreamble, loaded, load, update } = useAppSettings()
onMounted(() => {
  if (!loaded.value) void load()
})

// Edited locally and saved when the field loses focus, so typing is not a request per key.
const preambleDraft = ref(climayteWorkerPreamble.value)
watch(climayteWorkerPreamble, (v) => (preambleDraft.value = v))
async function savePreamble() {
  if (preambleDraft.value === climayteWorkerPreamble.value) return
  if (await update({ climayteWorkerPreamble: preambleDraft.value }))
    toast.success(t('settings.workerPreambleSaved'))
  else toast.error(t('settings.providerToastFailed'))
}

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
    <SettingsRow :icon="ScrollText" :label="$t('settings.workerPreambleLabel')">
      <template #info>
        <InfoHint :text="$t('settings.workerPreambleHint')" />
      </template>
    </SettingsRow>
    <div class="px-3.5 pb-3">
      <Textarea
        v-model="preambleDraft"
        class="max-h-56 min-h-20 text-xs"
        :placeholder="$t('settings.workerPreamblePlaceholder')"
        @blur="savePreamble"
      />
    </div>
  </SettingsGroup>
  <SettingsGroup
    :label="$t('settings.claudeNativeTitle')"
    :description="$t('settings.claudeNativeHint')"
  >
    <ClaudeNativeSettings />
  </SettingsGroup>
</template>
