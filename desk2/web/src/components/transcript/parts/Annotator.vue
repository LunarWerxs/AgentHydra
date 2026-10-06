<script setup lang="ts">
// The viewer's annotate mode: the picture fitted to the window with a canvas over it for pen, highlighter, arrow,
// rectangle and circle marks (rules: lib/annotate.ts). Save draws the marks onto a full-size copy and hands it up;
// the original is never changed. Keys come from Lightbox.vue through handleKey while this is open.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Check, Circle, Highlighter, MoveUpRight, Pencil, Redo2, Square, Trash2, Undo2 } from '@lucide/vue'
import { MAX_IMAGE_BYTES } from '@/components/composer/logic'
import {
  ANNOTATE_COLORS,
  ANNOTATE_SIZES,
  ANNOTATE_TOOLS,
  addMark,
  annotateKeyAction,
  annotatedName,
  clearMarks,
  drawMark,
  extendMark,
  isMeaningful,
  markWidth,
  redoMark,
  toNatural,
  undoMark,
  type AnnotateTool,
  type Mark,
  type MarkHistory,
} from '../lib/annotate'

const props = defineProps<{ src: string; name: string }>()
const emit = defineEmits<{ cancel: []; save: [copy: { dataUrl: string; mediaType: string; name: string }] }>()

const TOOL_ICONS = { pen: Pencil, highlighter: Highlighter, arrow: MoveUpRight, rect: Square, ellipse: Circle } as const

const area = ref<HTMLElement | null>(null)
const img = ref<HTMLImageElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const natural = ref({ w: 0, h: 0 })
const room = ref({ w: 0, h: 0 })
const tool = ref<AnnotateTool>('pen')
const color = ref(ANNOTATE_COLORS[0]!.color)
const size = ref<number>(ANNOTATE_SIZES[1])
const history = shallowRef<MarkHistory>({ marks: [], undone: [] })
const live = shallowRef<Mark | null>(null)
const error = ref('')
const saving = ref(false)

// The picture fitted to the room left by the toolbar; a small one grows (twice, or to about 480 across) so it is easy to mark.
const shown = computed(() => {
  const { w, h } = natural.value
  if (!w || !h || !room.value.w || !room.value.h) return { w: 0, h: 0 }
  const s = Math.min(room.value.w / w, room.value.h / h, Math.max(2, 480 / Math.max(w, h)))
  return { w: Math.round(w * s), h: Math.round(h * s) }
})

function measure() {
  const el = area.value
  if (el) room.value = { w: Math.max(1, el.clientWidth - 48), h: Math.max(1, el.clientHeight - 48) }
}
function onLoad() {
  const el = img.value
  if (!el) return
  natural.value = { w: el.naturalWidth, h: el.naturalHeight }
  measure()
  void nextTick(redraw)
}

let frame = 0
function redraw() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    const c = canvas.value
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    for (const m of history.value.marks) drawMark(ctx, m)
    if (live.value) drawMark(ctx, live.value)
  })
}
watch([history, live], redraw)

function pointOf(e: { clientX: number; clientY: number }) {
  return toNatural(e.clientX, e.clientY, canvas.value!.getBoundingClientRect(), natural.value)
}
function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || !natural.value.w || !canvas.value) return
  error.value = ''
  live.value = { tool: tool.value, color: color.value, width: markWidth(tool.value, size.value, natural.value.w, shown.value.w), points: [pointOf(e)] }
  canvas.value.setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!live.value) return
  // Every sample the pointer took since the last frame, so a fast stroke stays smooth.
  const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
  let mark = live.value
  for (const s of samples.length ? samples : [e]) mark = extendMark(mark, pointOf(s))
  live.value = mark
}
function onPointerUp() {
  const mark = live.value
  live.value = null
  if (mark && isMeaningful(mark)) history.value = addMark(history.value, mark)
}

