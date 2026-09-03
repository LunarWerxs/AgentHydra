<script setup lang="ts">
import InfoHint from './InfoHint.vue';
/**
 * SettingsGroup, one labelled section of a settings sidebar: a small caps label
 * (+ optional ⓘ info tooltip) over a rounded, hairline-divided card. Every LunarWerx
 * app's settings use this (+ SettingsRow) so the three read identically. A section-level
 * `description` is disclosed behind the info icon, never as a verbose paragraph. Put
 * SettingsRow children inside, or arbitrary content for richer sections.
 */
defineProps<{ label?: string; description?: string }>();
</script>

<template>
  <section>
    <div v-if="label || description || $slots.description" class="mb-2 flex items-center gap-1.5 px-1">
      <p v-if="label" class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ label }}
      </p>
      <slot name="info">
        <InfoHint v-if="description || $slots.description">
          <slot name="description">{{ description }}</slot>
        </InfoHint>
      </slot>
    </div>
    <div class="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      <slot />
    </div>
  </section>
</template>
