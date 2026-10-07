import { computed, ref, watch } from 'vue'
import type { DevWebSettings } from '@shared/devwebui'
import { devSettings, saveDevSettings } from '@/components/servers/api'
import { useDevServers } from '@/components/servers/store'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useDevServerSettings() {
  const dev = useDevServers()
  const settings = ref<DevWebSettings | null>(null)
  const error = ref<string | null>(null)
  const savedAt = ref(0)
  const running = computed(() => dev.status.value?.state === 'running')

  // Reads never start the service: a stopped one stays stopped until the person starts it.
  async function load() {
    if (!running.value) return
    try {
      settings.value = await devSettings({ start: false })
      error.value = null
    } catch (e) {
      error.value = message(e)
    }
  }

  watch(running, (on) => {
    if (on) void load()
  })

  async function save(patch: Partial<DevWebSettings>): Promise<boolean> {
    if (!settings.value) return false
    const before = settings.value
    settings.value = { ...before, ...patch }
    error.value = null
    try {
      settings.value = await saveDevSettings(patch)
      savedAt.value = Date.now()
      return true
    } catch (e) {
      settings.value = before
      error.value = message(e)
      return false
    }
  }

  function rowNotes(id: string): string[] {
    const s = settings.value
    if (!s) return []
    switch (id) {
      case 'dwLinkHost':
        return s.linkHost ? [`${s.linkHost}:port`] : []
      case 'dwSkip':
        return [
          `Scanning ${!s.skipWindows && !s.skipMac && !s.skipLinux ? 'all operating systems' : 'skips: ' + [s.skipWindows ? 'Windows' : '', s.skipMac ? 'macOS' : '', s.skipLinux ? 'Linux' : ''].filter(Boolean).join(', ')}`
        ]
      case 'dwExclude':
        return s.scanExclude.length ? [`${s.scanExclude.length} excluded`] : []
      default:
        return []
    }
  }

  return {
    settings,
    error,
    savedAt,
    running,
    load,
    save,
    rowNotes
  }
}

export type DevServerSettingsContext = ReturnType<typeof useDevServerSettings>
