<script setup lang="ts">
// Shared right-side drawer chrome — the unified LunarWerx Sidebar in PUSH mode,
// exactly like Settings: docks to the edge and shifts page content (no overlay);
// bottom sheet on mobile. `title` is the accessible name; the visible header lives
// in the #header slot.
import { ref, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import Sidebar from "@/shell/Sidebar.vue";

const open = defineModel<boolean>("open", { required: true });
defineProps<{ title: string }>();

// Lock the side at open time so a mid-open resize can't break the slide (matches
// the shell's usePushPanel, so the panel and the content push agree).
const isDesktop = useMediaQuery("(min-width: 768px)");
const side = ref<"right" | "bottom">(isDesktop.value ? "right" : "bottom");
watch(open, (o) => {
  if (o) side.value = isDesktop.value ? "right" : "bottom";
});
</script>

<template>
  <Sidebar
    :open="open"
    :side="side"
    :title="title"
    body-class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4"
    @update:open="open = $event"
  >
    <template #header>
      <slot name="header" />
    </template>
    <slot />
  </Sidebar>
</template>
