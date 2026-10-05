<script setup lang="ts">
// The composer dock, laid out like the real Claude Desktop Code tab (docs/reference/real DESIGN.md
// "Composer"): 768 wide, gap 6, top to bottom: Hydra Desk's status row (pending, queued;
// ours), the repo strip, the box, the toolbar row below the box.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { composerIcons, icons } from '@/lib/icons'
import type {
  ChatStatus,
  ChatSummary,
  Effort,
  ImageRef,
  ModelChoice,
  PermissionMode,
  GitStatus,
  CreateChatRequest,
  SlashCommandInfo
} from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import WorkerDock from '@/components/climayte/WorkerDock.vue'
import { COMPOSER_API, httpComposerApi, OPEN_CLIMAYTE_EVENT, OPEN_DIFF_EVENT, SHOW_PENDING_EVENT } from './api'
import {
  appendDictation,
  applyMention,
  applySlashCommand,
  composerKeyAction,
  STOP_GUARD_MS,
  dataUrlToBase64,
  filterMentions,
  filterSlashCommands,
  folderName,
  loadDraft,
  mentionQuery,
  dockedRequest,
  saveDraft,
  shownSuggestion,
  slashQuery,
  splitModels,
  validateImage,
  dismissTip,
  draftSlot,
  modelTriggerLabel,
  nextTip,
  type Tip as TipInfo
} from './logic'
import { dataUrlToFile, parseCopiedImages } from '@/lib/clipboard-images'
import { holdFocus } from '@/lib/hold-focus'
import { warmChat } from '@/lib/timing'
import { isExternalChatId } from '@/components/external/logic'
import { draftImages, draftImagesReady, saveDraftImages, type DraftImage } from './draft-images'
import { HEADER, ITEM, MENU, MENU_GLYPH, SEPARATOR, SHORTCUT, SUB_TRIGGER, TOOL_ICON, TOOL_VALUE } from './menu'
import SendSplit from './SendSplit.vue'
import QueueTray from './QueueTray.vue'
import QueueChip from './QueueChip.vue'
import { aheadInLine, queuedForChat, sendOrEnqueue, sendWords, type QueuedMessage } from './queue'
import ContextRing from './ContextRing.vue'
import NewSessionBar from './NewSessionBar.vue'
import McpSubmenu from './McpSubmenu.vue'
import TipBanner from './TipBanner.vue'
import RepoStrip from './RepoStrip.vue'
import { Tip } from '@/components/ui/tooltip'
import { provideTranscript } from '@/components/transcript/context'
import { useShellSource } from '@/components/shell/source'
import PermissionCard from '@/components/transcript/parts/PermissionCard.vue'
import QuestionCard from '@/components/transcript/parts/QuestionCard.vue'
import PlanCard from '@/components/transcript/parts/PlanCard.vue'
import ElicitationCard from '@/components/transcript/parts/ElicitationCard.vue'

const Check = icons.check
const Plus = icons.add
const Mic = icons.record
const DictationChevron = icons.dictationSettings
const X = icons.dismiss
const FolderIcon = icons.folder

type PendingImage = DraftImage

type MenuName = 'plus' | 'dictation' | 'mode' | 'model' | 'effort'

const props = defineProps<{
  chat: ChatSummary | null
  /** A chat working in Claude Desktop: a send goes into it as text (`send`), pictures and voice are off (`why` says so). */
  into?: { send: (text: string) => Promise<void>; why: string }
  /** Gallery only: start in a given state without a server. */
  demo?: {
    text?: string
    images?: { name: string; mediaType: string; url: string }[]
    slashOpen?: boolean
    mentionOpen?: boolean
    cwd?: string
    openMenu?: MenuName
  }
}>()
const emit = defineEmits<{ 'open-diff': [cwd: string] }>()

const desk = useDesk()
const api = inject(COMPOSER_API, httpComposerApi)
const storage = typeof localStorage === 'undefined' ? null : localStorage

const text = ref('')
// Shallow: the pictures hold large base64 strings, so they are replaced, never changed in place, and never walked.
const images = shallowRef<PendingImage[]>([])
const notice = ref<string | null>(null)
const sending = ref(false)
const dragging = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const caret = ref(0)

// One menu open at a time, like the real toolbar.
const openMenu = ref<MenuName | null>(props.demo?.openMenu ?? null)
function menuModel(name: MenuName) {
  return {
    open: openMenu.value === name,
    'onUpdate:open': (v: boolean) => (openMenu.value = v ? name : openMenu.value === name ? null : openMenu.value)
  }
}
const nonModal = !!props.demo?.openMenu // the gallery shows a menu open without trapping the page
// The real menus open with an item highlighted, even from a click: the model menu its current model,
// the others their first item. data-initial keeps that fill until the pointer or a key moves on, so it
// survives the trigger taking focus back.
const HIGHLIGHT_ON_OPEN: Partial<Record<MenuName, string>> = { plus: '', model: '[aria-checked=true]' }
watch(openMenu, (name) => {
  const selector = name ? HIGHLIGHT_ON_OPEN[name] : undefined
  if (selector === undefined) return
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (openMenu.value !== name) return
      const menu = document.querySelector<HTMLElement>(`[data-composer-menu="${name}"]`)
      const item =
        (selector ? menu?.querySelector<HTMLElement>(selector) : null) ??
        menu?.querySelector<HTMLElement>('[role^=menuitem]:not([data-disabled])')
      if (!menu || !item) return
      item.focus({ preventScroll: true })
      item.dataset.initial = ''
      const clear = () => {
        delete item.dataset.initial
        menu.removeEventListener('pointermove', clear)
        menu.removeEventListener('keydown', clear)
      }
      menu.addEventListener('pointermove', clear)
      menu.addEventListener('keydown', clear)
    })
  )
}, { immediate: true })

