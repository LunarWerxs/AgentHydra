import { computed, ref } from 'vue'
import {
  ApiError,
  type AuthStatus,
  api,
  type GatewayStatus,
  type SwitchResult,
  type SwitchStatus,
} from '@/lib/api'

// Module-level singletons: one gateway, one auth state, however many components read them.
const auth = ref<AuthStatus | null>(null)
const status = ref<GatewayStatus | null>(null)
const authError = ref<string | null>(null)
const statusError = ref<string | null>(null)
const switching = ref(false)
let statusTimer: ReturnType<typeof setInterval> | undefined

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useGateway() {
  async function loadAuth(): Promise<void> {
    try {
      auth.value = await api.authStatus()
      authError.value = null
    } catch (err) {
      authError.value = message(err)
    }
  }

  async function loadStatus(): Promise<void> {
    try {
      status.value = await api.status()
      statusError.value = null
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && auth.value) {
        // The session lapsed (or the key was rotated from another device): back to the gate.
        auth.value = { ...auth.value, authenticated: false }
      }
      statusError.value = message(err)
    }
  }

  function startPolling(ms = 20_000): void {
    stopPolling()
    statusTimer = setInterval(() => void loadStatus(), ms)
  }
  function stopPolling(): void {
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = undefined
  }

  const needsSignIn = computed(
    () => !!auth.value && auth.value.authEnforced && !auth.value.authenticated,
  )
  const switchState = computed<SwitchStatus | null>(() => status.value?.switch ?? null)

  /** Throw the switch through `python orch.py arm|disarm`; the answer carries the fresh heartbeat read. */
  async function setArmed(on: boolean): Promise<SwitchResult> {
    switching.value = true
    try {
      const result = on ? await api.arm() : await api.disarm()
      if (status.value) status.value = { ...status.value, switch: result.switch }
      return result
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        // The gateway answers 502 with the same shape when orch.py exits non-zero.
        throw err
      }
      throw err
    } finally {
      switching.value = false
    }
  }

  async function signOut(everywhere = false): Promise<void> {
    if (everywhere) await api.logoutAll()
    else await api.logout()
    window.location.reload()
  }

  return {
    auth,
    status,
    authError,
    statusError,
    switching,
    needsSignIn,
    switchState,
    loadAuth,
    loadStatus,
    startPolling,
    stopPolling,
    setArmed,
    signOut,
  }
}
