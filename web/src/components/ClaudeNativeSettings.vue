<script setup lang="ts">
import { Monitor, Plug, RefreshCw } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
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
import { usePanels } from '@/composables/usePanels'
import {
  type ClaudeNativeSettings,
  getClaudeNativeSettings,
  setClaudeNativeProfileConfig,
} from '@/lib/api'
import {
  automaticClaudeNativeConfig,
  normalizeClaudeNativeProfileKey,
} from '@/lib/claude-native-settings'
import { displayName } from '@/lib/instance-appearance'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
const { instances, refreshInstances } = useInstances()
const { settingsOpen } = usePanels()
const settings = ref<ClaudeNativeSettings>({})
const selectedProfile = ref('')
const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)
const error = ref('')
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
      return instance ? `#${instance.num} ${displayName(instance)}` : profile
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
      t('settings.claudeNativeSaved', { account: `#${instance.num} ${displayName(instance)}` }),
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    toast.error(t('settings.claudeNativeSaveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
watch(settingsOpen, (open) => {
  if (open) void load()
})
</script>

<template>
  <div class="space-y-2 px-3.5 py-3">
    <div class="flex items-center gap-2">
      <label class="flex-1 text-sm" for="claude-native-account">{{ $t('settings.claudeNativeAccount') }}</label>
      <Button
        variant="ghost"
        size="icon-sm"
        :disabled="loading || saving"
        :aria-label="$t('settings.claudeNativeRefresh')"
        @click="load"
      >
        <RefreshCw class="size-3.5" :class="loading ? 'animate-spin' : ''" />
      </Button>
    </div>
    <Select v-model="selectedProfile" :disabled="loading || saving || !profiles.length">
      <SelectTrigger id="claude-native-account" class="w-full">
        <SelectValue :placeholder="$t(loading ? 'settings.claudeNativeLoading' : 'settings.claudeNativeNoAccounts')" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="instance in profiles" :key="instance.dir" :value="instance.dir">
          {{ $t('settings.claudeNativeAccountLabel', { n: instance.num, name: displayName(instance) }) }}
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
  <SettingsRow
    :icon="Plug"
    :label="$t('settings.claudeNativeAutoLabel')"
    :description="$t('settings.claudeNativeAutoHint')"
  >
    <template #control>
      <Switch
        :aria-label="$t('settings.claudeNativeAutoLabel')"
        :model-value="!!config?.launchDebugger"
        :disabled="disabled"
        @update:model-value="save"
      />
    </template>
  </SettingsRow>
  <div class="space-y-2 px-3.5 py-3 text-xs" aria-live="polite">
    <p v-if="error" role="alert" class="break-words text-destructive">{{ error }}</p>
    <template v-if="loaded && selectedInstance">
      <p class="font-medium" :class="config?.launchDebugger ? 'text-success' : 'text-foreground'">
        {{ saving ? $t('settings.claudeNativeSaving') : status }}
      </p>
      <p class="text-muted-foreground">{{ $t('settings.claudeNativeNextOpen') }}</p>
      <p v-if="config" class="text-muted-foreground">
        {{ $t('settings.claudeNativePort', { port: config.port }) }}
      </p>
      <Button v-if="config" variant="outline" size="xs" :disabled="disabled" @click="save(null)">
        <Monitor class="size-3.5" />
        {{ $t('settings.claudeNativeReset') }}
      </Button>
    </template>
    <p v-if="loaded" class="break-words text-muted-foreground">
      {{ automaticProfiles.length
        ? $t('settings.claudeNativeEnabledAccounts', { accounts: automaticProfiles.join(', ') })
        : $t('settings.claudeNativeNoAutomaticAccounts') }}
    </p>
    <p class="text-muted-foreground">{{ $t('settings.claudeNativeSupport') }}</p>
  </div>
</template>
