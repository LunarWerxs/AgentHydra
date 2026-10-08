<script setup lang="ts">
import { computed } from 'vue'
import { Play, Plus, Server, Square } from '@lucide/vue'
import type { DevWebProcess } from '@shared/devwebui'
import { Tip } from '@/components/ui/tooltip'
import { allKey, groupActions, groupServers } from '../logic'
import { useDevServers } from '../store'
import { BTN, BTN_PRIMARY, CHIP, chip, ICON_BTN } from './kit/kit'
import Card from './kit/Card.vue'
import EmptyState from './kit/EmptyState.vue'
import Notice from './kit/Notice.vue'
import ServerRows from './ServerRows.vue'
import StatTile from './kit/StatTile.vue'

// The Dev servers page with nothing picked (the title bar's Dev servers button opens it here): every project as a card of
// its servers, in the sidebar list's order (projects with a server running first, a project's starred servers first),
// with Start all / Stop all, and tiles counting projects, servers, running ones and errors. A project's name opens it, a
// server's row opens the server.
const servers = useDevServers()
const projects = computed(() => servers.projects.value)
const groups = computed(() => groupServers(projects.value ?? []))
const all = computed(() => (projects.value ?? []).flatMap((p) => p.processes))
const running = computed(() => all.value.filter((x) => x.status === 'running').length)
const errors = computed(() => all.value.reduce((n, x) => n + (x.errorCount ?? 0), 0))
const firing = computed(() => all.value.filter((x) => x.alertsFiring).length)
const starredFirst = (list: DevWebProcess[]) => [...list].sort((a, b) => Number(!!b.starred) - Number(!!a.starred))
</script>

<template>
  <div class="flex flex-col gap-5 p-4">
    <section class="flex flex-wrap items-end gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-[20px] font-semibold leading-7 text-text">Dev servers</h2>
        <p class="text-[13px] leading-5 text-text-muted">The projects AgentHydra runs, and their servers. Pick one to see it.</p>
      </div>
      <button type="button" :class="BTN" @click="servers.select({ kind: 'add' })"><Plus class="size-3.5" aria-hidden="true" />Add project</button>
    </section>

    <Notice v-if="servers.projectsError.value" tone="danger" title="The projects could not be read">{{ servers.projectsError.value }}</Notice>

    <div v-if="!projects" role="status" class="flex flex-col gap-3" aria-busy="true">
      <span class="sr-only">Reading the projects…</span>
      <div class="grid grid-cols-2 gap-2.5 @2xl:grid-cols-4">
        <div v-for="i in 4" :key="i" class="h-21 animate-pulse rounded-(--radius-10) bg-fill-5 motion-reduce:animate-none" />
      </div>
      <div class="h-40 animate-pulse rounded-(--radius-10) bg-fill-5 motion-reduce:animate-none" />
    </div>

    <template v-else-if="!projects.length">
      <Card>
        <EmptyState :icon="Server" title="No projects yet" text="Add a folder with a package.json or a .devwebui file, clone one, or scan this PC for them.">
          <button type="button" :class="BTN_PRIMARY" @click="servers.select({ kind: 'add' })"><Plus class="size-3.5" aria-hidden="true" />Add project</button>
        </EmptyState>
      </Card>
    </template>

    <template v-else>
      <div class="grid grid-cols-2 gap-2.5 @2xl:grid-cols-4">
        <StatTile label="Projects" :value="String(projects.length)" />
        <StatTile label="Servers" :value="String(all.length)" />
        <StatTile label="Running" :value="String(running)" :sub="`of ${all.length}`" :tone="running > 0 ? 'success' : undefined" />
        <StatTile label="Errors" :value="String(errors)" :sub="firing ? `${firing} ${firing === 1 ? 'alert' : 'alerts'} firing` : undefined" :tone="errors > 0 ? 'danger' : undefined" />
      </div>

      <section v-for="g in groups" :key="g.project.id" class="flex flex-col gap-2" :aria-label="g.project.name">
        <div class="flex min-h-8 items-center gap-2 px-0.5">
          <span class="size-2.5 shrink-0 rounded-full" :class="g.project.color ? '' : 'bg-fill-selected'" :style="g.project.color ? { background: g.project.color } : undefined" aria-hidden="true" />
          <h3 class="min-w-0">
            <button
              type="button"
              class="max-w-full cursor-default truncate rounded-(--radius-5) px-1 text-[14px] font-medium leading-5 text-text transition-colors duration-60 hover:bg-fill-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
              :aria-label="`${g.project.name} details`"
              @click="servers.select({ kind: 'project', id: g.project.id })"
            >{{ g.project.name }}</button>
          </h3>
          <span v-if="g.servers.length" :class="g.running && g.running === g.servers.length ? chip('success') : CHIP" class="tnum">{{ g.running }} of {{ g.servers.length }} running</span>
          <span class="flex-1" />
          <Tip v-if="groupActions(g.servers).start" label="Start all">
            <button type="button" :class="ICON_BTN" :disabled="servers.busy.value.has(allKey(g.project))" :aria-label="`Start all in ${g.project.name}`" @click="servers.actAll(g.project, 'start')"><Play class="size-3.5" /></button>
          </Tip>
          <Tip v-if="groupActions(g.servers).stop" label="Stop all">
            <button type="button" :class="ICON_BTN" :disabled="servers.busy.value.has(allKey(g.project))" :aria-label="`Stop all in ${g.project.name}`" @click="servers.actAll(g.project, 'stop')"><Square class="size-3.5" /></button>
          </Tip>
        </div>
        <Card v-if="g.servers.length" flush>
          <ServerRows :processes="starredFirst(g.servers)" />
        </Card>
        <Card v-else>
          <p class="text-[13px] leading-5 text-text-muted">No servers in this project yet. Open it to add one.</p>
        </Card>
      </section>
    </template>
  </div>
</template>
