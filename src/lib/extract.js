import { pdfjsLib, Util } from './pdfjs'

/**
 * Load a PDF from an ArrayBuffer. The buffer is cloned because pdf.js
 * transfers (detaches) whatever it is given, and pdf-lib needs the bytes
 * again later for export.
 */
export async function loadPdf(arrayBuffer) {
  const task = pdfjsLib.getDocument({
    data: arrayBuffer.slice(0),
    // keep the original glyph mapping so extracted strings match the file
    disableNormalization: true,
    useSystemFonts: false,
  })
  return task.promise
}

/** Render one page into a canvas at the given CSS scale. */
export async function renderPageToCanvas(page, canvas, scale) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const viewport = page.getViewport({ scale: scale * dpr })
  const cssViewport = page.getViewport({ scale })

  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(cssViewport.width)}px`
  canvas.style.height = `${Math.floor(cssViewport.height)}px`

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const task = page.render({ canvasContext: ctx, viewport, background: '#ffffff' })
  await task.promise
  return { viewport: cssViewport, dpr }
}

function fontInfoFor(page, fontName) {
  let raw = fontName || ''
  try {
    if (page.commonObjs.has(fontName)) {
      const obj = page.commonObjs.get(fontName)
      raw = obj?.name || obj?.fallbackName || fontName
    }
  } catch {
    /* font object not resolved yet - fall back to the internal id */
  }
  // strip subset prefixes like "ABCDEF+"
  const clean = raw.replace(/^[A-Z]{6}\+/, '')
  const lower = clean.toLowerCase()
  const bold = /bold|black|heavy|semibold|demi/.test(lower)
  const italic = /italic|oblique/.test(lower)

  let family = '"Helvetica Neue", Helvetica, Arial, sans-serif'
  if (/times|serif|georgia|garamond|book|roman|minion|cambria/.test(lower)) {
    family = '"Times New Roman", Times, serif'
  } else if (/courier|mono|consol/.test(lower)) {
    family = '"Courier New", Courier, monospace'
  }
  return { rawName: clean, family, bold, italic }
}

/**
 * Extract every text run of a page, in PDF user space (y grows upward).
 * Each run keeps the exact baseline origin, size, rotation and run width
 * of the original so it can be reproduced or hidden byte-for-byte later.
 */
export async function extractRuns(page, pageIndex) {
  const content = await page.getTextContent({
    includeMarkedContent: false,
    disableCombineTextItems: true,
  })

  const runs = []
  let opIndex = -1
  for (const item of content.items) {
    if (item.type) continue // marked-content marker, not a glyph run
    opIndex += 1
    if (!item.str || !item.str.trim()) continue

    const t = item.transform
    const fontSize = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1])
    const angle = Math.atan2(t[1], t[0])
    const info = fontInfoFor(page, item.fontName)

    runs.push({
      id: `p${pageIndex}_r${opIndex}`,
      pageIndex,
      opIndex, // position among show-text operators, used to match the stream
      text: item.str,
      x: t[4],
      y: t[5], // baseline, PDF space
      width: item.width,
      height: item.height || fontSize,
      fontSize,
      angle,
      fontName: item.fontName,
      fontRawName: info.rawName,
      fontFamily: info.family,
      bold: info.bold,
      italic: info.italic,
      color: '#000000',
      bg: '#ffffff',
    })
  }
  return runs
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Sample the rendered page to learn each run's real ink colour and the
 * colour sitting behind it. Sampling the raster (instead of the content
 * stream) means gradients, images and theme blocks behind the text are
 * respected as-is.
 */
export function sampleColors(runs, canvas, viewport, dpr) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  for (const run of runs) {
    const [x1, y1] = viewport.convertToViewportPoint(run.x, run.y)
    const [x2] = viewport.convertToViewportPoint(run.x + run.width, run.y)
    const h = run.fontSize * viewport.scale
    const left = Math.max(0, Math.floor(Math.min(x1, x2) * dpr))
    const top = Math.max(0, Math.floor((y1 - h) * dpr))
    const w = Math.max(1, Math.ceil(Math.abs(x2 - x1) * dpr))
    const hh = Math.max(1, Math.ceil(h * 1.25 * dpr))
    if (left + w > canvas.width || top + hh > canvas.height) continue

    let data
    try {
      data = ctx.getImageData(left, top, w, hh).data
    } catch {
      continue
    }

    // background = most frequent colour in the box; ink = darkest/most distant
    const counts = new Map()
    let ink = null
    let inkScore = -1
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
      if (a < 250) continue
      const key = (r << 16) | (g << 8) | b
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    let bgKey = 0xffffff
    let best = -1
    for (const [key, n] of counts) {
      if (n > best) { best = n; bgKey = key }
    }
    const br = (bgKey >> 16) & 255, bg_ = (bgKey >> 8) & 255, bb = bgKey & 255
    for (const [key, n] of counts) {
      if (n < 2) continue // ignore stray antialiasing pixels
      const r = (key >> 16) & 255, g = (key >> 8) & 255, b = key & 255
      const dist = Math.abs(r - br) + Math.abs(g - bg_) + Math.abs(b - bb)
      const darkness = 765 - (r + g + b)
      const score = dist * 2 + darkness
      if (dist > 40 && score > inkScore) { inkScore = score; ink = [r, g, b] }
    }
    run.bg = toHex(br, bg_, bb)
    run.color = ink ? toHex(ink[0], ink[1], ink[2]) : '#000000'
  }
  return runs
}

/** Screen box (CSS px, top-left origin) for a run at the current viewport. */
export function runToScreenBox(run, viewport) {
  const m = Util.transform(viewport.transform, [
    run.fontSize, 0, 0, run.fontSize, run.x, run.y,
  ])
  const height = Math.hypot(m[2], m[3])
  const width = Math.abs(run.width) * viewport.scale
  return {
    left: m[4],
    baselineY: m[5],
    // an HTML line box of line-height == font-size puts its baseline at
    // ~0.8em from the top, so shift up by that much to sit on the real one
    top: m[5] - height * 0.8,
    coverTop: m[5] - height * 0.92,
    coverHeight: height * 1.2,
    width,
    height,
    fontPx: height,
    angleDeg: (-run.angle * 180) / Math.PI,
  }
}
