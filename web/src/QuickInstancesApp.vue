<script setup lang="ts">
import {
  AppWindow,
  Boxes,
  Focus,
  Moon,
  Play,
  RefreshCw,
  Square,
  Sun,
  Terminal,
  X,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type {
  CliInstance,
  CMActionResult,
  CMInstance,
  CodexInstance,
  UsageSnapshot,
} from '@/lib/api'
import {
  API_BASE,
  focusCodexDesktopInstance,
  focusInstance,
  getInstanceAccount,
  getUsageCache,
  launchCliInstance,
  launchCodexInstance,
  listCliInstances,
  listCodexInstances,
  listInstances,
  openCodexDesktopInstance,
  openInstance,
  quitCodexDesktopInstance,
  quitInstance,
} from '@/lib/api'
import { loginChanged } from '@/lib/instance-appearance'
import { useTheme } from '@/lib/theme'
import { isStaleSnap, usageBadgeVariant, usageCellLabel, usageCheckedAgo } from '@/lib/usage'
import { applyWindowSizeHint } from '@/lib/window-size-hint'

// A second --app launch can be forwarded into an existing Chromium process, which ignores both
// --window-size and saved geometry. Honor the daemon's one-shot URL hint just like the full shell.
applyWindowSizeHint()

const claude = ref<CMInstance[]>([])
const claudeCli = ref<CliInstance[]>([])
const codex = ref<CodexInstance[]>([])
const loading = ref(true)
const refreshing = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(new Set<string>())
const resolvingAccounts = ref(new Set<string>())
const usageSnapshots = ref(new Map<string, UsageSnapshot>())
const lightweightServer = ref(false)
const lastAccountResolveAt = new Map<string, number>()

const { isDark, toggle: toggleTheme } = useTheme()

const sortedClaude = computed(() =>
  [...claude.value].sort(
    (a, b) =>
      Number(b.isRunning) - Number(a.isRunning) ||
      (a.label ?? a.name).localeCompare(b.label ?? b.name),
  ),
)
const sortedClaudeCli = computed(() =>
  [...claudeCli.value].sort((a, b) => a.name.localeCompare(b.name)),
)
const sortedCodex = computed(() =>
  [...codex.value].sort(
    (a, b) =>
      Number(b.isDesktopRunning) - Number(a.isDesktopRunning) || a.name.localeCompare(b.name),
  ),
)
const total = computed(() => claude.value.length + claudeCli.value.length + codex.value.length)

function usageForClaude(instance: CMInstance): UsageSnapshot | undefined {
  return usageSnapshots.value.get(`desktop:${instance.dir}`)
}

function usageForClaudeCli(instance: CliInstance): UsageSnapshot | undefined {
  return instance.lastUsageCheck ?? usageSnapshots.value.get(`cli:${instance.id}`)
}

function usageTitle(snapshot: UsageSnapshot | undefined): string {
  if (!snapshot?.weekAll) return 'Usage has not been checked yet.'
  return `Weekly usage · checked ${usageCheckedAgo(snapshot.capturedAt)}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setBusy(key: string, value: boolean): void {
  const next = new Set(busy.value)
  if (value) next.add(key)
  else next.delete(key)
  busy.value = next
}

function setResolvingAccount(dir: string, value: boolean): void {
  const next = new Set(resolvingAccounts.value)
  if (value) next.add(dir)
  else next.delete(dir)
  resolvingAccounts.value = next
}

async function hydrateClaudeAccounts(rows: CMInstance[], force = false): Promise<void> {
  const now = Date.now()
  await Promise.all(
    rows.map(async (instance) => {
      const last = lastAccountResolveAt.get(instance.dir) ?? 0
      if (!force && !loginChanged(instance) && instance.account && now - last < 60_000) return
      setResolvingAccount(instance.dir, true)
      try {
        // Cache/local-token only: identity and plan appear without putting Anthropic network work
        // on the quick-launch path. The full manager refreshes this same identity cache.
        const account = await getInstanceAccount(instance.dir, { noNetwork: true })
        lastAccountResolveAt.set(instance.dir, Date.now())
        const index = claude.value.findIndex((row) => row.dir === instance.dir)
        if (index >= 0) {
          const next = claude.value.slice()
          next[index] = { ...next[index]!, account }
          claude.value = next
        }
      } catch {
        // Keep the row usable. Start/focus must never wait on optional identity metadata.
      } finally {
        setResolvingAccount(instance.dir, false)
      }
    }),
  )
}

async function refresh(silent = false): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  if (!silent) loading.value = true
  try {
    const [desktopRows, cliRows, codexRows, usageResult] = await Promise.all([
      listInstances(),
      listCliInstances(),
      listCodexInstances(),
      getUsageCache().catch(() => null),
    ])
    const previousAccounts = new Map(
      claude.value.map((instance) => [instance.dir, instance.account]),
    )
    claude.value = desktopRows.map((instance) => {
      // Carry a previously resolved identity forward (the list omits it) — unless the instance has
      // since been signed into a different account, in which case it is dropped rather than shown.
      const next = {
        ...instance,
        account: instance.account ?? previousAccounts.get(instance.dir) ?? null,
      }
      return loginChanged(next) ? { ...instance, account: instance.account ?? null } : next
    })
    claudeCli.value = cliRows
    codex.value = codexRows
    if (usageResult) usageSnapshots.value = new Map(Object.entries(usageResult.cache))
    error.value = null
    void hydrateClaudeAccounts(claude.value, !silent)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    refreshing.value = false
    loading.value = false
  }
}

async function act(
  key: string,
  label: string,
  action: () => Promise<CMActionResult>,
): Promise<void> {
  setBusy(key, true)
  notice.value = null
  try {
    const result = await action()
    if (!result.ok) throw new Error(result.message ?? `${label} failed.`)
    notice.value = result.message || `${label} completed.`
    await refresh(true)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    setBusy(key, false)
  }
}

function openClaude(instance: CMInstance): void {
  const key = `claude:${instance.dir}`
  void act(key, instance.isRunning ? 'Focus' : 'Start', () =>
    instance.isRunning ? focusInstance(instance.dir) : openInstance(instance.dir),
  )
}

function stopClaude(instance: CMInstance): void {
  if (
    instance.isExternal &&
    !window.confirm('Quit the external/default Claude Desktop window? Its open chats are real.')
  )
    return
  const key = `claude:${instance.dir}`
  void act(key, 'Stop', () => quitInstance(instance.dir, { confirmExternal: instance.isExternal }))
}

function launchClaudeCli(instance: CliInstance): void {
  void act(`claude-cli:${instance.id}`, 'Launch CLI', () => launchCliInstance(instance.id))
}

function openCodex(instance: CodexInstance): void {
  const key = `codex:${instance.id}`
  void act(key, instance.isDesktopRunning ? 'Focus' : 'Start', () =>
    instance.isDesktopRunning
      ? focusCodexDesktopInstance(instance.id)
      : openCodexDesktopInstance(instance.id),
  )
}

function stopCodex(instance: CodexInstance): void {
  void act(`codex:${instance.id}`, 'Stop', () => quitCodexDesktopInstance(instance.id))
}

function launchCodexCli(instance: CodexInstance): void {
  void act(`codex:${instance.id}`, 'Launch CLI', () => launchCodexInstance(instance.id))
}

let pollTimer: number | null = null
let lifetime: EventSource | null = null

async function connectLifetime(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/health`)
    const health = (await response.json()) as { mode?: string }
    lightweightServer.value = health.mode === 'instances'
    if (lightweightServer.value) {
      lifetime = new EventSource(`${API_BASE}/api/instance-mode/lifetime`)
    }
  } catch {
    // Listing calls below carry the actionable connection error; health is only capability
    // detection for disposable-server lifetime.
  }
}

