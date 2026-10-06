<script setup lang="ts">
// The card every instance table sits in: its header (InstanceSectionHeader), anything drawn under the
// header (Quick add, a warning) and the table, on one lighter, rounded box. The Free table had it
// first and the owner kept it for all of them (2026-10-06: the rows "wrapped inside a lighter gray
// color ... adds a little bit of modernness", where the others only shaded their column headings).
// The header bar is the card's rounded top; the table's last row meets its bottom edge.
</script>

<template>
  <section class="m-4 overflow-hidden rounded-lg border bg-card">
    <slot />
  </section>
</template>
