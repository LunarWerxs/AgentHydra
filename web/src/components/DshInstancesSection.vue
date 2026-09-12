<script setup lang="ts">
// DeepSeek Harness instances: one DSH_HOME per row.
//
// A DeepSeek account IS a home — credentials, settings, plugin profiles and every conversation live
// under one root — so this table is the same shape as the Codex one above it, minus everything that
// only makes sense for a subscription. There are no usage or plan columns because the harness bills
// a pay-as-you-go API key: there is no 5-hour or weekly window to report, and an empty quota column
// would invite a question with no answer.
//
// ⛔ The SPA never sees a server's URL. `dsh web` prints a one-time `?token=` that is the whole of
// its authentication, so "launch" and "open" are daemon actions that open the window on the machine
// the daemon runs on and answer with an outcome. See server/src/core/dsh-instances.ts.
import {
  ChevronDown,
  Copy,
  EllipsisVertical,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from '@lucide/vue'
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import DeleteCliInstanceDialog from '@/components/DeleteCliInstanceDialog.vue'
import ExpandArea from '@/components/ExpandArea.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  createDshInstance,
  type DshInstance,
  deleteDshInstance,
  launchDshInstance,
  listDshInstances,
  quitDshInstance,
  renameDshInstance,
} from '@/lib/api'

const { t } = useI18n()

const instances = ref<DshInstance[]>([])
const loading = ref(true)
const open = ref(true)
/** The id of whatever action is in flight, so one row's button can be busy without freezing the
 *  table: a launch legitimately takes seconds (the harness prints its address only once serving). */
const busyId = ref<string | null>(null)
let timer: number | undefined

async function refresh(): Promise<void> {
  try {
    instances.value = await listDshInstances()
  } catch {
    // A failed poll leaves the last good list on screen: a table that empties itself on one dropped
    // request reads as "your instances are gone".
  } finally {
    loading.value = false
  }
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

onMounted(() => {
  void refresh()
  // Slow on purpose: nothing here changes without a person doing something, and the only live fact
  // (is a server up) costs a connect probe per home.
  timer = window.setInterval(() => void refresh(), 15_000)
})
onUnmounted(() => window.clearInterval(timer))
</script>

<template>
  <div class="mt-6">
    <div class="mb-2 flex items-center gap-2">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-1.5 font-medium text-sm"
        @click="open = !open"
      >
        <ChevronDown class="size-4 transition-transform" :class="open ? '' : '-rotate-90'" />
        {{ $t('dshInstances.title') }}
        <span class="text-muted-foreground text-xs">({{ instances.length }})</span>
      </button>
      <div class="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" :aria-label="$t('dshInstances.refresh')" @click="refresh">
          <RefreshCw class="size-3.5" />
        </Button>
        <Button size="sm" @click="openCreate">
          <Plus class="size-3.5" />{{ $t('dshInstances.createInstance') }}
        </Button>
      </div>
    </div>

    <ExpandArea :open="open">
      <Table>
        <TableHeader>
          <TableRow>
            <!-- Same fixed widths as the three tables above, which is what keeps the stack aligned. -->
            <TableHead class="w-44">{{ $t('dshInstances.colName') }}</TableHead>
            <TableHead class="w-40">{{ $t('dshInstances.colStatus') }}</TableHead>
            <TableHead class="w-24">{{ $t('dshInstances.colSessions') }}</TableHead>
            <TableHead>{{ $t('dshInstances.colHome') }}</TableHead>
            <TableHead class="text-right">{{ $t('dshInstances.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody v-if="instances.length === 0">
          <TableEmpty v-if="!loading" :colspan="5">
            <div class="flex flex-col items-center gap-1 text-center">
              <p class="font-medium text-foreground">{{ $t('dshInstances.empty') }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('dshInstances.emptyHint') }}</p>
            </div>
          </TableEmpty>
          <TableRow v-for="i in 2" v-else :key="i">
            <TableCell><Skeleton class="h-4 w-28" /></TableCell>
            <TableCell><Skeleton class="h-5 w-20" /></TableCell>
            <TableCell><Skeleton class="h-3 w-8" /></TableCell>
            <TableCell><Skeleton class="h-3 w-56" /></TableCell>
            <TableCell><div class="flex justify-end"><Skeleton class="h-6 w-20" /></div></TableCell>
          </TableRow>
        </TableBody>
        <TableBody v-else>
          <TableRow v-for="inst in instances" :key="inst.id">
            <TableCell class="font-medium">
              <!-- Same chip as every other instance table: the number comes from ONE sequence
                   spanning all four families, so it has to look identical everywhere. -->
              <div class="flex items-center gap-1.5">
                <InstanceNumber :num="inst.num" />
                <span>{{ inst.name }}</span>
                <Badge v-if="inst.isDefault" variant="outline" :title="$t('dshInstances.defaultHint')">
                  {{ $t('dshInstances.defaultBadge') }}
                </Badge>
              </div>
            </TableCell>
            <TableCell>
              <span class="inline-flex items-center gap-1.5 text-xs">
                <span
                  class="inline-block size-2 rounded-full"
                  :class="inst.running ? 'bg-success' : 'bg-muted-foreground/40'"
                />
                {{ inst.running ? $t('dshInstances.running') : $t('dshInstances.stopped') }}
                <span v-if="inst.running && inst.port" class="text-muted-foreground">
                  {{ $t('dshInstances.port', { port: inst.port }) }}
                </span>
              </span>
            </TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ inst.sessions }}</TableCell>
            <TableCell class="mono max-w-[20rem] truncate text-[0.625rem] text-muted-foreground" :title="inst.home">
              {{ inst.home }}
            </TableCell>
            <TableCell>
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
                    <DropdownMenuItem
                      v-if="inst.running"
                      :title="$t('dshInstances.quitHint')"
                      @select="act(inst.id, () => quitDshInstance(inst.id))"
                    >
                      <Square />{{ $t('dshInstances.quit') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="!inst.isDefault" @select="openRename(inst)">
                      <Pencil />{{ $t('dshInstances.rename') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem @select="copyHome(inst)">
                      <Copy />{{ $t('dshInstances.copyHome') }}
                    </DropdownMenuItem>
                    <!-- The default home is the machine's own install: it can be read and launched,
                         never removed or deleted from here. -->
                    <template v-if="!inst.isDefault">
                      <DropdownMenuItem
                        :title="$t('dshInstances.removeHint')"
                        @select="onRemove(inst)"
                      >
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
        </TableBody>
      </Table>
    </ExpandArea>

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
    <DeleteCliInstanceDialog
      :open="deleteTarget !== null"
      namespace="dshInstances"
      :instance-name="deleteTarget?.name ?? null"
      :submitting="submitting"
      :error-message="dialogError"
      @update:open="(v) => { if (!v) deleteTarget = null }"
      @confirm="onDeleteConfirm"
    />
  </div>
</template>
