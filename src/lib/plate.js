import { loadPdf } from './extract.js'
import { buildPlateBytes } from './plateBuild.js'

const PLATE_SCALE = 3
const MAX_CACHED_PAGES = 4

/** Lazily renders and caches plate pages, and hands out slices of them. */
export class PlateStore {
  constructor() {
    this.doc = null
    this.failed = false
    this.cache = new Map()
    this.pending = new Map()
  }

  async load(originalBytes) {
    try {
      const bytes = await buildPlateBytes(originalBytes)
      if (!bytes) { this.failed = true; return false }
      this.doc = await loadPdf(bytes)
      return true
    } catch (err) {
      console.warn('[pdf-editor] background plate unavailable:', err)
      this.failed = true
      return false
    }
  }

  async getPage(pageIndex) {
    if (!this.doc) return null
    if (this.cache.has(pageIndex)) return this.cache.get(pageIndex)
    if (this.pending.has(pageIndex)) return this.pending.get(pageIndex)

    const job = (async () => {
      const page = await this.doc.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: PLATE_SCALE })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise
      const entry = { canvas, viewport }
      this.cache.set(pageIndex, entry)
      if (this.cache.size > MAX_CACHED_PAGES) {
        const oldest = this.cache.keys().next().value
        this.cache.delete(oldest)
      }
      this.pending.delete(pageIndex)
      return entry
    })()

    this.pending.set(pageIndex, job)
    return job
  }

  /** Source rectangle, in plate pixels, for a PDF-space rectangle. */
  sourceBox(entry, rect) {
    const [x1, y1] = entry.viewport.convertToViewportPoint(rect.x, rect.y + rect.h)
    const [x2, y2] = entry.viewport.convertToViewportPoint(rect.x + rect.w, rect.y)
    return {
      sx: Math.max(0, Math.min(x1, x2)),
      sy: Math.max(0, Math.min(y1, y2)),
      sw: Math.abs(x2 - x1),
      sh: Math.abs(y2 - y1),
    }
  }

  /** Paint the background slice for `rect` into a destination canvas. */
  paintInto(entry, rect, destCanvas, cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const { sx, sy, sw, sh } = this.sourceBox(entry, rect)
    if (sw < 0.5 || sh < 0.5) return false
    destCanvas.width = Math.max(1, Math.round(cssW * dpr))
    destCanvas.height = Math.max(1, Math.round(cssH * dpr))
    destCanvas.style.width = `${cssW}px`
    destCanvas.style.height = `${cssH}px`
    const ctx = destCanvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(entry.canvas, sx, sy, sw, sh, 0, 0, destCanvas.width, destCanvas.height)
    return true
  }

  /** PNG bytes of the background slice for `rect`, for embedding on export. */
  async patchPng(pageIndex, rect) {
    const entry = await this.getPage(pageIndex)
    if (!entry) return null
    const { sx, sy, sw, sh } = this.sourceBox(entry, rect)
    if (sw < 0.5 || sh < 0.5) return null
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(sw))
    c.height = Math.max(1, Math.round(sh))
    const ctx = c.getContext('2d')
    ctx.drawImage(entry.canvas, sx, sy, sw, sh, 0, 0, c.width, c.height)
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
    if (!blob) return null
    return new Uint8Array(await blob.arrayBuffer())
  }
}
