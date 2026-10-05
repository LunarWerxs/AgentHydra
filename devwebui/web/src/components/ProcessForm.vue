<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  FolderOpen,
  Hash,
  Link2,
  Network,
  Palette,
  Plug,
  SquareTerminal,
  Tag,
  Timer,
  TriangleAlert,
  Users,
  X,
} from "@lucide/vue";
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import SettingsGroup from "@/shell/SettingsGroup.vue";
import SettingsRow from "@/shell/SettingsRow.vue";
import InfoHint from "@/shell/InfoHint.vue";
import IconButton from "./IconButton.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addProcess, deleteProcess, updateProcess } from "@/api";
import { useAppStore } from "@/store";
import type { ProcessInput, ProcessView } from "@/types";

const { t } = useI18n({ useScope: "global" });

const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{
  mode: "add" | "edit";
  projectId: string;
  initial: ProcessView | null;
}>();
const emit = defineEmits<{ saved: [] }>();
const store = useAppStore();

const form = reactive({
  id: "",
  name: "",
  command: "",
  cwd: "",
  color: "",
  port: null as number | null,
  url: "",
  autostart: false,
  // "auto" maps to no per-process runtime (use the global default).
  runtime: "auto" as "auto" | "node" | "bun",
  // A port number, or another process's id (in this same project) — waits for that
  // port to be listening before this process spawns. Typed as free text; parsed to
  // a number when it looks like one, else sent as the sibling-id string.
  waitForPort: "",
  // Sibling localIds that start together with this process (symmetric, transitive).
  links: [] as string[],
  // Start this process whenever any other process in the project is started.
  companion: false,
});

/** The project's other processes — the candidates for the "linked servers" picker. */
const linkCandidates = computed(() => {
  const processes = store.projects.find((p) => p.id === props.projectId)?.processes ?? [];
  return processes.filter((p) => p.localId !== (props.initial?.localId ?? form.id));
});

function toggleLink(localId: string) {
  form.links = form.links.includes(localId)
    ? form.links.filter((l) => l !== localId)
    : [...form.links, localId];
}

/** All / None shortcuts in the linked-servers fly-out — select every candidate, or clear. */
function setAllLinks(select: boolean) {
  form.links = select ? linkCandidates.value.map((p) => p.localId) : [];
}

/** Keep the linked-servers fly-out open while ticking multiple entries: reka closes the
 *  menu on a checkbox item's `select` unless the default is prevented. */
function keepMenuOpen(e: Event) {
  e.preventDefault();
}
const runtimeOptions = [
  { label: "auto", value: "auto" },
  { label: "node", value: "node" },
  { label: "bun", value: "bun" },
];
const error = ref("");
const saving = ref(false);
const confirmDelete = ref(false);
const advancedOpen = ref(false);

watch(open, (v) => {
  if (!v) return;
  error.value = "";
  confirmDelete.value = false;
  const p = props.initial;
  advancedOpen.value = false; // always start collapsed
  form.id = p?.localId ?? "";
  form.name = p?.name ?? "";
  form.command = p?.command ?? "";
  form.cwd = p?.cwdRaw ?? "";
  form.color = p?.color ?? "";
  form.port = p?.port ?? null;
  form.url = p?.url ?? "";
  form.autostart = p?.autostart ?? false;
  form.runtime = p?.runtime ?? "auto";
  form.waitForPort = p?.waitForPort != null ? String(p.waitForPort) : "";
  form.links = [...(p?.links ?? [])];
  form.companion = p?.companion ?? false;
});

function payload(): ProcessInput {
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    command: form.command.trim(),
    cwd: form.cwd.trim() || undefined,
    color: form.color.trim() || undefined,
    port: form.port ?? undefined,
    url: form.url.trim() || undefined,
    autostart: form.autostart || undefined,
    // Not edited here, but the update replaces the whole file entry — echo it back
    // so saving an edit doesn't silently un-star the process.
    starred: props.initial?.starred || undefined,
    runtime: form.runtime === "auto" ? undefined : form.runtime,
    waitForPort: parseWaitForPort(form.waitForPort),
    links: form.links.length ? form.links : undefined,
    companion: form.companion || undefined,
  };
}

