<script setup lang="ts">
// Port of dashboard.html's renderAccounts(): the 5-hour/weekly usage chips, the load-balancing
// verdict, and the MOVE / LAND IN DESKTOP suggestion cards.
import { computed } from 'vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { AccountRow, AccountsData } from '@/lib/api'

const props = defineProps<{ data: AccountsData | null; loading: boolean; error: string | null }>()

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`
}

function dotClass(v: number | null | undefined, fresh: boolean): string {
  if (v == null || !fresh) return 'bg-muted-foreground'
  if (v >= 80) return 'bg-destructive'
  if (v >= 50) return 'bg-warning'
  return 'bg-success'
}

function instancesLabel(a: AccountRow): string {
  const list = a.instances.map((i) => i.name + (i.isRunning ? ' 🟢' : '')).join(', ')
  return list || a.kind || ''
}

const nextEmails = computed(() => new Set((props.data?.useNext ?? []).map((a) => a.email)))
const topNextEmail = computed(() => props.data?.useNext?.[0]?.email ?? null)

function isNext(a: AccountRow): boolean {
  return !!a.email && a.email === topNextEmail.value
}

const verdictColor = computed(() => {
  const level = props.data?.likelihood?.level
  if (level === 'likely') return 'text-warning'
  if (level === 'blocked') return 'text-destructive'
  return 'text-success'
})
</script>

<template>
  <Card class="mb-4">
    <CardHeader>
      <CardTitle>Accounts · usage bands · the balancing plan</CardTitle>
    </CardHeader>
    <CardContent class="space-y-3">
      <p v-if="error" class="text-xs text-destructive">
        ⛔ usage read failed: {{ error }} — not showing guesses in its place.
      </p>
      <p v-else-if="loading && !data" class="text-xs text-muted-foreground">
        re-checking every account's usage…
      </p>
      <template v-else-if="data">
        <p v-if="data.usageSource === 'cache-fallback'" class="text-xs text-warning">
          ⚠ the live usage survey did not answer — showing the daemon's CACHED snapshots (ages flagged per
          account). Refresh to retry the live survey.
        </p>

        <p class="text-xs">
          <b>{{ data.activeAccounts }}</b> usable desktop account(s) of {{ data.totalLogins }} logins
          ({{ data.measuredAccounts }} with a real reading). A "—" means never measured, which is never "plenty left".
        </p>

        <div class="flex flex-wrap gap-2.5">
          <div
            v-for="a in data.accounts"
            :key="a.email ?? a.identity"
            class="min-w-[210px] rounded-lg border bg-muted/20 px-3 py-2"
            :class="isNext(a) ? 'border-primary' : 'border-border'"
          >
            <div class="flex items-center gap-1.5 text-[13px] font-semibold">
              <span class="size-2 shrink-0 rounded-full" :class="dotClass(a.bindingPct, a.fresh && a.readingOk)" />
              {{ a.email ?? a.identity }}
            </div>
            <div class="mt-0.5 text-xs tabular-nums text-foreground/80">
              5-hour {{ pct(a.fiveHourPct) }} · weekly {{ pct(a.weeklyAllPct) }} · Fable {{ pct(a.weeklyModelPct) }}
            </div>
            <div class="mt-0.5 text-[11px] text-muted-foreground">
              {{ a.plan ?? 'plan?' }} · {{ instancesLabel(a) }}<template v-if="a.weeklyResets"> · wk resets {{ a.weeklyResets }}</template>
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
              <span v-if="a.underPressure" :class="a.open ? 'text-destructive' : 'text-muted-foreground'">
                {{ a.open ? '⛔ under pressure' : '🤖 self-note: do NOT open this one' }}
              </span>
              <span v-if="!a.readingOk" class="text-warning">⚠ no reading — NOT "plenty left"</span>
              <span v-else-if="!a.fresh" class="text-warning">⚠ stale reading ({{ Math.round(a.ageHours ?? 0) }}h old)</span>
              <span v-if="isNext(a)" class="font-bold text-primary">▶ HAND OFF HERE{{ a.mustOpen ? ' (needs opening)' : '' }}</span>
              <span v-else-if="a.email && nextEmails.has(a.email)" class="font-bold text-primary">
                runner-up{{ a.mustOpen ? ' (needs opening)' : '' }}
              </span>
            </div>
          </div>
        </div>

        <p class="text-[13px]">
          <b :class="verdictColor">Load balancing: {{ (data.likelihood?.level || '?').toUpperCase() }}</b>
          — {{ data.likelihood?.why || '' }}
        </p>

        <div
          v-for="(m, i) in data.moves"
          :key="`move-${i}`"
          class="rounded-r-lg border-l-[3px] border-warning bg-muted/30 px-2.5 py-1.5 text-[13px]"
        >
          <b>MOVE</b> "{{ m.title }}" — {{ m.from.instance }} ({{ m.from.email ?? '?' }}, {{ m.from.bindingPct ?? '?' }}%)
          → <b>{{ m.to.instance }}</b> ({{ m.to.email }}, {{ m.to.bindingPct }}%)
          <div class="text-xs">{{ m.why }}</div>
          <span class="cmd">{{ m.command }}</span>
        </div>

        <div
          v-for="(c, i) in data.consoleStrays"
          :key="`stray-${i}`"
          class="rounded-r-lg border-l-[3px] border-primary bg-muted/30 px-2.5 py-1.5 text-[13px]"
        >
          <b>LAND IN DESKTOP (required)</b> "{{ c.title }}" — {{ c.why }}
          <div v-if="c.command"><span class="cmd">{{ c.command }}</span></div>
        </div>

        <p class="text-[11px] text-muted-foreground">
          Moves obey the residence rule (everything lands IN the desktop, nothing leaves it), never touch a live
          chat, and run through migrate_chat.py's own rails — nothing moves from this page.
        </p>
      </template>
    </CardContent>
  </Card>
</template>
