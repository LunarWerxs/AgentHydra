// server/tests/side-run-header.test.ts - a daemon with a relocated store says so on every /api/*
// answer and in /api/health, so no client mistakes a scratch database for the fleet's.

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { IS_PRIMARY_INSTALL } from '../src/instance'
import { SIDE_RUN_HEADER, sideRunHeader, sideRunHealthFields } from '../src/side-run'

function appWith(sideRun: boolean) {
  return new Hono()
    .use('/api/*', sideRunHeader(sideRun, 'X:/scratch/agenthydra.db'))
    .get('/api/ping', (c) => c.json({ ok: true }))
    .get('/other', (c) => c.text('not api'))
}

describe('sideRunHeader', () => {
  test('a side-run stamps every /api answer with its store', async () => {
    const res = await appWith(true).request('/api/ping')
    expect(res.status).toBe(200)
    expect(res.headers.get(SIDE_RUN_HEADER)).toBe('X:/scratch/agenthydra.db')
    expect(await res.json()).toEqual({ ok: true })
  })

  test('a primary install adds nothing', async () => {
    const res = await appWith(false).request('/api/ping')
    expect(res.headers.get(SIDE_RUN_HEADER)).toBeNull()
  })

  test('the stamp is scoped to /api, where the clients look', async () => {
    const res = await appWith(true).request('/other')
    expect(res.headers.get(SIDE_RUN_HEADER)).toBeNull()
  })
})

describe('sideRunHealthFields', () => {
  test('names this process, whether the store is the machine\u2019s, and where the pointer lives', () => {
    const fields = sideRunHealthFields()
    expect(fields.pid).toBe(process.pid)
    expect(fields.sideRun).toBe(!IS_PRIMARY_INSTALL)
    expect(fields.pointerFile.replace(/\\/g, '/')).toMatch(/\/runtime\.json$/)
  })
})
