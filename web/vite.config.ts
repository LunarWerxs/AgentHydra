import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * Drop the kit's Google Fonts `@import` from this app's CSS, because we serve Inter ourselves.
 *
 * styles/kit-base.css opens with `@import url('https://fonts.googleapis.com/css2?family=Inter…')`.
 * A remote @import at the head of a render-blocking stylesheet blocks first paint on a round trip
 * to fonts.googleapis.com — pure dead time for a local desktop app, and an outright stall with no
 * network. src/style.css declares the same typeface from web/public/fonts/ instead; this removes
 * the remote one so the two don't both load.
 *
 * Done here rather than by editing kit-base.css because that file is VENDORED FROM THE SHARED KIT
 * (lunarwerx-ui) and `bun run check:kit` fails on any byte of drift. Stripping at build time keeps
 * the checked-in copy identical to the kit while this app opts out of the behaviour. See the long
 * comment in src/style.css for why the fix isn't pushed up into the kit itself.
 *
 * It runs at `enforce: 'post'` AND again over the emitted bundle. Both are needed: @tailwindcss/vite
 * inlines the `@import` chain itself and re-serialises the result (dropping `url(...)` to a bare
 * string in the process), so a `pre` transform on the entry stylesheet never sees the kit's line —
 * verified 2026-08-06, the remote import survived that shape untouched.
 */
function stripRemoteFontImport(): Plugin {
  // Both spellings: `@import url('https://…');` as authored in the kit, and the bare
  // `@import"https://…";` Tailwind re-serialises it to.
  //
  // The URL body is matched up to its QUOTE or CLOSING PAREN, never up to a semicolon — the
  // Google Fonts URL contains semicolons of its own (`wght@400;500;600;700`). An earlier version
  // used `[^;)]*` and cut the at-rule in half, leaving `500;600;700&display=swap";` as garbage at
  // the head of the stylesheet; the browser then failed to parse the whole file and the entire UI
  // fell back to unstyled Times New Roman. Keep the terminators as they are.
  const REMOTE_FONT_IMPORT = new RegExp(
    [
      // @import url("https://fonts.googleapis.com/…") ;   (quoted inside url())
      String.raw`@import\s*url\(\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\1\s*\)\s*;`,
      // @import url(https://fonts.googleapis.com/…) ;     (bare inside url())
      String.raw`@import\s*url\(\s*https:\/\/fonts\.googleapis\.com[^)]*\)\s*;`,
      // @import "https://fonts.googleapis.com/…" ;        (no url(), what Tailwind emits)
      String.raw`@import\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\2\s*;`,
    ].join('|'),
    'g',
  )
  const strip = (css: string) => css.replace(REMOTE_FONT_IMPORT, '')
  return {
    name: 'agenthydra:strip-remote-font-import',
    enforce: 'post',
    transform(code, id) {
      if (!id.endsWith('.css') || !code.includes('fonts.googleapis.com')) return null
      return { code: strip(code), map: null }
    },
    // The build-time backstop, and the one that actually does the work: @tailwindcss/vite assembles
    // the final stylesheet outside the transform pipeline above, so the `post` transform never sees
    // it (verified 2026-08-06 — dropping this hook puts the remote @import straight back). Whatever
    // produced the CSS, the file the daemon serves must not carry a remote font import.
    //
    // Caveat, deliberate: this runs AFTER Rollup hashes the asset filename, so the hash describes
    // the pre-strip content. Harmless in practice — the strip is deterministic, so the same source
    // always yields the same output — but it means editing THIS PLUGIN without touching any CSS
    // reuses the old filename, and a browser will happily serve you its cached copy. Hard-reload
    // when iterating here.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue
        const css =
          typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8')
        if (!css.includes('fonts.googleapis.com')) continue
        const next = strip(css)
        // Loud rather than silent: if Google's URL or the at-rule shape ever changes, this plugin
        // would quietly stop working and the blocking fetch would creep back onto the startup path.
        if (next.includes('fonts.googleapis.com'))
          this.warn(`${file.fileName} still references fonts.googleapis.com — check the pattern.`)
        file.source = next
      }
    },
  }
}

export default defineConfig({
  plugins: [stripRemoteFontImport(), vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      // This app is still on vite 6 (classic Rollup). @vueuse/core ships /* #__PURE__ */ comments
      // in positions Rollup can't bind to a call expression (e.g. before an object literal), which
      // it warns as INVALID_ANNOTATION. The annotation is inert there — drop that one benign
      // warning and forward everything else. (rolldown-vite apps use build.rollupOptions.checks.)
      onwarn(warning, defaultHandler) {
        if (warning.code === 'INVALID_ANNOTATION') return
        defaultHandler(warning)
      },
      output: {
        // Split heavy vendor libs into their own chunks so no single bundle trips the 500 kB
        // warning and the browser can cache each independently (app code changes more often).
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('reka-ui') || id.includes('@floating-ui')) return 'vendor-reka'
          if (id.includes('@lucide') || id.includes('lucide')) return 'vendor-icons'
          if (id.includes('vue-i18n') || id.includes('@intlify')) return 'vendor-i18n'
          if (id.includes('@vueuse')) return 'vendor-vueuse'
          return 'vendor'
        },
      },
    },
  },
  server: {
    // PORT env wins so parallel dev instances (e.g. two chat sessions) can coexist
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
})