const canUndo = computed(() => history.value.marks.length > 0)
const canRedo = computed(() => history.value.undone.length > 0)
function undo() {
  history.value = undoMark(history.value)
}
function redo() {
  history.value = redoMark(history.value)
}
function clear() {
  history.value = clearMarks(history.value)
}

/** The copy as a data URL under the box's 5 MB a picture: PNG, else JPEG, else JPEG made smaller. */
function encode(out: HTMLCanvasElement): { dataUrl: string; mediaType: string } {
  const bytes = (url: string) => Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4)
  const png = out.toDataURL('image/png')
  if (bytes(png) <= MAX_IMAGE_BYTES) return { dataUrl: png, mediaType: 'image/png' }
  let src = out
  for (let i = 0; i < 6; i++) {
    const jpeg = src.toDataURL('image/jpeg', 0.9)
    if (bytes(jpeg) <= MAX_IMAGE_BYTES) return { dataUrl: jpeg, mediaType: 'image/jpeg' }
    const smaller = document.createElement('canvas')
    smaller.width = Math.round(src.width * 0.75)
    smaller.height = Math.round(src.height * 0.75)
    smaller.getContext('2d')!.drawImage(src, 0, 0, smaller.width, smaller.height)
    src = smaller
  }
  return { dataUrl: src.toDataURL('image/jpeg', 0.8), mediaType: 'image/jpeg' }
}

async function save() {
  if (saving.value || !canUndo.value || !img.value || !natural.value.w) return
  saving.value = true
  try {
    const out = document.createElement('canvas')
    out.width = natural.value.w
    out.height = natural.value.h
    const ctx = out.getContext('2d')!
    ctx.drawImage(img.value, 0, 0, out.width, out.height)
    for (const m of history.value.marks) drawMark(ctx, m)
    const { dataUrl, mediaType } = encode(out)
    emit('save', { dataUrl, mediaType, name: annotatedName(props.name, mediaType) })
  } catch {
    // A picture from another site taints the canvas; canAnnotate keeps the pen off those, this is the backstop.
    error.value = 'This picture cannot be copied, so the annotated version could not be saved.'
  } finally {
    saving.value = false
  }
}

/** A key while annotating; true when it was one of ours. */
function handleKey(e: KeyboardEvent): boolean {
  const action = annotateKeyAction(e)
  if (!action) return false
  if (e.repeat && action.type !== 'undo' && action.type !== 'redo') return true
  switch (action.type) {
    case 'cancel':
      emit('cancel')
      break
    case 'save':
      void save()
      break
    case 'undo':
      undo()
      break
    case 'redo':
      redo()
      break
    case 'tool':
      tool.value = action.tool
      break
  }
  return true
}
defineExpose({ handleKey })

let observer: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (area.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(area.value)
  }
})
onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
})
</script>

