<script setup lang="ts">
import { ChevronRight, Play, Square } from '@lucide/vue'
import type { DevWebProcess } from '@shared/devwebui'
import { Tip } from '@/components/ui/tooltip'
import { serverActions, serverPort, statusDot, statusWord } from '../logic'
import { useDevServers } from '../store'
import { DOT } from '../styles'
import { CHIP, ICON_BTN_SM } from './kit/kit'
import CountBadge from './kit/CountBadge.vue'

// A project's servers as rows of a flush card (a project's view, the Dev servers overview): status dot, name, status
// word, port, errors, and Start or Stop on hover; a click shows the server.
defineProps<{ processes: readonly DevWebProcess[] }>()
const servers = useDevServers()
</script>

<template>
  <ul class="divide-y divide-border">
    <li v-for="x in processes" :key="x.id" class="group relative">
      <button type="button" class="flex h-12 w-full cursor-default items-center gap-2.5 px-4 text-start transition-colors duration-60 hover:bg-fill-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none" :aria-label="`${x.name} details`" @click="servers.select({ kind: 'server', id: x.id })">
        <span class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(x.status)]" aria-hidden="true" />
        <span class="min-w-0 truncate text-[13px] text-text">{{ x.name }}</span>
        <span class="shrink-0 text-[12px] text-text-muted">{{ statusWord(x) }}</span>
        <span v-if="x.port" :class="CHIP" class="tnum">{{ serverPort(x) }}</span>
        <CountBadge v-if="x.errorCount" :count="x.errorCount" />
        <span class="flex-1" />
        <span class="size-6 shrink-0" aria-hidden="true" />
        <ChevronRight class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
      </button>
      <div class="absolute right-10 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-60 focus-within:opacity-100 group-hover:opacity-100">
        <Tip v-if="serverActions(x.status).includes('stop')" :label="`Stop ${x.name}`">
          <button type="button" :class="ICON_BTN_SM" :aria-label="`Stop ${x.name}`" :disabled="servers.busy.value.has(x.id)" @click.stop="servers.act(x, 'stop')"><Square class="size-3.5" /></button>
        </Tip>
        <Tip v-else-if="serverActions(x.status).includes('start')" :label="`Start ${x.name}`">
          <button type="button" :class="ICON_BTN_SM" :aria-label="`Start ${x.name}`" :disabled="servers.busy.value.has(x.id)" @click.stop="servers.act(x, 'start')"><Play class="size-3.5" /></button>
        </Tip>
      </div>
    </li>
  </ul>
</template>
