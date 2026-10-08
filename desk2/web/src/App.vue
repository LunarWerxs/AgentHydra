<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, h, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import DeskFrame from '@/components/shell/DeskFrame.vue'
import TitleTips from '@/components/ui/tooltip/TitleTips.vue'
import { SHELL_SOURCE } from '@/components/shell/source'
import type { View } from '@/components/shell/logic'
import { COMPOSER_API } from '@/components/composer/api'

// The gallery and the demo window (and the fixtures they draw) load only when their route is opened, so
// the app itself never downloads or parses them.
const Gallery = defineAsyncComponent(() => import('@/dev/Gallery.vue'))
// The picture viewer loads after the first paint, out of the files the window needs to draw.
const Lightbox = defineAsyncComponent(() => import('@/components/transcript/parts/Lightbox.vue'))

// Routes: `#/gallery` is the component gallery, `#/gallery/shell` the whole window on fixtures (no
// server needed; `/new` the new-session screen, `/accounts` the account popup open, `/collapsed` the
// sidebar hidden, `/external` a session running elsewhere, `/settings` the Settings dialog open over a
// chat), anything else the app.
const hash = ref(window.location.hash.slice(1))
const onHash = () => (hash.value = window.location.hash.slice(1))
onMounted(() => window.addEventListener('hashchange', onHash))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash))

const route = computed(() => (hash.value === '/gallery' ? 'gallery' : hash.value.startsWith('/gallery/shell') ? 'demo' : 'app'))

const DemoFrame = defineAsyncComponent(async () => {
  const { demoComposerApi, demoSource } = await import('@/components/shell/demo')
  return defineComponent({
    props: { start: { type: String, default: '' } },
    setup(props) {
      const start: View =
        props.start === 'new'
          ? { kind: 'new' }
          : props.start === 'external'
            ? { kind: 'external', id: 'x-run' }
            : props.start === 'settings'
              ? { kind: 'settings' }
              : { kind: 'chat', id: 'ccd' }
      provide(SHELL_SOURCE, demoSource(start))
      provide(COMPOSER_API, demoComposerApi)
      // Settings opens over the chat it was opened from.
      const history: View[] | undefined = start.kind === 'settings' ? [{ kind: 'chat', id: 'ccd' }] : undefined
      return () => h(DeskFrame, { demo: true, accountsOpen: props.start === 'accounts', sidebarHidden: props.start === 'collapsed', history })
    }
  })
})
</script>

<template>
  <Gallery v-if="route === 'gallery'" />
  <div v-else class="size-screen">
    <DemoFrame v-if="route === 'demo'" :key="hash" :start="hash.split('/')[3] ?? ''" />
    <DeskFrame v-else />
    <TitleTips />
  </div>
  <!-- One full-size picture viewer for every view: a transcript's pictures and the composer's attachments -->
  <Lightbox />
</template>
