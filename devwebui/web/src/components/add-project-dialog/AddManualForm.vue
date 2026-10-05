<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, FolderSearch, GitBranch, Sparkles, TriangleAlert, Upload } from "@lucide/vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ProjectProposal } from "@/api";

defineProps<{
  dragging: boolean;
  busy: boolean;
  error: string;
  note: string;
  isGitUrl: boolean;
}>();
const emit = defineEmits<{
  submit: [];
  clearMessages: [];
  pickDest: [];
  createScaffold: [];
}>();

const { t } = useI18n({ useScope: "global" });

// Set when a folder has no .devwebui but the daemon detected dev scripts to build one from.
const scaffold = defineModel<{ dir: string; fileName: string; proposal: ProjectProposal } | null>(
  "scaffold",
  { required: true },
);
const input = defineModel<string>("input", { required: true }); // a local path OR a git URL
const dest = defineModel<string>("dest", { required: true }); // git clone destination

// "a Vite" / "an Astro" / "a Node" — correct article for the detected framework.
const detectedFramework = computed(() => {
  const fw = scaffold.value?.proposal.framework;
  if (!fw) return { article: "a", label: "Node" };
  return { article: /^[aeiou]/i.test(fw) ? "an" : "a", label: fw };
});
</script>

<template>
  <!-- Drop zone -->
  <div
    class="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors"
    :class="dragging ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground'"
  >
    <Upload class="size-6" :class="dragging ? 'text-primary' : 'text-muted-foreground'" />
    <p class="text-sm" v-html="t('addProject.dropZone')" />
  </div>

  <Alert v-if="error" variant="destructive" class="whitespace-pre-line">
    <TriangleAlert />
    <AlertDescription>{{ error }}</AlertDescription>
  </Alert>
  <Alert v-else-if="note" variant="warning">
    <TriangleAlert />
    <AlertDescription>{{ note }}</AlertDescription>
  </Alert>

  <!-- Detected project — offer to scaffold a .devwebui -->
  <div
    v-if="scaffold"
    v-auto-animate
    class="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm"
  >
    <div class="flex items-center gap-2 font-medium">
      <Sparkles class="size-4 text-primary" />
      <span v-html="t('addProject.scaffoldHeading')" />
    </div>
    <i18n-t keypath="addProject.detected" tag="p" scope="global" class="mt-1 text-muted-foreground">
      <template #article>{{ detectedFramework.article }}</template>
      <template #framework><span class="text-foreground">{{ detectedFramework.label }}</span></template>
      <template #file><code class="text-foreground">{{ scaffold.fileName }}</code></template>
    </i18n-t>
    <ul class="mt-2 flex flex-col gap-1.5">
      <li v-for="p in scaffold.proposal.processes" :key="p.id" class="flex items-center gap-2">
        <span class="size-2 shrink-0 rounded-full bg-(--dot-color)" :style="{ '--dot-color': p.color || 'var(--process-dot-fallback)' }" />
        <span class="shrink-0 text-foreground">{{ p.name }}</span>
        <code class="truncate text-xs text-muted-foreground">
          <span v-if="p.cwd" class="opacity-70">{{ p.cwd }} › </span>{{ p.command }}
        </code>
        <span v-if="p.port" class="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          :{{ p.port }}
        </span>
      </li>
    </ul>
    <p v-if="scaffold.proposal.truncated" class="mt-1.5 text-xs text-muted-foreground">
      {{ t("addProject.moreOmitted", scaffold.proposal.truncated) }}
    </p>
    <div class="mt-3 flex gap-2">
      <Button size="sm" :disabled="busy" @click="emit('createScaffold')">
        <Sparkles class="size-4" /> {{ t("addProject.createAdd") }}
      </Button>
      <Button size="sm" variant="ghost" :disabled="busy" @click="scaffold = null">{{ t("addProject.cancel") }}</Button>
    </div>
  </div>

  <!-- Paste a path or git URL -->
  <div class="flex flex-col gap-1.5 text-sm">
    <Label for="add-path"><span class="font-normal text-muted-foreground">{{ t("addProject.pasteLabel") }}</span></Label>
    <div class="flex gap-2">
      <Input
        id="add-path"
        v-model="input"
        class="flex-1"
        :placeholder="t('addProject.pastePlaceholder')"
        @update:model-value="emit('clearMessages')"
        @keydown.enter="emit('submit')"
      />
      <Button :disabled="busy || !input.trim() || (isGitUrl && !dest.trim())" @click="emit('submit')">
        <component :is="isGitUrl ? GitBranch : FolderOpen" class="size-4" />
        {{ isGitUrl ? t("addProject.cloneAdd") : t("addProject.add") }}
      </Button>
    </div>
  </div>

  <!-- Clone destination — only when the input looks like a git URL -->
  <div v-if="isGitUrl" v-auto-animate class="flex flex-col gap-1.5 text-sm">
    <Label for="add-dest"><span class="font-normal text-muted-foreground">{{ t("addProject.cloneInto") }}</span></Label>
    <div class="flex gap-2">
      <Input id="add-dest" v-model="dest" class="flex-1" :placeholder="t('addProject.destPlaceholder')" @update:model-value="emit('clearMessages')" />
      <Button variant="outline" :disabled="busy" @click="emit('pickDest')">
        <FolderSearch class="size-4" /> {{ t("addProject.browse") }}
      </Button>
    </div>
    <span class="text-xs text-muted-foreground" v-html="t('addProject.cloneHint')" />
  </div>
</template>
