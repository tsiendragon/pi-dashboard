import { LIVE_SESSION_MAX_IMAGE_BYTES, LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES } from '@shared/live-sessions'

/**
 * Attached images travel inline as base64 inside the live-session protocol, so a
 * pasted 4K screenshot or phone photo blows past the per-image / total budgets and
 * the server rejects the whole command. Instead of asking the user to go shrink the
 * file somewhere else, we downscale + re-encode before the image is attached.
 */

/** Longest edge kept when we have to re-encode: enough for text screenshots, cheap to send. */
export const IMAGE_ATTACH_MAX_DIMENSION = 2048

const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5]
/** Extra shrink rounds after the quality ladder bottoms out. */
const MAX_SCALE_ROUNDS = 3

export interface PreparedImage {
  /** base64 payload without the `data:` prefix — shape of `LiveSessionImage.data`. */
  data: string
  mimeType: string
  /** Data URL for the thumbnail preview. */
  preview: string
  /** base64 length actually sent (what the protocol limit measures). */
  bytes: number
  /** Size of the file the user attached, before any downscaling. */
  originalBytes: number
  width?: number
  height?: number
  /** True when the image was re-encoded, i.e. the bytes on the wire are not the original. */
  resized: boolean
}

/** Base64 payload length for a file of `bytes` size, without reading it. */
export function base64LengthForBytes(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Per-image base64 budget once `total` images ride in one message: the per-image
 * limit, capped by an even share of the total limit.
 */
export function imageBudgetForCount(total: number): number {
  const share = Math.floor(LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES / Math.max(1, total))
  return Math.max(64 * 1024, Math.min(LIVE_SESSION_MAX_IMAGE_BYTES, share))
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      if (url.indexOf(',') < 0) {
        reject(new Error('图片读取失败'))
        return
      }
      resolve(url)
    }
    reader.readAsDataURL(blob)
  })
}

function blobToBase64(blob: Blob): Promise<string> {
  return readAsDataUrl(blob).then(url => url.slice(url.indexOf(',') + 1))
}

type Drawable = ImageBitmap | HTMLImageElement

/** Wrap a base64 payload (e.g. from the native picker bridge) so it can go through the same path. */
export function base64ToFile(data: string, mimeType: string, name = 'picked-image'): File {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], name, { type: mimeType || 'image/png' })
}

interface DecodedImage {
  source: Drawable
  width: number
  height: number
  release: () => void
}

async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      // Some formats (older SVG/HEIC) fail here but still load through <img>.
    }
  }
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('图片解码失败，无法压缩'))
      element.src = objectUrl
    })
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      release: () => URL.revokeObjectURL(objectUrl),
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('图片压缩失败'))), 'image/jpeg', quality)
  })
}

/**
 * Downscale + re-encode `file` until its base64 payload fits `budgetBytes`.
 * Small images pass through untouched (no decode, no quality loss).
 */
export async function prepareImageForAttach(
  file: File,
  budgetBytes: number = imageBudgetForCount(1),
): Promise<PreparedImage> {
  const originalBytes = file.size
  const mimeType = file.type || 'image/png'
  if (base64LengthForBytes(originalBytes) <= budgetBytes) {
    const dataUrl = await readAsDataUrl(file)
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
    return { data, mimeType, preview: dataUrl, bytes: data.length, originalBytes, resized: false }
  }

  const decoded = await decodeImage(file)
  try {
    if (!decoded.width || !decoded.height) throw new Error('图片尺寸无效，无法压缩')
    let scale = Math.min(1, IMAGE_ATTACH_MAX_DIMENSION / Math.max(decoded.width, decoded.height))
    for (let round = 0; round <= MAX_SCALE_ROUNDS; round++) {
      const width = Math.max(1, Math.round(decoded.width * scale))
      const height = Math.max(1, Math.round(decoded.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('当前浏览器无法压缩图片，请改用较小的图片')
      // JPEG carries no alpha: paint white so transparent PNGs do not turn black.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      context.drawImage(decoded.source, 0, 0, width, height)
      for (const quality of JPEG_QUALITIES) {
        const blob = await canvasToBlob(canvas, quality)
        const data = await blobToBase64(blob)
        if (data.length <= budgetBytes) {
          return {
            data,
            mimeType: 'image/jpeg',
            preview: `data:image/jpeg;base64,${data}`,
            bytes: data.length,
            originalBytes,
            width,
            height,
            resized: true,
          }
        }
      }
      scale *= 0.75
    }
    throw new Error('图片过大，自动压缩后仍超出限制，请改用更小的图片')
  } finally {
    decoded.release()
  }
}

/** Human-readable byte size for the "已压缩" hint. */
export function formatBytes(bytes: number): string {  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}