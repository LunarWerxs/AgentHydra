<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { AccountInfo, AccountRef } from '@shared/protocol'
import { icons, shellIcons } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'
import { accountLabel, barColor, pctText, usageTone } from './format'
import { ACCOUNTS_HINT, AUTO_ID, accountRows, chooseAccount, rowTip, type AccountRow } from './rows'

// Every account on one 28px row: Auto first with what it would pick now, Default login, then the
// accounts by headroom (signed out last), each with its plan and two thin bars, 5-hour and weekly. The
// reset times are in the row's tooltip. Choosing a row saves it as the default account for new chats.
const emit = defineEmits<{ chosen: [id: string]; settings: [] }>()

const api = usePaneApi()
const src = useShellSource()

const fetched = ref<AccountInfo[]>([])
const pick = ref<AccountRef | null>(null)
const error = ref<string | null>(null)
const loaded = ref(false)
const saving = ref<string | null>(null)
const listEl = ref<HTMLElement | null>(null)

const accounts = computed(() => (src.accounts.value.length ? src.accounts.value : fetched.value))
const rows = computed(() => accountRows(accounts.value, src.chats.value, src.settings.value?.defaultAccountId ?? AUTO_ID))
const now = ref(Date.now())
const pickLabel = computed(() => {
  const p = pick.value
  if (!p) return ''
  return rows.value.find((r) => r.id === p.id)?.label ?? accountLabel(p.label.replace(/(\s*\([^)]*\))+\s*$/, ''), null, p.id)
})

function windows(a: AccountInfo) {
  return [
    { name: '5h', pct: a.fiveHourPct },
    { name: 'Wk', pct: a.weeklyPct }
  ]
}

function dotClass(row: AccountRow): string {
  const a = row.account
  if (!a || !a.signedIn) return 'border border-text-muted opacity-50'
  if (row.inUse) return 'border-[1.5px] border-[var(--warning)]'
  const fuller = [a.fiveHourPct, a.weeklyPct].reduce<number | null>((m, p) => (p == null ? m : Math.max(m ?? 0, p)), null)
  return { ok: 'bg-[var(--success)]', warn: 'bg-[var(--warning)]', full: 'bg-[var(--danger)]', unknown: 'bg-text-muted' }[usageTone(fuller)]
}

async function load() {
  error.value = null
  now.value = Date.now()
  const tasks: Promise<unknown>[] = [api.pickAccount().then((p) => (pick.value = p)).catch(() => {})]
  if (!src.accounts.value.length) {
    tasks.push(
      api
        .accounts()
        .then((a) => (fetched.value = a))
        .catch((e) => (error.value = e instanceof Error ? e.message : String(e)))
    )
  }
  await Promise.all(tasks)
  loaded.value = true
}

