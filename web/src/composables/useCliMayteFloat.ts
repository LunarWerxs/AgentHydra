import { computed, onBeforeUnmount, ref } from 'vue'
import type { CliMayteWorkerView } from '@/lib/api'

export interface CliMayteFloatState {
  running: CliMayteWorkerView[]
  queued: CliMayteWorkerView[]
  now: number
  onRowClick?: (workerId: string) => void
}

interface StoredSize {
  width: number
  height: number
}

const PIP_STORAGE_KEY = 'agenthydra.climayte.float.size'
const DEFAULT_WIDTH = 320
const DEFAULT_HEIGHT = 400

export function useCliMayteFloat() {
  const pipWindow = ref<Window | null>(null)
  const isOpen = ref(false)
  const floatState = ref<CliMayteFloatState | null>(null)

  const storedSize = (): StoredSize => {
    const stored = localStorage.getItem(PIP_STORAGE_KEY)
    if (stored) {
      try {
        return JSON.parse(stored)
      } catch {
        return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
      }
    }
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  }

  const saveSize = (width: number, height: number) => {
    localStorage.setItem(PIP_STORAGE_KEY, JSON.stringify({ width, height }))
  }

  const cloneStylesheets = (targetDoc: Document) => {
    const sourceLinks = document.head.querySelectorAll('link[rel="stylesheet"]')
    for (const link of sourceLinks) {
      const clone = link.cloneNode(true)
      targetDoc.head.appendChild(clone)
    }

    const sourceStyles = document.head.querySelectorAll('style')
    for (const style of sourceStyles) {
      const clone = style.cloneNode(true)
      targetDoc.head.appendChild(clone)
    }
  }

  const open = async (state: CliMayteFloatState): Promise<boolean> => {
    if (!('documentPictureInPicture' in window)) {
      return false
    }

    try {
      const size = storedSize()
      const window_ = await (window.documentPictureInPicture as any).requestWindow({
        width: size.width,
        height: size.height,
      })

      pipWindow.value = window_
      floatState.value = state
      isOpen.value = true

      cloneStylesheets(window_.document)

      const root = window_.document.createElement('div')
      root.id = 'pip-root'
      root.style.cssText = 'width: 100%; height: 100%; display: flex; flex-direction: column;'
      window_.document.body.style.cssText =
        'margin: 0; padding: 0; overflow: hidden; font-family: inherit;'
      window_.document.body.appendChild(root)

      window_.addEventListener('pagehide', () => {
        pipWindow.value = null
        isOpen.value = false
        floatState.value = null
      })

      window_.addEventListener('resize', () => {
        saveSize(window_.innerWidth, window_.innerHeight)
      })

      return true
    } catch {
      return false
    }
  }

  const close = () => {
    if (pipWindow.value) {
      pipWindow.value.close()
      pipWindow.value = null
      isOpen.value = false
      floatState.value = null
    }
  }

  const updateState = (state: CliMayteFloatState) => {
    floatState.value = state
  }

  onBeforeUnmount(() => {
    close()
  })

  return {
    pipWindow: computed(() => pipWindow.value),
    pipDocument: computed(() => pipWindow.value?.document),
    floatState: computed(() => floatState.value),
    isOpen: computed(() => isOpen.value),
    open,
    close,
    updateState,
  }
}
