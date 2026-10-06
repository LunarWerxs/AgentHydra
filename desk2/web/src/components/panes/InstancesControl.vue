<script setup lang="ts">
import { RefreshCw } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import PaneSwitch from './PaneSwitch.vue'
import { BUTTON, SELECT_CONTENT, SELECT_ITEM, SELECT_TRIGGER } from './settings-styles'
import type { InstanceSettings } from './instances'
import type { SettingsRowId } from './settings'

// The control of an Instances row that is not a plain AgentHydra setting (instances.ts): a table's
// process columns, and Claude native control's account, switch and reset.
const props = defineProps<{ id: SettingsRowId; label: string; inst: InstanceSettings }>()
const table = props.inst.processTable(props.id)
</script>

<template>
  <PaneSwitch
    v-if="table"
    :label="label"
    :model-value="inst.processColumns(table)"
    @update:model-value="(v: boolean) => inst.setProcessColumns(table!, v)"
  />

  <div v-else-if="id === 'ahNativeAccount'" class="flex shrink-0 items-center gap-1">
    <Select v-model="inst.profile.value" :disabled="inst.nativeLoading.value || inst.nativeSaving.value || !inst.profiles.value.length">
      <SelectTrigger :class="SELECT_TRIGGER" aria-label="Claude Desktop account"><SelectValue :placeholder="inst.nativeLoading.value ? 'Loading accounts…' : 'No accounts'" /></SelectTrigger>
      <SelectContent :class="SELECT_CONTENT" position="popper" align="end" :side-offset="4">
        <SelectItem v-for="p in inst.profiles.value" :key="p.dir" :class="SELECT_ITEM" :value="p.dir">{{ inst.accountLabel(p) }}</SelectItem>
      </SelectContent>
    </Select>
    <button
      type="button"
      aria-label="Read the native control settings again"
      title="Read the native control settings again"
      class="flex size-7 shrink-0 cursor-default items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text disabled:opacity-50"
      :disabled="inst.nativeLoading.value || inst.nativeSaving.value"
      @click="inst.loadNative()"
    >
      <RefreshCw class="size-3.5" :class="inst.nativeLoading.value ? 'animate-spin' : ''" />
    </button>
  </div>

  <PaneSwitch
    v-else-if="id === 'ahNativeAuto'"
    :label="label"
    :disabled="inst.nativeBusy.value"
    :model-value="!!inst.nativeConfig.value?.launchDebugger"
    @update:model-value="(v: boolean) => inst.saveNative(v)"
  />

  <button v-else-if="id === 'ahNativeReset'" type="button" :class="BUTTON" :disabled="inst.nativeBusy.value" @click="inst.saveNative(null)">Reset</button>
</template>