const chatId = computed(() => props.chat?.id ?? null)

// A pending permission, question or plan request shows its card in the dock, above the strip, in
// place of the box (the real dock's approval slot); the transcript keeps a one-line row for it.
const shellItems = useShellSource().itemsByChat
const request = computed(() => (chatId.value ? dockedRequest(props.chat, shellItems.value.get(chatId.value) ?? []) : null))
provideTranscript({
  chatId: computed(() => props.chat?.id ?? ''),
  readOnly: computed(() => false),
  cwd: computed(() => props.chat?.cwd ?? null),
  children: computed(() => new Map())
})

const BUSY: ChatStatus[] = ['working', 'starting', 'needs_you']
const busy = computed(() => !!props.chat && BUSY.includes(props.chat.status))
const hasContent = computed(() => text.value.trim().length > 0 || images.value.length > 0)
const showStop = computed(() => busy.value && !hasContent.value)

// The managed send queue (SPEC "Send queue"), once the server reports one; the server sends from it. The
// Gallery and the parity scenes have none (demo, or a source without it), so they show no queue UI.
const shell = useShellSource()
const queue = computed(() => (props.demo ? null : (shell.queue?.value ?? null)))
const chatQueue = computed(() => queuedForChat(queue.value, chatId.value))
// What the tray above the strip lists: this chat's queued messages, or on the new-session screen the new
// chats queued for its folder.
const sameFolder = (a: string, b: string | null) => !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const trayItems = computed(
  () =>
    queue.value?.items.filter((i) =>
      i.kind === 'message' ? i.chatId === chatId.value : !chatId.value && !i.startedChatId && sameFolder(i.cwd, newCwd.value)
    ) ?? []
)
const queueOpen = ref(false)
// A docked card hides the box and the send group the popover is anchored to; the dock's chip opens it then.
watch(
  () => !!request.value,
  (docked) => {
    if (docked) queueOpen.value = false
  }
)
/** Whether a send goes out now or waits in the queue; `ctrl` is Ctrl+Enter or a Ctrl-click. */
function sendDecision(ctrl: boolean): 'send' | 'enqueue' {
  if (!queue.value || !shell.queueAdd) return 'send'
  return sendOrEnqueue({ status: props.chat?.status ?? null, queued: aheadInLine(queue.value, chatId.value), sendMode: queue.value.sendMode, ctrl })
}
const enterQueues = computed(() => sendDecision(false) === 'enqueue')
const sendText = computed(() =>
  sendWords({ enqueue: enterQueues.value, busy: busy.value, newChat: !props.chat, held: !!(chatId.value && queue.value?.held[chatId.value]) })
)

// Between turns the real box shows a suggested next prompt in the placeholder's grey; Tab takes it,
// typing replaces it. Hydra Desk has no source for one, so it stays empty unless the api gives one.
const suggestion = ref('')
function loadSuggestion() {
  suggestion.value = (chatId.value ? api.suggestion?.(chatId.value) : null) ?? ''
}
const shown = computed(() => shownSuggestion(suggestion.value, { empty: !hasContent.value, busy: busy.value }))

// New-session settings (an existing chat's come from the chat itself)
const newCwd = ref<string | null>(null)
const newAccount = ref('auto')
const newModel = ref<string | null>(null)
const newEffort = ref<Effort | null>(null)
const newMode = ref<PermissionMode>('bypassPermissions')

function resetNewSession() {
  const s = desk.settings.value
  const sel = desk.selected.value
  newCwd.value = props.demo?.cwd ?? (sel.kind === 'new' && sel.cwd ? sel.cwd : newCwd.value)
  newAccount.value = s?.defaultAccountId ?? 'auto'
  newModel.value = s?.defaultModel ?? null
  newEffort.value = s?.defaultEffort ?? null
  newMode.value = s?.defaultPermissionMode ?? 'bypassPermissions'
}

const model = computed(() => (props.chat ? props.chat.model : newModel.value))
const cwd = computed(() => props.chat?.cwd ?? newCwd.value)

async function patch(p: { model?: string | null; effort?: Effort | null; permissionMode?: PermissionMode }) {
  if (!props.chat) {
    if ('model' in p) newModel.value = p.model ?? null
    if ('effort' in p) newEffort.value = p.effort ?? null
    if (p.permissionMode) newMode.value = p.permissionMode
    return
  }
  try {
    await desk.updateChat(props.chat.id, p)
  } catch (e) {
    showNotice(`Could not change it: ${errText(e)}`)
  }
}

// Models
const models = ref<ModelChoice[]>([])
const modelSplit = computed(() => splitModels(models.value))
const modelText = computed(() => modelTriggerLabel(model.value, models.value))
function pickModel(value: string | null) {
  patch({ model: value })
  openMenu.value = null
}
function onModelKey(e: KeyboardEvent) {
  const i = Number(e.key) - 1
  const m = modelSplit.value.main[i]
  if (Number.isInteger(i) && m) {
    e.preventDefault()
    pickModel(m.value)
  }
}

// Repo strip
const git = shallowRef<GitStatus | null>(null)
const dismissedFor = ref<string | null>(null)
const showStrip = computed(() => !!git.value?.isRepo && dismissedFor.value !== cwd.value)

