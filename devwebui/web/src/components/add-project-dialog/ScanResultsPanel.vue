<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { FolderPlus, FolderSearch, Search, TriangleAlert } from "@lucide/vue";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import ScanResults from "@/components/ScanResults.vue";
import type { ScanResult } from "@/api";

const { t } = useI18n({ useScope: "global" });

// `focused` selects between the two places scan results are shown:
//  - false: the compact card embedded in the manual add form, alongside the
//    "scan a specific folder" affordance (this component's own scanFolder field).
//  - true: the standalone "Scan for projects" view (⋮ menu / launch auto-scan),
//    which shows only the results (plus a loading state and an empty-slot CTA).
defineProps<{
  focused: boolean;
  error?: string; // only shown when focused
  busy: boolean;
  scanning: boolean;
  scannedFolder?: string; // only relevant when !focused
  scanResult: ScanResult | null;
  scanDeepening: boolean;
  ignoredPaths: string[];
  showIgnored: boolean;
}>();
const emit = defineEmits<{
  browseScanFolder: [];
  scanTypedFolder: [];
  select: [path: string];
  ignore: [path: string];
  unignore: [path: string];
  addManually: [];
}>();

// Explicit "scan a specific folder" card — separate from the paste-a-path field so
// scoping a scan to one folder doesn't depend on the user knowing that trick.
const scanFolder = defineModel<string>("scanFolder", { required: true });
</script>

<template>
  <!-- Focused scan view — only the results, opened from the ⋮ menu or launch auto-scan -->
  <div v-if="focused" class="flex min-w-0 flex-col gap-3">
    <Alert v-if="error" variant="destructive" class="whitespace-pre-line">
      <TriangleAlert />
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div
      v-if="scanning && !scanResult"
      class="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-6 text-sm text-muted-foreground"
    >
      <Search class="size-4 animate-pulse text-primary" />
      <span v-html="t('addProject.scanningMachine')" />
    </div>

    <ScanResults
      v-if="scanResult"
      v-auto-animate
      :result="scanResult"
      :deepening="scanDeepening"
      :busy="busy"
      :ignored-paths="ignoredPaths"
      :show-ignored="showIgnored"
      @select="emit('select', $event)"
      @ignore="emit('ignore', $event)"
      @unignore="emit('unignore', $event)"
    >
      <template #empty>
        <Button variant="outline" size="sm" :disabled="busy" @click="emit('addManually')">
          <FolderPlus class="size-4" /> {{ t("addProject.addManually") }}
        </Button>
      </template>
    </ScanResults>
  </div>

  <template v-else>
    <!-- Scan a specific folder — an explicit, discoverable alternative to the
         "paste an absolute path, then hit Scan" trick above. Visually set apart
         (tinted card, like the scaffold/take-over callouts) from the plain-text
         inputs and from the footer's whole-machine Scan button. -->
    <div class="flex flex-col gap-1.5 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <div class="flex items-center gap-2 font-medium text-foreground">
        <FolderSearch class="size-4 text-primary" />
        {{ t("addProject.scanFolderHeading") }}
      </div>
      <p class="text-xs text-muted-foreground">{{ t("addProject.scanFolderBody") }}</p>
      <div class="mt-1 flex gap-2">
        <Input
          v-model="scanFolder"
          class="flex-1"
          :placeholder="t('addProject.scanFolderPlaceholder')"
          @keydown.enter="emit('scanTypedFolder')"
        />
        <Button :disabled="busy || scanning" @click="emit('browseScanFolder')">
          <Search v-if="scanning && scannedFolder" class="size-4 animate-pulse" />
          <FolderSearch v-else class="size-4" />
          {{ scanning && scannedFolder ? t("addProject.scanning") : t("addProject.browse") }}
        </Button>
      </div>
    </div>

    <!-- Results of a machine/folder scan — kicked off by the footer Scan button
         or the "scan a specific folder" card above. -->
    <p v-if="scannedFolder && scanResult" class="px-1 text-xs text-muted-foreground">
      {{ t("addProject.scannedFolderCaption", { folder: scannedFolder }) }}
    </p>
    <ScanResults
      v-if="scanResult"
      v-auto-animate
      compact
      :result="scanResult"
      :deepening="scanDeepening"
      :busy="busy"
      :ignored-paths="ignoredPaths"
      :show-ignored="showIgnored"
      @select="emit('select', $event)"
      @ignore="emit('ignore', $event)"
      @unignore="emit('unignore', $event)"
    />
  </template>
</template>
