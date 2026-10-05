<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Eye, EyeOff, FolderSearch, Search } from "@lucide/vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import Hint from "@/components/Hint.vue";
import TakeoverStep from "@/components/add-project-dialog/TakeoverStep.vue";
import AddManualForm from "@/components/add-project-dialog/AddManualForm.vue";
import ScanResultsPanel from "@/components/add-project-dialog/ScanResultsPanel.vue";
import {
  browseForFolder,
  scanForDevWebUI,
  suggestDest,
  type AddResult,
  type AutostartTrigger,
  type ProjectProposal,
  type ScanResult,
  type TakeOverResult,
} from "@/api";
import { useAppStore } from "@/store";
import { findProjectNameInDir, pathFromDrop, projectNameFromFile } from "@/lib/drop";

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{
  scanOnOpen?: boolean; // run a whole-machine scan as soon as the dialog opens
  prefillScan?: ScanResult | null; // show these scan results without re-scanning
}>();

const store = useAppStore();
const { t } = useI18n({ useScope: "global" });

const input = ref(""); // a local path OR a git URL
const dest = ref(""); // git clone destination
const error = ref("");
const note = ref(""); // friendly prompt when a drop can't reveal its path
const busy = ref(false);
// Set when a folder has no .devwebui but the daemon detected dev scripts to build one from.
const scaffold = ref<{ dir: string; fileName: string; proposal: ProjectProposal } | null>(null);
// Set after a load when the repo ALSO auto-starts its dev server outside DevWebUI
// (VS Code tasks.json folderOpen / the "Vite" extension) — offer to retire those.
const takeover = ref<{ dir: string; triggers: AutostartTrigger[]; result?: TakeOverResult } | null>(
  null,
);
// Machine-scan results (existing .devwebui files + detectable package-script projects).
const scanning = ref(false);
const scanDeepening = ref(false); // tier-1 results shown; tier-2 deep sweep still running
const scanResult = ref<ScanResult | null>(null);
let scanGen = 0; // bumped on reset/new-scan so a stale in-flight scan can't write back
// Explicit "scan a specific folder" card — separate from the paste-a-path field so
// scoping a scan to one folder doesn't depend on the user knowing that trick.
const scanFolder = ref("");
// The folder the most recent scoped scan actually ran against (from either the
// dedicated card above or a path typed into the paste field) — shown as a caption
// over the results so it's obvious the scan didn't sweep the whole machine.
const scannedFolder = ref("");
// Opened as a focused "Scan for projects" view (⋮ menu or launch auto-scan) —
// show only the results, hiding the drop zone / paste / clone form.
const scanMode = ref(false);
// Reveal the folders the user dismissed (so they can un-ignore them).
const showIgnored = ref(false);
async function ignoreDetected(dir: string) {
  try {
    await store.ignoreProject(dir);
  } catch {
    /* best-effort */
  }
}
async function unignoreDetected(dir: string) {
  try {
    await store.unignoreProject(dir);
  } catch {
    /* best-effort */
  }
}

// A real git remote has a scheme (https/ssh/git) or scp-style host. A bare
// ".git" suffix is deliberately NOT enough — local paths like C:\repos\x.git
// must still load as folders, not clone targets.
const GIT_RE = /^(https?:\/\/|git@[^:\s]+:|ssh:\/\/|git:\/\/)/i;
const isGitUrl = computed(() => GIT_RE.test(input.value.trim()));

// Drag highlight via a depth counter so moving over child elements doesn't flicker.
const dragDepth = ref(0);
const dragging = computed(() => dragDepth.value > 0);
let dropGen = 0; // ignore a slow drop-read once a newer drop has started

// Reset every time the dialog opens, and fetch a default clone destination.
watch(open, async (v) => {
  if (!v) return;
  input.value = "";
  dest.value = "";
  error.value = "";
  note.value = "";
  scaffold.value = null;
  takeover.value = null;
  scanResult.value = null;
  scanning.value = false;
  scanDeepening.value = false;
  scanFolder.value = "";
  scannedFolder.value = "";
  scanGen++; // invalidate any scan still running from a previous open
  dragDepth.value = 0;
  busy.value = false;
  // Either entry into the scan flow opens the focused results-only view.
  scanMode.value = !!(props.scanOnOpen || props.prefillScan);
  // Opened to show scan results (auto-scan), or to kick off a fresh whole-machine scan.
  if (props.prefillScan) scanResult.value = props.prefillScan;
  else if (props.scanOnOpen) void runScan();
  const suggested = await suggestDest();
  if (open.value && !dest.value) dest.value = suggested; // don't clobber a closed dialog or typed value
});

