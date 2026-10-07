<script setup lang="ts">
// The Free rows of the one Instances table (owner, 2026-10-07: one Instances table, Desktop, CLI and
// Free as toggles). InstancesView.vue owns the card, header, table, skeleton and empty state; this
// renders ONLY one shared InstanceRow per Free login (the columns it is handed, the model it builds),
// plus this kind's dialogs (reka dialogs teleport, so they sit beside the rows).
// Free instances: Claude and ChatGPT web logins (Incognito and Temporary chats) that Desk runs
// through the bundled harness (server/src/free-instances). A row's private chats open under
// HSwarm → CliMayte.
import {
  HeartPulse,
  LogIn,
  LogOut,
  MessagesSquare,
  Pencil,
  RefreshCw,
  SearchCheck,
  Trash2,
  TriangleAlert,
  X,
} from '@lucide/vue'
import {
  FREE_PROVIDERS,
  type FreeCommand,
  type FreeInstance,
  type FreeProvider,
} from '@desk/shared/free-instances'
import type { TokenParts } from '@agenthydra/server/types'
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceRow from '@/components/InstanceRow.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { TableBody } from '@/components/ui/table'
import { useFreeInstances } from '@/composables/useFreeInstances'
import { quotaSortColumns, useInstanceSource } from '@/composables/useInstanceSource'
import { pii } from '@/composables/usePrivacy'
import { useDesktopTokenWindow } from '@/composables/useTokenWindow'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsageMode } from '@/composables/useUsageMode'
import type { UsageSnapshot } from '@/lib/api'
import { formatTokens } from '@/lib/climayte-status'
import { timeAgo } from '@/lib/format'
import { type FreeVerdict, freeApi, freeCheckVerdict, freeLogo, freeUsageSnapshot, openFreeThread } from '@/lib/free-instances'
import { shortDisplayName } from '@/lib/instance-appearance'
import { type InstanceColumn, type InstanceRowModel } from '@/lib/instance-table'
import IconTooltip from '@/shell/IconTooltip.vue'

// The table's column list (lib/instance-table.ts): the one the header draws, so the cells follow it.
defineProps<{ columns: InstanceColumn[] }>()

const { t } = useI18n()
const { instances, tokens, jobs, errors, loaded, loadError, busy, run, logout, remove, recover, refreshFree } =
  useFreeInstances()
// The table's column mode and clock (composables/useUsageMode.ts), the desktop table's: one mode for
// every kind in the one table.
const { now } = useUsageMode(true)

const providerName = (p: FreeProvider) =>
  t(p === 'claude' ? 'freeInstances.claude' : 'freeInstances.chatgpt')
const chatMode = (p: FreeProvider) =>
  t(p === 'claude' ? 'freeInstances.incognito' : 'freeInstances.temporary')
/** Whether the instance's one running operation is one of these. */
const runningOf = (i: FreeInstance, ...commands: FreeCommand[]) =>
  busy(i.id) && commands.includes(jobs[i.id]!.command)

// One snapshot per reading, so a usage cell sees a new object only when its account's reading changed: a
// refresh that brings the same reading back redraws nothing.
const snapshotMemo = new Map<string, { key: string; snapshot: UsageSnapshot | null }>()
function usageFor(i: FreeInstance): UsageSnapshot | null {
  const key = JSON.stringify(i.usage)
  const memo = snapshotMemo.get(i.id)
  if (memo?.key === key) return memo.snapshot
  const snapshot = freeUsageSnapshot(i.usage)
  snapshotMemo.set(i.id, { key, snapshot })
  return snapshot
}

// The Tokens column (owner, 2026-10-06: "a column on the free table called tokens to show the amount of tokens run
// through the account, just like the others"), for the span its header has chosen. Neither site counts tokens, so
// these are Desk's estimate; an account that sent nothing from here has 0. One window for the whole table now
// (owner, 2026-10-07), so this reads the desktop one.
const tokenWindow = useDesktopTokenWindow()
function tokensOf(i: FreeInstance): TokenParts {
  const all = tokens.value[i.id]
  const p = !all ? null : tokenWindow.value === '5h' ? all.fiveHour : tokenWindow.value === 'week' ? all.week : all.total
  return { input: p?.input ?? 0, output: p?.output ?? 0, cacheRead: 0, cacheWrite: 0, total: p?.total ?? 0 }
}

