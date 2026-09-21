import { pdfjsLib, Util } from './pdfjs.js'
import { textWidthIn } from './nativeText.js'
import fontkit from '@pdf-lib/fontkit'

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

// parsing a font is not free, and a page uses each of its own many times
const metricsCache = new Map()

/**
 * Weight and slant as the font file states them.
 *
 * Reading them off the name misses as much as it catches - "Kp-Medium" is a
 * bold face, "Arial-BoldMT" is obvious, plenty of others say nothing at all.
 * The OS/2 table and the italic angle are what the font itself claims.
 */
function metricsOf(fontName, data) {
  if (metricsCache.has(fontName)) return metricsCache.get(fontName)
  let metrics = null
  try {
    if (data?.length) {
      const fk = fontkit.create(data)
      metrics = {
        weight: fk['OS/2']?.usWeightClass ?? null,
        slanted: (fk.post?.italicAngle ?? 0) !== 0,
      }
    }
  } catch {
    metrics = null
  }
  metricsCache.set(fontName, metrics)
  return metrics
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
  // "MinionPro-It" and "Arial-BoldMT" abbreviate the style after the dash
  const tail = lower.split('-').slice(1).join('-')
  const boldByName = /bold|black|heavy|semibold|demi/.test(lower) || tail.startsWith('bd')
  const italicByName = /italic|oblique/.test(lower) ||
    tail.endsWith('it') || tail.endsWith('ita') || tail.endsWith('obl')
  const metrics = metricsOf(fontName, obj?.data)
  // the name and the file each miss cases the other catches: "Kp-Medium"
  // says nothing while its weight class does, and a CFF face rebuilt by
  // pdf.js reports 400 however bold the original was
  const bold = boldByName || (metrics?.weight ?? 0) >= 600
  const italic = italicByName || !!metrics?.slanted

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
  // The face pdf.js built to draw this page with is already loaded in the
  // browser under its internal name, so ask for that first and the editor
  // shows the document's actual typeface - not an approximation of it.
  // Anything it has no glyph for falls through to the next name by itself,
  // which is exactly what happens on export too.
  const base = clean.split(/[-,]/)[0].replace(/(MT|PS|Std|Pro)$/i, '').trim()
  const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2')
  const named = base.length > 2 ? `"${base}", "${spaced}", ` : ''
  const embedded = fontName ? `"${fontName}", ` : ''
  return { rawName: clean, kind, family: `${embedded}${named}${CSS[kind]}`, bold, italic }
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

// Bengali vowel signs that are drawn to the LEFT of their consonant. A PDF
// stores glyphs in the order they were painted, so in a file whose ToUnicode
// table was written from that order, these come back before the consonant
// they belong to instead of after it.
const isPreBaseMatra = (c) => c === 0x09bf || c === 0x09c7 || c === 0x09c8 ||
  c === 0x09cb || c === 0x09cc
const isMatra = (c) => (c >= 0x09be && c <= 0x09cc) || c === 0x09d7
const isConsonant = (c) => (c >= 0x0995 && c <= 0x09b9) ||
  (c >= 0x09dc && c <= 0x09df) || c === 0x09ce
// marks that attach to the letter before them without replacing it:
// chandrabindu, anusvara, visarga, nukta and hasanta
const isAttached = (c) => (c >= 0x0981 && c <= 0x0983) || c === 0x09bc || c === 0x09cd
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

    if (isMatra(c)) {
      // any vowel sign must follow a letter; a leading or doubled one is
      // already proof that the glyphs came back in painting order
      if (previous < 0 || isBlank(previous) || isMatra(previous)) return true
      // and a left-side one must follow the consonant it wraps
      if (isPreBaseMatra(c) && !isConsonant(previous)) return true
    }
    if (!isAttached(c)) previous = c
  }
  return false
}

/**
 * Can these two runs be treated as one piece of writing?
 *
 * pdf.js reports text in the pieces the file happens to draw it in, which for
 * a justified or kerned line can be a fragment per word. Editing one of those
 * means replacing a word and watching it run into its neighbours, so pieces
 * that share a baseline, a font and a size are joined back into the sentence
 * they came from.
 */
function joins(a, b) {
  if (a.fontName !== b.fontName || a.pageIndex !== b.pageIndex) return false
  // a link or a highlighted word shares its neighbours' font and baseline and
  // is still a separate thing to edit
  if (!sameInk(a.color || '#000000', b.color || '#000000')) return false
  if (Math.abs(a.angle - b.angle) > 0.01) return false
  if (Math.abs(a.fontSize - b.fontSize) > a.fontSize * 0.06) return false
  if (Math.abs(a.y - b.y) > a.fontSize * 0.2) return false

  const gap = b.x - (a.x + a.width)
  // a small overlap is normal kerning; a gap wider than a couple of spaces
  // means a column, not a sentence
  return gap > -a.fontSize * 0.4 && gap < a.fontSize * 1.2
}