<template>
  <div class="absolute inset-0 flex flex-col" data-testid="annotator">
    <div class="flex shrink-0 items-center justify-center px-4 pt-3">
      <div class="tx-annotate-bar" role="toolbar" aria-label="Annotate">
        <button
          v-for="t in ANNOTATE_TOOLS"
          :key="t.tool"
          type="button"
          class="tx-annotate-btn"
          :class="{ 'tx-annotate-on': tool === t.tool }"
          :aria-label="t.label"
          :aria-pressed="tool === t.tool"
          :title="`${t.label} (${t.key})`"
          @click="tool = t.tool"
        >
          <component :is="TOOL_ICONS[t.tool]" class="size-4" />
        </button>
        <span class="tx-annotate-sep" />
        <button
          v-for="c in ANNOTATE_COLORS"
          :key="c.color"
          type="button"
          class="tx-annotate-btn"
          :class="{ 'tx-annotate-on': color === c.color }"
          :aria-label="c.label"
          :aria-pressed="color === c.color"
          :title="c.label"
          @click="color = c.color"
        >
          <span class="tx-annotate-swatch" :style="{ background: c.color }" />
        </button>
        <span class="tx-annotate-sep" />
        <button
          v-for="s in ANNOTATE_SIZES"
          :key="s"
          type="button"
          class="tx-annotate-btn"
          :class="{ 'tx-annotate-on': size === s }"
          :aria-label="`Line ${s} pixels`"
          :aria-pressed="size === s"
          :title="`Line ${s}px`"
          @click="size = s"
        >
          <span class="rounded-full bg-current" :style="{ width: `${s + 1}px`, height: `${s + 1}px` }" />
        </button>
        <span class="tx-annotate-sep" />
        <button type="button" class="tx-annotate-btn" aria-label="Undo" title="Undo (Ctrl+Z)" :disabled="!canUndo" @click="undo"><Undo2 class="size-4" /></button>
        <button type="button" class="tx-annotate-btn" aria-label="Redo" title="Redo (Ctrl+Y)" :disabled="!canRedo" @click="redo"><Redo2 class="size-4" /></button>
        <button type="button" class="tx-annotate-btn" aria-label="Clear all marks" title="Clear all marks" :disabled="!canUndo" @click="clear"><Trash2 class="size-4" /></button>
        <span class="tx-annotate-sep" />
        <button type="button" class="tx-annotate-text" title="Cancel (Esc)" @click="emit('cancel')">Cancel</button>
        <button
          type="button"
          class="tx-annotate-text tx-annotate-save"
          title="Save a copy next to the original (Ctrl+S)"
          :disabled="!canUndo || saving"
          data-testid="annotate-save"
          @click="save"
        >
          <Check class="size-3.5" />Save copy
        </button>
      </div>
    </div>
    <div ref="area" class="relative flex min-h-0 flex-1 items-center justify-center">
      <div class="tx-annotate-sheet relative" :style="shown.w ? { width: `${shown.w}px`, height: `${shown.h}px` } : { opacity: 0 }">
        <img ref="img" :src="src" :alt="name" class="block size-full select-none rounded-6" draggable="false" @load="onLoad" />
        <canvas
          ref="canvas"
          :width="natural.w"
          :height="natural.h"
          class="absolute inset-0 size-full cursor-crosshair touch-none rounded-6"
          data-testid="annotate-canvas"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
      </div>
    </div>
    <div class="flex shrink-0 items-center justify-center gap-3 px-4 py-3 text-[12px] text-text-muted">
      <span v-if="error" class="text-danger-text">{{ error }}</span>
      <span v-else class="opacity-70">Draw on the picture · Save copy puts the annotated version next to the original · Esc goes back</span>
    </div>
  </div>
</template>

<style scoped>
.tx-annotate-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  background: var(--bg-popover);
  box-shadow: var(--shadow-menu-ringed);
}
.tx-annotate-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--text-2);
  cursor: pointer;
  transition: background-color 60ms, color 60ms;
}
.tx-annotate-btn:hover:not(:disabled) {
  background: var(--fill-hover);
  color: var(--text);
}
.tx-annotate-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.tx-annotate-on {
  background: var(--fill-hover);
  color: var(--text);
  box-shadow: inset 0 0 0 1px #ffffff33;
}
.tx-annotate-swatch {
  width: 14px;
  height: 14px;
  border-radius: 9999px;
  box-shadow: inset 0 0 0 1px #ffffff40;
}
.tx-annotate-sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--border);
}
.tx-annotate-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
.tx-annotate-text:hover:not(:disabled) {
  background: var(--fill-hover);
  color: var(--text);
}
.tx-annotate-save {
  background: var(--text);
  color: var(--bg-page);
}
.tx-annotate-save:hover:not(:disabled) {
  background: var(--text);
  color: var(--bg-page);
  opacity: 0.9;
}
.tx-annotate-save:disabled {
  opacity: 0.4;
  cursor: default;
}
.tx-annotate-sheet {
  border-radius: 6px;
  box-shadow: var(--shadow-picture-lifted);
}
</style>
