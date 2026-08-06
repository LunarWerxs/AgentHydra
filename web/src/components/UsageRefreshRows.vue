<script setup lang="ts">
// The "keep the quota numbers warm" rows — auto-refresh plus its interval.
//
// Extracted from SettingsView so the SAME markup can render in two places: the Settings panel
// (where you go looking for it) and the Instances tab's usage flyout (where it actually applies).
// A copy-paste of the rows would have been two things to keep in step; the underlying state is
// already a singleton (useAppSettings), so the markup being shared is what makes the two surfaces
// genuinely the same control rather than two controls that happen to agree.
//
// Renders bare SettingsRows with no wrapper, so the caller decides the container: a SettingsGroup
// card in the panel, a divided block in the popover.
import { Gauge, Timer } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { USAGE_REFRESH_INTERVALS, useAppSettings } from '@/composables/useAppSettings'
import type { UsageSettings } from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
const { autoRefresh, autoRefreshIntervalMin, update: updateAppSettings } = useAppSettings()

async function patch(value: Partial<UsageSettings>) {
  if (!(await updateAppSettings(value))) toast.error(t('settings.usageToastFailed'))
}
</script>

<template>
  <SettingsRow :icon="Gauge" :label="$t('settings.usageAutoRefreshLabel')">
    <template #info>
      <InfoHint :text="$t('settings.usageAutoRefreshHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="autoRefresh"
        @update:model-value="(v: boolean) => patch({ autoRefresh: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow v-if="autoRefresh" :icon="Timer" :label="$t('settings.usageIntervalLabel')">
    <template #info>
      <InfoHint :text="$t('settings.usageIntervalHint')" />
    </template>
    <template #control>
      <div class="flex items-center gap-1">
        <Button
          v-for="mins in USAGE_REFRESH_INTERVALS"
          :key="mins"
          :variant="autoRefreshIntervalMin === mins ? 'secondary' : 'ghost'"
          size="xs"
          :aria-pressed="autoRefreshIntervalMin === mins"
          @click="patch({ autoRefreshIntervalMin: mins })"
        >
          {{ $t('settings.usageIntervalMinutes', { minutes: mins }) }}
        </Button>
      </div>
    </template>
  </SettingsRow>
</template>