// The header of the one table is the only sort control, so these rows follow ITS remembered sort (the
// persisted key the host sorts every kind by), under the same column keys (owner, 2026-10-07).
const { desktopSortKey, desktopSortDirection } = useUiPrefs()

// A Free login is never open or closed and has no plan the filter offers, so only its sign-in and
// usage can set it aside (as on the CLI tab).
const { visibleRows, hiddenByFilter, isDimmed } = useInstanceSource({
  rows: () => instances.value,
  rowKey: (i: FreeInstance) => i.id,
  facts: (i: FreeInstance) => ({ usage: usageFor(i), signedIn: i.loggedIn }),
  persisted: { key: desktopSortKey, direction: desktopSortDirection },
  columns: [
    { key: 'status', accessor: (i: FreeInstance) => i.loggedIn },
    { key: 'name', accessor: (i: FreeInstance) => i.name },
    { key: 'lastActive', accessor: (i: FreeInstance) => i.lastActiveAt ?? undefined },
    { key: 'tokens', accessor: (i: FreeInstance) => tokensOf(i).total },
    ...quotaSortColumns(usageFor, (i: FreeInstance) => i.provider, now),
  ],
})

/** True until the first list is in, which the host draws as its skeleton. */
const loading = computed(() => !loaded.value && !loadError.value)

/** What the shared row draws for one Free login (components/InstanceRow.vue). */
function rowModel(i: FreeInstance): InstanceRowModel {
  const shown = shortDisplayName(pii(i.name), 36)
  const working = busy(i.id)
  const used = tokensOf(i)
  return {
    id: i.id,
    num: i.num,
    dimmed: isDimmed(i),
    provider: freeLogo(i.provider),
    status: {
      on: i.loggedIn,
      pulse: working,
      title:
        (!working && lastCheckLine(i)) ||
        t(
          working
            ? 'freeInstances.working'
            : i.loggedIn
              ? 'freeInstances.connected'
              : i.checkedAt
                ? 'freeInstances.signedOut'
                : 'freeInstances.unchecked',
        ),
    },
    name: {
      shown,
      // A Free login carries no address, so its name is plain text (owner, 2026-10-06) and its hover
      // keeps the provider, the chat kind and the last check.
      tooltip: () => ({
        label: i.name,
        description: `${providerName(i.provider)} · ${chatMode(i.provider)}`,
        detail:
          lastCheckLine(i) ??
          (i.checkedAt
          ? t('freeInstances.checkedAt', { time: new Date(i.checkedAt).toLocaleString() })
          : t('freeInstances.unchecked')),
      }),
    },
    // The name is the login; the provider is the logo and the chat kind is in the name's hover.
    account: {},
    // An account whose text model has no cap (ChatGPT's free one) has no window to draw: its quota
    // cells say so, the model in the hover, as a pay-as-you-go row's say it has none.
    ...(i.usage?.unlimited_text
      ? {
          noQuota:
            i.usage.plan && i.usage.plan !== 'free'
              ? t('freeInstances.unlimitedPlanHint', {
                  model: i.usage.text_model ?? '',
                  plan: i.usage.plan.charAt(0).toUpperCase() + i.usage.plan.slice(1),
                })
              : t('freeInstances.unlimitedHint', { model: i.usage.text_model ?? '' }),
          noQuotaLabel: t('freeInstances.unlimited'),
        }
      : i.provider === 'claude' && i.usage && !usageFor(i)
        ? // Claude answers a free account's usage with empty windows until it sends a message (seen
          // 2026-10-06), which the cell used to call "Not checked yet.".
          {
            noQuota: t('freeInstances.noReadingHint'),
            noQuotaLabel: t('freeInstances.noReading'),
          }
        : {
          usage: {
            snapshot: usageFor(i),
            checking: runningOf(i, 'auth', 'usage'),
            key: `free:${i.id}`,
            onCheck: () => void run(i, 'usage'),
          },
        }),
    lastRunning: i.lastActiveAt
      ? {
          // A getter, as on the desktop table: only the cell that draws it ticks with the clock.
          get label() {
            void now.value
            return timeAgo(i.lastActiveAt)
          },
          running: runningOf(i, 'chat', 'resume'),
          title: new Date(i.lastActiveAt).toLocaleString(),
        }
      : null,
    tokens: used,
    tokensNote: {
      breakdown: t('freeInstances.tokensBreakdown', { output: formatTokens(used.output), input: formatTokens(used.input) }),
      source: t('freeInstances.tokensSource'),
    },
    menu: { name: i.name, actions: menuActionsFor(i), class: 'max-w-56' },
  }
}
const rowModels = computed(() => new Map(visibleRows.value.map((i) => [i.id, rowModel(i)])))

