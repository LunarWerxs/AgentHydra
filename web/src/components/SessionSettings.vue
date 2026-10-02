<script setup lang="ts">
// The Sessions list's own settings, opened from its ⋯ menu (owner, 2026-10-01: "move all the
// settings that make sense to their pages"). Which editor opens a session's file, what Copy session
// file location puts on the clipboard, the search index, and the ChatGPT handoff in a session's
// composer: all four act on sessions, and all four sat in the Settings panel before.
import {
  ChevronDown,
  ClipboardCopy,
  DatabaseZap,
  FilePenLine,
  MessageCircleQuestion,
  RotateCcw,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAppSettings } from '@/composables/useAppSettings'
import { useUiPrefs } from '@/composables/useUiPrefs'
import type { SearchIndexStatus } from '@/lib/api'
import * as api from '@/lib/api'
import { baseName, formatBytes } from '@/lib/format'
import { composeSessionPathClipboard } from '@/lib/session-clipboard'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsGroup from '@/shell/SettingsGroup.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
const {
  transcriptEditor,
  transcriptEditorResolved,
  chatGptHandoffEnabled,
  loaded,
  load,
  update: updateAppSettings,
} = useAppSettings()
onMounted(() => {
  if (!loaded.value) void load()
})

async function setHandoff(value: boolean) {
  if (!(await updateAppSettings({ chatGptHandoffEnabled: value })))
    toast.error(t('settings.providerToastFailed'))
}

// --- transcript editor (server/src/transcript-open.ts): which editor "Open the session file"
// hands the .jsonl to, so it never hits Windows' unassociated-extension "Pick an app" dialog ---
// Collapsed by default: auto-detect is right for nearly everyone, so the path field is a
// destination you go looking for, not something the panel puts in front of you.
const editorOpen = ref(false)

// --- the search index, the one file we put on disk that nobody asked for ---------------------
// Shown with its real size and a delete button, because an index the user cannot see or remove is
// a very different promise from one they can. It rebuilds itself from the transcripts on the next
// search, so removing it costs time and nothing else.
const searchIndex = ref<SearchIndexStatus | null>(null)
const deletingSearchIndex = ref(false)

async function refreshSearchIndex() {
  try {
    searchIndex.value = await api.getSearchIndex()
  } catch {
    searchIndex.value = null // an unreachable daemon simply hides the row's detail
  }
}
onMounted(refreshSearchIndex)

async function removeSearchIndex() {
  deletingSearchIndex.value = true
  try {
    searchIndex.value = await api.deleteSearchIndex()
    toast.success(t('settings.searchIndexDeleted'))
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('settings.searchIndexDeleteFailed'))
  } finally {
    deletingSearchIndex.value = false
  }
}

// "Copy session file location" used to put a bare path on the clipboard. These decide what else
// goes with it; both default on, and with both off the result is byte-for-byte what it always was.
const { copyPathIncludeName, copyPathIncludePrompt, copyPathPrompt } = useUiPrefs()
const copyPathOpen = ref(false)
/** Shown live in the settings row, because the only honest way to describe a clipboard format is
 *  to display it. */
const copyPathPreview = computed(() =>
  composeSessionPathClipboard({
    path: 'C:\\Users\\you\\.claude\\projects\\my-repo\\a1b2c3d4.jsonl',
    title: 'Postal server connection setup',
    includeName: copyPathIncludeName.value,
    includePrompt: copyPathIncludePrompt.value,
    prompt: copyPathPrompt.value,
  }),
)

async function saveTranscriptEditor() {
  if (!(await updateAppSettings({ transcriptEditor: transcriptEditor.value.trim() })))
    toast.error(t('settings.transcriptEditorToastFailed'))
}
/** Back to auto-detect. Clearing the box by hand works too, but an explicit "unset this" is the
 *  only affordance that reads as reversible once a path is in there. */
async function resetTranscriptEditor() {
  transcriptEditor.value = ''
  await saveTranscriptEditor()
}
/** The typed override exists but is not what will run, i.e. the server discarded it as a dead path
 *  and fell back to auto-detect. Worth a warning: the field looks honoured but isn't. */
const editorOverrideIgnored = computed(() => {
  const typed = transcriptEditor.value.trim()
  return !!typed && !!transcriptEditorResolved.value && typed !== transcriptEditorResolved.value
})
</script>

