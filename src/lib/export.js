import { PDFDocument, degrees, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { coverRect } from './plateBuild.js'
import { fontChain, assignFonts } from './fonts.js'

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return rgb(0, 0, 0)
  const v = parseInt(m[1], 16)
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)
}

const SMART = [
  [/[‘’‚‹›]/g, "'"],
  [/[“”„]/g, '"'],
  [/[‐‑‒–—]/g, '-'],
  [/…/g, '...'],
  [/[   ]/g, ' '],
]

/**
 * Draw one line, switching font per script run and advancing the pen by each
 * piece's own measured width so the pieces join up seamlessly.
 */
function drawSegments(page, segments, opts, warn) {
  const cos = Math.cos(opts.angle || 0)
  const sin = Math.sin(opts.angle || 0)
  let cursor = 0
  for (const seg of segments) {
    const o = {
      ...opts,
      font: seg.font,
      x: opts.x + cursor * cos,
      y: opts.y + cursor * sin,
    }
    delete o.angle
    let text = seg.text
    try {
      page.drawText(text, o)
    } catch {
      for (const [re, to] of SMART) text = text.replace(re, to)
      try {
        page.drawText(text, o)
      } catch {
        text = text.replace(/[^ -~¡-ÿ]/g, '')
        try {
          page.drawText(text, o)
          warn('Some characters could not be written with any available font and were dropped.')
        } catch (err) {
          warn(`Could not draw “${seg.text.slice(0, 24)}”: ${err.message}`)
          continue
        }
      }
    }
    try {
      cursor += seg.font.widthOfTextAtSize(text, opts.size)
    } catch {
      cursor += text.length * opts.size * 0.5
    }
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
      const { chain, notes } = await fontChain({
        pdfDoc, pdfjsPage, run, bold, italic, text, cache: fontCache,
      })
      const { segments, unsupported } = assignFonts(text, chain)
      if (unsupported && notes.length) {
        warn(`“${run.fontRawName}” has no glyphs for some of the new text; ${notes[0]} was used there.`)
      }
      drawSegments(page, segments, {
        x: run.x + (edit.dx ?? 0),
        y: run.y + (edit.dy ?? 0),
        size: edit.fontSize ?? run.fontSize,
        color: hexToRgb(edit.color ?? run.color),
        angle: run.angle,
        rotate: run.angle ? degrees((run.angle * 180) / Math.PI) : undefined,
      }, warn)
    }
  }

  onProgress?.('Saving…')
  const out = await pdfDoc.save({ useObjectStreams: false })
  return { bytes: out, warnings: [...warnings] }
}
