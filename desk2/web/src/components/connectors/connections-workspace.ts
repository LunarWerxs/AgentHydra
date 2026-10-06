// One chat's Connections workspace as the chip and the Connections pane both use it: the read, the list of workspaces,
// switching this chat, the default-for-new-chats star, and Sign in. Each caller gets its own state, so the chip and the
// pane never share a half-finished request.
import { computed, ref, type Ref } from 'vue'
import type { ConnectionsCompany, ConnectionsWorkspace } from '@shared/connectors'
import { readCompanies, readWorkspace, setDefaultWorkspace, startSignin, switchWorkspace } from './connections-api'
import { chatScopeAllowed, filterCompanies, pageShouldOpen, starState } from './connections-logic'

export const NO_SESSION = 'Available once this chat has started (it has no Claude session yet)'

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useConnectionsWorkspace(chat: () => { id: string; sessionId: string | null }) {
  const ws: Ref<ConnectionsWorkspace | null> = ref(null)
  const companies: Ref<ConnectionsCompany[]> = ref([])
  const query = ref('')
  const note = ref('')
  const busy = ref(false)
  /** The list of workspaces has answered (or failed): before that, an empty list means "loading", not "nothing matches". */
  const loaded = ref(false)

  const chatOk = computed(() => chatScopeAllowed(chat().sessionId))
  const matches = computed(() => filterCompanies(companies.value, query.value))
  const showNone = computed(() => !query.value.trim() || 'no workspace'.includes(query.value.trim().toLowerCase()))

  async function load() {
    try {
      ws.value = await readWorkspace(chat().id)
      note.value = ''
    } catch (e) {
      note.value = words(e)
    }
  }
  async function loadCompanies() {
    try {
      companies.value = await readCompanies(chat().id)
    } catch (e) {
      note.value = words(e)
    } finally {
      loaded.value = true
    }
  }
  async function pick(company: string | null) {
    if (!chatOk.value) {
      note.value = NO_SESSION
      return
    }
    busy.value = true
    try {
      ws.value = await switchWorkspace({ chat: chat().id, company, scope: 'chat' })
      note.value = ''
    } catch (e) {
      note.value = words(e)
    } finally {
      busy.value = false
    }
  }
  // The star: this workspace becomes (or, on the current default, stops being) the default for NEW chats in the folder.
  async function toggleDefault(c: ConnectionsCompany) {
    try {
      ws.value = await setDefaultWorkspace({ chat: chat().id, company: starState(ws.value, c).on ? null : c.companyId })
      note.value = ''
    } catch (e) {
      note.value = words(e)
    }
  }
  async function signIn() {
    try {
      const r = await startSignin(chat().id)
      const url = pageShouldOpen(r)
      if (url) window.open(url, '_blank', 'noopener')
      note.value = r.url ? 'Approve the sign-in in your browser, then open this again' : ''
    } catch (e) {
      note.value = words(e)
    }
  }
  return { ws, companies, query, note, busy, loaded, chatOk, matches, showNone, load, loadCompanies, pick, toggleDefault, signIn }
}
