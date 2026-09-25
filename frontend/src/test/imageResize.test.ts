import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  base64LengthForBytes,
  base64ToFile,
  imageBudgetForCount,
  prepareImageForAttach,
} from '../utils/imageResize'
import { LIVE_SESSION_MAX_IMAGE_BYTES, LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES } from '@shared/live-sessions'

/** A blob of `size` bytes whose base64 payload has the requested length (4/3 of raw). */
function blobOfBase64Length(base64Length: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(Math.floor((base64Length * 3) / 4))], { type })
}

function fileOfBase64Length(base64Length: number, name = 'shot.png'): File {
  const raw = Math.floor((base64Length * 3) / 4)
  return new File([new Uint8Array(raw)], name, { type: 'image/png' })
}

describe('imageResize', () => {
  let encodeSizes: number[] = []
  let drawnTo: Array<{ width: number; height: number }> = []
  let qualitiesUsed: number[] = []

  beforeEach(() => {
    encodeSizes = []
    drawnTo = []
    qualitiesUsed = []
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => {
        drawnTo.push({ width, height })
      },
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      _type?: string,
      quality?: number,
    ) {
      qualitiesUsed.push(quality ?? 0)
      // First attempt in the test always overshoots; later ones use the scripted sizes.
      const size = encodeSizes.length > 0 ? encodeSizes.shift()! : 4 * 1024 * 1024
      callback(blobOfBase64Length(size))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps small images untouched (no canvas work at all)', async () => {
    const file = fileOfBase64Length(64 * 1024)
    const prepared = await prepareImageForAttach(file, 3 * 1024 * 1024)
    expect(prepared.resized).toBe(false)
    expect(prepared.mimeType).toBe('image/png')
    expect(prepared.originalBytes).toBe(file.size)
    expect(prepared.bytes).toBeLessThanOrEqual(3 * 1024 * 1024)
    expect(prepared.preview.startsWith('data:image/png;base64,')).toBe(true)
    expect(drawnTo).toHaveLength(0)
  })

  it('downscales oversized images to the longest-edge limit and re-encodes as JPEG', async () => {
    const file = fileOfBase64Length(6 * 1024 * 1024)
    encodeSizes = [400 * 1024] // first re-encode already fits
    const prepared = await prepareImageForAttach(file, LIVE_SESSION_MAX_IMAGE_BYTES)
    expect(prepared.resized).toBe(true)
    expect(prepared.mimeType).toBe('image/jpeg')
    expect(prepared.preview.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(drawnTo[0]).toEqual({ width: 2048, height: 1536 })
    expect(prepared.width).toBe(2048)
    expect(prepared.bytes).toBeLessThanOrEqual(LIVE_SESSION_MAX_IMAGE_BYTES)
    expect(qualitiesUsed[0]).toBeCloseTo(0.9, 5)
  })

  it('walks down the quality ladder before shrinking further', async () => {
    const file = fileOfBase64Length(9 * 1024 * 1024)
    const budget = 512 * 1024
    encodeSizes = [4 * 1024 * 1024, 3 * 1024 * 1024, 2 * 1024 * 1024, 1 * 1024 * 1024, 700 * 1024, 400 * 1024]
    const prepared = await prepareImageForAttach(file, budget)
    expect(prepared.resized).toBe(true)
    expect(prepared.bytes).toBeLessThanOrEqual(budget)
    // Same geometry while the quality ladder runs, then one scaled round once it bottoms out.
    expect(drawnTo).toEqual([{ width: 2048, height: 1536 }, { width: 1536, height: 1152 }])
    expect(qualitiesUsed).toEqual([0.9, 0.8, 0.7, 0.6, 0.5, 0.9])
  })

  it('reports a clear error when the image cannot be squeezed under the budget', async () => {
    const file = fileOfBase64Length(12 * 1024 * 1024)
    encodeSizes = []
    await expect(prepareImageForAttach(file, 64 * 1024)).rejects.toThrow(/自动压缩后仍超出限制/)
  })

  it('falls back to the <img> decoder when createImageBitmap is unavailable', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const file = fileOfBase64Length(6 * 1024 * 1024)
    encodeSizes = [200 * 1024]
    const loadImage = vi.fn()
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 3000
      naturalHeight = 2000
      set src(_value: string) {
        loadImage()
        setTimeout(() => this.onload?.(), 0)
      }
    }
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image)
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() })

    const prepared = await prepareImageForAttach(file, 3 * 1024 * 1024)
    expect(loadImage).toHaveBeenCalled()
    expect(prepared.resized).toBe(true)
    expect(drawnTo[0]).toEqual({ width: 2048, height: 1365 })
  })

  it('budgets each image against the message total', () => {
    expect(base64LengthForBytes(3)).toBe(4)
    expect(base64LengthForBytes(4)).toBe(8)
    expect(imageBudgetForCount(1)).toBe(LIVE_SESSION_MAX_IMAGE_BYTES)
    expect(imageBudgetForCount(2)).toBe(LIVE_SESSION_MAX_IMAGE_BYTES)
    expect(imageBudgetForCount(4)).toBe(LIVE_SESSION_MAX_IMAGE_TOTAL_BYTES / 4)
    expect(imageBudgetForCount(0)).toBe(LIVE_SESSION_MAX_IMAGE_BYTES)
  })

  it('round-trips base64 payloads coming from the native picker', async () => {
    const data = btoa('hello image')
    const file = base64ToFile(data, 'image/png', 'picked.png')
    expect(file.type).toBe('image/png')
    expect(file.name).toBe('picked.png')
    expect(await file.text()).toBe('hello image')
  })
})