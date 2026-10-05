<script setup lang="ts">
import { computed } from "vue";
import {
  Clock,
  Cpu,
  EllipsisVertical,
  ExternalLink,
  Link2,
  Magnet,
  MemoryStick,
  MonitorDown,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
  Square,
  Star,
  TriangleAlert,
} from "@lucide/vue";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import Hint from "./Hint.vue";
import IconButton from "./IconButton.vue";
import { storeToRefs } from "pinia";
import { disableProcess, enableProcess, restart, start, stop } from "@/api";
import { useAppStore } from "@/store";
import { useFreePortAction } from "@/lib/freePort";
import { useGroupActionToast } from "@/lib/groupToast";
import { useShortcutAction } from "@/lib/shortcut";
import { useRunAction } from "@/lib/useAction";
import { useTooltipConfig } from "@/lib/tooltip-config";
import { commandEngine, formatBytes, formatUptime, processUrl } from "@/lib/format";
import { linkedPeers } from "@/lib/links";
import { statusPill, WARNING_BANNER } from "@/lib/severity";
import type { ProcessView } from "@/types";
import { useI18n } from "vue-i18n";

const { t } = useI18n({ useScope: "global" });
const freePortAction = useFreePortAction();
const { addProcessShortcut } = useShortcutAction();
const { enabled: tooltipsEnabled } = useTooltipConfig();

// `compact` is the LAUNCHER density, used by the focus window a desktop shortcut opens
// (FocusView). That window exists to answer "is it up?" and to start/stop — it is not a
// place to configure anything, so compact both tightens the density AND drops the
// config-only affordances (star, enable switch, edit, engine chip, the add-to-desktop
// overflow — you are already IN the thing the shortcut opened). It stays a prop on this
// card rather than a second component on purpose: status/logs/links/metrics/Start/Stop
// and the SSE wiring must never fork into a launcher copy that drifts from the dashboard.
const props = withDefaults(defineProps<{ process: ProcessView; compact?: boolean }>(), {
  compact: false,
});
const emit = defineEmits<{ logs: []; edit: []; errors: [] }>();

// Every density difference lives here, so "compact" can never quietly become a different
// LAYOUT — only a smaller one. Sizes are the kit's own scale (button xs/icon-xs), not
// ad-hoc overrides.
const d = computed(() =>
  props.compact
    ? {
        card: "sm" as const,
        body: "gap-2 px-2.5",
        name: "text-sm",
        btn: "xs" as const,
        icon: "icon-xs" as const,
        svg: "size-3",
      }
    : {
        card: "default" as const,
        body: "gap-3 px-3.5",
        name: "",
        btn: "sm" as const,
        icon: "icon-sm" as const,
        svg: "size-4",
      },
);

const store = useAppStore();
const { errorCountByProcess, now, monitorResources, linkHost } = storeToRefs(store);

const isLive = computed(
  () =>
    props.process.status === "running" ||
    props.process.status === "starting" ||
    props.process.status === "waiting",
);
// Title links to the dev server only while it's actually running — a link to a
// stopped server would just yield connection-refused.
const linkUrl = computed(() =>
  props.process.status === "running"
    ? processUrl(
        props.process.port,
        props.process.url,
        linkHost.value.trim() || window.location.hostname, // blank → the GUI page's own host
      )
    : null,
);
const uptime = computed(() =>
  formatUptime(now.value, props.process.startedAt, props.process.status === "running"),
);
const cpu = computed(() => (props.process.cpu != null ? `${props.process.cpu}%` : "—"));
const mem = computed(() => formatBytes(props.process.memory));
const errorCount = computed(() => errorCountByProcess.value[props.process.id] ?? 0);
const pill = computed(() => statusPill(props.process.status));
// Names of this process's linked group (either direction — links are symmetric).
const linkedNames = computed(() => {
  const siblings = store.projects.find((p) => p.id === props.process.projectId)?.processes ?? [];
  return linkedPeers(props.process, siblings).map((p) => p.name);
});

const runAction = useRunAction("processCard.actionFailed");
const showGroupToast = useGroupActionToast();

/** Start, surfacing the "also started …" ripple when a linked group / companion came along. */
function onStart() {
  return runAction(async () => {
    const res = await start(props.process.id);
    showGroupToast("started", res.coStarted);
  });
}

/** Stop, surfacing the "also stopped …" ripple when the linked group came down too. */
function onStop() {
  return runAction(async () => {
    const res = await stop(props.process.id);
    showGroupToast("stopped", res.coStopped);
  });
}
</script>