function mergeRuns(runs) {
  const merged = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (!last || !joins(last, run)) {
      merged.push({ ...run })
      continue
    }
    const gap = run.x - (last.x + last.width)
    const alreadySpaced = last.text.length !== last.text.trimEnd().length ||
      run.text.length !== run.text.trimStart().length
    const spaced = gap > last.fontSize * 0.12 && !alreadySpaced
    last.text += (spaced ? ' ' : '') + run.text
    last.width = run.x + run.width - last.x
    last.scrambled = looksScrambled(last.text)
  }
  return merged
}

const SENTENCE_END = new Set(['.', '?', '!', String.fromCharCode(0x0964)])

/**
 * Cut a line into the sentences it contains.
 *
 * A whole paragraph line is an awkward thing to edit - a word changed in the
 * first sentence pushes the rest of the line around. Splitting at full stops
 * gives a box per sentence, each one landing exactly where it does on the
 * page, since the widths come from the font the page was laid out with. A
 * line whose font cannot be measured that precisely is left alone rather
 * than split at a guessed position.
 */
function splitSentences(run, fontObj) {
  if (run.text.trim().length < 30) return [run]

  const parts = []
  let from = 0
  const chars = [...run.text]
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (!SENTENCE_END.has(chars[i])) continue
    if (chars[i + 1] !== ' ') continue
    const piece = chars.slice(from, i + 2).join('')
    if (piece.trim().length < 4) continue
    parts.push(piece)
    from = i + 2
  }
  if (!parts.length) return [run]
  const tail = chars.slice(from).join('')
  if (tail.trim().length < 4) return [run]
  parts.push(tail)

  const out = []
  let offset = 0
  for (let i = 0; i < parts.length; i += 1) {
    const width = textWidthIn(fontObj, parts[i], run.fontSize)
    if (width === null) return [run] // cannot place the pieces exactly
    out.push({
      ...run,
      id: `${run.id}s${i}`,
      text: parts[i],
      x: run.x + offset * Math.cos(run.angle),
      y: run.y + offset * Math.sin(run.angle),
      width,
      scrambled: looksScrambled(parts[i]),
    })
    offset += width
  }
  // the measured pieces must add up to the line we started from
  const total = out.reduce((n, piece) => n + piece.width, 0)
  if (Math.abs(total - Math.abs(run.width)) > Math.abs(run.width) * 0.06) return [run]
  return out
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

/**
 * Join the fragments a line arrived in and cut the result into sentences.
 *
 * This waits until the page has been drawn and each fragment's ink sampled,
 * because colour is what separates a link from the words around it - same
 * font, same baseline, same line, and not the same thing to edit.
 */
export function finishRuns(page, runs) {
  const fontOf = (name) => {
    try {
      return page.commonObjs.has(name) ? page.commonObjs.get(name) : null
    } catch {
      return null
    }
  }
  return mergeRuns(runs).flatMap((run) => splitSentences(run, fontOf(run.fontName)))
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
/**
 * Split a run wherever its ink changes colour.
 *
 * pdf.js reports a change of font or of position as a new piece of text, but
 * not a change of colour, so a sentence with a link in it arrives as one
 * item - and editing it would flatten the link into the body colour. The
 * page has been drawn by this point, so the colours can simply be read off
 * it, character by character, using the widths the font itself declares to
 * know where each one sits.
 */
function splitByInk(run, colourAt, widthOf) {
  const chars = [...run.text]
  if (chars.length < 2) return null

  const widths = chars.map((ch) => widthOf(ch))
  if (widths.some((width) => width === null)) return null

  const pieces = []
  let offset = 0
  for (let i = 0; i < chars.length; i += 1) {
    const ink = chars[i].trim() ? colourAt(offset, offset + widths[i]) : null
    const last = pieces[pieces.length - 1]
    if (last && (ink === null || last.color === null || sameInk(last.color, ink))) {
      last.text += chars[i]
      last.width += widths[i]
      if (last.color === null) last.color = ink
    } else {
      pieces.push({ text: chars[i], x: run.x + offset, width: widths[i], color: ink })
    }
    offset += widths[i]
  }

  const coloured = pieces.filter((piece) => piece.color)
  if (coloured.length < 2) return null

  return pieces.map((piece, index) => ({
    ...run,
    id: `${run.id}c${index}`,
    text: piece.text,
    x: piece.x,
    width: piece.width,
    color: piece.color || run.color,
  }))
}

/**
 * Is this the same ink, allowing for how the sample was taken?
 *
 * A run's colour is read off the drawn page, and a glyph is mostly
 * antialiased edge, so the same black word samples anywhere from #0a0a0a to
 * #323232 depending on how much of it the band covered. Comparing brightness
 * therefore says nothing; what separates a link from the body text is that
 * one has a colour at all. Greys are read as one ink unless they are plainly
 * different greys, and coloured inks are compared by hue.
 */
function sameInk(a, b) {
  if (!a || !b) return true
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0)
  const one = channels(a)
  const two = channels(b)
  const chroma = (c) => Math.max(...c) - Math.min(...c)
  const sum = (c) => c[0] + c[1] + c[2]

  const chromaOne = chroma(one)
  const chromaTwo = chroma(two)
  // every grey, from near-black to charcoal, counts as one ink: how dark a
  // sample came out says more about the glyph than about its colour
  if (chromaOne < 45 && chromaTwo < 45) return true
  if (Math.abs(chromaOne - chromaTwo) > 55) return false

  const direction = (c) => { const total = sum(c) || 1; return c.map((v) => v / total) }
  const dirOne = direction(one)
  const dirTwo = direction(two)
  return dirOne.every((v, i) => Math.abs(v - dirTwo[i]) < 0.08)
}

