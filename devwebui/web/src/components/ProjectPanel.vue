<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useLocalStorage } from "@vueuse/core";
import { toast } from "vue-sonner";
import {
  Boxes,
  ChevronDown,
  EllipsisVertical,
  Loader2,
  MonitorDown,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "@lucide/vue";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { storeToRefs } from "pinia";
import ProcessCard from "./ProcessCard.vue";
import ProcessTable from "./ProcessTable.vue";
import IconButton from "./IconButton.vue";
import TakeoverStep from "./add-project-dialog/TakeoverStep.vue";
import { disableProject, enableProject, startProject, stopProject } from "@/api";
import type { AutostartTrigger, TakeOverResult } from "@/api";
import { useAppStore } from "@/store";
import { useRunAction } from "@/lib/useAction";
import { useShortcutAction } from "@/lib/shortcut";
import { useTooltipConfig } from "@/lib/tooltip-config";
import { statusPill } from "@/lib/severity";
import { arrangeProcesses } from "@/lib/arrange";
import { fuzzySearch } from "@/lib/fuzzy";
import type { ProcessView, ProjectView } from "@/types";

const { t } = useI18n({ useScope: "global" });
const { enabled: tooltipsEnabled } = useTooltipConfig();

const props = defineProps<{ project: ProjectView }>();
const emit = defineEmits<{
  logs: [id: string];
  addProcess: [projectId: string];
  editProcess: [projectId: string, process: ProcessView];
  errorsProcess: [processId: string];
}>();

// Remember each project's collapsed state so a screen full of codebases stays tidy.
const open = useLocalStorage(`devwebui.collapsed.${props.project.id}.v2`, true);
function onOpen(v: boolean) {
  open.value = v;
}

const store = useAppStore();
const { viewMode, sortKey, sortDir, statusFilter, now, searchQuery } = storeToRefs(store);

const running = computed(
  () => props.project.processes.filter((p) => p.status === "running").length,
);
const total = computed(() => props.project.processes.length);

// The stack master switch (project.enabled) GATES the whole project's autostart
// without touching the individual per-process toggles. It's a preference only —
// flipping it never starts/stops anything now. Off collapses the stack; on re-expands it.
// The local collapse state is applied only once the daemon call actually succeeds —
// otherwise a failed toggle left the panel open/closed out of step with the real
// (unchanged) `project.enabled`, with no way to tell short of reloading.
async function onToggleStack(v: boolean) {
  try {
    await (v ? enableProject(props.project.id) : disableProject(props.project.id));
    onOpen(v);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("projectPanel.actionFailed"));
  }
}

/**
 * True when the project's own name fuzzy-matches the toolbar search (blank search always
 * matches). "path" scheme: a project name is usually its folder name.
 */
const projectNameMatches = computed(() => {
  const q = searchQuery.value.trim();
  return !q || fuzzySearch(props.project.name, q, "path") !== null;
});

// Filtered + sorted once here; both the card grid and the table render this list.
// `now` is only read while actually sorting by uptime — arrangeProcesses ignores it
// otherwise, so this computed doesn't reallocate on every 1s clock tick for nothing.
const arranged = computed(() =>
  arrangeProcesses(props.project.processes, {
    sortKey: sortKey.value,
    sortDir: sortDir.value,
    statusFilter: statusFilter.value,
    now: sortKey.value === "uptime" ? now.value : 0,
    // A matching project name already explains why this panel is visible — don't
    // ALSO require every individual process to match the same text.
    search: projectNameMatches.value ? "" : searchQuery.value,
  }),
);
// True when the project has processes but the active filter hides them all.
const filteredEmpty = computed(() => total.value > 0 && arranged.value.length === 0);
// The toolbar search hides the whole panel (rather than showing "no processes match" —
// that message stays reserved for the status filter) when neither the project's own
// name nor any of its processes match what was typed.
const hiddenBySearch = computed(
  () => !!searchQuery.value.trim() && !projectNameMatches.value && arranged.value.length === 0,
);

const removeDialogOpen = ref(false);
async function doRemove() {
  removeDialogOpen.value = false;
  await runAction(() => store.removeProject(props.project.id));
}

// ---- Edit project (rename + accent color) ----
const editDialogOpen = ref(false);
const editName = ref("");
const editColor = ref("");
const editError = ref("");
const editSaving = ref(false);

function openEditDialog() {
  editName.value = props.project.name;
  editColor.value = props.project.color ?? "";
  editError.value = "";
  editDialogOpen.value = true;
}

function onEditColorPick(e: Event) {
  editColor.value = (e.target as HTMLInputElement).value;
}

async function saveEdit() {
  const name = editName.value.trim();
  if (!name) {
    editError.value = t("projectPanel.editNameRequired");
    return;
  }
  editSaving.value = true;
  editError.value = "";
  try {
    const res = await store.updateProject(props.project.id, {
      name,
      color: editColor.value.trim() || undefined,
    });
    if (res?.error) {
      editError.value = res.error;
      return;
    }
    editDialogOpen.value = false;
  } catch (e) {
    editError.value = e instanceof Error ? e.message : t("projectPanel.actionFailed");
  } finally {
    editSaving.value = false;
  }
}

