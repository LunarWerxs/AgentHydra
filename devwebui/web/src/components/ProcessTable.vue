<script setup lang="ts">
// Dense, scan-friendly alternative to the ProcessCard grid: one row per process.
// Same actions + emitted events as ProcessCard, so ProjectPanel can swap layouts
// purely on the store's viewMode without changing its wiring.
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Cpu,
  EllipsisVertical,
  ExternalLink,
  Link2,
  Magnet,
  MemoryStick,
  MonitorDown,
  Pencil,
  Play,
  Power,
  PowerOff,
  RotateCw,
  ScrollText,
  Square,
  Star,
  TriangleAlert,
} from "@lucide/vue";
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Hint from "./Hint.vue";
import IconButton from "./IconButton.vue";
import { disableProcess, enableProcess, restart, start, stop } from "@/api";
import { useAppStore } from "@/store";
import { useFreePortAction } from "@/lib/freePort";
import { useGroupActionToast } from "@/lib/groupToast";
import { useShortcutAction } from "@/lib/shortcut";
import { useRunAction } from "@/lib/useAction";
import { useTooltipConfig } from "@/lib/tooltip-config";
import { commandEngine, formatBytes, formatUptime, processUrl } from "@/lib/format";
import { linkedPeers } from "@/lib/links";
import { statusPill } from "@/lib/severity";
import type { ProcessView, SortKey } from "@/types";

const { t } = useI18n({ useScope: "global" });
const freePortAction = useFreePortAction();
const { addProcessShortcut } = useShortcutAction();
const { enabled: tooltipsEnabled } = useTooltipConfig();

const props = defineProps<{ processes: ProcessView[] }>();
const emit = defineEmits<{
  logs: [process: ProcessView];
  edit: [process: ProcessView];
  errors: [process: ProcessView];
}>();

const store = useAppStore();
const { errorCountByProcess, now, sortKey, sortDir, monitorResources, linkHost } =
  storeToRefs(store);

const isLive = (p: ProcessView) =>
  p.status === "running" || p.status === "starting" || p.status === "waiting";

/**
 * Per-process link target, keyed by id. Only running processes get one — a link
 * to a stopped server just yields a connection-refused, so we render plain text
 * until it's actually up.
 */
const liveUrls = computed<Record<string, string>>(() => {
  // Blank linkHost → fall back to the host the GUI itself was opened on.
  const host = linkHost.value.trim() || window.location.hostname;
  const out: Record<string, string> = {};
  for (const p of props.processes) {
    if (p.status !== "running") continue;
    const url = processUrl(p.port, p.url, host);
    if (url) out[p.id] = url;
  }
  return out;
});

/** Icon shown in a sortable header: direction arrow when active, faint hint otherwise. */
const sortIcon = (key: SortKey) =>
  sortKey.value !== key ? ChevronsUpDown : sortDir.value === "asc" ? ArrowUp : ArrowDown;

/** Linked-group names per process id (links are symmetric — either direction counts). */
const linkedNamesById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  const projectId = props.processes[0]?.projectId;
  if (!projectId) return out;
  // Resolve peers against the FULL project list, not props.processes — the rows
  // are status-filtered, and a hidden peer still starts with its group.
  const siblings = store.projects.find((p) => p.id === projectId)?.processes ?? [];
  for (const p of props.processes) {
    const peers = linkedPeers(p, siblings);
    if (peers.length) out[p.id] = peers.map((x) => x.name).join(", ");
  }
  return out;
});

const runAction = useRunAction("processTable.actionFailed");
const showGroupToast = useGroupActionToast();

/** Start, surfacing the "also started …" ripple when a linked group / companion came along. */
function onStart(p: ProcessView) {
  return runAction(async () => {
    const res = await start(p.id);
    showGroupToast("started", res.coStarted);
  });
}

