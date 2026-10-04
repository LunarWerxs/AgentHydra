import { useStorage } from "@vueuse/core";

/**
 * App-wide "show tooltips" switch shared by every LunarWerx app.
 *
 * One localStorage-persisted reactive flag (same posture as lib/theme.ts) that the kit's
 * TooltipProvider wrapper consumes as its default `disabled` state, so a single Settings
 * switch gates every hover tooltip in the app with no per-call-site wiring. InfoHint
 * deliberately opts back in via a nested always-enabled provider — its disclosed text has
 * no other surface, so the kill-switch must never strand it (see shell/InfoHint.vue).
 */
export const TOOLTIPS_STORAGE_KEY = "lunarwerx-tooltips-enabled";

// Module-level singleton (mirrors lib/theme.ts's `mode`): one source of truth per app.
const enabled = useStorage<boolean>(TOOLTIPS_STORAGE_KEY, true);

export function useTooltipConfig() {
  return { enabled };
}
