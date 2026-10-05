<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Bell,
  Boxes,
  Check,
  DownloadCloud,
  EllipsisVertical,
  FolderPlus,
  LayoutGrid,
  ListFilter,
  Loader2,
  Play,
  Power,
  Search,
  Settings,
  Square,
  Table,
  X,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Hint from "@/components/Hint.vue";
import { useTooltipConfig } from "@/lib/tooltip-config";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "vue-sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { shutdownServer, startAll, stopAll } from "@/api";
import { useAppStore } from "@/store";
import { useRunAction } from "@/lib/useAction";
import type { ProcessView, StatusBucket, ViewMode } from "@/types";

const props = defineProps<{ connected: boolean; processes: ProcessView[]; busy?: boolean }>();
const emit = defineEmits<{ add: []; notifications: []; settings: []; scan: [] }>();

const { t } = useI18n({ useScope: "global" });
const { enabled: tooltipsEnabled } = useTooltipConfig();
const store = useAppStore();
const { errors, viewMode, statusFilter, unreadNotifications, searchQuery } = storeToRefs(store);
const running = computed(() => props.processes.filter((p) => p.status === "running").length);
const errorCount = computed(() => errors.value.length);
// Bell badge: errors + unread notifications; red when there are errors, else accent.
const bellCount = computed(() => errorCount.value + unreadNotifications.value);

// Filters live in a modal now (opened from the ⋮ menu) rather than the toolbar.
const filtersOpen = ref(false);
const shuttingDown = ref(false);
const stopAllConfirmOpen = ref(false);
const shutdownConfirmOpen = ref(false);

const statusOptions = computed<{ value: StatusBucket; label: string }[]>(() => [
  { value: "running", label: t("filters.status.running") },
  { value: "busy", label: t("filters.status.busy") },
  { value: "crashed", label: t("filters.status.crashed") },
  { value: "stopped", label: t("filters.status.stopped") },
]);
function setViewMode(v: ViewMode) {
  viewMode.value = v;
}

const runAction = useRunAction("actions.actionFailed");

async function runShutdown() {
  if (shuttingDown.value) return;
  shuttingDown.value = true;
  try {
    await shutdownServer();
    toast.success(t("actions.shuttingDown"));
  } catch (e) {
    shuttingDown.value = false;
    toast.error(e instanceof Error ? e.message : t("actions.shutdownFailed"));
  }
}

// "Stop all" and "Shut down" sat in the same dropdown as harmless items (view toggle,
// filters) and fired instantly — a stray click could take down every dev server or the
// whole daemon. Confirm both; skip the confirm for Stop all when nothing is even running
// (there's nothing destructive to warn about).
function onStopAllClick() {
  if (running.value > 0) stopAllConfirmOpen.value = true;
  else void runAction(stopAll);
}
async function confirmStopAll() {
  stopAllConfirmOpen.value = false;
  await runAction(stopAll);
}
function onShutdownClick() {
  shutdownConfirmOpen.value = true;
}
async function confirmShutdown() {
  shutdownConfirmOpen.value = false;
  await runShutdown();
}

async function updateApp() {
  if (store.updateChecking || store.updateApplying) return;
  try {
    // The explicit menu action bypasses the daemon's 5-minute status cache rather than
    // silently reusing whatever the last background check found (see store.ts).
    const status = await store.checkForUpdateFresh();
    if (!status?.ok) {
      toast.warning(t("actions.updateCheckFailed"), {
        description: status?.reason ?? undefined,
      });
      return;
    }
    if (!status?.updateAvailable) {
      toast(t("actions.updateNone"));
      return;
    }
    if (!status.canApply) {
      toast.warning(t("actions.updateBlocked"), {
        description: status.reason ?? undefined,
      });
      return;
    }
    const result = await store.applyUpdate();
    toast.success(t("actions.updateApplied"), {
      description: result.restartRequired ? t("actions.updateRestart") : undefined,
    });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("actions.updateFailed"));
  }
}
</script>

