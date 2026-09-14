<script lang="ts">
export default { inheritAttrs: false };
</script>

<script setup lang="ts">
// arkitect-allow: no-bandaids SettingsPanel is the public name every kit app imports; Sidebar.vue is the
// implementation. Removing this forwarder means repointing each app's Settings call sites in ONE kit sync
// (tracked in docs/todo/TODO.md, 'Retire the SettingsPanel forwarder'). Until then it forwards every
// prop/emit/slot so those call sites keep working.
import Sidebar from "./Sidebar.vue";
</script>

<template>
  <Sidebar v-bind="$attrs">
    <template v-for="(_, name) in $slots" #[name]="scope">
      <slot :name="name" v-bind="scope || {}" />
    </template>
  </Sidebar>
</template>
