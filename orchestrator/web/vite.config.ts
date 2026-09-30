import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// The remote gateway (server/src/main.ts) serves web/dist and owns /api/* and /oauth/*. In dev
// the Vite server proxies those two prefixes to it, so the SPA talks to the same daemon it will
// be served by. The port is written once, in ../package.json config.remotePort.
const REMOTE_PORT: number = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).config.remotePort
const GATEWAY = `http://127.0.0.1:${process.env.ORCH_REMOTE_PORT || REMOTE_PORT}`

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // @vueuse/core ships /* #__PURE__ */ annotations Rollup cannot bind; inert, not a bug.
        if (warning.code === 'INVALID_ANNOTATION') return
        defaultHandler(warning)
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('reka-ui') || id.includes('@floating-ui')) return 'vendor-reka'
          if (id.includes('@lucide') || id.includes('lucide')) return 'vendor-icons'
          if (id.includes('@vueuse')) return 'vendor-vueuse'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: Number(process.env.PORT) || 5179,
    strictPort: false,
    proxy: {
      '/api': GATEWAY,
      '/oauth': GATEWAY,
    },
  },
})
