// Failure incidents (server/src/incidents.ts) — list/ack/resolve over HTTP, for the web UI's
// Incidents panel. Same shape as routes/queue.ts's other small resource routes.
import { app } from '../http-app'
import {
  ackIncident,
  getIncident,
  INCIDENT_STATES,
  type IncidentState,
  listIncidents,
  resolveIncident,
} from '../incidents'

function parseState(raw: string | undefined): IncidentState | undefined {
  if (raw === undefined) return undefined
  return INCIDENT_STATES.includes(raw as IncidentState) ? (raw as IncidentState) : undefined
}

app.get('/api/incidents', (c) => {
  const state = c.req.query('state')
  if (state !== undefined && parseState(state) === undefined) {
    return c.json({ error: `state must be one of: ${INCIDENT_STATES.join(', ')}` }, 400)
  }
  return c.json(listIncidents(parseState(state)))
})

app.get('/api/incidents/:id', (c) => {
  const incident = getIncident(c.req.param('id'))
  if (!incident) return c.json({ error: 'incident not found' }, 404)
  return c.json(incident)
})

app.post('/api/incidents/:id/ack', (c) => {
  const id = c.req.param('id')
  if (!getIncident(id)) return c.json({ error: 'incident not found' }, 404)
  return c.json({ ok: ackIncident(id), incident: getIncident(id) })
})

app.post('/api/incidents/:id/resolve', (c) => {
  const id = c.req.param('id')
  if (!getIncident(id)) return c.json({ error: 'incident not found' }, 404)
  return c.json({ ok: resolveIncident(id), incident: getIncident(id) })
})
