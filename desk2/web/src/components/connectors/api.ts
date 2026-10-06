// The calls Settings → Connectors makes: GET /api/connectors and the four actions (shared/connectors.ts).
import { CONNECTORS, connectorAction, type ConnectorAction, type ConnectorId, type ConnectorsResponse, type ConnectorView } from '@shared/connectors'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new Error(err || `${res.status} ${res.statusText}`)
  }
  return body as T
}

export const listConnectors = async (): Promise<ConnectorView[]> => (await call<ConnectorsResponse>(CONNECTORS)).connectors

export const runConnectorAction = (id: ConnectorId, action: ConnectorAction): Promise<ConnectorView> =>
  call(connectorAction(id, action), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