// New session: the tip banner (dismissed tips are remembered) and the defaults once settings arrive
const tip = ref<TipInfo | null>(nextTip(storage))
function closeTip(t: TipInfo) {
  dismissTip(storage, t.id)
  tip.value = nextTip(storage)
}
function tryTip(t: TipInfo) {
  if (t.action === 'model') openMenu.value = 'model'
  else if (t.action === 'climayte') openCliMayte()
}
watch(
  () => desk.settings.value,
  (s, before) => {
    if (s && !before && !props.chat) resetNewSession()
  }
)
watch(
  () => desk.settings.value?.defaultAccountId,
  (id) => {
    if (id && !props.chat) newAccount.value = id
  }
)
// The repo is polled only while the window is shown and focused; a change of folder, a finished turn,
// and the window coming back refresh it at once.
const GIT_POLL_MS = 15_000
let gitTimer: ReturnType<typeof setInterval> | null = null
let gitRun: AbortController | null = null
async function refreshGit() {
  gitRun?.abort()
  gitRun = null
  const dir = cwd.value
  if (!dir) {
    git.value = null
    return
  }
  const run = new AbortController()
  gitRun = run
  try {
    const g = await api.git(dir, run.signal)
    // An unchanged answer keeps the object, so nothing that reads it re-renders.
    if (dir === cwd.value && JSON.stringify(g) !== JSON.stringify(git.value)) git.value = g
  } catch {
    if (!run.signal.aborted) git.value = null
  }
}
function openDiff() {
  if (!cwd.value) return
  emit('open-diff', cwd.value)
  window.dispatchEvent(new CustomEvent(OPEN_DIFF_EVENT, { detail: { cwd: cwd.value } }))
}
function createPr(draft: boolean) {
  if (!props.chat) return
  const ask = draft
    ? 'Commit the changes on this branch and open a draft pull request for it.'
    : 'Commit the changes on this branch and open a pull request for it.'
  desk.send(props.chat.id, { text: ask }).catch((e) => showNotice(`Not sent: ${errText(e)}`))
}

function openCliMayte() {
  window.dispatchEvent(new CustomEvent(OPEN_CLIMAYTE_EVENT, { detail: { originSessionId: props.chat?.sessionId ?? null } }))
}
function showPending() {
  window.dispatchEvent(new CustomEvent(SHOW_PENDING_EVENT, { detail: { chatId: chatId.value } }))
}

// Slash commands
const commands = ref<SlashCommandInfo[]>([])
let commandsFor: string | null = null
let commandsRun: AbortController | null = null
const slashIndex = ref(0)
const slashDismissed = ref(false)
const query = computed(() => slashQuery(text.value))
const slashMatches = computed(() => (query.value == null ? [] : filterSlashCommands(commands.value, query.value)))
const slashOpen = computed(() => query.value != null && !slashDismissed.value && !!props.chat)

watch(query, async (q) => {
  if (q == null) {
    slashDismissed.value = false
    return
  }
  slashIndex.value = 0
  const id = chatId.value
  if (id && commandsFor !== id) {
    commandsFor = id
    commandsRun?.abort()
    const run = new AbortController()
    commandsRun = run
    try {
      const list = await api.commands(id, run.signal)
      if (!run.signal.aborted) commands.value = list
    } catch {
      if (!run.signal.aborted) {
        commands.value = []
        commandsFor = null
      }
    }
  }
})

function pickCommand(cmd: SlashCommandInfo | undefined) {
  if (!cmd) return
  text.value = applySlashCommand(cmd)
  textarea.value?.focus()
}

// @-mentions: changed files from git plus the folder's top-level directories
const mentionDirs = ref<string[]>([])
let mentionDirsFor: string | null = null
let mentionRun: AbortController | null = null
const mentionIndex = ref(0)
const mentionDismissed = ref(false)
const mention = computed(() => mentionQuery(text.value, caret.value))
const mentionMatches = computed(() => {
  if (!mention.value) return []
  const files = (git.value?.files ?? []).map((f) => f.path)
  return filterMentions([...files, ...mentionDirs.value], mention.value.query, 20)
})
const mentionOpen = computed(() => !!mention.value && !mentionDismissed.value && !!cwd.value && !slashOpen.value)

watch(
  () => mention.value?.start ?? null,
  async (start) => {
    mentionIndex.value = 0
    if (start == null) {
      mentionDismissed.value = false
      return
    }
    const dir = cwd.value
    if (dir && mentionDirsFor !== dir) {
      mentionDirsFor = dir
      mentionRun?.abort()
      const run = new AbortController()
      mentionRun = run
      try {
        const dirs = (await api.browse(dir, run.signal)).dirs.map((d) => d + '/')
        if (!run.signal.aborted) mentionDirs.value = dirs
      } catch {
        if (!run.signal.aborted) mentionDirs.value = []
      }
    }
  }
)

function pickMention(path: string | undefined) {
  const m = mention.value
  if (!path || !m) return
  const next = applyMention(text.value, m, path)
  text.value = next.text
  nextTick(() => {
    textarea.value?.focus()
    textarea.value?.setSelectionRange(next.caret, next.caret)
    caret.value = next.caret
  })
}

function syncCaret() {
  caret.value = textarea.value?.selectionStart ?? text.value.length
}

// Text box: grows to the real max-h 384 (max-h-96), then scrolls
const MAX_TEXT_HEIGHT = 384
function autoGrow() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  const full = el.scrollHeight
  el.style.height = Math.min(full, MAX_TEXT_HEIGHT) + 'px'
  el.style.overflowY = full > MAX_TEXT_HEIGHT ? 'auto' : 'hidden'
}