<template>
  <header class="safe-top sticky top-0 z-20 bg-background/80 backdrop-blur">
    <div class="mx-auto flex max-w-(--container-max) items-center gap-4 px-4 py-3 sm:px-6">
      <div class="flex items-center gap-2.5">
        <div class="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
          <Boxes class="size-5" />
        </div>
        <span class="text-lg font-bold tracking-tight">DevWebUI</span>
      </div>

      <Hint :label="connected ? t('header.statusTooltip.live') : t('header.statusTooltip.offline')">
        <div class="flex items-center gap-1.5 text-sm">
          <span class="relative flex size-2">
            <span
              v-if="connected"
              class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60"
            />
            <span
              class="relative inline-flex size-2 rounded-full"
              :class="connected ? 'bg-success' : 'bg-destructive'"
            />
          </span>
          <span class="font-medium" :class="connected ? 'text-success' : 'text-destructive'">
            {{ connected ? t("header.live") : t("header.offline") }}
          </span>
          <span class="hidden items-center gap-1.5 text-muted-foreground sm:flex">
            <span aria-hidden="true">·</span>
            <i18n-t keypath="header.active" tag="span" scope="global">
              <template #running>
                <span class="font-semibold tabular-nums text-foreground">{{ running }}</span>
              </template>
              <template #total>{{ processes.length }}</template>
            </i18n-t>
          </span>
        </div>
      </Hint>

      <!-- Narrows every project/process by name; the status filter above is separate. -->
      <div class="relative mx-1 hidden items-center md:flex md:w-40 lg:w-56">
        <Search class="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden="true" />
        <Input
          v-model="searchQuery"
          type="search"
          leading="icon-sm"
          :trailing="searchQuery ? 'icon-sm' : 'none'"
          class="h-8"
          :placeholder="t('header.searchPlaceholder')"
          :aria-label="t('header.searchAriaLabel')"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="absolute right-1.5 cursor-pointer rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="t('header.searchClear')"
          @click="searchQuery = ''"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <div class="ms-auto flex items-center gap-2">
        <Button
          size="sm"
          class="group/add h-8 overflow-hidden"
          :disabled="busy"
          :aria-label="t('header.addProject')"
          @click="emit('add')"
        >
          <!-- One flex child, so the Button's own gap never opens beside the collapsed label;
               the label's ms-1.5 supplies the spacing only while it is shown. -->
          <span class="flex items-center">
            <FolderPlus class="size-4 shrink-0" />
            <span
              class="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/add:ms-1.5 group-hover/add:max-w-28 group-hover/add:opacity-100 group-focus-visible/add:ms-1.5 group-focus-visible/add:max-w-28 group-focus-visible/add:opacity-100"
            >{{ t("header.addProject") }}</span>
          </span>
        </Button>

        <Hint :label="errorCount ? t('header.notificationsWithErrors') : t('header.notifications')">
          <Button
            variant="ghost"
            size="icon"
            class="relative"
            :aria-label="bellCount ? t('header.notificationsCount', { count: bellCount }) : t('header.notifications')"
            @click="emit('notifications')"
          >
            <Bell class="size-[1.15rem]" />
            <span
              v-if="bellCount"
              class="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full px-1 text-3xs font-semibold leading-4 text-white ring-2 ring-background"
              :class="errorCount ? 'bg-destructive' : 'bg-primary'"
            >{{ bellCount > 9 ? "9+" : bellCount }}</span>
          </Button>
        </Hint>

        <!-- Dedicated settings gear (family parity with ReDesign/AgentHydra): settings is
             too primary an action to live only inside the ⋮ overflow. Toggles the panel. -->
        <Hint :label="t('actions.settings')">
          <Button
            variant="ghost"
            size="icon"
            :aria-label="t('actions.settings')"
            @click="emit('settings')"
          >
            <Settings class="size-[1.15rem]" />
          </Button>
        </Hint>

        <!-- No Hint here: wrapping a DropdownMenuTrigger in a TooltipTrigger (both
             reka `as-child` triggers that handle pointerdown) swallows the click and
             the menu never opens. A native title is a safe, non-conflicting fallback. -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="relative" :aria-label="t('header.more')" :title="tooltipsEnabled ? t('header.moreTooltip') : undefined">
              <EllipsisVertical class="size-[1.15rem]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-56">
            <!-- View: a single split control — click the side you want active. -->
            <DropdownMenuLabel>{{ t("view.label") }}</DropdownMenuLabel>
            <div class="px-1 pb-1 pt-0.5">
              <!-- Table leads: it's the default view. -->
              <div class="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
                <button
                  type="button"
                  class="flex cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 font-medium transition-colors"
                  :class="viewMode === 'table'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'"
                  :aria-label="t('view.tableView')"
                  :aria-pressed="viewMode === 'table'"
                  @click="setViewMode('table')"
                >
                  <Table class="size-4" /> {{ t("view.table") }}
                </button>
                <button
                  type="button"
                  class="flex cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 font-medium transition-colors"
                  :class="viewMode === 'cards'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'"
                  :aria-label="t('view.cardView')"
                  :aria-pressed="viewMode === 'cards'"
                  @click="setViewMode('cards')"
                >
                  <LayoutGrid class="size-4" /> {{ t("view.cards") }}
                </button>
              </div>
            </div>

            <DropdownMenuSeparator />
            <DropdownMenuItem @select="filtersOpen = true">
              <ListFilter class="size-4" /> {{ t("filters.open") }}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem @select="runAction(startAll)"><Play class="size-4" /> {{ t("actions.startAll") }}</DropdownMenuItem>
            <DropdownMenuItem @select="onStopAllClick"><Square class="size-4" /> {{ t("actions.stopAll") }}</DropdownMenuItem>
            <DropdownMenuItem :disabled="store.updateChecking || store.updateApplying" @select="updateApp">
              <Loader2 v-if="store.updateChecking || store.updateApplying" class="size-4 animate-spin" />
              <DownloadCloud v-else class="size-4" />
              {{ t("actions.checkUpdates") }}
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem @select="emit('scan')">
              <Search class="size-4" /> {{ t("actions.scan") }}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" :disabled="shuttingDown" @select="onShutdownClick">
              <Power class="size-4" /> {{ t("actions.shutdown") }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <!-- Sort & filter, lifted out of the toolbar into a focused modal. -->
    <Dialog v-model:open="filtersOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("filters.title") }}</DialogTitle>
          <DialogDescription>{{ t("filters.description") }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-5 py-1">
          <div class="space-y-2">
            <Label><span class="text-xs uppercase tracking-wide text-muted-foreground">{{ t("filters.showStatus") }}</span></Label>
            <div class="grid grid-cols-2 gap-1.5">
              <button
                v-for="o in statusOptions"
                :key="o.value"
                type="button"
                class="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors"
                :class="statusFilter.includes(o.value)
                  ? 'border-primary/50 bg-primary/5 text-foreground'
                  : 'text-muted-foreground hover:bg-accent'"
                :aria-pressed="statusFilter.includes(o.value)"
                @click="store.toggleStatusFilter(o.value, !statusFilter.includes(o.value))"
              >
                <span>{{ o.label }}</span>
                <Check v-if="statusFilter.includes(o.value)" class="size-4 shrink-0 text-primary" />
              </button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button variant="outline">{{ t("filters.done") }}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Confirm — Stop all (only shown when something is actually running) -->
    <Dialog v-model:open="stopAllConfirmOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ t("actions.confirmStopAllTitle") }}</DialogTitle>
          <DialogDescription>
            {{ t("actions.confirmStopAllDescription", { count: running }, running) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="stopAllConfirmOpen = false">{{ t("actions.cancel") }}</Button>
          <Button variant="destructive" @click="confirmStopAll">{{ t("actions.stopAll") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Confirm — Shut down (always confirmed; it takes the whole daemon down) -->
    <Dialog v-model:open="shutdownConfirmOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ t("actions.confirmShutdownTitle") }}</DialogTitle>
          <DialogDescription>{{ t("actions.confirmShutdownDescription") }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="shutdownConfirmOpen = false">{{ t("actions.cancel") }}</Button>
          <Button variant="destructive" :disabled="shuttingDown" @click="confirmShutdown">
            {{ t("actions.shutdown") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </header>
</template>
