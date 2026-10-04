<script setup lang="ts">
// The one instance row: every table's rows (Claude desktop, Claude CLI, Codex, DeepSeek) are this
// component, drawing the cells their table's column list names (lib/instance-table.ts) from one
// InstanceRowModel. What differs per kind comes in as slots: `name-extra` (icons after the name),
// `account-extra` (after the account login, on the name's line), `primary` (the action buttons) and `menu` (the items under the ⋯ menu's header).
import { EllipsisVertical } from '@lucide/vue'
import { computed, ref } from 'vue'
import CopyResetDate from '@/components/CopyResetDate.vue'
import InstanceGlyph from '@/components/InstanceGlyph.vue'
import InstanceMenuHeader from '@/components/InstanceMenuHeader.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import ProviderLogo from '@/components/ProviderLogo.vue'
import UsageBadge from '@/components/UsageBadge.vue'
import UsageBar from '@/components/UsageBar.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TableCell, TableRow } from '@/components/ui/table'
import { pii, piiName } from '@/composables/usePrivacy'
import { useUsageMode } from '@/composables/useUsageMode'
import { accountLine, type InstanceColumn, type InstanceRowModel } from '@/lib/instance-table'
import { useTooltipConfig } from '@/lib/tooltip-config'
import {
  resetLabel,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  waitSeverity,
  windowRemainingPct,
} from '@/lib/usage-reset'
import IconTooltip from '@/shell/IconTooltip.vue'

const props = defineProps<{ columns: InstanceColumn[]; row: InstanceRowModel }>()
/** Whether the ⋯ menu is open: the table keeps it when it opens one menu at a time. */
const menuOpen = defineModel<boolean>('menuOpen', { default: false })

const { enabled: tooltipsEnabled } = useTooltipConfig()
// The tab's shared clock (the table's owner keeps it running), so every countdown ticks together.
const { now } = useUsageMode()

// The name cell elides when the column is out of room; measured on hover, the one moment the
// tooltip is about to be read, so a name cut either way leads its hover with the full text.
const clipped = ref(false)
function noteClip(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  clipped.value = el.scrollWidth > el.clientWidth
}
// A CLI row is named after its account, and its folder can carry the address too.
const nameTooltip = computed(() => {
  const tip = props.row.name.tooltip(clipped.value)
  return {
    label: pii(tip.label),
    description: tip.description && pii(tip.description),
    detail: tip.detail && pii(tip.detail),
  }
})
// The builders mask the name in privacy mode, so the "say it once" check compares masked forms too.
const account = computed(() => {
  const line = accountLine(props.row.account, props.row.name.shown)
  if (!line) return null
  const text = piiName(line.text)
  if (text === props.row.name.shown.trim()) return null
  return { text, title: line.title ? pii(line.title) : text }
})

// One number per window drives the bar's length; the WEEKLY one also drives its colour, and the
// 5-hour bar is drawn `neutral` (see UsageBar's UsageBarVariant).
const snapshot = computed(() => props.row.usage?.snapshot)
const sessionReset = computed(() => resetLabel(snapshot.value?.session, now.value))
const weeklyReset = computed(() => resetLabel(snapshot.value?.weekAll, now.value))
const sessionRemaining = computed(
  () => windowRemainingPct(snapshot.value?.session, SESSION_WINDOW_MS, now.value) ?? 0,
)
const weeklyRemaining = computed(
  () => windowRemainingPct(snapshot.value?.weekAll, WEEK_WINDOW_MS, now.value) ?? 0,
)

function onContextMenu(e: MouseEvent): void {
  if (!props.row.menu) return
  e.preventDefault()
  menuOpen.value = true
}
</script>

