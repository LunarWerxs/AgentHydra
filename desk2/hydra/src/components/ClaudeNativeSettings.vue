<script setup lang="ts">
import { ChevronDown, Info, Monitor, Plug, RefreshCw } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useInstances } from '@/composables/useInstances'
import { piiDisplayName } from '@/composables/usePrivacy'
import {
  type ClaudeNativeSettings,
  getClaudeNativeSettings,
  setClaudeNativeProfileConfig,
} from '@/lib/api'
import {
  automaticClaudeNativeConfig,
  normalizeClaudeNativeProfileKey,
} from '@/lib/claude-native-settings'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
const { instances, refreshInstances } = useInstances()
const settings = ref<ClaudeNativeSettings>({})
const selectedProfile = ref('')
const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)
const error = ref('')
const detailsOpen = ref(false)
const profiles = computed(() =>
  instances.value
    .filter((instance) => /^[a-z]:[\\/]/i.test(instance.dir))
    .sort((a, b) => a.num - b.num),
)
const selectedInstance = computed(() =>
  profiles.value.find((instance) => instance.dir === selectedProfile.value),
)
const config = computed(() =>
  selectedProfile.value
    ? settings.value[normalizeClaudeNativeProfileKey(selectedProfile.value)]
    : undefined,
)
const disabled = computed(
  () => loading.value || saving.value || !loaded.value || !selectedInstance.value,
)
const automaticProfiles = computed(() =>
  Object.entries(settings.value)
    .filter(([, value]) => value.launchDebugger)
    .map(([profile]) => {
      const instance = profiles.value.find(
        (item) => normalizeClaudeNativeProfileKey(item.dir) === profile,
      )
      return instance ? `#${instance.num} ${piiDisplayName(instance)}` : profile
    }),
)
const status = computed(() => {
  if (config.value?.launchDebugger) return t('settings.claudeNativeAutomaticStatus')
  if (config.value) return t('settings.claudeNativeManualStatus')
  return t('settings.claudeNativeStandardStatus')
})

async function load() {
  if (loading.value || saving.value) return
  loading.value = true
  error.value = ''
  try {
    const [saved] = await Promise.all([
      getClaudeNativeSettings(),
      refreshInstances({ resolve: 'cache' }),
    ])
    settings.value = saved
    loaded.value = true
    if (!selectedInstance.value) {
      selectedProfile.value =
        profiles.value.find(
          (item) => saved[normalizeClaudeNativeProfileKey(item.dir)]?.launchDebugger,
        )?.dir ??
        profiles.value[0]?.dir ??
        ''
    }
  } catch (cause) {
    loaded.value = false
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

// Only saves settings. Opening or restarting a desktop is always a separate user action.
async function save(automatic: boolean | null) {
  const instance = selectedInstance.value
  if (disabled.value || !instance) return
  saving.value = true
  error.value = ''
  try {
    // Allocate against the latest settings so another account cannot silently share this port.
    const current = await getClaudeNativeSettings()
    const next =
      automatic === null
        ? null
        : automaticClaudeNativeConfig(current, instance.dir, automatic, 19300 + instance.num)
    settings.value = (await setClaudeNativeProfileConfig(instance.dir, next)).settings
    toast.success(
      t('settings.claudeNativeSaved', { account: `#${instance.num} ${piiDisplayName(instance)}` }),
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    toast.error(t('settings.claudeNativeSaveFailed'))
  } finally {
    saving.value = false
  }
}

// Mounted each time the Instances settings dialog opens, so this reads fresh settings every time.
onMounted(load)
</script>

<template>
  <!-- Owner, 2026-09-30: this section read like a manual. On screen now: the account, the one
       switch and one status line. The how-it-works text sits behind the switch's info icon and the
       rest (port, the managed copy, which accounts start automatically, the reset) under Details. -->
  <SettingsRow :icon="Monitor" :label="$t('settings.claudeNativeAccount')">
    <template #control>
      <Select v-model="selectedProfile" :disabled="loading || saving || !profiles.length">
        <SelectTrigger
          id="claude-native-account"
          size="sm"
          class="w-52"
          :aria-label="$t('settings.claudeNativeAccount')"
        >
          <SelectValue :placeholder="$t(loading ? 'settings.claudeNativeLoading' : 'settings.claudeNativeNoAccounts')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="instance in profiles" :key="instance.dir" :value="instance.dir">
            {{ $t('settings.claudeNativeAccountLabel', { n: instance.num, name: piiDisplayName(instance) }) }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        :disabled="loading || saving"
        :aria-label="$t('settings.claudeNativeRefresh')"
        :title="$t('settings.claudeNativeRefresh')"
        @click="load"
      >
        <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
      </Button>
    </template>
  </SettingsRow>
  <SettingsRow :icon="Plug" :label="$t('settings.claudeNativeAutoLabel')">
    <template #info>
      <InfoHint :text="$t('settings.claudeNativeAutoHint')" />
    </template>
    <template v-if="error || (loaded && selectedInstance)" #description>
      <span v-if="error" role="alert" class="wrap-break-word text-destructive">{{ error }}</span>
      <span v-else aria-live="polite" :class="config?.launchDebugger ? 'text-success' : ''">
        {{ saving ? $t('settings.claudeNativeSaving') : status }}
      </span>
    </template>
    <template #control>
      <Switch
        :aria-label="$t('settings.claudeNativeAutoLabel')"
        :model-value="!!config?.launchDebugger"
        :disabled="disabled"
        @update:model-value="save"
      />
    </template>
  </SettingsRow>
  <SettingsRow
    v-if="loaded"
    :icon="Info"
    :label="$t('settings.claudeNativeDetails')"
    clickable
    :aria-expanded="detailsOpen"
    @click="detailsOpen = !detailsOpen"
  >
    <template #control>
      <ChevronDown class="size-4 transition-transform duration-200" :class="detailsOpen ? 'rotate-180' : ''" />
    </template>
  </SettingsRow>
  <ExpandTransition :open="detailsOpen">
    <div class="space-y-2 px-3.5 pb-3.5 pt-1 text-xs leading-snug text-muted-foreground">
      <p v-if="config">{{ $t('settings.claudeNativePort', { port: config.port }) }}</p>
      <p>{{ $t('settings.claudeNativeNextOpen') }}</p>
      <p>{{ $t('settings.claudeNativeSupport') }}</p>
      <p class="wrap-break-word">
        {{ automaticProfiles.length
          ? $t('settings.claudeNativeEnabledAccounts', { accounts: automaticProfiles.join(', ') })
          : $t('settings.claudeNativeNoAutomaticAccounts') }}
      </p>
      <Button v-if="config" variant="outline" size="xs" :disabled="disabled" @click="save(null)">
        <Monitor class="size-3.5" />
        {{ $t('settings.claudeNativeReset') }}
      </Button>
    </div>
  </ExpandTransition>
</template>