function clearMessages() {
  error.value = "";
  note.value = "";
  scaffold.value = null;
  takeover.value = null;
  scanResult.value = null;
  scannedFolder.value = "";
}

// Leave the focused scan view for the full add form (e.g. scan found nothing).
function addManually() {
  clearMessages(); // drop the empty scan result so the manual form opens clean
  scanMode.value = false;
}

function finish(res: AddResult) {
  if (res.cancelled) return;
  if (res.needsScaffold && res.proposal && res.dir && res.fileName) {
    // No .devwebui here, but we detected dev scripts — offer to build one.
    scanMode.value = false;
    scaffold.value = { dir: res.dir, fileName: res.fileName, proposal: res.proposal };
    return;
  }
  if (res.cloned && res.error) {
    // Repo cloned fine but has no .devwebui — recoverable. Point the user at it.
    note.value = res.error;
    input.value = res.cloned;
    return;
  }
  if (res.error) {
    error.value = res.error;
    scaffold.value = null; // a failed scaffold attempt is no longer actionable — drop the preview
    return;
  }
  if (res.ok && res.autostartTriggers?.length && res.dir) {
    // Project added — but it also auto-starts its dev server outside DevWebUI.
    // Keep the dialog open to offer retiring those triggers (it's already added).
    takeover.value = { dir: res.dir, triggers: res.autostartTriggers };
    if (res.firstLoad) toast.success(t("addProject.firstLoadHint"));
    return;
  }
  if (res.ok) {
    // A brand-new path never auto-starts anything on its first load — the dialog
    // closes right below (no blocking step), so this is a toast, not inline copy.
    if (res.firstLoad) toast.success(t("addProject.firstLoadHint"));
    open.value = false;
  }
}

