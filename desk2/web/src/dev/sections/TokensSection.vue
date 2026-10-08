<script setup lang="ts">
// Every token of the measured layer (style.css), so it can be eyeballed against docs/reference/real/*.png.
const colors: Array<[string, string]> = [
  ['--bg-sidebar', '#111111'], ['--bg-page', '#151515'], ['--bg-panel', '#1a1a19'], ['--bg-deepest', '#0b0b0b'],
  ['--bg-popover', '#20201f'], ['--text', '#f0efec'], ['--text-2', '#c3c2b7'], ['--text-muted', '#898781'],
  ['--text-shortcut', '#a5a49a'], ['--border', '#ffffff1a'], ['--border-strong', '#ffffff33'],
  ['--border-stronger', '#ffffff66'], ['--fill-hover', '#ffffff13'], ['--fill-selected', '#ffffff26'],
  ['--fill-5', '#ffffff0d'], ['--accent', '#2a78d6'], ['--accent-hover', '#3987e5'], ['--accent-text', '#6da7ec'],
  ['--accent-bg', '#032042'], ['--brand', '#c6613f'], ['--brand-hover', '#d97757'], ['--success', '#009300'],
  ['--success-text', '#0ca30c'], ['--success-bg', '#11260f'], ['--warning', '#fab219'], ['--warning-text', '#db9300'],
  ['--warning-bg', '#311a00'], ['--danger', '#d03b3b'], ['--danger-text', '#ec7e7e'], ['--danger-bg', '#3c0e0e'],
  ['--code-text', '#ec7e7e'], ['--git-add', '#32d74b'], ['--git-del', '#ff2c56'], ['--git-mod', '#ffd014'],
  ['--git-merged', '#b796ff']
]
const status: Array<[string, string]> = [
  ['--status-needs-you', 'needs you / finished unread (warning)'], ['--status-error', 'error (danger)'],
  ['--status-limited', 'limited (pink ring)'], ['--status-working', 'working (blinks)'],
  ['--status-idle', 'idle (1px ring)']
]
const radii = [5, 6, 7, 8, 10, 12, 22]
const shadows = ['menu', 'composer', 'popover']
</script>

<template>
  <div class="space-y-6 text-[13px]">
    <div class="flex flex-wrap gap-3">
      <div v-for="[name, hex] in colors" :key="name" class="w-33">
        <div class="h-10 rounded-6 border border-border" :style="{ background: `var(${name})` }" />
        <div class="mt-1 text-text">{{ name }}</div>
        <div class="tnum text-text-muted">{{ hex }}</div>
      </div>
    </div>

    <div class="flex flex-wrap gap-4">
      <div v-for="[name, label] in status" :key="name" class="flex items-center gap-2">
        <span
          class="size-1.5 rounded-full"
          :class="name === '--status-working' && 'animate-dot-blink'"
          :style="name === '--status-idle'
            ? { border: '1px solid var(--status-idle)', opacity: 0.5, width: '8px', height: '8px' }
            : name === '--status-limited'
              ? { border: '1.5px solid var(--status-limited)' }
              : { background: `var(${name})` }"
        />
        <span :class="name === '--status-limited' ? 'text-(--status-limited-text)' : 'text-text-2'">{{ label }}</span>
      </div>
    </div>

    <div class="flex flex-wrap gap-4">
      <div v-for="r in radii" :key="r" class="text-center">
        <div class="size-14 border border-border-strong bg-fill-5" :style="{ borderRadius: `var(--radius-${r})` }" />
        <div class="mt-1 text-text-muted">--radius-{{ r }}</div>
      </div>
    </div>

    <div class="flex flex-wrap gap-6 rounded-10 bg-bg-sidebar p-6">
      <div v-for="s in shadows" :key="s" class="text-center">
        <div class="h-14 w-32 rounded-10 bg-bg-popover" :style="{ boxShadow: `var(--shadow-${s})` }" />
        <div class="mt-2 text-text-muted">--shadow-{{ s }}</div>
      </div>
      <div class="text-center">
        <button class="h-14 w-32 rounded-10 bg-bg-popover" style="box-shadow: var(--focus-ring)">focus</button>
        <div class="mt-2 text-text-muted">--focus-ring</div>
      </div>
    </div>

    <div class="space-y-1">
      <div class="font-sans text-[14px] leading-5 text-text">Sans 14/20: system-ui, Segoe UI. The quick brown fox 0123456789</div>
      <div class="font-sans text-[13px] text-text-2">Sans 13px, text-2 · <span class="text-text-muted">muted</span> · <span class="text-text-shortcut">Ctrl+N</span></div>
      <div class="font-mono text-[13px] leading-4.75 text-text">Mono 13/19: Consolas / Cascadia — const x = a !== b ? 1 : 2 <code class="rounded-5 border border-border bg-fill-5 px-1 text-[12.6px] text-code-text">inline</code></div>
      <div class="tnum text-text-muted">tabular 11:11 22:22 00:00 · 1,111 2,222</div>
    </div>

    <div class="code-scroll h-16 w-80 overflow-auto rounded-8 border border-border bg-bg-deepest p-2 font-mono text-[13px]">
      <div class="w-150 whitespace-pre">code-scroll: 8px scrollbar on a 5% track</div>
      <div>line</div><div>line</div><div>line</div><div>line</div>
    </div>
  </div>
</template>