/** Stop, surfacing the "also stopped …" ripple when the linked group came down too. */
function onStop(p: ProcessView) {
  return runAction(async () => {
    const res = await stop(p.id);
    showGroupToast("stopped", res.coStopped);
  });
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-border">
    <Table>
      <TableHeader>
        <TableRow variant="tinted">
          <!-- Process soaks up the table's spare width; every other column is content-sized (w-px). -->
          <TableHead class="w-full">
            <Button
              variant="ghost"
              size="compact"
              class="-ms-1"
              @click="store.toggleSort('name')"
            >
              <span
                class="inline-flex items-center gap-1"
                :class="sortKey === 'name' ? 'text-foreground' : 'text-muted-foreground group-hover/button:text-foreground'"
              >
                {{ t("processTable.colProcess") }}
                <component :is="sortIcon('name')" class="size-3" :class="sortKey === 'name' ? '' : 'opacity-40'" />
              </span>
            </Button>
          </TableHead>
          <TableHead class="hidden w-px md:table-cell">{{ t("processTable.colEngine") }}</TableHead>
          <TableHead class="w-px">
            <Button
              variant="ghost"
              size="compact"
              class="-ms-1"
              @click="store.toggleSort('status')"
            >
              <span
                class="inline-flex items-center gap-1"
                :class="sortKey === 'status' ? 'text-foreground' : 'text-muted-foreground group-hover/button:text-foreground'"
              >
                {{ t("processTable.colStatus") }}
                <component :is="sortIcon('status')" class="size-3" :class="sortKey === 'status' ? '' : 'opacity-40'" />
              </span>
            </Button>
          </TableHead>
          <TableHead class="w-px">
            <Button
              variant="ghost"
              size="compact"
              class="w-full justify-end"
              @click="store.toggleSort('port')"
            >
              <span
                class="inline-flex items-center gap-1"
                :class="sortKey === 'port' ? 'text-foreground' : 'text-muted-foreground group-hover/button:text-foreground'"
              >
                {{ t("processTable.colPort") }}
                <component :is="sortIcon('port')" class="size-3" :class="sortKey === 'port' ? '' : 'opacity-40'" />
              </span>
            </Button>
          </TableHead>
          <TableHead class="w-px">
            <Button
              variant="ghost"
              size="compact"
              class="w-full justify-end"
              @click="store.toggleSort('uptime')"
            >
              <span
                class="inline-flex items-center gap-1"
                :class="sortKey === 'uptime' ? 'text-foreground' : 'text-muted-foreground group-hover/button:text-foreground'"
              >
                {{ t("processTable.colUptime") }}
                <component :is="sortIcon('uptime')" class="size-3" :class="sortKey === 'uptime' ? '' : 'opacity-40'" />
              </span>
            </Button>
          </TableHead>
          <TableHead v-if="monitorResources" class="hidden w-px md:table-cell">
            <Button
              variant="ghost"
              size="compact"
              class="w-full justify-end"
              @click="store.toggleSort('cpu')"
            >
              <span
                class="inline-flex items-center gap-1"
                :class="sortKey === 'cpu' ? 'text-foreground' : 'text-muted-foreground group-hover/button:text-foreground'"
              >
                <Cpu class="size-3" /> {{ t("processTable.colCpu") }}
                <component :is="sortIcon('cpu')" class="size-3" :class="sortKey === 'cpu' ? '' : 'opacity-40'" />
              </span>
            </Button>
          </TableHead>
          <TableHead v-if="monitorResources" class="hidden w-px md:table-cell">
            <Button
              variant="ghost"
              size="compact"
              class="w-full justify-end"
              @click="store.toggleSort('memory')"
            >
              <span
                class="inline-flex items-center gap-1"
                :class="sortKey === 'memory' ? 'text-foreground' : 'text-muted-foreground group-hover/button:text-foreground'"
              >
                <MemoryStick class="size-3" /> {{ t("processTable.colMem") }}
                <component :is="sortIcon('memory')" class="size-3" :class="sortKey === 'memory' ? '' : 'opacity-40'" />
              </span>
            </Button>
          </TableHead>
          <TableHead class="w-px text-end">{{ t("processTable.colActions") }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="p in processes" :key="p.id" :variant="p.enabled ? 'default' : 'dimmed'">
          <!-- Process: colour dot + name -->
          <TableCell>
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="size-2.5 shrink-0 rounded-full bg-(--dot-color)"
                :style="{ '--dot-color': p.color || 'var(--primary)' }"
              />
              <Star
                v-if="p.starred"
                class="size-3 shrink-0 fill-warning text-warning"
                :aria-label="t('processTable.unstar')"
              />
              <Hint v-if="linkedNamesById[p.id]" :label="t('processTable.linkedWith', { names: linkedNamesById[p.id] })">
                <span class="inline-flex shrink-0" tabindex="0">
                  <Link2 class="size-3 text-muted-foreground/70" aria-hidden="true" />
                </span>
              </Hint>
              <Hint v-if="p.companion" :label="t('processTable.companionBadge')">
                <span class="inline-flex shrink-0" tabindex="0">
                  <Magnet class="size-3 text-muted-foreground/70" aria-hidden="true" />
                </span>
              </Hint>
              <!-- The row's dimming (opacity-60 above) is the at-a-glance signal; this icon is the
                   *why* — without it a disabled row just looks arbitrarily greyer than its neighbours. -->
              <Hint v-if="!p.enabled" :label="t('processTable.autostartOff')">
                <span class="inline-flex shrink-0" tabindex="0">
                  <PowerOff class="size-3 text-muted-foreground/70" aria-hidden="true" />
                </span>
              </Hint>
              <a
                v-if="liveUrls[p.id]"
                :href="liveUrls[p.id]"
                target="_blank"
                rel="noopener noreferrer"
                :title="tooltipsEnabled ? t('processTable.openUrl', { url: liveUrls[p.id] }) : undefined"
                class="group inline-flex min-w-0 items-center gap-1 rounded font-medium underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span class="truncate">{{ p.name }}</span>
                <ExternalLink
                  class="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
                  aria-hidden="true"
                />
              </a>
              <span v-else class="truncate font-medium">{{ p.name }}</span>
            </div>
          </TableCell>

          <!-- Command, condensed to its engine (the launching executable); hover the chip for the full command. -->
          <TableCell class="hidden md:table-cell">
            <Hint>
              <Badge variant="outline">
                <span class="font-mono text-2xs font-normal text-muted-foreground">{{ commandEngine(p.command) }}</span>
              </Badge>
              <template #label>
                <code class="break-all">{{ p.command }}</code>
              </template>
            </Hint>
          </TableCell>

          <!-- Status (+ error count) -->
          <TableCell>
            <div class="flex items-center gap-1.5">
              <Hint
                v-if="p.status === 'waiting' && p.waitingOnPort"
                :label="t('processTable.waitingForPort', { port: p.waitingOnPort })"
              >
                <Badge :variant="statusPill(p.status).variant">
                  <span class="capitalize">{{ statusPill(p.status).label }}</span>
                </Badge>
              </Hint>
              <Badge v-else :variant="statusPill(p.status).variant">
                <span class="capitalize">{{ statusPill(p.status).label }}</span>
              </Badge>
              <Hint v-if="errorCountByProcess[p.id]" :label="t('processTable.errorCountAriaLabel', errorCountByProcess[p.id])">
                <button
                  :aria-label="t('processTable.errorCountAriaLabel', errorCountByProcess[p.id])"
                  class="inline-flex cursor-pointer items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-semibold text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-destructive/40 active:bg-destructive/30"
                  @click="emit('errors', p)"
                >
                  <TriangleAlert class="size-3" aria-hidden="true" /> {{ errorCountByProcess[p.id] }}
                </button>
              </Hint>
              <!-- .devwebui changed this process's command/cwd/env on disk while it kept running
                   on its old definition; the daemon deliberately did not apply the change by itself. -->
              <Hint v-if="p.configChanged" :label="t('processTable.configChangedTooltip')">
                <button
                  type="button"
                  :aria-label="t('processTable.configChangedRestartAriaLabel', { name: p.name })"
                  class="cursor-pointer rounded text-warning outline-none transition-colors hover:text-warning/80 focus-visible:ring-2 focus-visible:ring-warning/40"
                  @click="runAction(() => restart(p.id))"
                >
                  <TriangleAlert class="size-3.5" />
                </button>
              </Hint>
            </div>
          </TableCell>

          <!-- Port. On conflict: amber number + a warning icon that toasts/frees the holder. -->
          <TableCell class="text-end">
            <span v-if="p.port == null" class="text-muted-foreground">—</span>
            <span v-else class="inline-flex items-center justify-end gap-1">
              <Hint v-if="p.conflict" :label="t('processTable.freePortAriaLabel', { port: p.port })">
                <button
                  class="cursor-pointer rounded text-warning outline-none transition-colors hover:text-warning/80 focus-visible:ring-2 focus-visible:ring-warning/40"
                  :aria-label="t('processTable.freePortAriaLabel', { port: p.port })"
                  @click="freePortAction(p)"
                >
                  <TriangleAlert class="size-3.5" />
                </button>
              </Hint>
              <span class="tabular-nums" :class="p.conflict ? 'text-warning' : ''">{{ p.port }}</span>
            </span>
          </TableCell>

          <!-- Uptime / CPU / Mem -->
          <TableCell class="text-end">
            <span class="tabular-nums">{{ formatUptime(now, p.startedAt, p.status === "running") }}</span>
          </TableCell>
          <TableCell v-if="monitorResources" class="hidden text-end md:table-cell"><span class="tabular-nums">{{ p.cpu != null ? `${p.cpu}%` : "—" }}</span></TableCell>
          <TableCell v-if="monitorResources" class="hidden text-end md:table-cell"><span class="tabular-nums">{{ formatBytes(p.memory) }}</span></TableCell>

          <!-- Actions. Star + enable/disable live in the ⋮ menu so the row stays narrow (no
               horizontal scroll); the enabled state still reads at a glance from the row's opacity,
               and the star from the indicator next to the name. -->
          <TableCell>
            <div class="flex items-center justify-end gap-1">
              <IconButton v-if="!isLive(p)" :tooltip="t('processTable.actionStart')" @click="onStart(p)">
                <Play class="size-4 text-success" />
              </IconButton>
              <IconButton v-else :tooltip="t('processTable.actionStop')" @click="onStop(p)">
                <Square class="size-4 text-destructive" />
              </IconButton>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" :aria-label="t('processTable.moreActions')">
                    <EllipsisVertical class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="max-w-44">
                  <DropdownMenuItem @select="store.toggleStar(p)">
                    <Star class="size-4" :class="p.starred ? 'fill-warning text-warning' : ''" />
                    {{ p.starred ? t("processTable.unstar") : t("processTable.star") }}
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="runAction(() => (p.enabled ? disableProcess(p.id) : enableProcess(p.id)))">
                    <Power class="size-4" />
                    {{ p.enabled ? t("processTable.actionDisable") : t("processTable.actionEnable") }}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem v-if="isLive(p) || p.status === 'crashed'" @select="runAction(() => restart(p.id))">
                    <RotateCw class="size-4" /> {{ t("processTable.actionRestart") }}
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="emit('edit', p)">
                    <Pencil class="size-4" /> {{ t("processTable.actionEdit") }}
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="emit('logs', p)">
                    <ScrollText class="size-4" /> {{ t("processTable.actionLogs") }}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem @select="addProcessShortcut(p.id)">
                    <MonitorDown class="size-4" /> {{ t("shortcut.addToDesktop") }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
