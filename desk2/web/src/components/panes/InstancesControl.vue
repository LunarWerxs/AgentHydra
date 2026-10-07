<script setup lang="ts">
import { RefreshCw } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import PaneSwitch from './PaneSwitch.vue'
import { BUTTON, FIELD, SELECT_CONTENT, SELECT_ITEM, SELECT_TRIGGER } from './settings-styles'
import type { InstanceSettings } from './instances'
import type { SettingsRowId } from './settings'

// The control of an Instances row that is not a plain AgentHydra setting (instances.ts): a table's
// process columns, Claude native control's account, switch and reset, and the Free keepalive.
const props = defineProps<{ id: SettingsRowId; label: string; inst: InstanceSettings }>()
const table = props.inst.processTable(props.id)

// The Free weekly floor: a whole 1 to 100 (the server refuses anything else); a box left empty or not a
// number goes back to the saved value.
function saveFloor(e: Event) {
  const box = e.target as HTMLInputElement
  const saved = props.inst.free.value?.weeklyFloorPct
  if (saved === undefined) return
  const n = Math.round(Number(box.value))
  if (!Number.isFinite(n) || box.value.trim() === '') {
    box.value = String(saved)
    return
  }
  const v = Math.min(100, Math.max(1, n))
  box.value = String(v)
  if (v !== saved) void props.inst.saveFree({ weeklyFloorPct: v })
}
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

  <PaneSwitch
    v-else-if="id === 'ahDesktopCliPair'"
    :label="label"
    :disabled="!inst.pairing.value || inst.pairingBusy.value"
    :model-value="!!inst.pairing.value?.enabled && !inst.pairingConfirm.value"
    @update:model-value="(v: boolean) => inst.setPairing(v)"
  />

  <PaneSwitch
    v-else-if="id === 'ahFreeKeepalive'"
    :label="label"
    :disabled="!inst.free.value"
    :model-value="!!inst.free.value?.keepWindows"
    @update:model-value="(v: boolean) => inst.saveFree({ keepWindows: v })"
  />

  <div v-else-if="id === 'ahFreeFloor' && inst.free.value" class="flex shrink-0 items-center gap-2 text-[13px] leading-[19px] text-text-muted">
    <input
      :key="inst.free.value.weeklyFloorPct"
      type="number"
      min="1"
      max="100"
      :value="inst.free.value.weeklyFloorPct"
      :aria-label="label"
      :class="[FIELD, 'tnum w-20 text-right [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none']"
      @change="saveFloor"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
    />
    %
  </div>
</template>