// The box's text and pictures are kept per chat, and per folder for a new session (draftSlot): moving to
// another chat or workspace and back finds them as they were left.
const slot = computed(() => draftSlot(chatId.value, cwd.value))
let draftTimer: ReturnType<typeof setTimeout> | null = null
watch(text, (t) => {
  nextTick(() => {
    autoGrow()
    syncCaret()
  })
  if (props.demo) return
  // The warm start: typing in a closed SDK chat starts its process now, so its start and hooks are over by Send.
  const c = props.chat
  if (c && t.trim() && c.status === 'closed' && c.workerId === undefined && !isExternalChatId(c.id) && document.activeElement === textarea.value) warmChat(c.id)
  if (draftTimer) clearTimeout(draftTimer)
  const s = slot.value
  draftTimer = setTimeout(() => saveDraft(storage, s, t), 250)
})
watch(
  images,
  (list) => {
    if (!props.demo) saveDraftImages(slot.value, list)
  }
)

watch(
  slot,
  (s, old) => {
    if (props.demo) {
      if (old === undefined) text.value = props.demo.text ?? ''
      return
    }
    if (old !== undefined) {
      if (draftTimer) clearTimeout(draftTimer)
      saveDraft(storage, old, text.value)
      saveDraftImages(old, images.value)
    }
    // A new session's first folder arrives after typing began: what is in the box moves to that folder.
    if (old === null && s?.startsWith('new:') && !loadDraft(storage, s) && !draftImages(s).length) {
      saveDraft(storage, s, text.value)
      saveDraftImages(s, images.value)
      saveDraft(storage, null, '')
      saveDraftImages(null, [])
      return
    }
    text.value = loadDraft(storage, s)
    images.value = draftImages(s)
    void draftImagesReady.then(() => {
      if (slot.value === s && !images.value.length) images.value = draftImages(s)
    })
  },
  { immediate: true }
)

watch(
  chatId,
  (id) => {
    notice.value = null
    commands.value = []
    commandsFor = null
    loadSuggestion()
    if (!id) resetNewSession()
  },
  { immediate: true }
)

// A folder's + (or the new-session screen opened for another folder) while the new-session box is up.
watch(
  () => {
    const sel = desk.selected.value
    return sel.kind === 'new' ? (sel.cwd ?? null) : null
  },
  (dir) => {
    if (dir && !props.chat && !props.demo) newCwd.value = dir
  }
)

watch(cwd, () => {
  mentionDirsFor = null
  mentionDirs.value = []
})

const lastSent = new Map<string, string>()
function recallLast(): string | null {
  const id = chatId.value
  if (!id) return lastSent.get('new') ?? null
  if (lastSent.has(id)) return lastSent.get(id)!
  const items = desk.itemsByChat.value.get(id) ?? []
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user' && !it.parentToolUseId) return it.text
  }
  return null
}

/** Up in an empty box takes this chat's last queued message back into the box to edit, like the CLI. */
async function pullQueued(item: QueuedMessage) {
  const moved = () => hasContent.value || chatId.value !== item.chatId
  let putBack = false
  try {
    const pictures = await Promise.all((item.images ?? []).map(pendingImage))
    if (moved()) return // typed into meanwhile: the queued message stays queued
    await shell.queueRemove?.(item.id)
    if (moved()) {
      // Typed into, or another chat opened, while the remove was out: the box keeps what is there and the
      // message goes back to the end of its chat's queue.
      putBack = true
      const refs = pictures.map((p) => ({ mediaType: p.mediaType, dataBase64: p.dataBase64, name: p.name }))
      await shell.queueAdd?.({ kind: 'message', chatId: item.chatId, text: item.text, ...(refs.length ? { images: refs } : {}) })
      return
    }
    text.value = item.text
    images.value = pictures
    nextTick(() => textarea.value?.setSelectionRange(item.text.length, item.text.length))
  } catch (e) {
    showNotice(`${putBack ? 'The queued message could not go back in the queue' : 'Could not take it back'}: ${errText(e)}`)
  }
}

/** A queued picture back as an attachment: the server keeps it as a URL, a send needs its bytes. */
async function pendingImage(img: ImageRef): Promise<PendingImage> {
  let url = img.dataBase64 ? `data:${img.mediaType};base64,${img.dataBase64}` : null
  if (!url) {
    if (!img.url) throw new Error('a picture is missing')
    const res = await fetch(img.url)
    if (!res.ok) throw new Error(`a picture could not be loaded (${res.status})`)
    const blob = await res.blob()
    url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('a picture could not be read'))
      reader.readAsDataURL(blob)
    })
  }
  return { id: crypto.randomUUID(), name: img.name ?? 'Image', mediaType: img.mediaType, dataBase64: dataUrlToBase64(url), url }
}

