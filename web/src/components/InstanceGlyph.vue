<script setup lang="ts">
// The instance's own glyph and colour beside its number: its identity, faded while it is closed.
// One owner for every provider's rows (Claude, Codex, DeepSeek), so the name cells cannot drift.
// A row that stores no choice gets the deterministic default for its folder.
import type { CMInstance } from '@/lib/api'
import {
  colorValue,
  iconComponent,
  resolveColorKey,
  resolveIconKey,
} from '@/lib/instance-appearance'

const props = defineProps<{
  dir: string
  icon?: CMInstance['icon']
  color?: CMInstance['color']
  running: boolean
}>()
const appearance = () => ({ dir: props.dir, icon: props.icon ?? null, color: props.color ?? null })
</script>

<template>
  <component
    :is="iconComponent(resolveIconKey(appearance()))"
    class="size-4 shrink-0 text-(--icon-color)"
    :style="{ '--icon-color': colorValue(resolveColorKey(appearance())) }"
    :class="running ? '' : 'opacity-40'"
  />
</template>
