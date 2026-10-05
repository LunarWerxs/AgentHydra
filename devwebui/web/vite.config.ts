import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Keep in sync with the daemon's DEFAULT_DAEMON_PORT (server/src/constants.ts).
// Honour DEVWEBUI_PORT so the proxy follows a daemon started on a custom port.
const DAEMON_PORT = Number(process.env.DEVWEBUI_PORT) || 4000;

/**
 * Drop the kit's Google Fonts `@import` from this app's CSS, because we serve Inter ourselves.
 *
 * styles/kit-base.css opens with `@import url('https://fonts.googleapis.com/css2?family=Inter...')`.
 * A remote @import at the head of a render-blocking stylesheet blocks first paint on a round trip
 * to fonts.googleapis.com: pure dead time for a local desktop app, and an outright stall with no
 * network. The app's entry stylesheet declares the same typeface from public/fonts/ instead; this
 * removes the remote one so the two don't both load.
 *
 * Done here rather than by editing kit-base.css because that file is VENDORED FROM THE SHARED KIT
 * (lunarwerx-ui) and its `--check` fails on any byte of drift. Stripping at build time keeps the
 * checked-in copy identical to the kit while this app opts out of the behaviour.
 */
function stripRemoteFontImport(): Plugin {
  // Both spellings: `@import url('https://...');` as authored in the kit, and the bare
  // `@import"https://...";` Tailwind re-serialises it to.
  //
  // The URL body is matched up to its QUOTE or CLOSING PAREN, never up to a semicolon: the Google
  // Fonts URL contains semicolons of its own (`wght@400;500;600;700`). Matching to `;` cuts the
  // at-rule in half and leaves garbage at the head of the stylesheet, which makes the browser fail
  // to parse the whole file and drops the entire UI to unstyled Times New Roman. Keep these
  // terminators as they are.
  const REMOTE_FONT_IMPORT = new RegExp(
    [
      // @import url("https://fonts.googleapis.com/…") ;   (quoted inside url())
      String.raw`@import\s*url\(\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\1\s*\)\s*;`,
      // @import url(https://fonts.googleapis.com/…) ;     (bare inside url())
      String.raw`@import\s*url\(\s*https:\/\/fonts\.googleapis\.com[^)]*\)\s*;`,
      // @import "https://fonts.googleapis.com/…" ;        (no url(), what Tailwind emits)
      String.raw`@import\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\2\s*;`,
    ].join("|"),
    "g",
  );
  const strip = (css: string) => css.replace(REMOTE_FONT_IMPORT, "");
  return {
    name: "strip-remote-font-import",
    enforce: "post",
    transform(code, id) {
      if (!id.endsWith(".css") || !code.includes("fonts.googleapis.com")) return null;
      return { code: strip(code), map: null };
    },
    // The hook that actually does the work: @tailwindcss/vite assembles the final stylesheet
    // outside the transform pipeline above, so the `post` transform never sees it. Whatever
    // produced the CSS, the file the daemon serves must not carry a remote font import.
    //
    // Caveat, deliberate: this runs AFTER Rollup hashes the asset filename, so the hash describes
    // the pre-strip content. Harmless in practice (the strip is deterministic), but editing THIS
    // PLUGIN without touching any CSS reuses the old filename. Hard-reload when iterating here.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const css =
          typeof file.source === "string" ? file.source : Buffer.from(file.source).toString("utf8");
        if (!css.includes("fonts.googleapis.com")) continue;
        const next = strip(css);
        if (next.includes("fonts.googleapis.com"))
          this.warn(`${file.fileName} still references fonts.googleapis.com; check the pattern.`);
        file.source = next;
      }
    },
  };
}

export default defineConfig({
  plugins: [stripRemoteFontImport(), vue(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    rollupOptions: {
      // @vueuse/core ships /* #__PURE__ */ comments in positions rolldown can't bind to a call
      // expression (e.g. before an object literal); it flags them as INVALID_ANNOTATION even
      // though the annotation is inert there. Silence that one benign check to keep builds quiet.
      checks: { invalidAnnotation: false },
      output: {
        // Split the heavy vendor libraries into their own chunks so no single
        // bundle blows past the 500 kB warning and the browser can cache each
        // independently (app code changes far more often than these do).
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("reka-ui") || id.includes("@floating-ui")) return "vendor-reka";
          if (id.includes("@lucide") || id.includes("lucide")) return "vendor-icons";
          if (id.includes("vue-i18n") || id.includes("@intlify")) return "vendor-i18n";
          if (id.includes("@vueuse")) return "vendor-vueuse";
          return "vendor"; // vue, pinia, vue-sonner, and the long tail
        },
      },
    },
  },
  server: {
    port: 4010,
    strictPort: true,
    proxy: {
      // Everything under /api goes to the DevWebUI daemon (REST + SSE).
      "/api": { target: `http://localhost:${DAEMON_PORT}`, changeOrigin: true },
    },
  },
});