/** Arrow/Enter/Tab/Esc for an open list menu (slash or mention). True when the key was used. */
function listKeys(e: KeyboardEvent, count: number, index: { value: number }, pick: () => void, dismiss: () => void) {
  if (e.key === 'Escape') {
    e.preventDefault()
    dismiss()
    return true
  }
  if (!count) return false
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    index.value = (index.value + (e.key === 'ArrowDown' ? 1 : count - 1)) % count
    return true
  }
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    e.preventDefault()
    pick()
    return true
  }
  return false
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (slashOpen.value && listKeys(e, slashMatches.value.length, slashIndex, () => pickCommand(slashMatches.value[slashIndex.value]), () => (slashDismissed.value = true))) return
  if (mentionOpen.value && listKeys(e, mentionMatches.value.length, mentionIndex, () => pickMention(mentionMatches.value[mentionIndex.value]), () => (mentionDismissed.value = true))) return
  switch (composerKeyAction(e, { empty: !text.value, busy: busy.value, suggestion: !!shown.value, stop: showStop.value })) {
    case 'swallow':
      e.preventDefault()
      return
    case 'accept-suggestion': {
      e.preventDefault()
      const s = shown.value
      text.value = s
      nextTick(() => textarea.value?.setSelectionRange(s.length, s.length))
      return
    }
    case 'send':
      e.preventDefault()
      submit()
      return
    case 'queue':
      e.preventDefault()
      submit(true)
      return
    case 'interrupt':
      e.preventDefault()
      stop()
      return
    case 'recall': {
      const pulled = chatQueue.value.findLast((i) => i.state !== 'sending')
      if (pulled) {
        e.preventDefault()
        pullQueued(pulled)
        return
      }
      const last = recallLast()
      if (last) {
        e.preventDefault()
        text.value = last
        nextTick(() => textarea.value?.setSelectionRange(last.length, last.length))
      }
      return
    }
    case 'attach':
      e.preventDefault()
      if (props.into) showNotice(props.into.why)
      else fileInput.value?.click()
      return
  }
}

// Images
let noticeTimer: ReturnType<typeof setTimeout> | null = null
const noticeInfo = ref(false) // a confirmation ("Queued: ..."), not a warning
function showNotice(msg: string, info = false) {
  notice.value = msg
  noticeInfo.value = info
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = null), 8000)
}

function addFiles(files: File[]) {
  if (props.into) return showNotice(props.into.why)
  for (const file of files) {
    const err = validateImage(file)
    if (err) {
      showNotice(err)
      continue
    }
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      images.value = [
        ...images.value,
        {
          id: crypto.randomUUID(),
          name: file.name || 'Pasted image',
          mediaType: file.type,
          dataBase64: dataUrlToBase64(url),
          url
        }
      ]
    }
    reader.onerror = () => showNotice(`Could not read ${file.name || 'the image'}.`)
    reader.readAsDataURL(file)
  }
}

function onPaste(e: ClipboardEvent) {
  // A message copied in Hydra Desk: its text pastes as usual, its pictures attach from the HTML
  const copied = parseCopiedImages(e.clipboardData?.getData('text/html') ?? '')
  if (copied.length) {
    addFiles(copied.map((url, i) => dataUrlToFile(url, `Pasted image ${i + 1}`)))
    return
  }
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
  if (files.length) {
    e.preventDefault()
    addFiles(files)
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) addFiles(files)
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}

function removeImage(id: string) {
  images.value = images.value.filter((i) => i.id !== id)
}

// Plus menu
function startSlash() {
  text.value = '/'
  slashDismissed.value = false
  nextTick(() => textarea.value?.focus())
}
/** The account whose .claude.json the chat reads: its own, the one picked, or where 'auto' would place it now. */
async function mcpConfigDir(): Promise<string | null> {
  if (props.chat) return props.chat.account.configDir
  if (newAccount.value === 'auto') return (await api.pickAccount()).configDir
  return desk.accounts.value.find((a) => a.id === newAccount.value)?.configDir ?? null
}

// Dictation: press and hold the mic (the browser's speech recognition, where it has one)
type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
const SpeechRecognition: (new () => Recognition) | null =
  typeof window === 'undefined' ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null)
const LANG_KEY = 'hydra-desk:dictation-lang'
const browserLang = typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US'
const dictationLangs = [...new Set([browserLang, 'en-US', 'en-GB'])]
const dictationLang = ref(storage?.getItem(LANG_KEY) || browserLang)
const recording = ref(false)
let recognition: Recognition | null = null

function setDictationLang(lang: string) {
  dictationLang.value = lang
  try {
    storage?.setItem(LANG_KEY, lang)
  } catch {}
}
function startDictation() {
  if (!SpeechRecognition) {
    showNotice('Dictation is not available in this browser.')
    return
  }
  if (recording.value) return
  const rec = new SpeechRecognition()
  rec.lang = dictationLang.value
  rec.continuous = true
  rec.interimResults = false
  rec.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i]
      if (r.isFinal) text.value = appendDictation(text.value, r[0].transcript)
    }
  }
  rec.onerror = (ev) => {
    if (ev.error !== 'no-speech' && ev.error !== 'aborted') showNotice(`Dictation stopped: ${ev.error}`)
  }
  rec.onend = () => {
    recording.value = false
    recognition = null
  }
  try {
    rec.start()
    recognition = rec
    recording.value = true
  } catch (e) {
    showNotice(`Dictation could not start: ${errText(e)}`)
  }
}
function stopDictation() {
  recognition?.stop()
}

// Send / stop
function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

let sentAt = 0
/** The Stop button or Esc. `click`: the button, which sits where Send was, so the second click of a send is not a Stop. */
function stop(click = false) {
  if (!props.chat || (click && Date.now() - sentAt < STOP_GUARD_MS)) return
  desk.interrupt(props.chat.id).catch((e) => showNotice(`Stop failed: ${errText(e)}`))
}

