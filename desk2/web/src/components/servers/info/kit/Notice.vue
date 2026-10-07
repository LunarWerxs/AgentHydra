<script setup lang="ts">
import type { Component } from 'vue'
import { AlertTriangle, CheckCircle2, Info, XCircle } from '@lucide/vue'
import type { Tone } from './kit'

// Something that needs a look or a decision (a port taken, a crash, changed settings, a take-over offer): a tinted card
// with its icon, a bold first line, the detail and its actions under it.
const props = defineProps<{ tone: Tone; title: string; icon?: Component }>()
const ICON: Record<Tone, Component> = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, accent: Info, neutral: Info }
const RING: Record<Tone, string> = {
  success: 'bg-[color-mix(in_srgb,var(--success-bg)_70%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--success)_35%,transparent)]',
  warning: 'bg-[color-mix(in_srgb,var(--warning-bg)_70%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warning)_30%,transparent)]',
  danger: 'bg-[color-mix(in_srgb,var(--danger-bg)_70%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger)_40%,transparent)]',
  accent: 'bg-[color-mix(in_srgb,var(--accent-bg)_70%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_40%,transparent)]',
  neutral: 'bg-fill-5 shadow-[inset_0_0_0_1px_var(--border)]'
}
const INK: Record<Tone, string> = { success: 'text-success-text', warning: 'text-warning-text', danger: 'text-danger-text', accent: 'text-accent-text', neutral: 'text-text-2' }
</script>

<template>
  <div :class="['flex min-w-0 gap-3 rounded-[var(--radius-10)] px-3.5 py-3', RING[tone]]" :role="tone === 'danger' || tone === 'warning' ? 'alert' : 'status'">
    <component :is="props.icon ?? ICON[tone]" class="mt-0.5 size-4 shrink-0" :class="INK[tone]" aria-hidden="true" />
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <p class="text-[13px] font-medium leading-5" :class="INK[tone]">{{ title }}</p>
      <div v-if="$slots.default" class="min-w-0 break-words text-[13px] leading-5 text-text-2"><slot /></div>
      <div v-if="$slots.actions" class="mt-1.5 flex flex-wrap items-center gap-1.5"><slot name="actions" /></div>
    </div>
  </div>
</template>
