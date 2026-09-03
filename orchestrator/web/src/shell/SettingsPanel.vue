<script lang="ts">
export default { inheritAttrs: false };
</script>

<script setup lang="ts">
// Back-compat shim. The shared slide-in sidebar now lives in Sidebar.vue, this
// forwards every prop/emit/slot so existing Settings call sites keep working.
import Sidebar from "./Sidebar.vue";
</script>

<template>
  <Sidebar v-bind="$attrs">
    <template v-for="(_, name) in $slots" #[name]="scope">
      <slot :name="name" v-bind="scope || {}" />
    </template>
  </Sidebar>
</template>