<template>
  <!-- A disabled process dims the whole card; the dimming lives on this plain wrapper
       because the Card owns its own effects. h-full keeps the card filling its grid cell. -->
  <div :class="process.enabled ? '' : 'opacity-60'">
    <Card class="h-full" :size="d.card">
      <!-- Tightened (gap-3/px-3.5, the Card's own vertical padding) since the command line
           moved into the engine chip — keeps the two-wide grid dense without the cards
           feeling empty. `compact` tightens it further for the launcher window; see the `d`
           density tokens. -->
      <div class="flex flex-col" :class="d.body">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span
                class="shrink-0 rounded-full bg-(--dot-color)"
                :class="compact ? 'size-2' : 'size-2.5'"
                :style="{ '--dot-color': process.color || 'var(--primary)' }"
              />
              <a
                v-if="linkUrl"
                :href="linkUrl"
                target="_blank"
                rel="noopener noreferrer"
                :title="tooltipsEnabled ? t('processCard.openUrl', { url: linkUrl }) : undefined"
                class="group inline-flex min-w-0 items-center gap-1 rounded font-semibold underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span class="truncate" :class="d.name">{{ process.name }}</span>
                <ExternalLink
                  class="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
                  aria-hidden="true"
                />
              </a>
              <h3 v-else class="truncate font-semibold" :class="d.name">{{ process.name }}</h3>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <button
              v-if="errorCount"
              :aria-label="t('processCard.errorCountAriaLabel', { count: errorCount })"
              class="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-semibold text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-destructive/40 active:bg-destructive/30"
              @click="emit('errors')"
            >
              <TriangleAlert class="size-3" aria-hidden="true" /> {{ errorCount }}
            </button>
            <!-- .devwebui changed this process's command/cwd/env on disk while it kept running on
                 its old definition; the daemon deliberately did not apply the change by itself. -->
            <Hint v-if="process.configChanged" :label="t('processCard.configChangedTooltip')">
              <button
                type="button"
                :aria-label="t('processCard.configChangedRestartAriaLabel', { name: process.name })"
                class="inline-flex items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-xs font-semibold text-warning outline-none transition-colors hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/40 active:bg-warning/30"
                @click="runAction(() => restart(process.id))"
              >
                <TriangleAlert class="size-3" aria-hidden="true" />
              </button>
            </Hint>
            <Hint v-if="linkedNames.length" :label="t('processCard.linkedWith', { names: linkedNames.join(', ') })">
              <span class="inline-flex" tabindex="0">
                <Link2 class="size-3.5 text-muted-foreground/70" aria-hidden="true" />
              </span>
            </Hint>
            <Hint v-if="process.companion" :label="t('processCard.companionBadge')">
              <span class="inline-flex" tabindex="0">
                <Magnet class="size-3.5 text-muted-foreground/70" aria-hidden="true" />
              </span>
            </Hint>
            <!-- Command, condensed to its engine; hover the chip for the full command (same as the table). -->
            <Hint v-if="!compact">
              <Badge variant="outline">
                <span class="font-mono text-2xs font-normal text-muted-foreground">{{ commandEngine(process.command) }}</span>
              </Badge>
              <template #label>
                <code class="break-all">{{ process.command }}</code>
              </template>
            </Hint>
            <!-- Status is the one thing a launcher MUST show, so it survives compact. -->
            <Badge :variant="pill.variant">
              <span class="capitalize">{{ pill.label }}</span>
            </Badge>
            <IconButton
              v-if="!compact"
              :tooltip="process.starred ? t('processCard.unstar') : t('processCard.star')"
              @click="store.toggleStar(process)"
            >
              <Star
                class="size-4"
                :class="process.starred ? 'fill-warning text-warning' : 'text-muted-foreground/60'"
              />
            </IconButton>
            <Switch
              v-if="!compact"
              :model-value="process.enabled"
              :aria-label="process.enabled ? t('processCard.switchAriaLabelEnabled') : t('processCard.switchAriaLabelDisabled')"
              :title="
                tooltipsEnabled
                  ? (process.enabled ? t('processCard.switchTitleEnabled') : t('processCard.switchTitleDisabled'))
                  : undefined
              "
              @update:model-value="(v: boolean) => runAction(() => (v ? enableProcess(process.id) : disableProcess(process.id)))"
            />
          </div>
        </div>

        <!-- Compact: one thin line of icon+value. A launcher glances at these; it doesn't
             study them, so the label-above-value grid (three rows tall) becomes three
             labelled icons on one row. Same values, same i18n keys — now the tooltip. -->
        <div
          v-if="compact"
          class="flex items-center gap-3 text-3xs tabular-nums text-muted-foreground"
        >
          <span class="flex items-center gap-1" :title="tooltipsEnabled ? t('processCard.uptime') : undefined">
            <Clock class="size-2.5 shrink-0" aria-hidden="true" />{{ uptime }}
          </span>
          <span
            v-if="monitorResources"
            class="flex items-center gap-1"
            :title="tooltipsEnabled ? t('processCard.cpu') : undefined"
          >
            <Cpu class="size-2.5 shrink-0" aria-hidden="true" />{{ cpu }}
          </span>
          <span
            v-if="monitorResources"
            class="flex items-center gap-1"
            :title="tooltipsEnabled ? t('processCard.mem') : undefined"
          >
            <MemoryStick class="size-2.5 shrink-0" aria-hidden="true" />{{ mem }}
          </span>
        </div>

        <div v-else class="grid gap-2 text-xs" :class="monitorResources ? 'grid-cols-3' : 'grid-cols-1'">
          <div>
            <div class="text-muted-foreground">{{ t("processCard.uptime") }}</div>
            <div class="mt-0.5 font-medium tabular-nums">{{ uptime }}</div>
          </div>
          <div v-if="monitorResources">
            <div class="flex items-center gap-1 text-muted-foreground"><Cpu class="size-3" /> {{ t("processCard.cpu") }}</div>
            <div class="mt-0.5 font-medium tabular-nums">{{ cpu }}</div>
          </div>
          <div v-if="monitorResources">
            <div class="flex items-center gap-1 text-muted-foreground">
              <MemoryStick class="size-3" /> {{ t("processCard.mem") }}
            </div>
            <div class="mt-0.5 font-medium tabular-nums">{{ mem }}</div>
          </div>
        </div>

        <div
          v-if="process.status === 'waiting' && process.waitingOnPort"
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs"
          :class="WARNING_BANNER"
        >
          <TriangleAlert class="size-3.5" />
          <i18n-t keypath="processCard.waitingForPort" tag="span" scope="global">
            <template #port>{{ process.waitingOnPort }}</template>
          </i18n-t>
        </div>

        <div
          v-if="process.conflict"
          class="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs"
          :class="WARNING_BANNER"
        >
          <span class="flex items-center gap-1.5">
            <TriangleAlert class="size-3.5" />
            <i18n-t keypath="processCard.portAlreadyInUse" tag="span" scope="global">
              <template #port>{{ process.port }}</template>
            </i18n-t>
          </span>
          <Hint :label="t('processCard.freePortAriaLabel', { port: process.port })">
            <button
              class="cursor-pointer rounded font-medium underline-offset-2 outline-none transition-opacity hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-warning/40 active:opacity-70"
              :aria-label="t('processCard.freePortAriaLabel', { port: process.port })"
              @click="freePortAction(process)"
            >
              {{ t("processCard.freeIt") }}
            </button>
          </Hint>
        </div>

        <div class="flex items-center gap-1.5">
          <IconButton v-if="!isLive" :tooltip="t('processCard.tooltipStart')" variant="outline" :size="d.icon" @click="onStart">
            <Play :class="d.svg" class="text-success" />
          </IconButton>
          <IconButton v-else :tooltip="t('processCard.tooltipStop')" variant="outline" :size="d.icon" @click="onStop">
            <Square :class="d.svg" class="text-destructive" />
          </IconButton>
          <IconButton :tooltip="t('processCard.tooltipRestart')" variant="outline" :size="d.icon" @click="runAction(() => restart(process.id))">
            <RotateCw :class="d.svg" />
          </IconButton>
          <!-- Edit is config, not launching: the launcher window sends you to the dashboard
               for that, so it doesn't carry a button for it. -->
          <IconButton v-if="!compact" :tooltip="t('processCard.tooltipEdit')" variant="ghost" @click="emit('edit')">
            <Pencil class="size-4" />
          </IconButton>
          <Button variant="outline" :size="d.btn" class="ms-auto" @click="emit('logs')">
            <ScrollText :class="d.svg" /> {{ t("processCard.logs") }}
          </Button>
          <!-- Overflow for actions that don't earn a permanent button. The card's other
               actions are inline icons, so this carries only what ProcessTable's own
               overflow adds beyond them — keeping the two layouts at feature parity.
               Dropped in compact: its only item is "add desktop shortcut", and you are
               already looking at the window a desktop shortcut opened. -->
          <DropdownMenu v-if="!compact">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="t('processCard.moreActions')">
                <EllipsisVertical class="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="max-w-56">
              <DropdownMenuItem @select="addProcessShortcut(process.id)">
                <MonitorDown class="size-4" /> {{ t("shortcut.addToDesktop") }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Card>
  </div>
</template>
