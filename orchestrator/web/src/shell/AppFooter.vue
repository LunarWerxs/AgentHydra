<script setup lang="ts">
/**
 * AppFooter, the single sponsor credit shown at the bottom of every LunarWerx
 * app. The wording is intentionally literal English (not i18n) so one component
 * serves apps with and without vue-i18n; it lives in src/shell, which every
 * app's i18n prose check exempts. Width tracks the shared `--container-max`.
 */
withDefaults(defineProps<{ name?: string; url?: string }>(), {
  name: "LunarWerx Studios",
  url: "https://lunarwerx.com/",
});
</script>

<template>
  <footer
    class="mx-auto w-full max-w-(--container-max) px-4 pb-6 pt-4 text-center text-xs text-muted-foreground/60 sm:px-6"
  >
    <span>
      Created by
      <a
        :href="url"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >{{ name }}</a
      >
    </span>
  </footer>
</template>
