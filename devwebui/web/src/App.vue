<script setup lang="ts">
import { Toaster } from "vue-sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";
import { applyWindowSizeHint } from "@/lib/window-size-hint";
import { processIdFromFocusPath } from "../../shared/constants";
import AppShell from "./AppShell.vue";
import FocusView from "./components/FocusView.vue";

// Portable --app windows opened while a sibling window was already running inherit that
// window's geometry (Chromium ignores --window-size AND the saved placement on a
// forwarded launch), so the daemon tags their URL with the size they should be and the
// page corrects itself before anything renders. No-op in a browser tab or un-hinted URL.
applyWindowSizeHint();

// Shared kit light/dark/system theme; drives the toaster theme. DevWebUI now defaults
// to dark (was the lone OS-`auto` outlier). `mode` ("light" | "dark" | "system") maps
// 1:1 to vue-sonner's theme prop.
const { mode } = useTheme();

// `/focus/<id>` swaps the whole dashboard for the single-process focus view that a
// desktop shortcut opens. Read once at startup rather than reactively: this app has no
// router and this is not a navigable route — the window is launched directly onto it,
// and "Open dashboard" is a full document navigation back to "/".
//
// The legacy `/?process=<id>` form is still honoured: shortcuts don't encode the URL (the
// .lnk only stores `open-process <file> <id>`, and the launcher builds the URL fresh), so
// nothing on disk needs migrating — but a window left open across an update, or a
// bookmark, can still be on the old URL.
const focusProcessId =
  processIdFromFocusPath(window.location.pathname) ??
  new URLSearchParams(window.location.search).get("process");
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <FocusView v-if="focusProcessId" :process-id="focusProcessId" />
    <AppShell v-else />
    <Toaster
      :theme="mode"
      position="bottom-center"
      :duration="3500"
      :offset="16"
      rich-colors
      close-button
    />
  </TooltipProvider>
</template>
