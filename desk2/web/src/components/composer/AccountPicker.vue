<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AccountInfo, AccountRef } from '@shared/protocol'
import { accountTitle } from '@/components/accounts/format'
import { Tip } from '@/components/ui/tooltip'
import type { ComposerApi } from './api'

// The account a new session will run on, as a quiet pill at the right end of the env pills. It is
// chosen from the profile control at the bottom left; this only names it.
const props = defineProps<{ modelValue: string; api: ComposerApi; accounts: AccountInfo[] }>()

const fetched = ref<AccountInfo[]>([])
const autoPick = ref<AccountRef | null>(null)

const list = computed(() => (props.accounts.length ? props.accounts : fetched.value))
const current = computed(() => list.value.find((a) => a.id === props.modelValue) ?? null)
const label = computed(() => {
  if (props.modelValue === 'auto') return 'Auto'
  return current.value ? accountTitle(current.value) : accountTitle({ id: props.modelValue, label: '' })
})
const hint = computed(() => {
  const pick = autoPick.value ? list.value.find((a) => a.id === autoPick.value!.id) ?? autoPick.value : null
  const now = props.modelValue === 'auto' && pick ? `Auto would pick ${accountTitle(pick)} now. ` : ''
  return `${now}Change the account from your profile at the bottom left.`
})

onMounted(async () => {
  if (!props.accounts.length) {
    try {
      fetched.value = await props.api.accounts()
    } catch {}
  }
})

// The pick is fetched whenever Auto is chosen, also after the profile control switches to it later.
watch(
  () => props.modelValue,
  async (v) => {
    if (v !== 'auto') return
    try {
      const pick = await props.api.pickAccount()
      if (props.modelValue === 'auto') autoPick.value = pick
    } catch {
      autoPick.value = null
    }
  },
  { immediate: true }
)
</script>

<template>
  <Tip :label="hint">
    <span class="flex h-6 min-w-0 shrink items-center truncate px-1.5 text-[12px] leading-4 text-text-muted" :aria-label="`Account: ${label}`">
      {{ label }}
    </span>
  </Tip>
</template>