/** The icon row at the top of a row's kebab (InstanceMenuHeader), in the order every table uses. */
function menuActionsFor(i: FreeInstance): MenuIconAction[] {
  return [
    {
      key: 'checkUsage',
      icon: RefreshCw,
      label: t('freeInstances.check'),
      run: () => void checkByHand(i),
      spin: runningOf(i, 'auth', 'usage'),
      disabled: busy(i.id),
    },
    {
      key: 'rename',
      icon: Pencil,
      label: t('freeInstances.rename'),
      closes: true,
      run: () => openRename(i),
      disabled: busy(i.id),
    },
    {
      key: 'logout',
      icon: LogOut,
      label: t('freeInstances.logout'),
      closes: true,
      run: () => openLogout(i),
      disabled: !i.loggedIn || busy(i.id),
    },
    {
      key: 'delete',
      icon: Trash2,
      label: t('freeInstances.delete'),
      closes: true,
      run: () => openDelete(i),
      disabled: busy(i.id),
    },
  ]
}

// --- check: the login check, then the usage read, ending in a verdict (owner, 2026-10-07: "It just spun, and
// then it stopped") that the row keeps for its dot and name hover. Not kept across a page load: the server's
// own checkedAt and loggedIn describe the row then.
const lastCheck = reactive<Record<string, FreeVerdict & { at: number }>>({})
async function checkOne(i: FreeInstance, withUsage: boolean): Promise<FreeVerdict> {
  const who = t('freeInstances.accountLabel', { num: i.num, name: shortDisplayName(pii(i.name), 36) })
  const auth = await run(i, 'auth')
  let usage = auth?.usage
  if (withUsage && auth?.ok && auth.authenticated) {
    const read = await run(i, 'usage')
    if (read?.ok && read.usage) usage = read.usage
    // The login is fine: a failed usage read must not leave the triangle on an alive row.
    errors[i.id] = ''
  }
  const verdict = freeCheckVerdict(who, auth, usage, errors[i.id] ?? '', t)
  lastCheck[i.id] = { ...verdict, at: Date.now() }
  return verdict
}
function toastVerdict(v: FreeVerdict) {
  if (v.state === 'alive') toast.success(v.text)
  else if (v.state === 'dead') toast.error(v.text)
  else toast.warning(v.text)
}
async function checkByHand(i: FreeInstance) {
  if (busy(i.id)) return
  toastVerdict(await checkOne(i, true))
}
/** The status dot's title and the name hover's detail, from the last check this page ran. */
function lastCheckLine(i: FreeInstance): string | null {
  const c = lastCheck[i.id]
  if (!c) return null
  const time = new Date(c.at).toLocaleTimeString()
  return t(c.state === 'alive' ? 'freeInstances.rowAlive' : c.state === 'dead' ? 'freeInstances.rowDead' : 'freeInstances.rowUnknown', {
    time,
    reason: c.reason,
  })
}

/** Refresh re-reads the list, then checks every saved login (read-only: no window opens). Only this
 *  spins the header: the background reads and opening the tab show no spinner. It ends with one summary toast. */
