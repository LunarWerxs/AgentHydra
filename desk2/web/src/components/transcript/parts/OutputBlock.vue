<script setup lang="ts">
import { computed } from 'vue'
import { truncateText } from '../lib/tools'
import { useTranscript } from '../context'

const props = defineProps<{ id: string; text: string; error?: boolean; serverTruncated?: boolean; maxLines?: number }>()
const ctx = useTranscript()
const key = computed(() => `${props.id}:all`)
const cut = computed(() => truncateText(props.text, props.maxLines ?? 30))
const showAll = computed(() => ctx.isOpen(key.value))
</script>

<template>
  <div>
    <pre
      class="code-scroll max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[19px]"
      :class="error ? 'text-danger-text' : 'text-text-2'"
    >{{ showAll ? text : cut.shown }}<span v-if="!text" class="italic text-text-muted">(no output)</span></pre>
    <div
      v-if="cut.truncated || serverTruncated"
      class="flex items-center gap-3 border-t border-border px-3 py-1 text-[12px] text-text-muted"
    >
      <button v-if="cut.truncated" type="button" class="text-text-muted hover:text-text" @click="ctx.toggle(key)">
        {{ showAll ? 'Show less' : `Show all (${cut.totalLines} lines)` }}
      </button>
      <span v-if="serverTruncated">Cut at 20,000 characters by the server</span>
    </div>
  </div>
</template>
