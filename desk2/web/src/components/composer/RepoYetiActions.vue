<script setup lang="ts">
// The bar's git actions while RepoYeti runs, in place of Create PR: one compact control, a primary button (the next step
// the repo waits for) plus a menu. Every action goes to Desk's server, which runs it in RepoYeti (the person's own click, so
// REST and not RepoYeti's approval-gated MCP). Commit, New branch, an undo and "Undo this chat's changes" ask in a small
// popover above the control first.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChatUndoPlan, RepoYetiGitAction, RepoYetiGitState } from '@shared/connectors'
import { icons } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { ITEM, MENU, SEPARATOR, SUB_TRIGGER } from './menu'
import {
  barItems,
  chatUndoApply,
  chatUndoPlan,
  commitText,
  gitStepText,
  primaryItem,
  undoLine,
  yetiAct,
  yetiDraft,
  yetiState,
  type BarGit,
  type BarItem,
  type BarKey
} from './repoyeti-bar'

const props = defineProps<{ cwd: string; chatId: string | null; git: BarGit }>()
const emit = defineEmits<{ notice: [text: string]; 'open-yeti': []; changed: [] }>()

const Chevron = icons.morePrOptions

const group = ref<HTMLElement | null>(null)
const state = ref<RepoYetiGitState | null>(null)
const busy = ref<string | null>(null)
const panel = ref<'commit' | 'branch' | 'step' | 'chat' | null>(null)
const menuOpen = ref(false)

let stateRun: AbortController | null = null
async function loadState() {
  stateRun?.abort()
  const run = new AbortController()
  stateRun = run
  try {
    const s = await yetiState(props.cwd, run.signal)
    if (!run.signal.aborted) state.value = s
  } catch {
    if (!run.signal.aborted) state.value = null
  }
}
watch(() => [props.cwd, props.git.branch, props.git.ahead, props.git.behind], loadState, { immediate: true })
watch(menuOpen, (o) => o && loadState())
onBeforeUnmount(() => stateRun?.abort())

const items = computed(() => barItems(props.git, state.value, !!props.chatId))
const primary = computed(() => primaryItem(props.git))
const item = (key: BarKey): BarItem => items.value.find((i) => i.key === key)!
const primaryEnabled = computed(() => item(primary.value.key).enabled && !busy.value)

// One action, with its notice and a refresh of the bar's counts.
async function act(action: RepoYetiGitAction, label: string, extra: { message?: string; amend?: boolean; branch?: string } = {}): Promise<boolean> {
  busy.value = label
  try {
    const res = await yetiAct(action, { cwd: props.cwd, ...extra })
    emit('notice', res.message)
    if (res.compareUrl) window.open(res.compareUrl, '_blank', 'noopener')
    return true
  } catch (e) {
    emit('notice', e instanceof Error ? e.message : String(e))
    return false
  } finally {
    busy.value = null
    emit('changed')
    void loadState()
  }
}

// Commit box
const message = ref('')
const drafting = ref(false)
const amend = ref(false)
const messageBox = ref<HTMLTextAreaElement | null>(null)
async function openCommit() {
  panel.value = 'commit'
  amend.value = false
  drafting.value = true
  await nextTick()
  messageBox.value?.focus()
  const draft = await yetiDraft(props.cwd).catch(() => null)
  // What the person typed while the draft came wins over it.
  message.value = commitText(draft, message.value)
  drafting.value = false
}
async function commit() {
  if (!message.value.trim() || busy.value) return
  panel.value = null
  if (await act('commit', 'Committing', { message: message.value, amend: amend.value })) message.value = ''
}

// New branch
const branchName = ref('')
const branchBox = ref<HTMLInputElement | null>(null)
async function openBranch() {
  panel.value = 'branch'
  branchName.value = ''
  await nextTick()
  branchBox.value?.focus()
}
async function createBranch() {
  const name = branchName.value.trim()
  if (!name || busy.value) return
  panel.value = null
  await act('branch', 'Creating the branch', { branch: name })
}

// Undo or redo of the last git action
const stepAction = ref<'undo' | 'redo'>('undo')
function openStep(a: 'undo' | 'redo') {
  stepAction.value = a
  panel.value = 'step'
}
const stepText = computed(() => (stepAction.value === 'undo' ? gitStepText('Undo', state.value?.undo ?? null) : gitStepText('Redo', state.value?.redo ?? null)))
async function runStep() {
  panel.value = null
  await act(stepAction.value, stepAction.value === 'undo' ? 'Undoing' : 'Redoing')
}