/** Sends the box, or queues it (see sendDecision); `ctrl` is Ctrl+Enter or a Ctrl-click, which asks to queue. */
async function submit(ctrl = false) {
  if (sending.value) return
  // Nothing to send. Never a Stop: only the Stop button and Esc stop a turn (stop()).
  if (showStop.value || !hasContent.value) return
  sentAt = Date.now()
  const enqueue = sendDecision(ctrl) === 'enqueue'
  const body = text.value.trim()
  const refs: ImageRef[] = images.value.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64, name: i.name }))
  const keptText = text.value
  const keptImages = images.value
  const sentSlot = slot.value
  sending.value = true
  text.value = ''
  images.value = []
  try {
    if (props.chat && props.into) {
      await props.into.send(body)
      lastSent.set(props.chat.id, body)
      saveDraft(storage, props.chat.id, '')
    } else if (props.chat) {
      const id = props.chat.id
      const message = { text: body, ...(refs.length ? { images: refs } : {}) }
      if (enqueue) await shell.queueAdd?.({ kind: 'message', chatId: id, ...message })
      else await desk.send(id, message)
      lastSent.set(id, body)
      saveDraft(storage, id, '')
      saveDraftImages(id, [])
    } else {
      if (!newCwd.value) throw new Error('Choose a folder first.')
      const req: CreateChatRequest = {
        cwd: newCwd.value,
        prompt: body,
        ...(refs.length ? { images: refs } : {}),
        accountId: newAccount.value,
        model: newModel.value,
        effort: newEffort.value,
        permissionMode: newMode.value
      }
      if (enqueue) {
        // The server starts it when an account has room; the screen stays for the next one.
        await shell.queueAdd?.({ kind: 'chat', ...req })
        showNotice('Queued: starts when an account has room', true)
      } else {
        // The store lists the new chat and opens it.
        await desk.createChat(req)
      }
      lastSent.set('new', body)
      saveDraft(storage, sentSlot, '')
      saveDraftImages(sentSlot, [])
    }
  } catch (e) {
    text.value = keptText
    images.value = keptImages
    showNotice(`Not sent: ${errText(e)}`)
  } finally {
    sending.value = false
    nextTick(() => textarea.value?.focus())
  }
}

// Lifecycle
watch(cwd, () => refreshGit())
function onShown() {
  if (!document.hidden) refreshGit()
}
watch(
  () => props.chat?.status,
  (now, before) => {
    if (before && BUSY.includes(before) && now && !BUSY.includes(now)) {
      refreshGit()
      loadSuggestion()
    }
  }
)

async function loadNewSessionDefaults() {
  if (props.chat || newCwd.value) return
  try {
    const recent = await api.recentFolders()
    if (!props.chat && !newCwd.value && recent.length) newCwd.value = recent[0]
  } catch {}
}

onMounted(async () => {
  if (props.demo?.images) {
    images.value = props.demo.images.map((i) => ({ ...i, id: crypto.randomUUID(), dataBase64: dataUrlToBase64(i.url) }))
  }
  if (props.demo?.slashOpen || props.demo?.mentionOpen) {
    textarea.value?.focus()
    syncCaret()
  }
  nextTick(autoGrow)
  refreshGit()
  gitTimer = setInterval(() => {
    if (!document.hidden && document.hasFocus()) refreshGit()
  }, GIT_POLL_MS)
  window.addEventListener('focus', refreshGit)
  document.addEventListener('visibilitychange', onShown)
  window.addEventListener('resize', autoGrow)
  loadNewSessionDefaults()
  try {
    models.value = await api.models()
  } catch {
    models.value = []
  }
})

// The frame puts the caret here when a new session opens (the plus button, Ctrl+N, the menu), and it stays
// through a closing menu taking focus back.
defineExpose({ focus: () => textarea.value && holdFocus(textarea.value, document) })

onBeforeUnmount(() => {
  if (gitTimer) clearInterval(gitTimer)
  gitRun?.abort()
  commandsRun?.abort()
  mentionRun?.abort()
  window.removeEventListener('focus', refreshGit)
  document.removeEventListener('visibilitychange', onShown)
  if (draftTimer) {
    clearTimeout(draftTimer)
    if (!props.demo) saveDraft(storage, slot.value, text.value)
  }
  recognition?.stop()
  window.removeEventListener('resize', autoGrow)
})
</script>

