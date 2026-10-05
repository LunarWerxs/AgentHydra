<script setup lang="ts">
// DeepSeek Harness instances as rows of the combined Instances table: one DSH_HOME per row.
//
// Rows only: the table, its header, its empty state and the provider filter belong to
// InstancesView, and every row here is the shared InstanceRow drawing that table's columns. A
// DeepSeek account IS a home (credentials, settings, plugin profiles and every conversation live
// under one root), so most of the ten are facts it does not have: no signed-in account, no process
// this row owns, and no quota, because the harness bills a pay-as-you-go API key with no 5-hour or
// weekly window. Those cells say so with a dash rather than standing empty.
//
// ⛔ The SPA never sees a server's URL. `dsh web` prints a one-time `?token=` that is the whole of
// its authentication, so "launch" and "open" are daemon actions that open the window on the machine
// the daemon runs on and answer with an outcome. See server/src/core/dsh-instances.ts.
import { Copy, Pencil, Play, Square, Trash2 } from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import type { MenuIconAction } from '@/components/InstanceMenuHeader.vue'
import InstanceRow from '@/components/InstanceRow.vue'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useDshInstances } from '@/composables/useDshInstances'
import { pii } from '@/composables/usePrivacy'
import {
  createDshInstance,
  type DshInstance,
  deleteDshInstance,
  launchDshInstance,
  quitDshInstance,
  renameDshInstance,
} from '@/lib/api'
import { shortDisplayName } from '@/lib/instance-appearance'
import type { InstanceColumn, InstanceRowModel } from '@/lib/instance-table'

// The table's column list (lib/instance-table.ts): the one the header draws, so the cells follow it.
defineProps<{ columns: InstanceColumn[] }>()

const { t } = useI18n()
const { instances, refresh, startPolling } = useDshInstances()

/** The id of whatever action is in flight, so one row's button can be busy without freezing the
 *  table: a launch legitimately takes seconds (the harness prints its address only once serving). */
const busyIds = shallowRef<Set<string>>(new Set())
function setBusy(id: string, on: boolean) {
  const next = new Set(busyIds.value)
  if (on) next.add(id)
  else next.delete(id)
  busyIds.value = next
}

/** The status dot's hover: whether a server answers for this home, and on which port. */
function statusTitle(inst: DshInstance): string {
  if (!inst.running) return t('dshInstances.stopped')
  return inst.port
    ? t('dshInstances.runningOnPort', { port: inst.port })
    : t('dshInstances.running')
}

/** Run one action, then re-read: every verb here changes something the list reports (a port, a
 *  running flag, a row), so the table would otherwise be stale exactly when it is being watched. */
async function act(id: string, fn: () => Promise<{ ok: boolean; message: string | null }>) {
  setBusy(id, true)
  try {
    const result = await fn()
    if (result.ok) toast.success(result.message ?? '')
    else toast.error(result.message ?? '')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  } finally {
    setBusy(id, false)
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

/** What the shared row draws for one DeepSeek home. Most of the columns are facts a home does not
 *  have, so they are left out of the model and the row says so with a dash: a home is signed in with
 *  an API key, not an account; the list reports whether a server answers for it, not which process
 *  it is; and pay-as-you-go has no 5-hour or weekly window to fill. */
function rowModel(inst: DshInstance): InstanceRowModel {
  return {
    id: inst.id,
    num: inst.num,
    provider: 'deepseek',
    status: { on: inst.running, title: statusTitle(inst) },
    glyph: { dir: inst.home, running: inst.running },
    // The home and its chat count are the hover, the same place the Claude rows keep their profile
    // folder, so every row is one line tall.
    name: {
      shown: shortDisplayName(pii(inst.name)),
      tooltip: () => ({
        label: inst.name,
        description: inst.home,
        detail: t('dshInstances.sessionCount', { count: inst.sessions }, inst.sessions),
      }),
    },
    // The machine's own install, badged like the Claude rows' External one.
    badge: inst.isDefault
      ? { label: t('dshInstances.defaultBadge'), title: t('dshInstances.defaultHint') }
      : undefined,
    account: {},
    noQuota: t('dshInstances.noQuota'),
    plan: { label: t('dshInstances.planApiKey'), plain: true, title: t('dshInstances.noQuota') },
    // "Now" while its server runs; the list keeps no record of when it last did.
    lastRunning: inst.running ? { label: t('instances.lastRunningNow'), running: true } : null,
    menu: { name: inst.name, actions: menuActionsFor(inst) },
  }
}

// Built once per data change, so a row whose instance did not change keeps the same model and does not redraw.
const rowModels = computed(() => new Map(instances.value.map((inst) => [inst.id, rowModel(inst)])))

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

defineExpose({ openCreate, refresh })
</script>

<template>
  <InstanceRow v-for="inst in instances" :key="inst.id" :columns="columns" :row="rowModels.get(inst.id)!">
    <template #primary>
      <Button
        size="sm"
        variant="outline"
        :disabled="busyIds.has(inst.id)"
        :title="inst.running ? $t('dshInstances.openHint') : $t('dshInstances.launchHint')"
        @click="act(inst.id, () => launchDshInstance(inst.id))"
      >
        <Play class="size-3.5" />
        {{
          busyIds.has(inst.id)
            ? $t('dshInstances.launching')
            : inst.running
              ? $t('dshInstances.open')
              : $t('dshInstances.launch')
        }}
      </Button>
    </template>
    <template #menu>
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
    </template>
  </InstanceRow>

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