const runAction = useRunAction("projectPanel.actionFailed");
const { addProjectShortcut } = useShortcutAction();

// ---- Re-check for external autostart conflicts (VS Code tasks.json / the Vite
// extension). Take-over is otherwise offered exactly once, automatically, right when
// a project is added (AddProjectDialog's take-over step), and can never be revisited —
// a task can reappear later (re-scaffolded .devwebui, a fresh VS Code workspace) with
// no way back in. This reuses that same TakeoverStep.vue, but skips straight to its
// result view: POST take-over first, then show what it found/retired.
const takeoverCheckOpen = ref(false);
const takeoverCheck = ref<{
  dir: string;
  triggers: AutostartTrigger[];
  result?: TakeOverResult;
} | null>(null);
const takeoverBusy = ref(false);
const takeoverError = ref("");

async function checkAutostart() {
  // project.path is the .devwebui FILE; take-over operates on the folder holding it
  // (same derivation AppShell.vue uses for `loadedDirs`).
  const dir = props.project.path.replace(/[\\/][^\\/]+$/, "");
  takeoverError.value = "";
  takeoverCheck.value = null;
  takeoverBusy.value = true;
  takeoverCheckOpen.value = true;
  try {
    const result = await store.takeOverAutostart(dir);
    takeoverCheck.value = { dir, triggers: [], result };
  } catch (e) {
    takeoverError.value = e instanceof Error ? e.message : t("projectPanel.actionFailed");
  } finally {
    takeoverBusy.value = false;
  }
}
</script>

