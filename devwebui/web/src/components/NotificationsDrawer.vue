<script setup lang="ts">
// One combined right-side panel for both in-app notifications (e.g. the startup
// scan found new projects) and the error log. Opened by the TopBar bell; also
// opened filtered to a single process from a process's error chip.
import { computed } from "vue";
import {
  CheckCircle2,
  Copy,
  FolderOpen,
  FolderSearch,
  Inbox,
  Sparkles,
  Trash2,
  X,
} from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "vue-sonner";
import RightDrawer from "./RightDrawer.vue";
import IconButton from "./IconButton.vue";
import { storeToRefs } from "pinia";
import { useAppStore } from "@/store";
import { formatAgo, formatAgoCoarse } from "@/lib/format";
import { sourceBadgeVariant } from "@/lib/severity";
import type { AppNotification, ErrorEvent } from "@/types";
import { openInEditor } from "@/api";
import { findSourceFrames, type SourceFrame } from "../../../shared/source-frames";
import type { OpenInEditorFailure } from "../../../shared/dto";
import { useI18n } from "vue-i18n";

const { t } = useI18n({ useScope: "global" });

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{ processId?: string | null }>();
const emit = defineEmits<{ clearFilter: []; review: [notification: AppNotification] }>();

const store = useAppStore();
const { allProcesses, errors, notifications, now } = storeToRefs(store);

const errorList = computed(() =>
  props.processId ? errors.value.filter((e) => e.processId === props.processId) : errors.value,
);
// Group the errors by the process that produced them, so the drawer shows "which process" at a
// glance (each group headed by its process + a per-process count) instead of one undifferentiated
// list. errorList is already sorted by lastSeen desc, so items within a group keep that order;
// groups are ordered by their most-recent error.
const errorGroups = computed(() => {
  const groups = new Map<
    string,
    { processId: string; processName: string; projectName: string; items: ErrorEvent[] }
  >();
  for (const e of errorList.value) {
    const g = groups.get(e.processId);
    if (g) g.items.push(e);
    else
      groups.set(e.processId, {
        processId: e.processId,
        processName: e.processName,
        projectName: e.projectName,
        items: [e],
      });
  }
  return [...groups.values()].sort(
    (a, b) => (b.items[0]?.lastSeen ?? 0) - (a.items[0]?.lastSeen ?? 0),
  );
});
const filterName = computed(() =>
  props.processId
    ? (errorList.value[0]?.processName ??
      allProcesses.value.find((p) => p.id === props.processId)?.name ??
      t("notifications.processNameFallback"))
    : "",
);