const refreshing = ref(false)
async function refreshAccounts() {
  refreshing.value = true
  try {
    await refreshFree()
    const verdicts = await Promise.all(instances.value.filter((i) => !busy(i.id)).map((i) => checkOne(i, false)))
    const count = (s: FreeVerdict['state']) => verdicts.filter((v) => v.state === s).length
    if (verdicts.length > 0) {
      const text =
        t('freeInstances.checkSummary', { alive: count('alive'), dead: count('dead') }) +
        (count('unknown') > 0 ? t('freeInstances.checkSummaryUnknown', { unknown: count('unknown') }) : '')
      if (count('dead') + count('unknown') > 0) toast.warning(text)
      else toast.success(text)
    }
  } finally {
    refreshing.value = false
  }
}

// --- add: the host's + menu names the provider (it merges these options into its own); the server
// names the account after its login ---
const createOptions = computed(() =>
  FREE_PROVIDERS.map((p) => ({ id: p, provider: freeLogo(p), label: providerName(p) })),
)
async function openCreate(id?: string) {
  try {
    const created = await freeApi.create(id === 'chatgpt' ? 'chatgpt' : 'claude')
    // Into the list as it is, not through a refresh: a refresh would start a login check on the
    // new row and hold the sign-in below off it.
    instances.value = [...instances.value, created]
    void signIn(created)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('freeInstances.createFailed'))
  }
}

// --- sign in: a visible browser window; the row pulses until the harness has checked it ---
async function signIn(i: FreeInstance) {
  toast.info(t('freeInstances.signingIn'), { description: t('freeInstances.preparing') })
  const result = await run(i, 'login')
  // The server renames an automatic name to the account's: read the row again for the toast.
  const name = instances.value.find((x) => x.id === i.id)?.name ?? i.name
  if (result?.ok && result.authenticated) toast.success(t('freeInstances.signedIn', { name }))
  else if (result || errors[i.id]) toast.error(errors[i.id] || t('freeInstances.signInUnverified'))
}
async function cancelSignIn(i: FreeInstance) {
  const job = jobs[i.id]
  if (job?.state !== 'running') return
  try {
    await freeApi.cancel(job.id)
  } catch (e) {
    // The window may still be open: say so rather than look cancelled.
    toast.error(e instanceof Error ? e.message : t('freeInstances.cancelFailed'))
  }
}

// --- log out: removes the stored login; the row's chats stay ---
const logoutOpen = ref(false)
const logoutTarget = ref<FreeInstance | null>(null)
const loggingOut = ref(false)
function openLogout(i: FreeInstance) {
  logoutTarget.value = i
  logoutOpen.value = true
}
async function onLogoutConfirm() {
  const i = logoutTarget.value
  if (!i) return
  loggingOut.value = true
  try {
    if (await logout(i)) toast.success(t('freeInstances.toastLogout'))
    else toast.error(errors[i.id] || t('freeInstances.toastLogoutFailed'))
  } finally {
    loggingOut.value = false
    logoutOpen.value = false
    logoutTarget.value = null
  }
}

// --- delete: removes the account here and on the owner's other PCs; its chats stay at the provider ---
const deleteOpen = ref(false)
const deleteTarget = ref<FreeInstance | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
function openDelete(i: FreeInstance) {
  deleteTarget.value = i
  deleteError.value = null
  deleteOpen.value = true
}
async function onDeleteConfirm() {
  const i = deleteTarget.value
  if (!i) return
  deleting.value = true
  deleteError.value = null
  try {
    if (await remove(i)) {
      toast.success(t('freeInstances.toastDeleted', { name: i.name }))
      deleteOpen.value = false
      deleteTarget.value = null
    } else deleteError.value = errors[i.id] || t('freeInstances.deleteFailed')
  } finally {
    deleting.value = false
  }
}

// --- rename ---
const renameOpen = ref(false)
const renameTarget = ref<FreeInstance | null>(null)
const renaming = ref(false)
const renameError = ref<string | null>(null)
function openRename(i: FreeInstance) {
  renameTarget.value = i
  renameError.value = null
  renameOpen.value = true
}
async function onRenameSubmit(name: string) {
  const i = renameTarget.value
  if (!i) return
  renaming.value = true
  renameError.value = null
  try {
    await freeApi.rename(i.id, name)
    toast.success(t('freeInstances.toastRenamed'))
    renameOpen.value = false
    renameTarget.value = null
    await refreshFree()
  } catch (e) {
    renameError.value = e instanceof Error ? e.message : t('freeInstances.renameFailed')
  } finally {
    renaming.value = false
  }
}

