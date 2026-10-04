import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const server = 'http://127.0.0.1:7795'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    // Parallel workers pass their own `--port <n> --strictPort` (SPEC "Parallel workers and ports").
    port: 4795,
    proxy: {
      '/api': { target: server },
      '/ws': { target: server, ws: true },
    },
  },
})
