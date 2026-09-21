import { pdfjsLib, Util } from './pdfjs.js'

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
    // without this pdf.js drops each font's bytes once it has drawn with
    // them, and export could not reuse the document's own typefaces
    fontExtraProperties: true,
  })
  return task.promise
}

/**
 * Start rendering one page into a canvas at the given CSS scale. The caller
 * gets the live task back so it can cancel it - React runs effects twice in
 * development, and pdf.js refuses two concurrent renders on one canvas.
 */
export function startPageRender(page, canvas, scale) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const viewport = page.getViewport({ scale: scale * dpr })
  const cssViewport = page.getViewport({ scale })

  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(cssViewport.width)}px`
  canvas.style.height = `${Math.floor(cssViewport.height)}px`

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const task = page.render({ canvasContext: ctx, viewport, background: '#ffffff' })
  return { task, viewport: cssViewport, dpr }
}

function fontInfoFor(page, fontName) {
  let obj = null
  try {
    if (page.commonObjs.has(fontName)) obj = page.commonObjs.get(fontName)
  } catch {
    /* fall back to whatever the name alone tells us */
  }
  const raw = obj?.name || obj?.fallbackName || fontName || ''
  // strip subset prefixes like "ABCDEF+"
  const clean = raw.replace(/^[A-Z]{6}\+/, '')
  const lower = clean.toLowerCase()
  const bold = /bold|black|heavy|semibold|demi/.test(lower)
  const italic = /italic|oblique/.test(lower)

  // the name is a better signal than the descriptor's serif flag, which
  // word processors set carelessly
  let kind = 'sans'
  if (/courier|mono|consol/.test(lower)) {
    kind = 'mono'
  } else if (/times|serif|georgia|garamond|book|roman|minion|cambria|palatino/.test(lower)) {
    kind = 'serif'
  } else if (!/arial|helvetica|calibri|verdana|tahoma|segoe|roboto|lato|open ?sans|futura|gothic/.test(lower)) {
    if (obj?.isMonospace) kind = 'mono'
    else if (obj?.isSerifFont) kind = 'serif'
  }
  const CSS = {
    sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    serif: '"Times New Roman", Times, serif',
    mono: '"Courier New", Courier, monospace',
  }
  return { rawName: clean, kind, family: CSS[kind], bold, italic }
}

/**
 * Wait for the page's font objects to arrive.
 *
 * getOperatorList makes pdf.js request them, but each one only resolves once
 * its web font has finished binding, which can land after the operator list
 * does. Reading a run's font before then reports the internal id and no
 * weight, slant or file.
 */
async function awaitFonts(page, items) {
  const names = new Set()
  for (const item of items) if (item.fontName) names.add(item.fontName)

  const pending = [...names]
    .filter((name) => !page.commonObjs.has(name))
    .map((name) => new Promise((resolve) => {
      try {
        page.commonObjs.get(name, resolve)
      } catch {
        resolve()
      }
    }))
  if (!pending.length) return

  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
}

// Bengali dependent vowel signs, and the code points pdf.js falls back to
// when a glyph has no character behind it at all.
const isMatra = (c) => (c >= 0x09be && c <= 0x09cc) || c === 0x09d7
const isUnmapped = (c) => c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff)
const isBlank = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xa0

/**
 * Does this run read as something we could never write back?
 *
 * A PDF stores shaped, reordered glyphs and maps them to characters through
 * a ToUnicode table its producer wrote - one that routinely leaves conjuncts
 * out and hands back vowel signs in the order they were painted rather than
 * the order they are typed. Text like that is mojibake: it cannot be
 * re-encoded, so the editor has to know never to redraw it.
 */
export function looksScrambled(text) {
  let previous = -1
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (isUnmapped(c)) return true
    // a vowel sign has to follow a consonant: a leading or doubled one means
    // the glyphs came back in the order they were drawn
    if (isMatra(c) && (previous < 0 || isMatra(previous) || isBlank(previous))) {
      return true
    }
    previous = c
  }
  return false
}

/**
 * Extract every text run of a page, in PDF user space (y grows upward).
 * Each run keeps the exact baseline origin, size, rotation and run width
 * of the original so it can be reproduced or hidden byte-for-byte later.
 */
export async function extractRuns(page, pageIndex) {
  // pdf.js only resolves a page's font objects while it walks the drawing
  // operators, and the real font names, weights and file bytes live there -
  // without this every run would report its internal id and no typeface.
  try {
    await page.getOperatorList()
  } catch {
    /* text is still extractable without it, just with less font detail */
  }

  const content = await page.getTextContent({
    includeMarkedContent: false,
    disableCombineTextItems: true,
  })
  await awaitFonts(page, content.items)

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
      fontKind: info.kind,
      bold: info.bold,
      italic: info.italic,
      // text we cannot faithfully re-encode; editing it means retyping it
      scrambled: looksScrambled(item.str),
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