// The host reads these through a ref: visibleCount feeds its heading count (the rows actually drawn,
// filter included), total the toggle's count, hiddenByFilter its filter note.
const visibleCount = computed(() => visibleRows.value.length)
const total = computed(() => instances.value.length)
defineExpose({
  openCreate,
  createOptions,
  refresh: refreshAccounts,
  refreshing,
  hiddenByFilter,
  visibleCount,
  total,
  loading,
})
</script>

<template>
  <TableBody v-if="visibleRows.length > 0">
    <InstanceRow
      v-for="inst in visibleRows"
      :key="inst.id"
      :columns="columns"
      :row="rowModels.get(inst.id)!"
    >
      <template #name-extra>
        <!-- The last operation failed: what the harness said, on the row it belongs to. -->
        <IconTooltip
          v-if="errors[inst.id]"
          :label="$t('freeInstances.failed')"
          :description="errors[inst.id]"
        >
          <span class="inline-flex items-center" :aria-label="$t('freeInstances.failed')">
            <TriangleAlert class="size-3.5 text-destructive" />
          </span>
        </IconTooltip>
      </template>
      <!-- The row's one primary action, as Open is on a desktop row. -->
      <template #primary>
        <IconTooltip :label="$t('freeInstances.newChat')" :description="$t('freeInstances.chatLocation')">
          <Button
            variant="outline"
            size="icon-sm"
            :aria-label="$t('freeInstances.newChatShort')"
            :disabled="!inst.loggedIn || busy(inst.id)"
            @click="openFreeThread(inst.id)"
          >
            <MessagesSquare />
          </Button>
        </IconTooltip>
      </template>
      <template #menu>
        <DropdownMenuItem v-if="runningOf(inst, 'login')" @click="cancelSignIn(inst)">
          <X /> {{ $t('freeInstances.cancelSignIn') }}
        </DropdownMenuItem>
        <!-- Only while signed out; "again" once this login has been signed in before. -->
        <DropdownMenuItem
          v-else-if="!inst.loggedIn"
          :disabled="busy(inst.id)"
          @click="signIn(inst)"
        >
          <LogIn />
          {{ $t(inst.lastSignedInAt ? 'freeInstances.signInAgain' : 'freeInstances.login') }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="busy(inst.id)" @click="checkByHand(inst)">
          <HeartPulse /> {{ $t('freeInstances.isAlive') }}
        </DropdownMenuItem>
        <!-- The page lost track of a running operation: look it up rather than send again. -->
        <DropdownMenuItem
          v-if="errors[inst.id] && jobs[inst.id]?.state === 'running'"
          @click="recover(inst.id)"
        >
          <SearchCheck /> {{ $t('freeInstances.recover') }}
        </DropdownMenuItem>
      </template>
    </InstanceRow>
  </TableBody>

  <!-- The dialogs teleport to <body>, so sitting beside the rows puts nothing inside the tbody. -->
  <LogoutInstanceDialog
    v-model:open="logoutOpen"
    :instance-name="logoutTarget?.name ?? null"
    :account-email="null"
    :description="$t('freeInstances.logoutDialogDescription')"
    :submitting="loggingOut"
    @confirm="onLogoutConfirm"
  />
  <DeleteInstanceDialog
    v-model:open="deleteOpen"
    namespace="freeInstances"
    :instance-name="deleteTarget?.name ?? null"
    :submitting="deleting"
    :error-message="deleteError"
    @confirm="onDeleteConfirm"
  />
  <CliInstanceNameDialog
    v-model:open="renameOpen"
    mode="rename"
    namespace="freeInstances"
    :current-name="renameTarget?.name ?? null"
    :submitting="renaming"
    :error-message="renameError"
    @submit="onRenameSubmit"
  />
</template>