async function closeWindow(): Promise<void> {
  if (lightweightServer.value) {
    await fetch(`${API_BASE}/api/instance-mode/shutdown`, { method: 'POST' }).catch(() => undefined)
  }
  window.close()
  notice.value = 'You can close this window.'
}

onMounted(() => {
  document.title = 'Quick Instances · AgentHydra'
  void connectLifetime()
  void refresh()
  pollTimer = window.setInterval(() => {
    if (!document.hidden) void refresh(true)
  }, 10_000)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  lifetime?.close()
})
</script>

<template>
  <!-- Instance mode intentionally stays English-only so it does not download or initialize the
       full vue-i18n catalog during a one-click launch. -->
  <!-- i18n-ignore -->
  <div class="min-h-screen bg-background text-foreground">
    <header class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Boxes class="size-5" />
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-sm font-semibold">Quick Instances</h1>
          <p class="truncate text-xs text-muted-foreground">
            Instance controls only · {{ total }} available
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          :title="isDark ? 'Use light theme' : 'Use dark theme'"
          @click="toggleTheme"
        >
          <Sun v-if="isDark" />
          <Moon v-else />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Refresh instances"
          :disabled="refreshing"
          @click="refresh()"
        >
          <RefreshCw :class="{ 'animate-spin': refreshing }" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Close quick instances" @click="closeWindow">
          <X />
        </Button>
      </div>
    </header>

    <main class="mx-auto max-w-3xl space-y-4 p-4">
      <div
        v-if="error"
        class="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
      >
        <span>{{ error }}</span>
        <button class="shrink-0 text-xs underline underline-offset-2" @click="error = null">
          Dismiss
        </button>
      </div>
      <div
        v-else-if="notice"
        class="rounded-lg border border-primary/25 bg-primary/8 px-3 py-2 text-sm"
      >
        {{ notice }}
      </div>

      <div v-if="loading" class="space-y-2" aria-label="Loading instances">
        <div v-for="row in 4" :key="row" class="h-16 animate-pulse rounded-xl bg-muted" />
      </div>

      <template v-else>
        <section class="overflow-hidden rounded-xl border bg-card">
          <div class="flex items-center gap-2 border-b px-3 py-2.5">
            <AppWindow class="size-4 text-primary" />
            <h2 class="flex-1 text-sm font-medium">Claude Desktop</h2>
            <span class="w-20 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Usage
            </span>
            <div class="flex w-28 justify-end">
              <Badge variant="secondary">{{ claude.length }}</Badge>
            </div>
          </div>
          <div v-if="sortedClaude.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
            No Claude Desktop instances found.
          </div>
          <div
            v-for="instance in sortedClaude"
            :key="instance.dir"
            class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :class="instance.isRunning ? 'bg-emerald-500' : 'bg-muted-foreground/35'"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ instance.label ?? instance.name }}</span>
                <Badge v-if="instance.isExternal" variant="outline">External</Badge>
                <Badge
                  v-if="instance.account?.planLabel"
                  variant="secondary"
                  class="shrink-0"
                >
                  {{ instance.account.planLabel }}
                </Badge>
              </div>
              <p
                class="truncate text-xs text-muted-foreground"
                :title="instance.account?.email ?? undefined"
              >
                <template v-if="instance.account?.email">{{ instance.account.email }} · </template>
                <template v-else-if="resolvingAccounts.has(instance.dir)">Account resolving… · </template>
                <template v-else>Account unavailable · </template>
                {{ instance.isRunning ? `Running · PID ${instance.pid ?? '—'}` : 'Stopped' }}
              </p>
            </div>
            <div class="flex w-20 shrink-0 justify-center">
              <Badge
                :variant="
                  usageForClaude(instance)?.weekAll
                    ? usageBadgeVariant(usageForClaude(instance)!.weekAll!.pct)
                    : 'outline'
                "
                :class="isStaleSnap(usageForClaude(instance)) ? 'opacity-60' : ''"
                :title="usageTitle(usageForClaude(instance))"
              >
                {{ usageCellLabel(usageForClaude(instance), 'week', true) }}
              </Badge>
            </div>
            <div class="flex w-28 shrink-0 justify-end gap-1">
              <Button
                size="sm"
                :variant="instance.isRunning ? 'secondary' : 'default'"
                :disabled="busy.has(`claude:${instance.dir}`)"
                @click="openClaude(instance)"
              >
                <Focus v-if="instance.isRunning" />
                <Play v-else />
                {{ instance.isRunning ? 'Focus' : 'Start' }}
              </Button>
              <Button
                v-if="instance.isRunning"
                variant="ghost"
                size="icon-sm"
                title="Stop instance"
                :disabled="busy.has(`claude:${instance.dir}`)"
                @click="stopClaude(instance)"
              >
                <Square />
              </Button>
            </div>
          </div>
        </section>

        <section v-if="sortedClaudeCli.length" class="overflow-hidden rounded-xl border bg-card">
          <div class="flex items-center gap-2 border-b px-3 py-2.5">
            <Terminal class="size-4 text-primary" />
            <h2 class="flex-1 text-sm font-medium">Claude CLI</h2>
            <span class="w-20 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Usage
            </span>
            <div class="flex w-28 justify-end">
              <Badge variant="secondary">{{ claudeCli.length }}</Badge>
            </div>
          </div>
          <div
            v-for="instance in sortedClaudeCli"
            :key="instance.id"
            class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :class="instance.loggedIn ? 'bg-emerald-500' : 'bg-amber-500'"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ instance.name }}</p>
              <p class="truncate text-xs text-muted-foreground">
                {{ instance.loggedIn ? 'Signed in' : 'Needs sign-in' }}
              </p>
            </div>
            <div class="flex w-20 shrink-0 justify-center">
              <Badge
                :variant="
                  usageForClaudeCli(instance)?.weekAll
                    ? usageBadgeVariant(usageForClaudeCli(instance)!.weekAll!.pct)
                    : 'outline'
                "
                :class="isStaleSnap(usageForClaudeCli(instance)) ? 'opacity-60' : ''"
                :title="usageTitle(usageForClaudeCli(instance))"
              >
                {{ usageCellLabel(usageForClaudeCli(instance), 'week', true) }}
              </Badge>
            </div>
            <div class="flex w-28 shrink-0 justify-end">
              <Button
                size="sm"
                variant="secondary"
                :disabled="busy.has(`claude-cli:${instance.id}`)"
                @click="launchClaudeCli(instance)"
              >
                <Terminal /> Launch
              </Button>
            </div>
          </div>
        </section>

        <section class="overflow-hidden rounded-xl border bg-card">
          <div class="flex items-center gap-2 border-b px-3 py-2.5">
            <Boxes class="size-4 text-primary" />
            <h2 class="text-sm font-medium">Codex</h2>
            <Badge variant="secondary" class="ml-auto">{{ codex.length }}</Badge>
          </div>
          <div v-if="sortedCodex.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
            No Codex instances found.
          </div>
          <div
            v-for="instance in sortedCodex"
            :key="instance.id"
            class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :class="instance.isDesktopRunning ? 'bg-emerald-500' : 'bg-muted-foreground/35'"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ instance.name }}</p>
              <p class="truncate text-xs text-muted-foreground">
                Desktop {{ instance.isDesktopRunning ? 'running' : 'stopped' }} · CLI
                {{ instance.loggedIn ? 'signed in' : 'not signed in' }}
              </p>
            </div>
            <Button
              size="sm"
              :variant="instance.isDesktopRunning ? 'secondary' : 'default'"
              :disabled="busy.has(`codex:${instance.id}`)"
              @click="openCodex(instance)"
            >
              <Focus v-if="instance.isDesktopRunning" />
              <Play v-else />
              {{ instance.isDesktopRunning ? 'Focus' : 'Start' }}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Launch Codex CLI"
              :disabled="busy.has(`codex:${instance.id}`)"
              @click="launchCodexCli(instance)"
            >
              <Terminal />
            </Button>
            <Button
              v-if="instance.isDesktopRunning"
              variant="ghost"
              size="icon-sm"
              title="Stop Codex Desktop"
              :disabled="busy.has(`codex:${instance.id}`)"
              @click="stopCodex(instance)"
            >
              <Square />
            </Button>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
