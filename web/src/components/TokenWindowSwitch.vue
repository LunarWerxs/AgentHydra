<script setup lang="ts">
// The Tokens column's 5h / Week / Total switch, one per table (composables/useTokenWindow.ts).
import { TOKEN_WINDOWS, type TokenWindow } from '@/lib/token-window'

const model = defineModel<TokenWindow>({ required: true })
const labelKey = { '5h': 'tokensWindow5h', week: 'tokensWindowWeek', total: 'tokensWindowTotal' }
const hintKey = {
  '5h': 'tokensWindow5hHint',
  week: 'tokensWindowWeekHint',
  total: 'tokensWindowTotalHint',
}
</script>

<template>
  <span
    class="inline-flex rounded-md border text-[10px] font-normal leading-none"
    role="group"
    :aria-label="$t('cliInstances.tokensWindowLabel')"
  >
    <button
      v-for="w in TOKEN_WINDOWS"
      :key="w"
      type="button"
      class="px-1.5 py-0.5 first:rounded-s-md last:rounded-e-md"
      :class="model === w ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'"
      :aria-pressed="model === w"
      :title="$t(`cliInstances.${hintKey[w]}`)"
      @click="model = w"
    >
      {{ $t(`cliInstances.${labelKey[w]}`) }}
    </button>
  </span>
</template>
