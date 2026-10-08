<script setup lang="ts">
// The one instance row: every table's rows (Claude desktop, Claude CLI, Codex, DeepSeek) are this
// component, drawing the cells their table's column list names (lib/instance-table.ts) from one
// InstanceRowModel. What differs per kind comes in as slots: `name-extra` (icons after the name),
// `account-extra` (after the name and its stale-login mark), `session-mark` (a dot on the 5-hour counter, as a
// notification dot sits on an icon), `primary` (the action buttons) and `menu` (the items under the ⋯ menu's header).
import LazyOverlay from '@/components/ui/lazy/LazyOverlay.vue'
import { EllipsisVertical, TriangleAlert } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
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
import { pii } from '@/composables/usePrivacy'
import { useUsageMode } from '@/composables/useUsageMode'
import { type InstanceColumn, type InstanceRowModel } from '@/lib/instance-table'
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

const { t } = useI18n()
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
// A click on the name copies the account's full address (owner, 2026-10-06; the row no longer prints
// the handle). The clipboard gets the real address; only what is displayed is masked in privacy mode.
function copyEmail(): void {
  const email = props.row.name.copy
  if (!email) return
  navigator.clipboard?.writeText(email).catch(() => {})
  toast.success(t('instances.toastEmailCopied', { email: pii(email) }))
}
// The live login check failed and the row shows the last known account (accounts.ts 'cache' and
// 'offline'): a yellow mark after the name.
const loginStale = computed(() => !!props.row.account.stale)

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
    :data-instance-num="row.num"
    :data-instance-kind="row.kind"
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
              v-if="row.name.copy"
              type="button"
              class="min-w-0 cursor-pointer truncate text-start hover:underline"
              @pointerenter="noteClip"
              @click="copyEmail"
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
          <span v-if="row.account.note" class="min-w-0 shrink-8 truncate text-2xs font-normal text-muted-foreground">{{
            row.account.note
          }}</span>
          <span
            v-if="loginStale"
            role="img"
            class="inline-flex shrink-0 text-warning"
            :aria-label="$t('instances.loginUnconfirmed')"
            :title="$t('instances.loginUnconfirmed')"
          >
            <TriangleAlert class="size-3.5" aria-hidden="true" />
          </span>
          <slot name="account-extra" />
        </div>
      </TableCell>

      <TableCell v-else-if="col.key === 'configDir'" class="max-w-[16rem]">
        <span class="mono block truncate text-3xs text-muted-foreground">{{ row.configDir }}</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'pid'">
        <span class="mono text-muted-foreground">{{ row.pid ?? '—' }}</span>
      </TableCell>
      <!-- Tabular figures: these two change on every poll, and proportional digits made the text
           shuffle in place each time. -->
      <TableCell v-else-if="col.key === 'uptime'">
        <span class="tabular-nums text-muted-foreground">{{ row.uptime ?? '—' }}</span>
      </TableCell>
      <TableCell v-else-if="col.key === 'memory'">
        <span class="tabular-nums text-muted-foreground">{{ row.memory ?? '—' }}</span>
      </TableCell>

      <!-- A bar, not a bare number: usage mode is for scanning many rows at once for the ones up
           against a wall. The number stays inside the bar, and the countdown says when it stops
           mattering. A row with no quota (a pay-as-you-go key) says so in a dash's hover. -->
      <TableCell v-else-if="col.key === 'session'">
        <div v-if="row.usage" class="flex items-center gap-1.5">
          <span class="relative inline-flex">
            <UsageBadge
              scope="session"
              :snapshot="row.usage.snapshot"
              :checking="row.usage.checking"
              :usage-key="row.usage.key"
              @check="row.usage.onCheck()"
            />
            <span v-if="$slots['session-mark']" class="absolute -right-0.5 -top-0.5 flex"><slot name="session-mark" /></span>
          </span>
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
        <span v-else class="text-muted-foreground" :title="row.noQuota">{{ row.noQuotaLabel ?? '—' }}</span>
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
        <span v-else class="text-muted-foreground" :title="row.noQuota">{{ row.noQuotaLabel ?? '—' }}</span>
      </TableCell>

      <!-- Process columns have no 5-hour counter: the session mark sits on this one. -->
      <TableCell v-else-if="col.key === 'usage'">
        <span v-if="row.usage" class="relative inline-flex">
          <UsageBadge
            :snapshot="row.usage.snapshot"
            :checking="row.usage.checking"
            :usage-key="row.usage.key"
            @check="row.usage.onCheck()"
          />
          <span v-if="$slots['session-mark']" class="absolute -right-0.5 -top-0.5 flex"><slot name="session-mark" /></span>
        </span>
        <span v-else class="text-xs text-muted-foreground" :title="row.noQuota">{{ row.noQuotaLabel ?? '—' }}</span>
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
          <!-- A row nobody has opened is its trigger button alone (LazyOverlay); the stand-in carries
               what reka's trigger sets while closed. -->
          <LazyOverlay
            v-if="row.menu"
            :interest="['hover', 'focus', 'press', 'key']"
            first-press="click"
            :armed="menuOpen"
            :stand-in="{
              'data-slot': 'dropdown-menu-trigger',
              'data-state': 'closed',
              type: 'button',
              'aria-haspopup': 'menu',
              'aria-expanded': 'false',
            }"
          >
            <template #closed>
              <Button variant="ghost" size="icon-sm" :aria-label="$t('instances.moreActions')">
                <EllipsisVertical />
              </Button>
            </template>
          <DropdownMenu v-model:open="menuOpen">
            <!-- No tooltip wrapper: nesting a TooltipTrigger around the DropdownMenuTrigger
                 swallowed the click so the menu never opened. aria-label keeps it accessible. -->
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="$t('instances.moreActions')">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" :width="row.menu.width ?? 'md'">
              <!-- The menu leads with WHICH instance it belongs to, by number: on a table of
                   near-identically named rows an open menu is otherwise detached from its row. -->
              <InstanceMenuHeader :num="row.num" :name="row.menu.name" :actions="row.menu.actions" />
              <slot name="menu" />
            </DropdownMenuContent>
          </DropdownMenu>
          </LazyOverlay>
        </div>
      </TableCell>
    </template>
  </TableRow>
</template>
