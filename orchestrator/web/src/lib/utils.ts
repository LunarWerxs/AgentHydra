import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn-vue class merge helper. Shared verbatim across all apps. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The ONE prefers-reduced-motion read for every kit module (the theme crossfade, the resize-grip
 * reset glide, ...). Keeping the SSR guard, the matchMedia capability check and the policy in a
 * single place stops the copies drifting apart. Stylesheet-level motion is handled separately by
 * the `@media (prefers-reduced-motion: reduce)` block in base.css.
 *
 * Read on every call rather than cached, so a change to the OS setting applies to the next
 * animation without a reload.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}
