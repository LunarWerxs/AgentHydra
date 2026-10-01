<script setup lang="ts">
// DeepSeek Harness instances as rows of the combined Instances table: one DSH_HOME per row.
//
// Rows only: the table, its header, its empty state and the provider filter belong to
// InstancesView, and every row here renders that table's ten cells in its order, in both modes. A
// DeepSeek account IS a home (credentials, settings, plugin profiles and every conversation live
// under one root), so most of the ten are facts it does not have: no signed-in account, no process
// this row owns, and no quota, because the harness bills a pay-as-you-go API key with no 5-hour or
// weekly window. Those cells say so with a dash rather than standing empty.
//
// ⛔ The SPA never sees a server's URL. `dsh web` prints a one-time `?token=` that is the whole of
// its authentication, so "launch" and "open" are daemon actions that open the window on the machine
// the daemon runs on and answer with an outcome. See server/src/core/dsh-instances.ts.
import { Copy, EllipsisVertical, Pencil, Play, Square, Trash2 } from '@lucide/vue'
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import InstanceMenuHeader, { type MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import ProviderLogo from '@/components/ProviderLogo.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TableCell, TableRow } from '@/components/ui/table'
import { useDshInstances } from '@/composables/useDshInstances'
import {
  createDshInstance,
  type DshInstance,
  deleteDshInstance,
  launchDshInstance,
  quitDshInstance,
  renameDshInstance,
} from '@/lib/api'

defineProps<{ usageMode: boolean }>()

const { t } = useI18n()
const { instances, refresh, startPolling, stopPolling } = useDshInstances()

/** The id of whatever action is in flight, so one row's button can be busy without freezing the
 *  table: a launch legitimately takes seconds (the harness prints its address only once serving). */
const busyId = ref<string | null>(null)

/** The status dot's hover: whether a server answers for this home, and on which port. */
function statusTitle(inst: DshInstance): string {
  if (!inst.running) return t('dshInstances.stopped')
  return inst.port
    ? t('dshInstances.runningOnPort', { port: inst.port })
    : t('dshInstances.running')
}

/** The full name as a hover only when the column actually cut it, so a name shown whole does not
 *  sprout a box repeating itself. */
function titleIfClipped(event: PointerEvent, text: string): void {
  const el = event.currentTarget as HTMLElement
  el.title = el.scrollWidth > el.clientWidth ? text : ''
}

/** Run one action, then re-read: every verb here changes something the list reports (a port, a
 *  running flag, a row), so the table would otherwise be stale exactly when it is being watched. */
async function act(id: string, fn: () => Promise<{ ok: boolean; message: string | null }>) {
  busyId.value = id
  try {
    const result = await fn()
    if (result.ok) toast.success(result.message ?? '')
    else toast.error(result.message ?? '')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  } finally {
    busyId.value = null
    await refresh()
  }
}

// The three lifecycle verbs go through the SAME dialogs the CLI and Codex tables use (one name
// input, one type-the-name delete), not through window.prompt: this app has exactly one native
// prompt in it, in the tray's quick window, and a second one in the main Instances view would look
// like a different program. `namespace` is what points those dialogs at this table's own copy.
const nameDialog = ref<{ mode: 'create' | 'rename'; target: DshInstance | null } | null>(null)
const deleteTarget = ref<DshInstance | null>(null)
const submitting = ref(false)
const dialogError = ref<string | null>(null)

function openCreate(): void {
  dialogError.value = null
  nameDialog.value = { mode: 'create', target: null }
}

function openRename(inst: DshInstance): void {
  dialogError.value = null
  nameDialog.value = { mode: 'rename', target: inst }
}

/** The icon row at the top of a row's ⋯ menu. The default home is the machine's own install and
 *  keeps its name, so it has no quick actions of its own (Copy number is always there). */
function menuActionsFor(inst: DshInstance): MenuIconAction[] {
  if (inst.isDefault) return []
  return [
    {
      key: 'rename',
      icon: Pencil,
      label: t('dshInstances.rename'),
      closes: true,
      run: () => openRename(inst),
    },
  ]
}

async function onNameSubmit(name: string): Promise<void> {
  const dialog = nameDialog.value
  if (!dialog) return
  submitting.value = true
  dialogError.value = null
  try {
    const result =
      dialog.mode === 'create'
        ? await createDshInstance(name)
        : await renameDshInstance(dialog.target?.id ?? '', name)
    if (!result.ok) {
      // Kept IN the dialog rather than thrown as a toast: the input the person typed is still on
      // screen and the message is about that input ("a name like that already exists").
      dialogError.value = result.message
      return
    }
    toast.success(result.message ?? '')
    nameDialog.value = null
    await refresh()
  } catch (err) {
    dialogError.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

async function onDeleteConfirm(typed: string): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  submitting.value = true
  dialogError.value = null
  try {
    const result = await deleteDshInstance(target.id, { deleteFiles: true, confirmName: typed })
    if (!result.ok) {
      dialogError.value = result.message
      return
    }
    toast.success(result.message ?? '')
    deleteTarget.value = null
    await refresh()
  } catch (err) {
    dialogError.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

/** Forget an instance WITHOUT touching its files — the reversible half of delete, so it needs no
 *  type-the-name gate. The toast says where the home still is. */
async function onRemove(inst: DshInstance): Promise<void> {
  await act(inst.id, () => deleteDshInstance(inst.id))
}

async function copyHome(inst: DshInstance): Promise<void> {
  try {
    await navigator.clipboard.writeText(inst.home)
    toast.success(t('dshInstances.copied'))
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(startPolling)
onUnmounted(stopPolling)

defineExpose({ openCreate, refresh })
</script>

<template>
  <TableRow v-for="inst in instances" :key="inst.id">
    <!-- 1 status: one dot, same size and colours as the Codex and CLI rows; the words and the port
         are its hover. -->
    <TableCell>
      <span
        role="img"
        class="inline-block size-2 rounded-full"
        :class="inst.running ? 'bg-success' : 'bg-muted-foreground/40'"
        :title="statusTitle(inst)"
        :aria-label="statusTitle(inst)"
      />
    </TableCell>
    <!-- 2 name: max-w-0 so a long name or home elides instead of widening the table. -->
    <TableCell class="max-w-0">
      <div class="flex min-w-0 items-center gap-1.5 font-medium">
        <ProviderLogo provider="deepseek" class="size-3.5" />
        <!-- Same chip as every other instance row: the number comes from ONE sequence spanning
             all four families, so it has to look identical everywhere. -->
        <InstanceNumber :num="inst.num" />
        <span class="min-w-0 truncate" @pointerenter="titleIfClipped($event, inst.name)">{{ inst.name }}</span>
        <Badge
          v-if="inst.isDefault"
          variant="outline"
          class="shrink-0"
          :title="$t('dshInstances.defaultHint')"
        >
          {{ $t('dshInstances.defaultBadge') }}
        </Badge>
      </div>
      <div class="flex min-w-0 items-center gap-1 text-3xs text-muted-foreground">
        <span class="mono min-w-0 truncate" :title="inst.home">{{ inst.home }}</span>
        <span class="shrink-0" aria-hidden="true">·</span>
        <span class="shrink-0">{{
          $t('dshInstances.sessionCount', { count: inst.sessions }, inst.sessions)
        }}</span>
      </div>
    </TableCell>
    <!-- 3 account: a home is signed in with an API key, not an account with a name. -->
    <TableCell><span class="text-xs text-muted-foreground">—</span></TableCell>
    <!-- 4-6 PID, Uptime, Memory: the list reports whether a server answers for the home, not which
         process it is. -->
    <template v-if="!usageMode">
      <TableCell><span class="text-xs text-muted-foreground">—</span></TableCell>
      <TableCell><span class="text-xs text-muted-foreground">—</span></TableCell>
      <TableCell><span class="text-xs text-muted-foreground">—</span></TableCell>
    </template>
    <!-- 4-6 Session (5h), Weekly, 5-hour usage: pay-as-you-go has no window to fill. -->
    <template v-else>
      <TableCell>
        <span class="text-xs text-muted-foreground" :title="$t('dshInstances.noQuota')">—</span>
      </TableCell>
      <TableCell>
        <span class="text-xs text-muted-foreground" :title="$t('dshInstances.noQuota')">—</span>
      </TableCell>
      <TableCell>
        <span class="text-xs text-muted-foreground" :title="$t('dshInstances.noQuota')">—</span>
      </TableCell>
    </template>
    <!-- 7 usage -->
    <TableCell>
      <span class="text-xs text-muted-foreground" :title="$t('dshInstances.noQuota')">—</span>
    </TableCell>
    <!-- 8 plan -->
    <TableCell>
      <span class="text-xs text-muted-foreground" :title="$t('dshInstances.noQuota')">{{
        $t('dshInstances.planApiKey')
      }}</span>
    </TableCell>
    <!-- 9 last running: "Now" while its server runs; the list keeps no record of when it last did. -->
    <TableCell>
      <span v-if="inst.running" class="text-xs text-success">{{ $t('instances.lastRunningNow') }}</span>
      <span v-else class="text-xs text-muted-foreground">—</span>
    </TableCell>
    <!-- 10 actions -->
    <TableCell class="text-end">
      <div class="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="outline"
          :disabled="busyId === inst.id"
          :title="inst.running ? $t('dshInstances.openHint') : $t('dshInstances.launchHint')"
          @click="act(inst.id, () => launchDshInstance(inst.id))"
        >
          <Play class="size-3.5" />
          {{
            busyId === inst.id
              ? $t('dshInstances.launching')
              : inst.running
                ? $t('dshInstances.open')
                : $t('dshInstances.launch')
          }}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="sm" :aria-label="$t('dshInstances.moreActions')">
              <EllipsisVertical class="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <InstanceMenuHeader :num="inst.num" :actions="menuActionsFor(inst)" />
            <DropdownMenuItem
              v-if="inst.running"
              :title="$t('dshInstances.quitHint')"
              @select="act(inst.id, () => quitDshInstance(inst.id))"
            >
              <Square />{{ $t('dshInstances.quit') }}
            </DropdownMenuItem>
            <DropdownMenuItem @select="copyHome(inst)">
              <Copy />{{ $t('dshInstances.copyHome') }}
            </DropdownMenuItem>
            <!-- The default home is the machine's own install: it can be read and launched, never
                 removed or deleted from here. -->
            <template v-if="!inst.isDefault">
              <DropdownMenuItem :title="$t('dshInstances.removeHint')" @select="onRemove(inst)">
                <Trash2 />{{ $t('dshInstances.remove') }}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" @select="deleteTarget = inst">
                <Trash2 />{{ $t('dshInstances.delete') }}
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TableCell>
  </TableRow>

  <!-- Both dialogs portal to the body, so sitting beside the rows inside the table's body is safe. -->
  <CliInstanceNameDialog
    :open="nameDialog !== null"
    namespace="dshInstances"
    :mode="nameDialog?.mode ?? 'create'"
    :current-name="nameDialog?.target?.name ?? null"
    :submitting="submitting"
    :error-message="dialogError"
    @update:open="(v) => { if (!v) nameDialog = null }"
    @submit="onNameSubmit"
  />
  <DeleteInstanceDialog
    :open="deleteTarget !== null"
    namespace="dshInstances"
    :instance-name="deleteTarget?.name ?? null"
    :submitting="submitting"
    :error-message="dialogError"
    @update:open="(v) => { if (!v) deleteTarget = null }"
    @confirm="onDeleteConfirm"
  />
</template>
