<script setup lang="ts">
import type { Component } from "vue";

/**
 * SettingsRow, a single settings line: [icon] label (+optional description / info)
 * ... [control]. Lives inside a SettingsGroup. The control slot holds the right-hand
 * widget (a Switch, a Select, a value + chevron, etc.). `clickable` adds a hover
 * affordance for whole-row buttons (e.g. a row that opens a subpage).
 */
withDefaults(
  defineProps<{ icon?: Component; label?: string; description?: string; clickable?: boolean }>(),
  { clickable: false },
);
</script>

<template>
  <div
    class="flex items-center gap-3 px-3.5 py-2.5"
    :class="clickable ? 'cursor-pointer transition-colors hover:bg-accent/60' : ''"
  >
    <component :is="icon" v-if="icon" class="size-[18px] shrink-0 text-muted-foreground" />
    <slot v-else name="icon" />
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5 text-sm text-foreground">
        <slot name="label">{{ label }}</slot>
        <slot name="info" />
      </span>
      <span
        v-if="description || $slots.description"
        class="mt-0.5 block text-[12px] leading-snug text-muted-foreground"
      >
        <slot name="description">{{ description }}</slot>
      </span>
    </span>
    <div class="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
      <slot name="control" />
    </div>
  </div>
</template>