async function choose(row: AccountRow) {
  if (saving.value !== null) return
  saving.value = row.id
  try {
    if (await chooseAccount(row, (patch) => src.updateSettings(patch))) emit('chosen', row.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = null
  }
}

// One tab stop (the checked row); arrows, Home and End move between rows, Enter or Space chooses.
const tabRow = computed(() => rows.value.find((r) => r.checked)?.id ?? AUTO_ID)
function onKey(e: KeyboardEvent) {
  const opts = [...(listEl.value?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
  if (!opts.length) return
  const at = opts.indexOf(document.activeElement as HTMLElement)
  let next = -1
  if (e.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(opts.length - 1, at + 1)
  else if (e.key === 'ArrowUp') next = at < 0 ? opts.length - 1 : Math.max(0, at - 1)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = opts.length - 1
  if (next < 0) return
  e.preventDefault()
  opts[next]!.focus()
  opts[next]!.scrollIntoView({ block: 'nearest' })
}

defineExpose({ load })
onMounted(async () => {
  await load()
  await nextTick()
  listEl.value?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.scrollIntoView({ block: 'nearest' })
})

const ROW =
  'flex h-7 w-full cursor-default items-center gap-1.5 rounded-[var(--radius-6)] px-2 text-start text-[13px] leading-[19px] transition-colors duration-[60ms] hover:bg-fill-hover focus-visible:bg-fill-hover focus-visible:outline-none aria-disabled:hover:bg-transparent'
</script>

<template>
  <div class="flex max-h-[70vh] w-85 flex-col p-1 text-[13px] leading-4.75 text-text">
    <div class="flex h-5.75 shrink-0 items-center px-2 text-[13px] font-medium text-text-muted">Account for new chats</div>

    <div v-if="error" class="shrink-0 px-2 py-1 text-[12px] text-danger-text">{{ error }}</div>
    <div v-else-if="loaded && accounts.length === 0" class="shrink-0 px-2 py-1 text-[12px] text-text-muted">No accounts. Is AgentHydra running?</div>

    <div
      ref="listEl"
      role="listbox"
      aria-label="Account for new chats"
      class="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto [scrollbar-width:thin]"
      @keydown="onKey"
    >
      <Tip v-for="row in rows" :key="row.id" :label="rowTip(row, now)" side="right" align="center">
        <button
          type="button"
          role="option"
          :aria-selected="row.checked"
          :aria-disabled="row.disabled || undefined"
          :aria-busy="saving === row.id || undefined"
          :tabindex="row.id === tabRow ? 0 : -1"
          :class="ROW"
          @click="choose(row)"
        >
          <span class="flex size-4 shrink-0 items-center justify-center">
            <component :is="icons.check" v-if="row.checked" class="size-4" />
            <span v-else class="size-1.5 rounded-full" :class="dotClass(row)" />
          </span>
          <span class="min-w-0 truncate" :class="row.disabled ? 'text-text-muted' : ''">{{ row.label }}</span>
          <span
            v-if="row.plan"
            class="flex h-4 shrink-0 items-center rounded-sm bg-fill-5 px-1 text-[11px] leading-4 text-text-muted"
            :class="row.disabled ? 'opacity-60' : ''"
          >{{ row.plan }}</span>
          <span class="min-w-2 flex-1" />
          <span v-if="!row.account" class="min-w-0 truncate text-[12px] leading-4 text-text-muted">{{ pickLabel ? `right now: ${pickLabel}` : '' }}</span>
          <span v-else-if="row.disabled" class="shrink-0 text-[12px] leading-4 text-text-muted">Signed out</span>
          <span v-else class="flex shrink-0 items-center gap-2.5">
            <span v-for="w in windows(row.account)" :key="w.name" class="flex items-center gap-1">
              <span class="text-[10px] leading-4 text-text-muted">{{ w.name }}</span>
              <span class="h-1 w-7 overflow-hidden rounded-full bg-(--fill-secondary)">
                <span class="block h-full rounded-full" :style="{ width: `${Math.max(0, Math.min(100, w.pct ?? 0))}%`, background: barColor(w.pct) }" />
              </span>
              <span class="tnum w-6.5 text-end text-[11px] leading-4" :class="w.pct == null ? 'text-text-muted' : 'text-text-2'">{{ pctText(w.pct) }}</span>
            </span>
          </span>
        </button>
      </Tip>
    </div>

    <div class="mx-2 my-1 h-px shrink-0 bg-border" />
    <button
      type="button"
      class="flex h-6 w-full shrink-0 cursor-default items-center gap-1.5 rounded-(--radius-6) px-2 text-start hover:bg-fill-hover focus-visible:bg-fill-hover focus-visible:outline-none"
      @click="emit('settings')"
    >
      <component :is="shellIcons.settings" class="size-4 text-text-2" />
      Settings
    </button>
    <p class="shrink-0 px-2 py-1 text-[12px] leading-4 text-text-muted">{{ ACCOUNTS_HINT }}</p>
  </div>
</template>