export function sampleColors(page, runs, canvas, viewport, dpr) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const fontOf = (name) => {
    try {
      return page?.commonObjs?.has(name) ? page.commonObjs.get(name) : null
    } catch {
      return null
    }
  }

  const out = []
  for (const run of runs) {
    const [x1, y1] = viewport.convertToViewportPoint(run.x, run.y)
    const [x2] = viewport.convertToViewportPoint(run.x + run.width, run.y)
    const h = run.fontSize * viewport.scale
    const left = Math.max(0, Math.floor(Math.min(x1, x2) * dpr))
    const top = Math.max(0, Math.floor((y1 - h) * dpr))
    const w = Math.max(1, Math.ceil(Math.abs(x2 - x1) * dpr))
    const hh = Math.max(1, Math.ceil(h * 1.25 * dpr))
    if (left + w > canvas.width || top + hh > canvas.height) { out.push(run); continue }

    let data
    try {
      data = ctx.getImageData(left, top, w, hh).data
    } catch {
      out.push(run)
      continue
    }

    // background = most frequent colour in the box
    const counts = new Map()
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 250) continue
      counts.set((data[i] << 16) | (data[i + 1] << 8) | data[i + 2],
        (counts.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) || 0) + 1)
    }
    let bgKey = 0xffffff
    let best = -1
    for (const [key, n] of counts) {
      if (n > best) { best = n; bgKey = key }
    }
    const br = (bgKey >> 16) & 255
    const bgG = (bgKey >> 8) & 255
    const bb = bgKey & 255

    // Ink over a band of columns: the average of the pixels furthest from the
    // background, not the single furthest one. A glyph is mostly antialiased
    // edge, and one stray pixel is not worth calling a change of colour over.
    const inkBetween = (fromCol, toCol) => {
      const first = Math.max(0, Math.floor(fromCol))
      const last = Math.min(w, Math.ceil(toCol))
      const found = []
      let furthest = 0
      for (let y = 0; y < hh; y += 1) {
        for (let x = first; x < last; x += 1) {
          const i = (y * w + x) * 4
          if (data[i + 3] < 250) continue
          const dist = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb)
          if (dist <= 60) continue
          if (dist > furthest) furthest = dist
          found.push(i, dist)
        }
      }
      if (found.length < 6) return null // too little ink to judge by

      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let k = 0; k < found.length; k += 2) {
        if (found[k + 1] < furthest * 0.7) continue
        const i = found[k]
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1
      }
      if (!n) return null
      return toHex(Math.round(r / n), Math.round(g / n), Math.round(b / n))
    }

    run.bg = toHex(br, bgG, bb)
    // averaging leaves plain black text reading as #101010; snap the
    // near-extremes back so a redrawn line matches its neighbours exactly
    const overall = inkBetween(0, w) || '#000000'
    const parts = [1, 3, 5].map((i) => parseInt(overall.slice(i, i + 2), 16) || 0)
    const spread = Math.max(...parts) - Math.min(...parts)
    const total = parts[0] + parts[1] + parts[2]
    run.color = spread < 45 && total < 90 ? '#000000'
      : spread < 45 && total > 690 ? '#ffffff' : overall

    // and now, where the ink changes colour part way through, into pieces
    const fontObj = fontOf(run.fontName)
    const toColumns = (Math.abs(x2 - x1) * dpr) / Math.max(0.001, Math.abs(run.width))
    const widthOf = (ch) => textWidthIn(fontObj, ch, run.fontSize)
    const split = fontObj
      ? splitByInk(run, (from, to) => inkBetween(from * toColumns, to * toColumns), widthOf)
      : null
    if (split) out.push(...split)
    else out.push(run)
  }
  return out
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