<template>
  <SettingsGroup>
    <!-- Transcript editor: auto-detect is right for nearly everyone (VS Code / Cursor /
         Notepad++ / Sublime), so the path field is a nested disclosure the row states the
         resolved editor and reveals the input only if you go looking for it. -->
    <SettingsRow
      :icon="FilePenLine"
      :label="$t('settings.transcriptEditorLabel')"
      clickable
      @click="editorOpen = !editorOpen"
    >
      <template #info>
        <InfoHint :text="$t('settings.transcriptEditorHint')" />
      </template>
      <template #control>
        <span
          class="max-w-44 truncate"
          :class="editorOverrideIgnored ? 'text-warning' : ''"
          :title="transcriptEditorResolved || undefined"
        >
          {{
            transcriptEditorResolved
              ? baseName(transcriptEditorResolved)
              : $t('settings.transcriptEditorPlaceholder')
          }}
        </span>
        <Badge v-if="transcriptEditor.trim()" variant="secondary">
          {{ $t('settings.transcriptEditorCustomBadge') }}
        </Badge>
        <ChevronDown
          class="size-4 transition-transform duration-200"
          :class="editorOpen ? 'rotate-180' : ''"
        />
      </template>
    </SettingsRow>
    <ExpandTransition :open="editorOpen">
      <div class="space-y-1.5 px-3.5 pb-3.5 pt-1">
        <Input
          v-model="transcriptEditor"
          type="text"
          :placeholder="$t('settings.transcriptEditorPlaceholder')"
          variant="mono"
          class="w-full"
          @change="saveTranscriptEditor"
        />
        <p
          class="text-2xs"
          :class="editorOverrideIgnored ? 'text-warning' : 'text-muted-foreground'"
        >
          {{
            editorOverrideIgnored
              ? $t('settings.transcriptEditorNotFound', { editor: baseName(transcriptEditorResolved) })
              : $t('settings.transcriptEditorResolved', { editor: baseName(transcriptEditorResolved) })
          }}
        </p>
        <Button
          v-if="transcriptEditor.trim()"
          variant="ghost"
          size="xs"
          @click="resetTranscriptEditor"
        >
          <RotateCcw /> {{ $t('settings.transcriptEditorReset') }}
        </Button>
      </div>
    </ExpandTransition>
    <!-- Copying a session's file location. The preview is the control that matters: a
         clipboard format described in prose is a format nobody can picture. -->
    <SettingsRow
      :icon="ClipboardCopy"
      :label="$t('settings.copyPathLabel')"
      clickable
      @click="copyPathOpen = !copyPathOpen"
    >
      <template #info>
        <InfoHint :text="$t('settings.copyPathHint')" />
      </template>
      <template #control>
        <ChevronDown
          class="size-4 transition-transform duration-200"
          :class="copyPathOpen ? 'rotate-180' : ''"
        />
      </template>
    </SettingsRow>
    <ExpandTransition :open="copyPathOpen">
      <div class="space-y-3 px-3.5 pb-3.5 pt-1">
        <label class="flex items-center justify-between gap-3 text-sm">
          {{ $t('settings.copyPathIncludeNameLabel') }}
          <Switch v-model="copyPathIncludeName" />
        </label>
        <label class="flex items-center justify-between gap-3 text-sm">
          {{ $t('settings.copyPathIncludePromptLabel') }}
          <Switch v-model="copyPathIncludePrompt" />
        </label>
        <Input
          v-model="copyPathPrompt"
          type="text"
          :disabled="!copyPathIncludePrompt"
          :placeholder="$t('settings.copyPathPromptPlaceholder')"
          :aria-label="$t('settings.copyPathPromptLabel')"
          class="w-full"
        />
        <div>
          <p class="mb-1 text-2xs text-muted-foreground">
            {{ $t('settings.copyPathPreviewLabel') }}
          </p>
          <pre class="overflow-x-auto rounded border border-border bg-muted/40 p-2 font-mono text-2xs leading-relaxed text-muted-foreground">{{ copyPathPreview }}</pre>
        </div>
      </div>
    </ExpandTransition>

    <!-- The search index is the one file AgentHydra puts on disk that the user did not ask
         for, so it says how big it is and offers to remove it. It rebuilds itself from the
         transcripts, which is why deleting is a plain button and not a confirmation dance. -->
    <SettingsRow :icon="DatabaseZap" :label="$t('settings.searchIndexLabel')">
      <template #info>
        <InfoHint :text="$t('settings.searchIndexHint')" />
      </template>
      <template #description>
        {{
          searchIndex && searchIndex.exists
            ? $t('settings.searchIndexBuilt', {
                size: formatBytes(searchIndex.sizeBytes),
                n: searchIndex.sessions,
              })
            : $t('settings.searchIndexAbsent')
        }}
      </template>
      <template #control>
        <Button
          v-if="searchIndex?.exists"
          variant="outline"
          size="xs"
          :disabled="deletingSearchIndex"
          @click="removeSearchIndex"
        >
          {{ $t('settings.searchIndexDelete') }}
        </Button>
      </template>
    </SettingsRow>
    <SettingsRow
      :icon="MessageCircleQuestion"
      :label="$t('settings.chatGptHandoffLabel')"
    >
      <template #info>
        <InfoHint :text="$t('settings.chatGptHandoffHint')" />
      </template>
      <template #control>
        <Switch
          :model-value="chatGptHandoffEnabled"
          @update:model-value="setHandoff"
        />
      </template>
    </SettingsRow>
  </SettingsGroup>
</template>