function clearErr() {
  // Optimistic: the store drops the records locally right away and reconciles with the
  // daemon in the background, so the list empties on click instead of stalling until the
  // next ~2s SSE monitoring tick echoes the cleared list back.
  store.clearErrorsLocal(props.processId ?? undefined);
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function buildErrorReport(items: ErrorEvent[]) {
  const lines = [
    "DevWebUI error report",
    "Use this context to diagnose and fix the failing dev server(s).",
    "",
    `Scope: ${props.processId ? `${filterName.value} (${props.processId})` : "all processes"}`,
    `Copied at: ${formatTimestamp(now.value)}`,
    `Error groups: ${items.length}`,
    "",
  ];

  for (const [index, e] of items.entries()) {
    const process = allProcesses.value.find((p) => p.id === e.processId);

    lines.push(
      `Error ${index + 1}`,
      `Project: ${e.projectName} (${e.projectId})`,
      `Process: ${e.processName} (${e.processId})`,
      `Local process ID: ${e.localId}`,
    );

    if (process) {
      lines.push(
        `Command: ${process.command}`,
        `Working directory: ${process.cwd}`,
        `Status: ${process.status}`,
      );
      if (process.runtime) lines.push(`Runtime: ${process.runtime}`);
      if (process.port != null) lines.push(`Port: ${process.port}`);
      if (process.url) lines.push(`URL: ${process.url}`);
    }

    lines.push(
      `Source: ${e.source}`,
      `Occurrences: ${e.count}`,
      `First seen: ${formatTimestamp(e.firstSeen)}`,
      `Last seen: ${formatTimestamp(e.lastSeen)}`,
      `Fingerprint: ${e.fingerprint}`,
      "Sample:",
      e.sample.trimEnd() || "(empty)",
      "",
    );
  }

  return lines.join("\n");
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some embedded/browser contexts expose the async Clipboard API but deny writes.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

async function copyErr() {
  try {
    const items = errorList.value;
    await writeClipboardText(buildErrorReport(items));
    toast.success(t("notifications.copyErrorsSuccess", { count: items.length }, items.length));
  } catch {
    toast.error(t("notifications.copyErrorsFailed"));
  }
}

// A stack trace is only useful if you can get to the line it names: split each sample into
// plain text and file:line:col frames so every frame renders as a jump into the editor.
type SampleSegment = { text: string; frame?: SourceFrame };

function sampleSegments(sample: string): SampleSegment[] {
  const out: SampleSegment[] = [];
  let at = 0;
  for (const f of findSourceFrames(sample)) {
    if (f.index > at) out.push({ text: sample.slice(at, f.index) });
    out.push({ text: sample.slice(f.index, f.index + f.length), frame: f });
    at = f.index + f.length;
  }
  if (at < sample.length) out.push({ text: sample.slice(at) });
  return out;
}

const OPEN_FAILURE_KEY: Record<OpenInEditorFailure, string> = {
  "bad-input": "notifications.openFailedBadInput",
  "not-found": "notifications.openFailedNotFound",
  "no-editor": "notifications.openFailedNoEditor",
  "unsupported-editor": "notifications.openFailedUnsupportedEditor",
  "launch-failed": "notifications.openFailedLaunch",
};

// `f` is optional only because the template's v-if narrowing does not reach into @click.
async function openFrame(e: ErrorEvent, f?: SourceFrame) {
  if (!f) return;
  try {
    const r = await openInEditor({
      file: f.file,
      line: f.line,
      column: f.column,
      processId: e.processId,
    });
    if (r.ok) toast.success(t("notifications.openedInEditor", { editor: r.editor }));
    else toast.error(t(OPEN_FAILURE_KEY[r.reason]), { description: r.detail });
  } catch {
    toast.error(t(OPEN_FAILURE_KEY["launch-failed"]));
  }
}

// How many found projects to list inline before collapsing the rest into "+N more".
const SCAN_PREVIEW = 6;

const SCAN_ROOT_MARKERS = new Set([
  "client",
  "clients",
  "demo",
  "demos",
  "example",
  "examples",
  "infra",
  "misc",
  "script",
  "scripts",
  "server",
  "servers",
  "service",
  "services",
  "src",
  "tool",
  "tools",
  "web",
  "www",
]);

function scanPathParts(filePath: string) {
  return filePath.split(/[\\/]+/).filter(Boolean);
}

function scanRootName(filePath: string) {
  const dir = scanPathParts(filePath).slice(0, -1);

  for (let i = 0; i < dir.length - 1; i++) {
    if (i > 0 && SCAN_ROOT_MARKERS.has(dir[i].toLowerCase())) return dir[i - 1];
  }

  let i = dir.length - 1;
  while (i > 0 && SCAN_ROOT_MARKERS.has(dir[i].toLowerCase())) i--;
  return dir[i] ?? t("notifications.scanRootFallback");
}

function scanRootLabel(n: AppNotification) {
  const roots = [
    ...new Set([
      ...(n.scan?.files.map((f) => scanRootName(f.path)) ?? []),
      ...(n.scan?.detected?.map((p) => scanRootName(`${p.path}\\package.json`)) ?? []),
    ]),
  ];
  if (!roots.length) return t("notifications.scanRootFallback");
  if (roots.length === 1) return roots[0];
  return t("notifications.scanMultipleRoots", { count: roots.length });
}

function scanCount(n: AppNotification) {
  return (n.scan?.files.length ?? 0) + (n.scan?.detected?.length ?? 0);
}

/** The localized title for a notification — scan notifications derive it from their find count. */
function notifTitle(n: AppNotification) {
  if (n.kind === "scan" && n.scan) {
    const count = scanCount(n);
    return t("notifications.scanFoundTitle", { count, root: scanRootLabel(n) }, count);
  }
  return n.title ?? "";
}
</script>

<template>
  <RightDrawer v-model:open="open" :title="t('notifications.panelTitle')">
    <template #header>
      <div class="flex w-full items-center gap-2">
        <span class="font-semibold">{{ t("notifications.panelTitle") }}</span>
        <Badge v-if="errors.length" variant="destructive">{{ errors.length }}</Badge>
        <span v-if="processId" class="flex items-center gap-1 text-sm text-muted-foreground">
          <i18n-t keypath="notifications.errorsForProcess" tag="span" scope="global">
            <template #name>{{ filterName }}</template>
          </i18n-t>
          <IconButton :tooltip="t('notifications.showEverything')" @click="emit('clearFilter')">
            <X class="size-3.5" />
          </IconButton>
        </span>
      </div>
    </template>

    <div class="mt-3 min-h-0 flex-1 space-y-6 overflow-auto">
      <!-- Notifications -->
      <section v-if="!processId" class="space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t("notifications.sectionNotifications") }}</h3>
          <IconButton
            v-if="notifications.length"
            :tooltip="t('notifications.clear')"
            @click="store.clearNotifications()"
          >
            <Trash2 class="size-4" />
          </IconButton>
        </div>

        <div
          v-if="!notifications.length"
          class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground"
        >
          <Inbox class="size-7 opacity-60" />
          {{ t("notifications.allCaughtUp") }}
        </div>

        <div
          v-for="n in notifications"
          :key="n.id"
          class="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
          :class="n.read ? '' : 'border-primary/30 bg-primary/5'"
        >
          <span class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <FolderSearch class="size-4" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{{ notifTitle(n) }}</span>
              <span class="ms-auto shrink-0 text-xs text-muted-foreground">{{ formatAgoCoarse(now, n.ts) }}</span>
              <IconButton :tooltip="t('notifications.dismiss')" @click="store.dismissNotification(n.id)">
                <X class="size-3.5" />
              </IconButton>
            </div>

            <!-- What was actually found: process count + path, so the user
                 can tell at a glance whether it's worth adding. -->
            <ul v-if="scanCount(n)" class="mt-2 flex flex-col gap-0.5">
              <li
                v-for="f in (n.scan?.files ?? []).slice(0, SCAN_PREVIEW)"
                :key="f.path"
                class="flex min-w-0 items-center gap-2 rounded-md bg-muted/40 px-2 py-1"
              >
                <FolderOpen class="size-3.5 shrink-0 text-primary" />
                <span class="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-3xs font-medium uppercase text-primary">
                  {{ t("scanResults.configuredBadge") }}
                </span>
                <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ t("scanResults.procCount", { count: f.processes }) }}</span>
                <code class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ f.path }}</code>
              </li>
              <li
                v-for="p in (n.scan?.detected ?? []).slice(0, Math.max(0, SCAN_PREVIEW - (n.scan?.files.length ?? 0)))"
                :key="`detected:${p.path}`"
                class="flex min-w-0 items-center gap-2 rounded-md bg-muted/40 px-2 py-1"
              >
                <Sparkles class="size-3.5 shrink-0 text-primary" />
                <span class="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-3xs font-medium uppercase text-primary">
                  {{ t("scanResults.detectedBadge") }}
                </span>
                <span v-if="p.framework" class="shrink-0 text-xs text-muted-foreground">{{ p.framework }}</span>
                <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ t("scanResults.procCount", { count: p.processes }) }}</span>
                <code class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ p.path }}</code>
              </li>
            </ul>
            <p v-if="scanCount(n) > SCAN_PREVIEW" class="mt-1 px-2 text-xs text-muted-foreground">
              {{ t("notifications.scanMore", { count: scanCount(n) - SCAN_PREVIEW }) }}
            </p>

            <div v-if="n.scan" class="mt-2 flex items-center gap-2">
              <Button size="sm" @click="emit('review', n)">{{ t("notifications.reviewAndAdd") }}</Button>
            </div>
          </div>
        </div>
      </section>

      <!-- Errors -->
      <section class="space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {{ t("notifications.sectionErrors") }}
            <Badge v-if="errorList.length" variant="destructive">{{ errorList.length }}</Badge>
          </h3>
          <div v-if="errorList.length" class="flex items-center gap-1">
            <IconButton :tooltip="t('notifications.copyErrors')" @click="copyErr">
              <Copy class="size-4" />
            </IconButton>
            <IconButton :tooltip="processId ? t('notifications.clearThese') : t('notifications.clearAll')" @click="clearErr">
              <Trash2 class="size-4" />
            </IconButton>
          </div>
        </div>

        <div
          v-if="!errorList.length"
          class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground"
        >
          <CheckCircle2 class="size-7 text-success" />
          {{ processId ? t("notifications.noErrorsForProcess") : t("notifications.noErrors") }}
        </div>

        <div v-for="g in errorGroups" :key="g.processId" class="space-y-2">
          <!-- group header: which process/project these errors came from + its own count -->
          <div class="flex items-center gap-2 px-0.5">
            <span class="shrink-0 text-sm font-medium text-foreground">{{ g.processName }}</span>
            <span class="min-w-0 truncate text-xs text-muted-foreground">· {{ g.projectName }}</span>
            <Badge variant="destructive" class="ms-auto shrink-0">{{ g.items.length }}</Badge>
          </div>
          <div
            v-for="e in g.items"
            :key="e.fingerprint"
            class="rounded-lg border border-border bg-card p-3"
          >
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge :variant="sourceBadgeVariant(e.source)"><span class="capitalize">{{ e.source }}</span></Badge>
              <span class="ms-auto flex items-center gap-2">
                <span class="rounded bg-muted px-1.5 py-0.5 font-semibold tabular-nums text-foreground">
                  ×{{ e.count }}
                </span>
                <span>{{ formatAgo(now, e.lastSeen) }}</span>
                <IconButton :tooltip="t('notifications.dismissError')" @click="store.dismissError(e.fingerprint)">
                  <X class="size-3.5" />
                </IconButton>
              </span>
            </div>
            <pre
              class="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded border border-border bg-muted p-2.5 font-mono text-xs text-destructive"
              ><template v-for="(s, i) in sampleSegments(e.sample)" :key="i"><button v-if="s.frame" type="button" class="inline cursor-pointer text-start underline decoration-dotted underline-offset-2 hover:decoration-solid" :title="t('notifications.openInEditor')" @click="openFrame(e, s.frame)">{{ s.text }}</button><template v-else>{{ s.text }}</template></template></pre
            >
          </div>
        </div>
      </section>
    </div>
  </RightDrawer>
</template>
