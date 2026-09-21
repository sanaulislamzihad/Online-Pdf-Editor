import {
  PDFDocument,
  PDFArray,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  rgb,
  StandardFonts,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { findShowOps, hideShowOps } from './contentStream'

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return rgb(0, 0, 0)
  const v = parseInt(m[1], 16)
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)
}

function getContentBytes(page) {
  const contents = page.node.Contents()
  if (!contents) return null
  const ctx = page.node.context

  const decodeOne = (obj) => {
    const stream = obj instanceof PDFRawStream ? obj : ctx.lookup(obj, PDFRawStream)
    return decodePDFRawStream(stream).decode()
  }

  if (contents instanceof PDFArray) {
    const parts = []
    for (let i = 0; i < contents.size(); i += 1) {
      try {
        parts.push(decodeOne(contents.get(i)))
        parts.push(new Uint8Array([0x0a]))
      } catch {
        return null // an undecodable part means we cannot safely rewrite
      }
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) { out.set(p, o); o += p.length }
    return out
  }
  try {
    return decodeOne(contents)
  } catch {
    return null
  }
}

function setContentBytes(pdfDoc, page, bytes) {
  const stream = pdfDoc.context.flateStream(bytes)
  const ref = pdfDoc.context.register(stream)
  page.node.set(PDFName.of('Contents'), ref)
}

/** Is this stream operator plausibly the one that drew this run? */
function plausible(op, text) {
  if (!op) return false
  const n = text.length
  return Math.abs(op.stringBytes - n) <= 2 || Math.abs(op.stringBytes - n * 2) <= 4
}

/** Locate the operator for a run, allowing small drift in operator numbering. */
function matchOp(ops, run, used) {
  const exact = ops[run.opIndex]
  if (exact && !used.has(exact.index) && plausible(exact, run.text)) return exact
  for (let d = 1; d <= 4; d += 1) {
    for (const i of [run.opIndex - d, run.opIndex + d]) {
      const cand = ops[i]
      if (cand && !used.has(cand.index) && plausible(cand, run.text)) return cand
    }
  }
  return null
}

const STANDARD = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
}

function standardNameFor(run, bold, italic) {
  const fam = /Times|serif/i.test(run.fontFamily) ? 'serif'
    : /Courier|mono/i.test(run.fontFamily) ? 'mono' : 'sans'
  return STANDARD[fam][(bold ? 1 : 0) + (italic ? 2 : 0)]
}

/**
 * Pick the font to redraw a run with. The original embedded font is reused
 * whenever the user did not change weight or slant, so edited text keeps the
 * exact same glyph shapes as the rest of the document.
 */
async function resolveFont(pdfDoc, pdfjsPage, run, bold, italic, cache, warn) {
  const styleChanged = bold !== run.bold || italic !== run.italic
  if (!styleChanged) {
    const key = `embedded:${run.fontName}`
    if (cache.has(key)) return cache.get(key)
    try {
      const obj = pdfjsPage.commonObjs.has(run.fontName)
        ? pdfjsPage.commonObjs.get(run.fontName)
        : null
      const data = obj?.data
      if (data && data.length > 0) {
        const font = await pdfDoc.embedFont(data, { subset: false, customName: run.fontName })
        cache.set(key, font)
        return font
      }
    } catch (err) {
      warn(`Could not reuse the embedded font ${run.fontRawName}; using a close match.`)
    }
  }
  const name = standardNameFor(run, bold, italic)
  const key = `std:${name}`
  if (cache.has(key)) return cache.get(key)
  const font = await pdfDoc.embedFont(name)
  cache.set(key, font)
  return font
}

const SMART = [
  [/[‘’‚‹›]/g, "'"],
  [/[“”„]/g, '"'],
  [/[‐‑‒–—]/g, '-'],
  [/…/g, '...'],
  [/[   ]/g, ' '],
]

function drawRunText(page, text, opts, warn) {
  try {
    page.drawText(text, opts)
    return true
  } catch {
    let fixed = text
    for (const [re, to] of SMART) fixed = fixed.replace(re, to)
    try {
      page.drawText(fixed, opts)
      return true
    } catch {
      const ascii = fixed.replace(/[^\x20-\x7e¡-ÿ]/g, '')
      try {
        page.drawText(ascii, opts)
        warn('Some characters are not available in the fallback font and were dropped.')
        return true
      } catch (err) {
        warn(`Could not draw "${text.slice(0, 24)}…": ${err.message}`)
        return false
      }
    }
  }
}

/**
 * Produce the edited PDF.
 *
 * Untouched content is never re-encoded: the original file is kept and only
 * the operators for edited runs are switched to invisible render mode, then
 * the replacement text is painted in the same spot.
 */
export async function exportPdf({ originalBytes, pages, edits, onProgress }) {
  const pdfDoc = await PDFDocument.load(originalBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  })
  pdfDoc.registerFontkit(fontkit)

  const warnings = new Set()
  const warn = (m) => warnings.add(m)
  const fontCache = new Map()

  // group edits per page
  const byPage = new Map()
  for (const [id, edit] of Object.entries(edits)) {
    for (const p of pages) {
      const run = p.runs.find((r) => r.id === id)
      if (run) {
        if (!byPage.has(p.index)) byPage.set(p.index, [])
        byPage.get(p.index).push({ run, edit })
        break
      }
    }
  }

  for (const [pageIndex, items] of byPage) {
    onProgress?.(`Rewriting page ${pageIndex + 1}…`)
    const page = pdfDoc.getPage(pageIndex)
    const pdfjsPage = pages.find((p) => p.index === pageIndex).page

    // 1. hide the original glyphs for every edited run
    const bytes = getContentBytes(page)
    const covers = []
    if (bytes) {
      const ops = findShowOps(bytes)
      const used = new Set()
      const toHide = []
      for (const { run } of items) {
        const op = matchOp(ops, run, used)
        if (op) {
          used.add(op.index)
          toHide.push(op)
        } else {
          covers.push(run) // no confident match: paint over it instead
        }
      }
      if (toHide.length) setContentBytes(pdfDoc, page, hideShowOps(bytes, toHide))
    } else {
      for (const { run } of items) covers.push(run)
    }
    if (covers.length) {
      warn(`${covers.length} block(s) on page ${pageIndex + 1} were covered instead of removed.`)
    }

    // 2. paint a patch over anything that could not be removed cleanly
    for (const run of covers) {
      page.drawRectangle({
        x: run.x - run.fontSize * 0.05,
        y: run.y - run.fontSize * 0.26,
        width: Math.abs(run.width) + run.fontSize * 0.2,
        height: run.fontSize * 1.2,
        color: hexToRgb(run.bg),
      })
    }

    // 3. draw the replacement text
    for (const { run, edit } of items) {
      if (edit.deleted) continue
      const text = edit.text ?? run.text
      if (!text) continue
      const size = edit.fontSize ?? run.fontSize
      const bold = edit.bold ?? run.bold
      const italic = edit.italic ?? run.italic
      const font = await resolveFont(pdfDoc, pdfjsPage, run, bold, italic, fontCache, warn)
      drawRunText(
        page,
        text,
        {
          x: run.x + (edit.dx ?? 0),
          y: run.y + (edit.dy ?? 0),
          size,
          font,
          color: hexToRgb(edit.color ?? run.color),
          rotate: undefined,
        },
        warn,
      )
    }
  }

  onProgress?.('Saving…')
  const out = await pdfDoc.save({ useObjectStreams: false })
  if (warnings.size) console.warn('[pdf-editor]', [...warnings].join('\n'))
  return out
}
