import { join } from 'node:path'
import { CONFIG_DIR, INSTANCE_MODE_WINDOW_SIZE } from './config'
import { openUi } from './open-ui'
import { openPortableWindow, type PortableWindowResult } from './portable-window.mjs'
import { WINDOW_SIZE_HINT_PARAM, windowSizeHintFor } from './window-size'

export const INSTANCE_MODE_PATH = '/instances'
export const INSTANCE_MODE_PROFILE_DIR = join(CONFIG_DIR, 'instance-portable-profile')

/** Resolve the quick surface from any daemon base URL without carrying through a full-app path,
 * query, or hash. Kept pure for focused path/placement tests. */
export function instanceModeUrl(baseUrl: string): string {
  return new URL(INSTANCE_MODE_PATH, baseUrl).toString()
}

/** Open the quick surface in its own compact app window, falling back to a normal browser tab when
 * no Chromium app-window host is available. This works against either the full or lightweight
 * daemon; the UI selects its root from the pathname. */
export async function openInstanceModeWindow(baseUrl: string): Promise<PortableWindowResult> {
  const url = instanceModeUrl(baseUrl)
  let target = url
  const hint = windowSizeHintFor(INSTANCE_MODE_PROFILE_DIR, url, INSTANCE_MODE_WINDOW_SIZE)
  if (hint) {
    const hinted = new URL(url)
    hinted.searchParams.set(WINDOW_SIZE_HINT_PARAM, hint)
    target = hinted.toString()
  }

  const result = await openPortableWindow(target, {
    profileDir: INSTANCE_MODE_PROFILE_DIR,
    initialSize: INSTANCE_MODE_WINDOW_SIZE,
  })
  if (!result.ok) openUi(target)
  return result
}