/** "" -> undefined; a bare integer -> number (literal port); anything else -> the string as-is
 *  (a sibling process id, per the schema). */
function parseWaitForPort(v: string): number | string | undefined {
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

async function save() {
  if (!form.id.trim() || !form.name.trim() || !form.command.trim()) {
    error.value = t("processForm.requiredFields");
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const res =
      props.mode === "add"
        ? await addProcess(props.projectId, payload())
        : await updateProcess(props.projectId, props.initial!.localId, payload());
    if (res?.error) {
      error.value = res.error;
      return;
    }
    emit("saved");
    open.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("processForm.saveFailed");
  } finally {
    saving.value = false;
  }
}

function onColorPick(e: Event) {
  form.color = (e.target as HTMLInputElement).value;
}

async function remove() {
  if (!props.initial) return;
  saving.value = true;
  error.value = "";
  try {
    const res = await deleteProcess(props.projectId, props.initial.localId);
    if (res?.error) {
      error.value = res.error;
      return;
    }
    emit("saved");
    open.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("processForm.deleteFailed");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!saving) open = v }">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-120" :aria-busy="saving">
      <DialogHeader>
        <DialogTitle>{{ mode === "add" ? t("processForm.addProcess") : t("processForm.editProcess") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("processForm.dialogDescription") }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="save">
        <Alert v-if="error" variant="destructive">
          <TriangleAlert />
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <!-- Identity — the same settings-card idiom as the STARTUP / Advanced groups.
             Name + ID share a row: Name (variable-length label) gets the wider column,
             ID (always a short slug) the narrow one. -->
        <SettingsGroup>
          <div class="grid grid-cols-[1.5fr_1fr] gap-x-3.5 px-3.5 py-2.5 max-[440px]:grid-cols-1 max-[440px]:gap-y-3">
            <div>
              <div class="mb-1.5 flex items-center gap-1.5">
                <Tag class="size-4.5 shrink-0 text-muted-foreground" />
                <Label for="pf-name"><span class="text-sm font-normal">{{ t("processForm.labelName") }}</span></Label>
                <InfoHint>{{ t("processForm.nameHint") }}</InfoHint>
              </div>
              <Input id="pf-name" v-model="form.name" :placeholder="t('processForm.placeholderName')" />
            </div>
            <div>
              <div class="mb-1.5 flex items-center gap-1.5">
                <Hash class="size-4.5 shrink-0 text-muted-foreground" />
                <Label for="pf-id"><span class="text-sm font-normal">{{ t("processForm.labelId") }}</span></Label>
                <InfoHint>{{ t("processForm.idHint") }}</InfoHint>
              </div>
              <Input
                id="pf-id"
                v-model="form.id"
                :disabled="mode === 'edit'"
                :placeholder="t('processForm.placeholderId')"
              />
            </div>
          </div>
        </SettingsGroup>

        <!-- Startup behaviour — compact settings-style rows: verbose copy lives behind the
             InfoHint (ⓘ) hover, and linked servers collapse into a fly-out instead of a
             full-width grid taking over the dialog. -->
        <SettingsGroup :label="t('processForm.startupGroup')">
          <SettingsRow :icon="Plug" :label="t('processForm.autostartLabel')">
            <template #info><InfoHint>{{ t("processForm.autostartDescription") }}</InfoHint></template>
            <template #control>
              <Switch
                id="pf-autostart"
                :model-value="form.autostart"
                :aria-label="t('processForm.autostartLabel')"
                @update:model-value="(v: boolean) => (form.autostart = v)"
              />
            </template>
          </SettingsRow>

          <SettingsRow :icon="Users" :label="t('processForm.companionLabel')">
            <template #info><InfoHint>{{ t("processForm.companionDescription") }}</InfoHint></template>
            <template #control>
              <Switch
                id="pf-companion"
                :model-value="form.companion"
                :aria-label="t('processForm.companionLabel')"
                @update:model-value="(v: boolean) => (form.companion = v)"
              />
            </template>
          </SettingsRow>

          <SettingsRow v-if="linkCandidates.length" :icon="Link2" :label="t('processForm.linksLabel')">
            <template #info><InfoHint>{{ t("processForm.linksDescription") }}</InfoHint></template>
            <template #control>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button type="button" variant="outline" size="lg">
                    {{ form.links.length ? t("processForm.linksCount", { count: form.links.length }) : t("processForm.linksNone") }}
                    <ChevronDown class="ms-0.5 size-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="max-w-56">
                  <!-- Quick All / None with a live count, so a long candidate list isn't ticked one by one. -->
                  <div class="flex items-center justify-between gap-2 px-2 py-1">
                    <span class="text-2xs tabular-nums text-muted-foreground">{{ form.links.length }}/{{ linkCandidates.length }}</span>
                    <div class="flex items-center gap-0.5 text-xs">
                      <button
                        type="button"
                        class="rounded px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                        :disabled="form.links.length === linkCandidates.length"
                        @click="setAllLinks(true)"
                      >
                        {{ t("processForm.linksAll") }}
                      </button>
                      <span class="text-muted-foreground/40" aria-hidden="true">·</span>
                      <button
                        type="button"
                        class="rounded px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                        :disabled="form.links.length === 0"
                        @click="setAllLinks(false)"
                      >
                        {{ t("processForm.linksClear") }}
                      </button>
                    </div>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    v-for="p in linkCandidates"
                    :key="p.localId"
                    :model-value="form.links.includes(p.localId)"
                    @update:model-value="() => toggleLink(p.localId)"
                    @select="keepMenuOpen"
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <span
                        class="size-2.5 shrink-0 rounded-full bg-(--swatch)"
                        :style="{ '--swatch': p.color || 'var(--primary)' }"
                      />
                      <span class="truncate">{{ p.name }}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </template>
          </SettingsRow>
        </SettingsGroup>

        <div class="border-t border-border pt-3.5">
          <button
            type="button"
            class="flex w-full items-center gap-2 py-1.5 text-start text-sm font-medium text-muted-foreground outline-none transition hover:text-foreground focus-visible:text-foreground"
            :aria-expanded="advancedOpen"
            @click="advancedOpen = !advancedOpen"
          >
            <ChevronRight
              class="size-3.5 text-muted-foreground transition-transform"
              :class="advancedOpen ? 'rotate-90' : ''"
            />
            {{ t("processForm.advancedOptions") }}
          </button>

          <div
            class="advanced-reveal grid"
            :class="advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
          >
            <div class="min-h-0 overflow-hidden">
              <!-- Advanced fields — the same settings-card idiom as the STARTUP group:
                   each field's "· optional" / what-it-does copy now lives behind an ⓘ hover
                   instead of cluttering the label. -->
              <div class="pt-3.5">
                <SettingsGroup>
                  <div class="px-3.5 py-2.5">
                    <div class="mb-1.5 flex items-center gap-1.5">
                      <FolderOpen class="size-4.5 shrink-0 text-muted-foreground" />
                      <Label for="pf-cwd"><span class="text-sm font-normal">{{ t("processForm.labelCwd") }}</span></Label>
                      <InfoHint>{{ t("processForm.cwdHint") }}</InfoHint>
                    </div>
                    <Input id="pf-cwd" v-model="form.cwd" :placeholder="t('processForm.placeholderCwd')" />
                  </div>

                  <!-- Port + Wait-for-port share a row — both hold short values. -->
                  <div class="grid grid-cols-2 gap-x-3.5 px-3.5 py-2.5 max-[440px]:grid-cols-1 max-[440px]:gap-y-3">
                    <div>
                      <div class="mb-1.5 flex items-center gap-1.5">
                        <Network class="size-4.5 shrink-0 text-muted-foreground" />
                        <Label for="pf-port"><span class="text-sm font-normal">{{ t("processForm.labelPort") }}</span></Label>
                        <InfoHint>{{ t("processForm.portHint") }}</InfoHint>
                      </div>
                      <Input
                        id="pf-port"
                        type="number"
                        min="1"
                        :model-value="form.port ?? ''"
                        :placeholder="t('processForm.placeholderPort')"
                        @update:model-value="(v) => (form.port = v === '' || v == null ? null : Number(v))"
                      />
                    </div>
                    <div>
                      <div class="mb-1.5 flex items-center gap-1.5">
                        <Timer class="size-4.5 shrink-0 text-muted-foreground" />
                        <Label for="pf-wait-for-port"><span class="text-sm font-normal">{{ t("processForm.labelWaitForPort") }}</span></Label>
                        <InfoHint>{{ t("processForm.waitForPortHint") }}</InfoHint>
                      </div>
                      <Input
                        id="pf-wait-for-port"
                        v-model="form.waitForPort"
                        :placeholder="t('processForm.placeholderWaitForPort')"
                      />
                    </div>
                  </div>

                  <div class="px-3.5 py-2.5">
                    <div class="mb-1.5 flex items-center gap-1.5">
                      <ExternalLink class="size-4.5 shrink-0 text-muted-foreground" />
                      <Label for="pf-url"><span class="text-sm font-normal">{{ t("processForm.labelUrl") }}</span></Label>
                      <InfoHint>{{ t("processForm.urlHint") }}</InfoHint>
                    </div>
                    <Input id="pf-url" v-model="form.url" :placeholder="t('processForm.placeholderUrl')" />
                  </div>

                  <SettingsRow :icon="Palette" :label="t('processForm.labelColor')">
                    <template #info><InfoHint>{{ t("processForm.colorHint") }}</InfoHint></template>
                    <template #control>
                      <label
                        class="relative block size-7 cursor-pointer overflow-hidden rounded-md border border-border bg-(--swatch)"
                        :style="{ '--swatch': form.color || 'var(--primary)' }"
                        :title="form.color || t('processForm.titlePickColor')"
                      >
                        <input
                          type="color"
                          class="absolute -inset-1 size-[150%] cursor-pointer border-0 bg-transparent p-0"
                          :value="form.color || '#6366f1'"
                          :aria-label="t('processForm.titlePickColor')"
                          @input="onColorPick"
                        />
                      </label>
                    </template>
                  </SettingsRow>

                  <SettingsRow :icon="Cpu" :label="t('processForm.labelRuntime')">
                    <template #info><InfoHint>{{ t("processForm.runtimeHint") }}</InfoHint></template>
                    <template #control>
                      <Select v-model="form.runtime">
                        <SelectTrigger id="pf-runtime" class="h-8 w-28" :aria-label="t('processForm.labelRuntime')">
                          <SelectValue :placeholder="t('processForm.runtimeAuto')" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="o in runtimeOptions" :key="o.value" :value="o.value">
                            {{ o.value === "auto" ? t("processForm.runtimeAuto") : o.value === "node" ? t("processForm.runtimeNode") : t("processForm.runtimeBun") }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </template>
                  </SettingsRow>

                  <div class="px-3.5 py-2.5">
                    <div class="mb-1.5 flex items-center gap-1.5">
                      <SquareTerminal class="size-4.5 shrink-0 text-muted-foreground" />
                      <Label for="pf-cmd"><span class="text-sm font-normal">{{ t("processForm.labelCommand") }}</span></Label>
                      <InfoHint>{{ t("processForm.commandHint") }}</InfoHint>
                    </div>
                    <Input id="pf-cmd" v-model="form.command" :placeholder="t('processForm.placeholderCommand')" />
                  </div>
                </SettingsGroup>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter :class="mode === 'edit' ? 'sm:justify-between' : ''">
          <div v-if="confirmDelete" class="flex items-center gap-2">
            <Button type="button" variant="destructive" :disabled="saving" @click="remove">
              {{ t("processForm.confirmDelete") }}
            </Button>
            <IconButton
              type="button"
              variant="ghost"
              size="icon"
              :tooltip="t('processForm.cancelDelete')"
              :disabled="saving"
              @click="confirmDelete = false"
            >
              <X class="size-4" />
            </IconButton>
          </div>
          <Button
            v-else-if="mode === 'edit'"
            type="button"
            variant="destructive"
            :disabled="saving"
            @click="confirmDelete = true"
          >
            {{ t("processForm.delete") }}
          </Button>
          <div class="ms-auto flex items-center gap-2">
            <Button type="button" variant="ghost" :disabled="saving" @click="open = false">
              {{ t("processForm.cancel") }}
            </Button>
            <Button type="submit" :disabled="saving">
              {{ mode === "add" ? t("processForm.add") : t("processForm.save") }}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
