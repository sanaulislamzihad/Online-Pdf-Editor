import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { coverRect } from './plateBuild.js'

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return rgb(0, 0, 0)
  const v = parseInt(m[1], 16)
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)
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
 * Pick the font to redraw a run with. The document's own embedded font is
 * reused whenever the user did not change weight or slant, so edited text
 * keeps exactly the glyph shapes the rest of the page uses.
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
        const font = await pdfDoc.embedFont(data, { subset: false })
        cache.set(key, font)
        return font
      }
    } catch {
      warn(`Could not reuse the embedded font “${run.fontRawName}”; a close match was used instead.`)
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
    return
  } catch {
    /* the font cannot encode something - try progressively simpler text */
  }
  let fixed = text
  for (const [re, to] of SMART) fixed = fixed.replace(re, to)
  try {
    page.drawText(fixed, opts)
    return
  } catch {
    /* fall through */
  }
  const ascii = fixed.replace(/[^\x20-\x7e¡-ÿ]/g, '')
  try {
    page.drawText(ascii, opts)
    warn('Some characters are missing from the fallback font and were dropped.')
  } catch (err) {
    warn(`Could not draw “${text.slice(0, 24)}”: ${err.message}`)
  }
}

/**
 * Produce the edited PDF.
 *
 * The original file is loaded and kept as-is: nothing is re-rendered or
 * re-encoded. For each edited line a slice of the text-free background plate
 * is stamped over the old glyphs, then the replacement text is drawn on top
 * at the same baseline, in the same font, size and colour unless the user
 * changed them.
 */
export async function exportPdf({ originalBytes, pages, edits, plate, onProgress }) {
  const pdfDoc = await PDFDocument.load(originalBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  })
  pdfDoc.registerFontkit(fontkit)

  const warnings = new Set()
  const warn = (m) => warnings.add(m)
  const fontCache = new Map()

  const byPage = new Map()
  for (const p of pages) {
    for (const run of p.runs) {
      const edit = edits[run.id]
      if (!edit) continue
      if (!byPage.has(p.index)) byPage.set(p.index, [])
      byPage.get(p.index).push({ run, edit })
    }
  }

  for (const [pageIndex, items] of byPage) {
    onProgress?.(`Applying edits to page ${pageIndex + 1}…`)
    const page = pdfDoc.getPage(pageIndex)
    const pdfjsPage = pages.find((p) => p.index === pageIndex).page

    // 1. erase: stamp the original background back over each edited line
    for (const { run } of items) {
      const rect = coverRect(run)
      let png = null
      try {
        png = plate ? await plate.patchPng(pageIndex, rect) : null
      } catch {
        png = null
      }
      if (png) {
        const image = await pdfDoc.embedPng(png)
        page.drawImage(image, { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
      } else {
        page.drawRectangle({
          x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: hexToRgb(run.bg),
        })
        warn(`Page ${pageIndex + 1}: used a flat colour patch because the page background could not be rebuilt.`)
      }
    }

    // 2. draw the replacement text
    for (const { run, edit } of items) {
      if (edit.deleted) continue
      const text = edit.text ?? run.text
      if (!text) continue
      const bold = edit.bold ?? run.bold
      const italic = edit.italic ?? run.italic
      const font = await resolveFont(pdfDoc, pdfjsPage, run, bold, italic, fontCache, warn)
      drawRunText(page, text, {
        x: run.x + (edit.dx ?? 0),
        y: run.y + (edit.dy ?? 0),
        size: edit.fontSize ?? run.fontSize,
        font,
        color: hexToRgb(edit.color ?? run.color),
        rotate: run.angle ? degrees((run.angle * 180) / Math.PI) : undefined,
      }, warn)
    }
  }

  onProgress?.('Saving…')
  const out = await pdfDoc.save({ useObjectStreams: false })
  return { bytes: out, warnings: [...warnings] }
}
