export type AppMode = 'full' | 'instances'

/** Path-based on purpose: Chromium keys app-window geometry by pathname but ignores query strings,
 * and Vite can split the two roots before either component graph is imported. */
export function appModeForPath(pathname: string): AppMode {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  return normalized === '/instances' ? 'instances' : 'full'
}