<template>
  <!-- Dimmed, not disabled: a filtered-out instance is one you've set aside, so every action on the
       row still works; it just does not react to the pointer (the faded variant). -->
  <TableRow
    :variant="row.dimmed ? 'faded' : 'default'"
    class="group/row"
    @contextmenu="onContextMenu"
  >
    <template v-for="col in columns" :key="col.key">
      <TableCell v-if="col.cell">
        <component :is="col.cell" :row="row" />
      </TableCell>

      <TableCell v-else-if="col.key === 'status'">
        <span
          role="img"
          class="inline-block size-2 rounded-full"
          :class="row.status.on ? ['bg-success', row.status.pulse && 'animate-pulse'] : 'bg-muted-foreground/40'"
          :title="row.status.title"
          :aria-label="row.status.title"
        />
      </TableCell>

      <!-- max-w-0 so a long name elides instead of widening the table. The number sits BEFORE the
           name because the name is the untrustworthy half: it can drift from the account it was
           named after, and the number never does (one sequence spans every instance family). -->
      <TableCell v-else-if="col.key === 'name'" class="max-w-0">
        <div class="flex min-w-0 items-center gap-1.5 font-medium">
          <ProviderLogo v-if="row.provider" :provider="row.provider" class="size-3.5" />
          <InstanceNumber :num="row.num" />
          <InstanceGlyph
            v-if="row.glyph"
            :dir="row.glyph.dir"
            :icon="row.glyph.icon"
            :color="row.glyph.color"
            :running="row.glyph.running"
          />
          <IconTooltip v-bind="nameTooltip">
            <button
              v-if="row.name.onClick"
              type="button"
              class="min-w-0 cursor-pointer truncate text-start hover:underline"
              :disabled="row.name.busy"
              @pointerenter="noteClip"
              @click="row.name.onClick"
            >
              {{ $pii(row.name.shown) }}
            </button>
            <span v-else class="min-w-0 cursor-default truncate" @pointerenter="noteClip">{{
              $pii(row.name.shown)
            }}</span>
          </IconTooltip>
          <Badge v-if="row.badge" variant="outline" :title="row.badge.title">{{
            row.badge.label
          }}</Badge>
          <slot name="name-extra" />
          <!-- The signed-in account, after the name on the same line (one-line rows, owner
               2026-10-04). It gives way first: its shrink weight is far above the name's. -->
          <span
            v-if="account"
            class="min-w-0 shrink-[8] truncate text-2xs font-normal text-muted-foreground"
            :title="account.title"
          >{{ account.text }}</span>
          <slot name="account-extra" />
        </div>
      </TableCell>

      <TableCell v-else-if="col.key === 'configDir'" class="max-w-[16rem]">
        <span class="mono block truncate text-3xs text-muted-foreground">{{ row.configDir }}</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'pid'">
        <span class="mono text-muted-foreground">{{ row.pid ?? '—' }}</span>
      </TableCell>
      <TableCell v-else-if="col.key === 'uptime'">
        <span class="text-muted-foreground">{{ row.uptime ?? '—' }}</span>
      </TableCell>
      <TableCell v-else-if="col.key === 'memory'">
        <span class="text-muted-foreground">{{ row.memory ?? '—' }}</span>
      </TableCell>

      <!-- A bar, not a bare number: usage mode is for scanning many rows at once for the ones up
           against a wall. The number stays inside the bar, and the countdown says when it stops
           mattering. A row with no quota (a pay-as-you-go key) says so in a dash's hover. -->
      <TableCell v-else-if="col.key === 'session'">
        <div v-if="row.usage" class="flex items-center gap-1.5">
          <UsageBadge
            scope="session"
            :snapshot="row.usage.snapshot"
            :checking="row.usage.checking"
            :usage-key="row.usage.key"
            @check="row.usage.onCheck()"
          />
          <UsageBar
            v-if="sessionReset"
            :fill-pct="sessionRemaining"
            variant="neutral"
            :label="sessionReset"
            :aria-label="$t('instances.resetsIn', { when: sessionReset })"
          />
          <span
            v-else-if="snapshot?.sessionLimitUnavailable"
            class="text-muted-foreground"
            :title="$t('codexInstances.noSessionLimit')"
          >{{ $t('codexInstances.noSessionLimitShort') }}</span>
        </div>
        <span v-else class="text-muted-foreground" :title="row.noQuota">—</span>
      </TableCell>
      <TableCell v-else-if="col.key === 'weekly'">
        <div v-if="row.usage" class="flex items-center gap-1.5">
          <UsageBadge
            :snapshot="row.usage.snapshot"
            :checking="row.usage.checking"
            :usage-key="row.usage.key"
            @check="row.usage.onCheck()"
          />
          <CopyResetDate v-if="weeklyReset" :limit="snapshot?.weekAll">
            <UsageBar
              :fill-pct="weeklyRemaining"
              :variant="waitSeverity(weeklyRemaining)"
              :label="weeklyReset"
              :aria-label="$t('instances.resetsIn', { when: weeklyReset })"
            />
          </CopyResetDate>
        </div>
        <span v-else class="text-muted-foreground" :title="row.noQuota">—</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'usage'">
        <UsageBadge
          v-if="row.usage"
          :snapshot="row.usage.snapshot"
          :checking="row.usage.checking"
          :usage-key="row.usage.key"
          @check="row.usage.onCheck()"
        />
        <span v-else class="text-xs text-muted-foreground" :title="row.noQuota">—</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'plan'">
        <span
          v-if="row.plan?.plain"
          class="text-xs text-muted-foreground"
          :title="row.plan.title"
        >{{ row.plan.label }}</span>
        <Badge v-else-if="row.plan" variant="outline">{{ row.plan.label }}</Badge>
        <span v-else class="text-xs text-muted-foreground">—</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'lastActive'">
        <span
          v-if="row.lastRunning"
          class="text-xs tabular-nums"
          :class="row.lastRunning.running ? 'text-success' : ''"
          :title="tooltipsEnabled ? row.lastRunning.title : undefined"
        >{{ row.lastRunning.label }}</span>
        <span v-else class="text-xs text-muted-foreground">—</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'actions'">
        <div class="flex items-center justify-end gap-1">
          <slot name="primary" />
          <DropdownMenu v-if="row.menu" v-model:open="menuOpen">
            <!-- No tooltip wrapper: nesting a TooltipTrigger around the DropdownMenuTrigger
                 swallowed the click so the menu never opened. aria-label keeps it accessible. -->
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="$t('instances.moreActions')">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" :class="row.menu.class ?? 'max-w-56'">
              <!-- The menu leads with WHICH instance it belongs to, by number: on a table of
                   near-identically named rows an open menu is otherwise detached from its row. -->
              <InstanceMenuHeader :num="row.num" :name="row.menu.name" :actions="row.menu.actions" />
              <slot name="menu" />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </template>
  </TableRow>
</template>
