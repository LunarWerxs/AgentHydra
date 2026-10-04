// Pictures and files in the transcript: where an ImageRef loads from, what its file card says, the
// one lightbox every picture opens in. Pure apart from the shared lightbox ref.
import { ref } from 'vue'
import type { ImageRef } from '@shared/protocol'

export { isSendFileTool } from './tools'

/** The picture's address: the server's cache url, else the bytes the window itself sent; null for a file card only. */
export function imageSrc(img: ImageRef): string | null {
  if (img.url && img.url.startsWith('/api/media/')) return img.url
  if (img.dataBase64 && /^image\/(png|jpeg|gif|webp)$/.test(img.mediaType)) return `data:${img.mediaType};base64,${img.dataBase64}`
  return null
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

/** The picture open in the lightbox, if any. */
export const lightbox = ref<{ src: string; alt: string } | null>(null)

export function openLightbox(src: string, alt = ''): void {
  lightbox.value = { src, alt }
}

export function closeLightbox(): void {
  lightbox.value = null
}