async function createScaffold() {
  const s = scaffold.value;
  if (!s || busy.value) return;
  error.value = "";
  note.value = "";
  busy.value = true;
  let res: AddResult | undefined;
  try {
    res = await store.scaffoldProject(s.dir, s.fileName, {
      name: s.proposal.name,
      processes: s.proposal.processes,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("addProject.requestFailed");
  } finally {
    busy.value = false;
  }
  if (res) finish(res);
}

// ---- scan for configured/detectable projects ----------------------------
// If the field holds an ABSOLUTE path, scope the scan to it (fast); otherwise
// (empty, partial, or junk input) sweep the whole machine, bounded by the daemon.
const ABS_PATH_RE = /^([a-zA-Z]:[\\/]|\/|\\\\)/;
const scanRoot = computed(() => {
  const t = input.value.trim();
  return !isGitUrl.value && ABS_PATH_RE.test(t) ? t : "";
});
// Tooltip for the footer Scan button — narrows to the typed folder when one is present.
const scanHint = computed(() =>
  scanRoot.value
    ? t("addProject.scanHintRoot", { root: scanRoot.value })
    : t("addProject.scanHintMachine"),
);

// `explicitRoot` comes from the dedicated "scan a specific folder" card (a typed
// path or the native picker); omit it to fall back to the paste field's implicit
// scoping (an absolute path typed there) or a whole-machine sweep.
async function runScan(explicitRoot?: string) {
  if (scanning.value) return;
  clearMessages();
  scanning.value = true;
  scanDeepening.value = false;
  const gen = ++scanGen; // invalidate this run if the dialog is reset/reopened meanwhile
  const forRoot = explicitRoot ?? scanRoot.value;
  // For an explicit root the caller (not the paste field) owns the scope, so gen alone
  // is enough to detect staleness; for the implicit path, also bail if the field changed.
  const live = () => gen === scanGen && (explicitRoot !== undefined || scanRoot.value === forRoot);
  try {
    if (forRoot) {
      // Scoped to a folder — one thorough pass (it's small, so it's fast anyway).
      scannedFolder.value = forRoot;
      const r = await scanForDevWebUI({
        roots: [forRoot],
        preset: "scoped",
        detectPackages: true,
      });
      if (live()) scanResult.value = r;
      return;
    }
    // Whole machine, tiered: shallow+fast first (the likely projects), then deep for outliers.
    const tier1 = await scanForDevWebUI({ preset: "quick", detectPackages: true });
    if (!live()) return; // user typed a path, or the dialog was reset
    scanResult.value = tier1;
    scanDeepening.value = true;
    const tier2 = await scanForDevWebUI({ preset: "deep", detectPackages: true });
    if (live()) scanResult.value = tier2; // tier-2 is a superset — replace
  } catch {
    if (gen === scanGen) error.value = t("addProject.scanFailed");
  } finally {
    if (gen === scanGen) {
      scanning.value = false;
      scanDeepening.value = false;
    }
  }
}

// Native folder picker, scoped straight into a scan — the discoverable alternative
// to knowing that pasting an absolute path above also narrows the scan.
async function browseScanFolder() {
  if (busy.value || scanning.value) return;
  try {
    const r = await browseForFolder();
    if (r.ok && r.path) {
      scanFolder.value = r.path;
      void runScan(r.path);
    }
  } catch {
    error.value = t("addProject.errPicker");
  }
}

// Enter in the "scan a specific folder" field — scan whatever was typed/pasted there.
function scanTypedFolder() {
  const f = scanFolder.value.trim();
  if (f) void runScan(f);
}

async function addFound(file: string) {
  if (busy.value) return;
  error.value = "";
  note.value = "";
  busy.value = true;
  let res: AddResult | undefined;
  try {
    res = await store.loadProjectByPath(file);
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("addProject.requestFailed");
  } finally {
    busy.value = false;
  }
  if (res) finish(res);
}

async function submit() {
  if (busy.value) return;
  const val = input.value.trim();
  if (!val) {
    error.value = t("addProject.errPasteOrDrag");
    return;
  }
  if (isGitUrl.value && !dest.value.trim()) {
    error.value = t("addProject.errChooseDest");
    return;
  }
  clearMessages();
  busy.value = true;
  let res: AddResult | undefined;
  try {
    res = isGitUrl.value
      ? await store.cloneProject(val, dest.value.trim())
      : await store.loadProjectByPath(val);
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("addProject.requestFailed");
  } finally {
    busy.value = false;
  }
  if (res) finish(res); // after busy clears — a programmatic close is blocked while busy
}

async function browseFile() {
  if (busy.value) return;
  clearMessages();
  busy.value = true;
  let res: AddResult | undefined;
  try {
    res = await store.browseForProject();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("addProject.requestFailed");
  } finally {
    busy.value = false;
  }
  if (res) finish(res);
}

async function pickDest() {
  if (busy.value) return;
  try {
    const r = await browseForFolder();
    if (r.ok && r.path) dest.value = r.path;
  } catch {
    error.value = t("addProject.errPicker");
  }
}

// ---- drag & drop: best-effort path, else prompt -------------------------
function onDrop(e: DragEvent) {
  dragDepth.value = 0;
  const dt = e.dataTransfer;
  if (!dt) return;
  clearMessages();
  const gen = ++dropGen;
  const p = pathFromDrop(dt);
  if (p) {
    input.value = p;
    void submit();
    return;
  }
  // No OS path (e.g. Chrome from Explorer): read the drop client-side to
  // confirm what it is, then ask the user to pin the location.
  void readDropped(dt, gen);
}

async function readDropped(dt: DataTransfer, gen: number) {
  try {
    const entry = dt.items?.[0]?.webkitGetAsEntry?.();
    const file = dt.files?.[0];
    if (entry?.isFile && entry.name.toLowerCase().endsWith(".devwebui")) {
      promptForLocation(gen, await projectNameFromFile(file), entry.name, false);
    } else if (entry?.isDirectory) {
      const name = await findProjectNameInDir(entry as FileSystemDirectoryEntry);
      promptForLocation(gen, name, entry.name, true);
    } else if (file?.name.toLowerCase().endsWith(".devwebui")) {
      promptForLocation(gen, await projectNameFromFile(file), file.name, false);
    } else if (gen === dropGen) {
      note.value = t("addProject.errDropRead");
    }
  } catch {
    if (gen === dropGen) note.value = t("addProject.errDropRead");
  }
}

function promptForLocation(
  gen: number,
  projectName: string | null,
  droppedName: string,
  isFolder: boolean,
) {
  if (gen !== dropGen) return; // a newer drop superseded this one
  const what = projectName
    ? t("addProject.dropNamed", { name: projectName })
    : isFolder
      ? t("addProject.dropFolder", { name: droppedName })
      : droppedName;
  note.value = t("addProject.dropPrompt", { what });
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!busy) open = v }">
    <DialogContent class="max-h-[90vh] overflow-y-auto overflow-x-hidden sm:max-w-135" :aria-busy="busy">
      <!-- One wrapper so DialogContent's own grid gap never applies: the header/footer
           margins below set this dialog's spacing. -->
      <div class="flex min-w-0 flex-col">
      <DialogHeader class="mb-4">
        <DialogTitle>
          {{ takeover ? t("addProject.titleTakeover") : scanMode ? t("addProject.titleScan") : t("addProject.titleAdd") }}
        </DialogTitle>
        <DialogDescription>
          {{
            takeover
              ? t("addProject.descTakeover")
              : scanMode
                ? t("addProject.descScan")
                : t("addProject.descAdd")
          }}
        </DialogDescription>
      </DialogHeader>
      <span aria-live="polite" class="sr-only">{{ busy ? t("addProject.working") : "" }}</span>

      <!-- Take over — the added repo also auto-starts its dev server outside DevWebUI -->
      <TakeoverStep
        v-if="takeover"
        v-model:open="open"
        v-model:takeover="takeover"
        v-model:busy="busy"
        v-model:error="error"
      />

      <div
        v-else-if="!scanMode"
        class="flex min-w-0 flex-col gap-4"
        @dragover.prevent
        @dragenter.prevent="dragDepth++"
        @dragleave.prevent="dragDepth = Math.max(0, dragDepth - 1)"
        @drop.prevent="onDrop"
      >
        <!-- Manual add: drop zone, alerts, scaffold offer, paste path/URL, clone destination -->
        <AddManualForm
          v-model:scaffold="scaffold"
          v-model:input="input"
          v-model:dest="dest"
          :dragging="dragging"
          :busy="busy"
          :error="error"
          :note="note"
          :is-git-url="isGitUrl"
          @submit="submit"
          @clear-messages="clearMessages"
          @pick-dest="pickDest"
          @create-scaffold="createScaffold"
        />

        <!-- Scan a specific folder, and its results -->
        <ScanResultsPanel
          :focused="false"
          v-model:scan-folder="scanFolder"
          :busy="busy"
          :scanning="scanning"
          :scanned-folder="scannedFolder"
          :scan-result="scanResult"
          :scan-deepening="scanDeepening"
          :ignored-paths="store.ignoredProjects"
          :show-ignored="showIgnored"
          @browse-scan-folder="browseScanFolder"
          @scan-typed-folder="scanTypedFolder"
          @select="addFound"
          @ignore="ignoreDetected"
          @unignore="unignoreDetected"
        />
      </div>

      <!-- Focused scan view — only the results, opened from the ⋮ menu or launch auto-scan -->
      <ScanResultsPanel
        v-else
        :focused="true"
        v-model:scan-folder="scanFolder"
        :error="error"
        :scanning="scanning"
        :scan-result="scanResult"
        :scan-deepening="scanDeepening"
        :busy="busy"
        :ignored-paths="store.ignoredProjects"
        :show-ignored="showIgnored"
        @select="addFound"
        @ignore="ignoreDetected"
        @unignore="unignoreDetected"
        @add-manually="addManually"
      />

      <!-- No explicit Close button: the corner ✕ and click-outside both dismiss. -->
      <DialogFooter v-if="!takeover" class="mt-4 sm:justify-start">
        <!-- Focused scan view: a single rescan button. -->
        <Button v-if="scanMode" variant="ghost" :disabled="scanning || busy" @click="runScan">
          <Search class="size-4" :class="scanning ? 'animate-pulse text-primary' : ''" />
          {{ scanning ? t("addProject.scanning") : t("addProject.scanAgain") }}
        </Button>
        <Button
          v-if="scanMode && store.ignoredProjects.length"
          variant="ghost"
          :disabled="busy"
          @click="showIgnored = !showIgnored"
        >
          <Eye v-if="showIgnored" class="size-4" />
          <EyeOff v-else class="size-4" />
          {{ t("addProject.showIgnored") }}
        </Button>
        <!-- Normal add view: Scan + Browse side by side, each with a hint. -->
        <div v-else class="flex items-center gap-2">
          <Hint :label="scanHint" side="top">
            <Button variant="ghost" :disabled="scanning || busy" @click="runScan">
              <Search class="size-4" :class="scanning ? 'animate-pulse text-primary' : ''" />
              {{ scanning ? t("addProject.scanning") : t("addProject.scan") }}
            </Button>
          </Hint>
          <Hint :label="t('addProject.browseHint')" side="top">
            <Button variant="ghost" :disabled="busy" @click="browseFile">
              <FolderSearch class="size-4" /> {{ t("addProject.browseFile") }}
            </Button>
          </Hint>
        </div>
      </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>
