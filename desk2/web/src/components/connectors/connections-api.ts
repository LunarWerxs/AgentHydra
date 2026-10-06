// The Connections chip's calls to Desk 2's server (routes in shared/connectors.ts, server plugins/58-connections.ts),
// and its one shared read of GET /api/connectors (is the connector on and on this machine).
import { ref } from 'vue'
import {
  CONNECTIONS_COMPANIES,
  CONNECTIONS_SIGNIN,
  CONNECTIONS_SWITCH,
  CONNECTIONS_WORKSPACE,
  CONNECTORS,
  type ConnectionsCompany,
  type ConnectionsSignin,
  type ConnectionsSwitch,
  type ConnectionsWorkspace,
  type ConnectorsResponse,
  type ConnectorView
} from '@shared/connectors'

export const connectorList = ref<ConnectorView[] | null>(null)

export async function refreshConnectorList(): Promise<void> {
  try {
    const res = await fetch(CONNECTORS)
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) connectorList.value = ((await res.json()) as ConnectorsResponse).connectors
  } catch {
    /* the server is restarting: keep what was last seen */
  }
}

async function ask<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return body
}

const post = (url: string, body: object): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const readWorkspace = (chat: string): Promise<ConnectionsWorkspace> => fetch(`${CONNECTIONS_WORKSPACE}?chat=${encodeURIComponent(chat)}`).then((r) => ask(r))

export const readCompanies = (chat: string): Promise<ConnectionsCompany[]> =>
  fetch(`${CONNECTIONS_COMPANIES}?chat=${encodeURIComponent(chat)}`)
    .then((r) => ask<{ companies: ConnectionsCompany[] }>(r))
    .then((b) => b.companies)

export const switchWorkspace = (s: ConnectionsSwitch): Promise<ConnectionsWorkspace> => post(CONNECTIONS_SWITCH, s).then((r) => ask(r))

export const startSignin = (chat: string): Promise<ConnectionsSignin> => post(CONNECTIONS_SIGNIN, { chat }).then((r) => ask(r))
