<script setup lang="ts">
import { provide } from 'vue'
import type { LocalhostState } from '@shared/protocol'
import LocalhostPanel from '@/components/localhost/LocalhostPanel.vue'
import { LOCALHOST_API, type LocalhostApi } from '@/components/localhost/api'

// The globe button's panel on fixture answers: a Desk-started Vite server with its log, a plain node server,
// a startable preview script, and DevWebUI not running.
const FOLDER = 'C:/Users/me/Projects/site'
const now = Date.now()
const state: LocalhostState = {
  folder: FOLDER,
  hidden: 41,
  error: null,
  scannedAt: now,
  devwebui: { up: false, url: 'http://127.0.0.1:4000', error: 'not running', processes: 0 },
  servers: [
    { port: 5173, address: '127.0.0.1', pid: 4120, process: 'node', command: 'node vite', cwd: FOLDER, project: FOLDER, url: 'http://localhost:5173/', http: { status: 200, title: 'Site preview' }, kind: 'dev', startedAt: now - 14 * 60_000, managed: 'desk', managedId: 'script:dev' },
    { port: 8188, address: '127.0.0.1', pid: 2461, process: 'python', command: 'python main.py --port 8188', cwd: null, project: null, url: 'http://localhost:8188/', http: { status: 200, title: 'ComfyUI' }, kind: 'dev', startedAt: now - 26 * 3_600_000, managed: null, managedId: null },
    { port: 3001, address: '0.0.0.0', pid: 7781, process: 'bun', command: 'bun run api', cwd: null, project: 'C:/Users/me/Projects/api', url: 'http://localhost:3001/', http: null, kind: 'dev', startedAt: now - 3 * 60_000, managed: null, managedId: null }
  ],
  startable: [
    { id: 'script:dev', name: 'dev', command: 'bun run dev', cwd: FOLDER, source: 'package.json', port: 5173, running: { pid: 4120, port: 5173, startedAt: now - 14 * 60_000, status: 'running' }, managed: 'desk' },
    { id: 'script:preview', name: 'preview', command: 'bun run preview', cwd: FOLDER, source: 'package.json', port: null, running: null, managed: null }
  ]
}
const api: LocalhostApi = {
  state: async () => state,
  start: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
  restart: async () => ({ ok: true }),
  log: async (_f, id) => ({ id, source: 'desk', lines: ['$ vite', '', '  VITE v7.1.3  ready in 412 ms', '', '  Local:   http://localhost:5173/'] })
}
provide(LOCALHOST_API, api)
</script>

<template>
  <div class="w-fit rounded-[var(--radius-10)] bg-[var(--bg-popover)] shadow-(--shadow-menu-ringed)">
    <LocalhostPanel :folder="FOLDER" :poll-ms="0" />
  </div>
</template>
