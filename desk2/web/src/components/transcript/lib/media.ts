// Pictures and files in the transcript: where an ImageRef loads from, what its file card says, the
// one lightbox every picture opens in. Pure apart from the shared lightbox ref.
import { ref } from 'vue'
import type { ImageRef } from '@shared/protocol'

import { stepIndex } from './viewer'

export { isSendFileTool } from './tools'

/** The picture's address: the server's cache url, else the bytes the window itself sent; null for a video or a file card only. */
export function imageSrc(img: ImageRef): string | null {
  if (img.url && img.url.startsWith('/api/media/') && !img.mediaType.startsWith('video/')) return img.url
  if (img.dataBase64 && /^image\/(png|jpeg|gif|webp)$/.test(img.mediaType)) return `data:${img.mediaType};base64,${img.dataBase64}`
  return null
}

/** A video's address: the server's cache url of an mp4 or webm; null for anything else. */
export function videoSrc(img: ImageRef): string | null {
  return img.mediaType.startsWith('video/') && img.url?.startsWith('/api/media/') ? img.url : null
}

/** The type badge of a file card: the extension in capitals ("PNG"), else the media subtype. */
export function fileBadge(img: ImageRef): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(img.name ?? '')?.[1]
  if (ext) return ext.toUpperCase()
  const sub = img.mediaType.split('/')[1] ?? 'file'
  return (sub === 'jpeg' ? 'jpg' : sub.replace(/^svg\+xml$/, 'svg')).toUpperCase().slice(0, 5)
}

/** A file size as the real card writes it: "67.2KB", "1.4MB", "812B". */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export interface ViewerPicture {
  src: string
  alt: string
}

/** The viewer's state while it is open: the pictures of one message and which one shows; null when closed. */
export const lightbox = ref<{ items: ViewerPicture[]; index: number } | null>(null)

/**
 * Open the viewer on `src`. `group` is the message's pictures in order (Left/Right step through them); without
 * it, or when `src` is not among them, the viewer holds just that one picture.
 */
export function openLightbox(src: string, alt = '', group?: ViewerPicture[]): void {
  const at = group ? group.findIndex((p) => p.src === src) : -1
  lightbox.value = at >= 0 ? { items: group!, index: at } : { items: [{ src, alt }], index: 0 }
}

export function closeLightbox(): void {
  lightbox.value = null
}

/** Show the previous or next picture of the message; stops at both ends. */
export function stepLightbox(delta: number): void {
  const lb = lightbox.value
  if (lb) lightbox.value = { items: lb.items, index: stepIndex(lb.index, lb.items.length, delta) }
}

/**
 * Space on a focused picture tile opens the viewer (a click does too). The key is taken here, both on press
 * and release, so the button's own "click on Space release" cannot reopen a viewer that Space just closed.
 */
export function tileKey(e: { key: string; type: string; preventDefault(): void }, open: () => void): void {
  if (e.key !== ' ' && e.key !== 'Spacebar') return
  e.preventDefault()
  if (e.type === 'keydown') open()
}