<template>
  <div class="bg-[var(--bg-page)] px-4 pb-[9px]">
    <div class="mx-auto flex w-full max-w-[768px] flex-col gap-1.5">
      <!-- Hydra Desk status row (ours): pending, queued -->
      <WorkerDock
        :pending="Math.max(0, (chat?.pendingCount ?? 0) - (request ? 1 : 0))"
        :queued="chat?.queuedCount ?? 0"
        @show-pending="showPending"
      />
      <!-- The box (and its queue tray) gives way to a docked request: the queue opens from here then -->
      <QueueChip v-if="request && queue && trayItems.length" :count="trayItems.length" :chat-id="chatId" />

      <div v-if="request" :key="request.id" data-request-dock>
        <PermissionCard v-if="request.kind === 'permission'" :item="request" docked />
        <QuestionCard v-else-if="request.kind === 'question'" :item="request" docked />
        <PlanCard v-else-if="request.kind === 'plan'" :item="request" docked />
        <ElicitationCard v-else :item="request" docked />
      </div>

      <!-- This chat's queue (ours), stacked above the strip and the box while it has some: three rows, then
           "+N more"; any of them opens the queue popover, where they are managed -->
      <QueueTray v-if="!request && queue && trayItems.length" :items="trayItems" :held="queue.held" @open="queueOpen = true" />

      <!-- Repository and pull request controls -->
      <template v-if="!chat">
        <NewSessionBar
          v-model:cwd="newCwd"
          :api="api"
          :branch="git?.isRepo ? git.branch : null"
          :account="newAccount"
          :accounts="desk.accounts.value"
        />
        <TipBanner v-if="tip" :tip="tip" @try="tryTip" @dismiss="closeTip" />
      </template>

      <RepoStrip
        v-else-if="showStrip"
        :project="cwd ? folderName(cwd) : null"
        :project-path="cwd"
        :branch="git?.branch ?? null"
        :added="git?.isRepo ? git.added : 0"
        :removed="git?.isRepo ? git.removed : 0"
        :can-create-pr="!!chat && !!git?.isRepo && !!git.branch"
        @open-diff="openDiff"
        @create-pr="createPr"
        @dismiss="dismissedFor = cwd"
      />

      <!-- The box -->
      <div
        v-show="!request"
        class="relative z-[1] rounded-[var(--radius-12)] bg-[var(--bg-popover)] p-2 transition-[box-shadow,background-color] duration-200 ease-[var(--ease-composer)]"
        :class="
          dragging
            ? 'shadow-[inset_0_0_0_2px_var(--accent)]'
            : 'shadow-[var(--shadow-composer)] focus-within:shadow-[var(--shadow-composer-focus)]'
        "
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <!-- Slash command menu -->
        <div
          v-if="slashOpen"
          class="absolute bottom-full left-0 z-30 mb-1.5 flex w-[420px] max-w-full flex-col overflow-y-auto"
          :class="MENU"
          style="max-height: 320px"
          role="listbox"
          aria-label="Slash commands"
        >
          <p v-if="!slashMatches.length" class="flex h-6 items-center px-2 text-[var(--text-muted)]">
            {{ commands.length ? 'No matching command' : 'Loading commands…' }}
          </p>
          <button
            v-for="(cmd, i) in slashMatches"
            :key="cmd.name"
            type="button"
            role="option"
            :aria-selected="i === slashIndex"
            class="flex h-6 w-full shrink-0 items-center gap-1.5 rounded-[var(--radius-6)] px-2 text-left"
            :class="i === slashIndex ? 'bg-[var(--fill-hover)]' : ''"
            @mouseenter="slashIndex = i"
            @mousedown.prevent="pickCommand(cmd)"
          >
            <span class="shrink-0 text-[var(--text)]">/{{ cmd.name }}</span>
            <span v-if="cmd.argumentHint" class="shrink-0 text-[var(--text-muted)]">{{ cmd.argumentHint }}</span>
            <span class="ml-auto truncate pl-3 text-[var(--text-muted)]">{{ cmd.description }}</span>
          </button>
        </div>

        <!-- @-mention menu -->
        <div
          v-if="mentionOpen"
          class="absolute bottom-full left-0 z-30 mb-1.5 flex w-[420px] max-w-full flex-col overflow-y-auto"
          :class="MENU"
          style="max-height: 320px"
          role="listbox"
          aria-label="Files and folders"
        >
          <p v-if="!mentionMatches.length" class="flex h-6 items-center px-2 text-[var(--text-muted)]">No matching file or folder</p>
          <button
            v-for="(p, i) in mentionMatches"
            :key="p"
            type="button"
            role="option"
            :aria-selected="i === mentionIndex"
            class="flex h-6 w-full shrink-0 items-center gap-1.5 rounded-[var(--radius-6)] px-2 text-left"
            :class="i === mentionIndex ? 'bg-[var(--fill-hover)]' : ''"
            @mouseenter="mentionIndex = i"
            @mousedown.prevent="pickMention(p)"
          >
            <component :is="p.endsWith('/') ? FolderIcon : icons.addFiles" class="size-4 shrink-0 text-[var(--text-muted)]" />
            <span class="truncate text-[var(--text)]">{{ p }}</span>
          </button>
        </div>

        <!-- Image thumbnails -->
        <!-- Attachments as the real box shows them (real-running-task-and-attachments.png): 120px tiles 6 apart,
             12 in from the box edge, r8, a 1px #444 ring, the picture contained on the page colour -->
        <div v-if="images.length" class="flex flex-wrap gap-1.5 px-1 pb-2 pt-1">
          <div v-for="img in images" :key="img.id" class="group relative">
            <Tip :label="img.name" side="top">
              <img
                :src="img.url"
                :alt="img.name"
                class="size-[120px] rounded-[var(--radius-8)] border border-[#444444] bg-[var(--bg-page)] object-contain"
              />
            </Tip>
            <button
              type="button"
              class="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-[var(--bg-popover)] text-[var(--text-2)] opacity-0 shadow-[var(--shadow-menu-ringed)] transition-opacity duration-150 hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100"
              :aria-label="`Remove ${img.name}`"
              @click="removeImage(img.id)"
            >
              <X class="size-3" />
            </button>
          </div>
        </div>

        <div class="flex items-end gap-2">
          <textarea
            ref="textarea"
            v-model="text"
            rows="1"
            :placeholder="shown || 'Describe a task or ask a question'"
            spellcheck="true"
            aria-label="Message"
            class="block max-h-96 min-h-6 flex-1 resize-none overflow-hidden bg-transparent px-1 py-0.5 text-[14px] leading-5 text-[var(--text)] caret-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
            @keydown="onKeydown"
            @keyup="syncCaret"
            @click="syncCaret"
            @paste="onPaste"
          />
          <span v-if="(busy || enterQueues) && hasContent" class="mb-[3px] shrink-0 text-[12px] text-[var(--text-muted)]">Queue</span>
          <SendSplit
            v-model:open="queueOpen"
            :show-stop="showStop"
            :can-send="hasContent && !sending"
            :suggested="!!shown"
            :send-label="sendText.label"
            :send-tip="sendText.tip"
            :queue="!!queue"
            :chat-id="chatId"
            @send="submit"
            @stop="stop(true)"
            @close-focus="textarea?.focus()"
          />
        </div>
      </div>

      <p
        v-if="notice"
        class="-mt-0.5 px-2 text-[12px]"
        :class="noticeInfo ? 'text-[var(--text-muted)]' : 'text-[var(--warning-text)]'"
        :role="noticeInfo ? 'status' : 'alert'"
      >{{ notice }}</p>

      <!-- Toolbar row below the box: h20, 12px #c3c2b7, padding 0 10 0 7 -->
      <div class="flex h-5 items-center pl-[7px] pr-2.5">
        <DropdownMenu v-bind="menuModel('plus')" :modal="!nonModal">
          <DropdownMenuTrigger as-child>
            <button type="button" :class="TOOL_ICON" aria-label="Add">
              <Plus class="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" :side-offset="6" :class="MENU" data-composer-menu="plus">
            <DropdownMenuItem :class="ITEM" :disabled="!!into" :title="into?.why" @select="fileInput?.click()">
              <icons.addFiles :class="MENU_GLYPH" />
              Add files or photos
              <span :class="SHORTCUT">Ctrl+U</span>
            </DropdownMenuItem>
            <DropdownMenuItem :class="ITEM" @select="showNotice('Adding a folder is not in Hydra Desk yet')">
              <composerIcons.addFolder :class="MENU_GLYPH" />
              Add folder
            </DropdownMenuItem>
            <DropdownMenuItem :class="ITEM" :disabled="!chat" @select="startSlash">
              <icons.slashCommands :class="MENU_GLYPH" />
              Slash commands
            </DropdownMenuItem>
            <McpSubmenu :api="api" :cwd="cwd" :chat-id="chatId" :config-dir="mcpConfigDir" @error="showNotice" />
          </DropdownMenuContent>
        </DropdownMenu>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="hidden" @change="onFilePicked" />

        <Tip :label="into ? into.why : SpeechRecognition ? 'Press and hold to record' : 'Dictation is not available in this browser'" side="top">
          <button
            type="button"
            :class="[TOOL_ICON, recording ? 'bg-[var(--danger-bg)] text-[var(--danger-text)]' : '']"
            :aria-label="recording ? 'Recording, release to stop' : 'Press and hold to record'"
            :disabled="!SpeechRecognition || !!into"
            @pointerdown.prevent="startDictation"
            @pointerup="stopDictation"
            @pointerleave="stopDictation"
          >
            <Mic class="size-3.5" :class="recording ? 'animate-[var(--animate-dot-blink)]' : ''" />
          </button>
        </Tip>
        <DropdownMenu v-bind="menuModel('dictation')" :modal="!nonModal">
          <DropdownMenuTrigger as-child>
            <button type="button" :class="TOOL_ICON" class="w-[19px]" aria-label="Dictation settings">
              <DictationChevron class="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" :side-offset="6" :class="MENU">
            <div :class="HEADER">Dictation language</div>
            <DropdownMenuItem v-for="l in dictationLangs" :key="l" :class="ITEM" @select="setDictationLang(l)">
              <span class="flex-1">{{ l }}{{ l === browserLang ? ' (browser)' : '' }}</span>
              <Check v-if="dictationLang === l" class="ml-auto size-3.5 text-[var(--accent)]" :stroke-width="3" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div class="flex-1" />

        <div class="flex items-center gap-1">
          <DropdownMenu v-bind="menuModel('model')" :modal="!nonModal">
            <DropdownMenuTrigger as-child>
              <button type="button" :class="TOOL_VALUE" :aria-label="`Model: ${modelText}`">{{ modelText }}</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              :side-offset="6"
              :class="MENU"
              @keydown="onModelKey"
              data-composer-menu="model"
            >
              <DropdownMenuItem
                v-for="(m, i) in modelSplit.main"
                :key="m.value"
                role="menuitemradio"
                :aria-checked="model === m.value"
                :class="ITEM"
                @select="pickModel(m.value)"
              >
                <span class="flex-1 whitespace-nowrap">{{ m.label }}</span>
                <Check v-if="model === m.value" class="-mr-1 ml-3 size-3.5 text-[var(--accent)]" :stroke-width="3" />
                <span v-else :class="SHORTCUT">{{ i + 1 }}</span>
              </DropdownMenuItem>
              <div role="separator" :class="SEPARATOR" />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger :class="[ITEM, SUB_TRIGGER]">More models</DropdownMenuSubTrigger>
                <DropdownMenuSubContent :class="MENU">
                  <DropdownMenuItem role="menuitemradio" :aria-checked="!model" :class="ITEM" @select="pickModel(null)">
                    <span class="flex-1 whitespace-nowrap">Account default</span>
                    <Check v-if="!model" class="ml-3 size-3.5 text-[var(--accent)]" :stroke-width="3" />
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    v-for="m in modelSplit.more"
                    :key="m.value"
                    role="menuitemradio"
                    :aria-checked="model === m.value"
                    :class="ITEM"
                    @select="pickModel(m.value)"
                  >
                    <span class="flex-1 whitespace-nowrap">{{ m.label }}</span>
                    <Check v-if="model === m.value" class="ml-3 size-3.5 text-[var(--accent)]" :stroke-width="3" />
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>

          <ContextRing :pct="chat?.contextPct ?? null" />
        </div>
      </div>
    </div>
  </div>
</template>