// Undo this chat's changes
const plan = ref<ChatUndoPlan | null>(null)
const planError = ref<string | null>(null)
const picked = ref<Set<string>>(new Set())
async function openChatUndo() {
  if (!props.chatId) return
  panel.value = 'chat'
  plan.value = null
  planError.value = null
  try {
    const p = await chatUndoPlan(props.chatId)
    plan.value = p
    picked.value = new Set(p.files.filter((f) => f.state === 'ready').map((f) => f.path))
  } catch (e) {
    planError.value = e instanceof Error ? e.message : String(e)
  }
}
function toggle(path: string) {
  const next = new Set(picked.value)
  if (!next.delete(path)) next.add(path)
  picked.value = next
}
async function runChatUndo() {
  if (!props.chatId || !picked.value.size) return
  busy.value = 'Undoing the chat’s changes'
  panel.value = null
  try {
    const res = await chatUndoApply(props.chatId, [...picked.value])
    const n = res.done.length
    emit('notice', res.skipped.length ? `Put back ${n} ${n === 1 ? 'file' : 'files'}; skipped ${res.skipped.length}: ${res.skipped[0]!.reason}` : `Put back ${n} ${n === 1 ? 'file' : 'files'}`)
  } catch (e) {
    emit('notice', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = null
    emit('changed')
  }
}

function run(key: BarKey) {
  switch (key) {
    case 'commit':
      return void openCommit()
    case 'push':
      return void act('push', 'Pushing')
    case 'pull':
      return void act('pull', 'Pulling')
    case 'create-pr':
      return void act('create-pr', 'Creating the PR page')
    case 'new-branch':
      return void openBranch()
    case 'undo':
      return openStep('undo')
    case 'redo':
      return openStep('redo')
    case 'undo-chat':
      return void openChatUndo()
    case 'open':
      return emit('open-yeti')
  }
}

const other = computed(() => state.value?.branches.filter((b) => b !== props.git.branch) ?? [])
const sections: BarKey[][] = [['commit', 'push', 'pull', 'create-pr'], ['new-branch'], ['undo', 'redo'], ['undo-chat', 'open']]
const BTN = 'text-[13px] font-medium text-[var(--text)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent'
const FIELD =
  'w-full rounded-[var(--radius-6)] bg-[var(--fill-5)] px-2 py-1 text-[13px] leading-[19px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus-visible:ring-1 focus-visible:ring-[var(--border)]'
const ACT = 'flex h-6 items-center rounded-[var(--radius-6)] px-2.5 text-[13px] font-medium transition-colors duration-[60ms]'
</script>

<template>
  <Popover :open="panel !== null" @update:open="(o: boolean) => !o && (panel = null)">
    <PopoverAnchor as="template" :reference="group ?? undefined" />
    <div
      ref="group"
      role="group"
      aria-label="Git actions"
      class="flex h-6 shrink-0 items-stretch overflow-hidden rounded-(--radius-6) bg-(--fill-secondary)"
    >
      <Tip :label="busy ?? item(primary.key).hint ?? 'Run it in RepoYeti'" side="top">
        <button type="button" :class="BTN" class="px-2" :aria-disabled="!primaryEnabled" :disabled="!primaryEnabled" @click="run(primary.key)">
          {{ busy ?? primary.label }}
        </button>
      </Tip>
      <span class="my-1 w-px bg-(--border)" />
      <DropdownMenu v-model:open="menuOpen">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="flex w-6 items-center justify-center text-(--text-muted) transition-colors duration-60 hover:bg-(--fill-hover) hover:text-(--text)"
            aria-label="Git actions in RepoYeti"
          >
            <Chevron class="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" :side-offset="6" :class="MENU">
          <template v-for="(keys, i) in sections" :key="i">
            <DropdownMenuSeparator v-if="i > 0" :class="SEPARATOR" />
            <template v-for="k in keys" :key="k">
              <DropdownMenuSub v-if="k === 'new-branch'">
                <DropdownMenuSubTrigger :class="[ITEM, SUB_TRIGGER]" :disabled="!other.length">Switch branch</DropdownMenuSubTrigger>
                <DropdownMenuSubContent :class="MENU">
                  <DropdownMenuItem v-for="b in other" :key="b" :class="ITEM" @select="act('checkout', 'Switching', { branch: b })">{{ b }}</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem :class="ITEM" :disabled="!item(k).enabled || !!busy" @select="run(k)">
                {{ item(k).label }}
                <span v-if="item(k).hint" class="ms-auto ps-3 text-(--text-muted)">{{ item(k).hint }}</span>
              </DropdownMenuItem>
            </template>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- The menu hands focus back to its trigger as it closes; that is not a click outside the panel it just opened. -->
    <PopoverContent side="top" align="end" :side-offset="6" flush @focus-outside.prevent class="w-85 rounded-(--radius-10) border-0 bg-(--bg-popover) p-2.5 shadow-(--shadow-menu-ringed) ring-0">
      <form v-if="panel === 'commit'" class="flex flex-col gap-2" aria-label="Commit" @submit.prevent="commit">
        <textarea
          ref="messageBox"
          v-model="message"
          rows="4"
          :class="FIELD"
          class="resize-none"
          :placeholder="drafting ? 'RepoYeti is drafting a message…' : 'Commit message'"
          aria-label="Commit message"
          @keydown.ctrl.enter.prevent="commit"
        />
        <div class="flex items-center gap-2">
          <label class="flex items-center gap-1.5 text-[13px] text-(--text-muted)">
            <input v-model="amend" type="checkbox" class="size-3.5" />
            Amend the last commit
          </label>
          <span class="tnum ms-auto text-[13px] text-(--text-muted)">{{ props.git.changed }} {{ props.git.changed === 1 ? 'file' : 'files' }}</span>
          <button type="submit" :class="ACT" class="bg-(--fill-secondary) hover:bg-(--fill-secondary-hover) disabled:opacity-50" :disabled="!message.trim()">Commit</button>
        </div>
      </form>

      <form v-else-if="panel === 'branch'" class="flex flex-col gap-2" aria-label="New branch" @submit.prevent="createBranch">
        <input ref="branchBox" v-model="branchName" :class="FIELD" placeholder="New branch name" aria-label="New branch name" />
        <p class="text-[13px] text-(--text-muted)">Created from {{ props.git.branch }} and switched to.</p>
        <button type="submit" :class="ACT" class="self-end bg-(--fill-secondary) hover:bg-(--fill-secondary-hover) disabled:opacity-50" :disabled="!branchName.trim()">Create</button>
      </form>

      <div v-else-if="panel === 'step'" class="flex flex-col gap-2" role="alertdialog" aria-label="Confirm">
        <p class="text-[13px]/4.75">{{ stepText }}</p>
        <div class="flex justify-end gap-1.5">
          <button type="button" :class="ACT" class="text-(--text-muted) hover:bg-(--fill-hover)" @click="panel = null">Cancel</button>
          <button type="button" :class="ACT" class="bg-(--fill-secondary) hover:bg-(--fill-secondary-hover)" @click="runStep">
            {{ stepAction === 'undo' ? 'Undo' : 'Redo' }}
          </button>
        </div>
      </div>

      <div v-else-if="panel === 'chat'" class="flex flex-col gap-2" role="alertdialog" aria-label="Undo this chat's changes">
        <p class="text-[13px] font-medium leading-4.75">Put these files back to how they were before this chat</p>
        <p v-if="planError" class="text-[13px] text-(--text-muted)">{{ planError }}</p>
        <p v-else-if="!plan" class="text-[13px] text-(--text-muted)">Reading the chat…</p>
        <p v-else-if="!plan.files.length" class="text-[13px] text-(--text-muted)">This chat changed no files that are still different.</p>
        <ul v-else class="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          <li v-for="f in plan.files" :key="f.path" class="flex items-start gap-1.5 text-[13px] leading-4.75">
            <input type="checkbox" class="mt-0.75 size-3.5 shrink-0" :checked="picked.has(f.path)" :disabled="f.state !== 'ready'" :aria-label="undoLine(f)" @change="toggle(f.path)" />
            <span class="min-w-0 flex-1">
              <Tip :label="f.path"><span class="block truncate font-mono">{{ f.path }}</span></Tip>
              <span v-if="f.state === 'ready'" class="tnum text-[12px]">
                <span class="text-(--git-add)">+{{ f.added }}</span> <span class="text-(--git-del)">−{{ f.removed }}</span>
                <span v-if="f.kind === 'delete'" class="text-(--text-muted)"> · created by the chat, deleted</span>
              </span>
              <span v-else class="block text-[12px] text-(--text-muted)">Left alone: {{ f.reason }}</span>
            </span>
          </li>
        </ul>
        <div class="flex justify-end gap-1.5">
          <button type="button" :class="ACT" class="text-(--text-muted) hover:bg-(--fill-hover)" @click="panel = null">Cancel</button>
          <button type="button" :class="ACT" class="bg-(--fill-secondary) hover:bg-(--fill-secondary-hover) disabled:opacity-50" :disabled="!picked.size" @click="runChatUndo">
            Undo {{ picked.size }} {{ picked.size === 1 ? 'file' : 'files' }}
          </button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