<template>
  <!-- The panel's frame lives on this plain wrapper: the Collapsible owns its shape. -->
  <div v-if="!hiddenBySearch" class="overflow-hidden rounded-xl border border-border bg-card/40">
    <Collapsible :open="open" @update:open="onOpen">
      <div class="flex items-center gap-2 px-2.5 py-3 sm:px-4">
        <CollapsibleTrigger as-child>
          <button
            type="button"
            class="group -mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-0.5 text-start outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring active:opacity-60"
            :aria-label="t('projectPanel.triggerAriaLabel', { name: project.name, running, total, action: open ? t('projectPanel.collapse') : t('projectPanel.expand') })"
          >
            <ChevronDown
              class="size-4 shrink-0 text-muted-foreground transition-transform"
              :class="open ? '' : '-rotate-90'"
            />
            <Boxes
              class="size-4.5 shrink-0"
              :class="project.enabled ? 'text-(--project-color)' : 'text-muted-foreground'"
              :style="{ '--project-color': project.color || 'var(--primary)' }"
            />
            <span class="truncate font-semibold" :class="project.enabled ? '' : 'text-muted-foreground'">
              {{ project.name }}
            </span>
            <Badge
              aria-hidden="true"
              :variant="running > 0 ? statusPill('running').variant : 'outline'"
            >
              <span :class="running > 0 ? '' : 'text-muted-foreground'">{{ running }}/{{ total }}</span>
            </Badge>
          </button>
        </CollapsibleTrigger>

        <div v-auto-animate class="flex shrink-0 items-center gap-1">
          <Switch
            :model-value="project.enabled"
            class="me-1"
            :aria-label="project.enabled ? t('projectPanel.disableStack', { name: project.name }) : t('projectPanel.enableStack', { name: project.name })"
            :title="tooltipsEnabled ? (project.enabled ? t('projectPanel.stackOnTitle') : t('projectPanel.stackOffTitle')) : undefined"
            @update:model-value="onToggleStack"
          />
          <IconButton v-if="open" :tooltip="t('projectPanel.startAll')" @click="runAction(() => startProject(project.id))">
            <Play class="size-4 text-success" />
          </IconButton>
          <IconButton v-if="open" :tooltip="t('projectPanel.stopAll')" @click="runAction(() => stopProject(project.id))">
            <Square class="size-4" />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="t('projectPanel.moreActions')">
                <EllipsisVertical class="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="max-w-44">
              <DropdownMenuItem @select="openEditDialog">
                <Pencil class="size-4" /> {{ t("projectPanel.editProject") }}
              </DropdownMenuItem>
              <DropdownMenuItem @select="emit('addProcess', project.id)">
                <Plus class="size-4" /> {{ t("projectPanel.addProcess") }}
              </DropdownMenuItem>
              <DropdownMenuItem @select="addProjectShortcut(project.id)">
                <MonitorDown class="size-4" /> {{ t("shortcut.addToDesktop") }}
              </DropdownMenuItem>
              <DropdownMenuItem @select="checkAutostart">
                <ShieldCheck class="size-4" /> {{ t("projectPanel.checkAutostart") }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="removeDialogOpen = true">
                <Trash2 class="size-4" /> {{ t("projectPanel.removeProject") }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <CollapsibleContent>
        <!-- A disabled stack dims its contents; the dimming lives on this plain wrapper
             because the CollapsibleContent owns its own effects. -->
        <div :class="project.enabled ? '' : 'opacity-50'">
          <p
            v-if="filteredEmpty"
            class="px-2.5 pb-4 pt-0 text-sm text-muted-foreground sm:px-4"
          >
            {{ t("projectPanel.noProcessesMatch") }}
          </p>
          <!-- pt-1 keeps the first row's top border clear of the CollapsibleContent's
               overflow-hidden edge, which otherwise shaves it at some zoom levels. -->
          <div v-else-if="viewMode === 'table'" class="px-2.5 pb-4 pt-1 sm:px-4">
            <ProcessTable
              :processes="arranged"
              @logs="(p) => emit('logs', p.id)"
              @edit="(p) => emit('editProcess', project.id, p)"
              @errors="(p) => emit('errorsProcess', p.id)"
            />
          </div>
          <div v-else class="grid grid-cols-1 gap-4 px-2.5 pb-4 pt-1 sm:grid-cols-2 sm:px-4">
            <ProcessCard
              v-for="p in arranged"
              :key="p.id"
              :process="p"
              @logs="emit('logs', p.id)"
              @edit="emit('editProcess', project.id, p)"
              @errors="emit('errorsProcess', p.id)"
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  </div>

  <Dialog v-model:open="removeDialogOpen">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t("projectPanel.removeProjectTitle", { name: project.name }) }}</DialogTitle>
        <DialogDescription>
          {{ t("projectPanel.removeProjectDescription", { name: project.name, count: total }, total) }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="removeDialogOpen = false">{{ t("projectPanel.cancel") }}</Button>
        <Button variant="destructive" @click="doRemove">{{ t("projectPanel.removeProject") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="editDialogOpen">
    <DialogContent class="sm:max-w-110" :aria-busy="editSaving">
      <DialogHeader>
        <DialogTitle>{{ t("projectPanel.editProjectTitle") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("projectPanel.editProjectDescription") }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="saveEdit">
        <Alert v-if="editError" variant="destructive">
          <AlertDescription>{{ editError }}</AlertDescription>
        </Alert>

        <div class="flex items-end gap-3">
          <div class="min-w-0 flex-1">
            <Label for="pe-name" class="mb-1.5 block"><span class="text-sm font-normal">{{ t("projectPanel.editNameLabel") }}</span></Label>
            <Input
              id="pe-name"
              v-model="editName"
              :placeholder="t('projectPanel.editNamePlaceholder')"
              :disabled="editSaving"
            />
          </div>
          <div class="shrink-0">
            <Label class="mb-1.5 block"><span class="text-sm font-normal">{{ t("projectPanel.editColorLabel") }}</span></Label>
            <div class="flex items-center gap-1.5">
              <label
                class="relative block size-9 cursor-pointer overflow-hidden rounded-md border border-border bg-(--swatch-color)"
                :style="{ '--swatch-color': editColor || 'var(--primary)' }"
                :title="editColor || t('projectPanel.editColorPick')"
              >
                <input
                  type="color"
                  class="absolute -inset-1 size-[150%] cursor-pointer border-0 bg-transparent p-0"
                  :value="editColor || '#6366f1'"
                  :aria-label="t('projectPanel.editColorPick')"
                  @input="onEditColorPick"
                />
              </label>
              <IconButton
                v-if="editColor"
                type="button"
                variant="ghost"
                size="icon"
                :tooltip="t('projectPanel.editColorReset')"
                @click="editColor = ''"
              >
                <X class="size-4 text-muted-foreground" />
              </IconButton>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" :disabled="editSaving" @click="editDialogOpen = false">
            {{ t("projectPanel.cancel") }}
          </Button>
          <Button type="submit" :disabled="editSaving">{{ t("projectPanel.save") }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="takeoverCheckOpen">
    <DialogContent class="sm:max-w-120">
      <DialogHeader>
        <DialogTitle>{{ t("projectPanel.takeoverCheckTitle") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("projectPanel.takeoverCheckDescription") }}</DialogDescription>
      </DialogHeader>
      <div v-if="takeoverBusy && !takeoverCheck" class="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 class="size-4 animate-spin" /> {{ t("projectPanel.takeoverChecking") }}
      </div>
      <Alert v-else-if="takeoverError" variant="destructive">
        <AlertDescription>{{ takeoverError }}</AlertDescription>
      </Alert>
      <TakeoverStep
        v-else
        v-model:open="takeoverCheckOpen"
        v-model:takeover="takeoverCheck"
        v-model:busy="takeoverBusy"
        v-model:error="takeoverError"
      />
    </DialogContent>
  </Dialog>
</template>
