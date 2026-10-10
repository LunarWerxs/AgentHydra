<script setup lang="ts">
// One CLI account's priority and caps for AgentHydra's work (owner, 2026-10-09: "set certain accounts as
// priority ... This is priority, like, top, and then up to 50% of five-hour, 50% of week"). The server's
// AccountPlacement: CliMayte sends new work to a higher priority first, among the accounts it fits, and
// a cap is that account's own line in place of the fleet's 85% (a session hands off there and is stopped
// 5 points above it). An empty cap, or 85 and over, is the fleet's line.
import type { AccountPlacement } from '@agenthydra/server/types'
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  instanceName?: string | null
  current?: AccountPlacement | null
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  submit: [placement: { priority: number; maxSessionPct: number | null; maxWeekPct: number | null }]
}>()

/** The levels, highest first (the server's PLACEMENT_PRIORITIES). */
const LEVELS = [
  { value: '2', key: 'cliInstances.priorityTop' },
  { value: '1', key: 'cliInstances.priorityHigh' },
  { value: '0', key: 'cliInstances.priorityNormal' },
  { value: '-1', key: 'cliInstances.priorityLow' },
] as const

const priority = ref('0')
const session = ref('')
const week = ref('')

watch(open, (isOpen) => {
  if (!isOpen) return
  priority.value = String(props.current?.priority ?? 0)
  session.value = props.current?.maxSessionPct == null ? '' : String(props.current.maxSessionPct)
  week.value = props.current?.maxWeekPct == null ? '' : String(props.current.maxWeekPct)
})

/** A cap as typed: null when empty (the fleet's line), else a whole percent from 1 to 85, else NaN. */
function capOf(text: string): number | null {
  const v = text.trim()
  if (!v) return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : Number.NaN
}

const valid = computed(() => [session.value, week.value].every((v) => !Number.isNaN(capOf(v))))

function handleSubmit() {
  if (!valid.value) return
  emit('submit', {
    priority: Number(priority.value),
    maxSessionPct: capOf(session.value),
    maxWeekPct: capOf(week.value),
  })
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form @submit.prevent="handleSubmit">
        <DialogHeader>
          <DialogTitle>{{ $t('cliInstances.placementDialogTitle', { name: instanceName ?? '' }) }}</DialogTitle>
          <DialogDescription>{{ $t('cliInstances.placementDialogDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-3">
          <div class="flex flex-col gap-1.5">
            <label id="placement-priority-label" class="text-xs font-medium text-muted-foreground">
              {{ $t('cliInstances.placementPriority') }}
            </label>
            <Select v-model="priority">
              <SelectTrigger class="w-full" aria-labelledby="placement-priority-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="l in LEVELS" :key="l.value" :value="l.value">{{ $t(l.key) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <label for="placement-session" class="text-xs font-medium text-muted-foreground">
                {{ $t('cliInstances.placementSessionCap') }}
              </label>
              <Input
                id="placement-session"
                v-model="session"
                inputmode="numeric"
                :placeholder="$t('cliInstances.placementCapPlaceholder')"
                :disabled="submitting"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="placement-week" class="text-xs font-medium text-muted-foreground">
                {{ $t('cliInstances.placementWeekCap') }}
              </label>
              <Input
                id="placement-week"
                v-model="week"
                inputmode="numeric"
                :placeholder="$t('cliInstances.placementCapPlaceholder')"
                :disabled="submitting"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('cliInstances.placementCapHint') }}</p>
          <p v-if="!valid" class="text-xs text-destructive">{{ $t('cliInstances.placementCapInvalid') }}</p>
          <p v-else-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" :disabled="submitting || !valid">
            {{ submitting ? $t('cliInstances.placementSaving') : $t('cliInstances.placementSave') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
