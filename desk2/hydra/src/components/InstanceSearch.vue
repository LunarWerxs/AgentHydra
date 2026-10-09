<script setup lang="ts">
// The Instances header's search (owner, 2026-10-09: "needs a search icon, up in the top right ... so we
// can filter/search the results"). An icon until it is clicked or Ctrl+F is pressed, then a box: what is
// typed narrows every table to the rows whose number, name, account or plan hold every word
// (useInstanceFilter's `visible`). Escape or the X clears it; an empty box closes when it loses focus.
import { Search, X } from '@lucide/vue'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import IconTooltip from '@/shell/IconTooltip.vue'

const { searchQuery } = useInstanceFilter()
const open = ref(searchQuery.value !== '')
const box = ref<InstanceType<typeof Input> | null>(null)
const inputEl = () => box.value?.$el as HTMLInputElement | undefined

async function openBox() {
  open.value = true
  await nextTick()
  inputEl()?.focus()
  inputEl()?.select()
}
function clear() {
  searchQuery.value = ''
  open.value = false
}
function onBlur() {
  if (!searchQuery.value.trim()) open.value = false
}
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    void openBox()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="open" class="relative">
    <Search
      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
    />
    <Input
      ref="box"
      v-model="searchQuery"
      class="w-56 pr-8 pl-8"
      :placeholder="$t('instances.searchPlaceholder')"
      :aria-label="$t('instances.search')"
      @keydown.escape.prevent="clear"
      @blur="onBlur"
    />
    <!-- mousedown.prevent keeps the focus in the box, so its blur does not close it before the click. -->
    <button
      v-if="searchQuery"
      type="button"
      class="absolute top-1/2 right-2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground"
      :aria-label="$t('instances.searchClear')"
      @mousedown.prevent
      @click="clear"
    >
      <X class="size-4" />
    </button>
  </div>
  <IconTooltip v-else :label="$t('instances.search')" :description="$t('instances.searchHint')">
    <Button variant="outline" size="icon" :aria-label="$t('instances.search')" @click="openBox">
      <Search />
    </Button>
  </IconTooltip>
</template>
