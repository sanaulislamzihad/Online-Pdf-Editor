import { PDFDocument, degrees, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { coverRect } from './plateBuild.js'
import { currentRect, imageChanged } from './images.js'
import { findXObjectOps, removeRanges } from './contentStream.js'
import { pageContentBytes, setPageContent } from './pdfBytes.js'
import { PDFName, PDFNumber, PDFOperator, PDFOperatorNames as ImgOps } from 'pdf-lib'
import { fontChain, planSegments } from './fonts.js'
import { pushNativeText } from './nativeText.js'

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
    const x = opts.x + cursor * cos
    const y = opts.y + cursor * sin

    if (seg.native) {
      if (pushNativeText(page, seg.native, { ...opts, text: seg.text, x, y })) {
        cursor += seg.native.widthOf(seg.text, opts.size)
        continue
      }
    }

    const drawOpts = { ...opts, font: seg.font, x, y }
    delete drawOpts.angle
    let text = seg.text
    try {
      page.drawText(text, drawOpts)
    } catch {
      for (const [re, to] of SMART) text = text.replace(re, to)
      try {
        page.drawText(text, drawOpts)
      } catch {
        text = text.replace(/[^ -~¡-ÿ]/g, '')
        try {
          page.drawText(text, drawOpts)
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
 * Apply every image edit on one page.
 *
 * The Do operators that drew the edited images are cut out of the content
 * stream - they leave no trace in the graphics state, so removing one is
 * exact - and anything still wanted is painted again at its new place. A
 * moved or resized image is re-drawn through the very same XObject, so its
 * pixels are never decoded or re-encoded; only a replacement brings in new
 * data.
 */
async function applyImageEdits(pdfDoc, page, items, warn) {
  const bytes = pageContentBytes(page)
  if (!bytes) {
    warn(`Page's drawing instructions could not be read, so its images were left as they are.`)
    return
  }

  const ops = findXObjectOps(bytes)
  const cut = []
  for (const { image } of items) {
    const op = ops[image.opIndex]
    if (op && op.name === image.name) cut.push(op)
  }
  if (cut.length !== items.length) {
    warn('Some images could not be located in the page and were left alone.')
  }
  if (cut.length) setPageContent(pdfDoc, page, removeRanges(bytes, cut))

  for (const { image, edit } of items) {
    if (edit.deleted) continue
    const rect = currentRect(image, edit)

    if (edit.replacement) {
      try {
        const embedded = edit.replacement.type === 'image/png'
          ? await pdfDoc.embedPng(edit.replacement.bytes)
          : await pdfDoc.embedJpg(edit.replacement.bytes)
        page.drawImage(embedded, { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
      } catch (err) {
        warn(`Could not place the replacement image: ${err.message}`)
      }
      continue
    }

    // same XObject, new placement matrix
    const num = (v) => PDFNumber.of(Math.round(v * 1000) / 1000)
    page.pushOperators(
      PDFOperator.of(ImgOps.PushGraphicsState),
      PDFOperator.of(ImgOps.ConcatTransformationMatrix, [
        num(rect.w), num(0), num(0), num(rect.h), num(rect.x), num(rect.y),
      ]),
      PDFOperator.of(ImgOps.DrawObject, [PDFName.of(image.name)]),
      PDFOperator.of(ImgOps.PopGraphicsState),
    )
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
export async function exportPdf({ originalBytes, pages, edits, images = [], imageEdits = {}, plate, onProgress }) {
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

  // images are grouped the same way, and have to be dealt with first: they
  // rewrite the page's content stream, which would throw away anything drawn
  // onto the page beforehand
  const imagesByPage = new Map()
  for (const list of images) {
    for (const image of list) {
      const edit = imageEdits[image.id]
      if (!imageChanged(edit)) continue
      if (!imagesByPage.has(image.pageIndex)) imagesByPage.set(image.pageIndex, [])
      imagesByPage.get(image.pageIndex).push({ image, edit })
    }
  }
  for (const [pageIndex, items] of imagesByPage) {
    onProgress?.(`Applying image edits to page ${pageIndex + 1}…`)
    await applyImageEdits(pdfDoc, pdfDoc.getPage(pageIndex), items, warn)
  }

  for (const [pageIndex, items] of byPage) {
    onProgress?.(`Applying edits to page ${pageIndex + 1}…`)
    const page = pdfDoc.getPage(pageIndex)
    const pdfjsPage = pages.find((p) => p.index === pageIndex).page

    // 1. erase: stamp the original background back over each edited line
    for (const { run } of items) {
      const rect = coverRect(run)

      // recognised text is part of the picture of the page, so there is no
      // text-free version of it to fall back on - paint over the paper
      if (run.source === 'ocr') {
        page.drawRectangle({
          x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: hexToRgb(run.bg),
        })
        continue
      }

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
      const { chain } = await fontChain({
        pdfDoc, pdfLibPage: page, pdfjsPage, run, bold, italic, text, cache: fontCache,
      })
      const { segments, unsupported, lost, swapped } = planSegments({
        original: run.text,
        text,
        chain,
      })
      for (const seg of segments) {
        if (!seg.native) seg.font = await seg.cand.embed()
      }
      if (lost) {
        warn(`Part of “${run.text.slice(0, 18)}” is not described properly by the PDF and could not be kept.`)
      } else if (swapped.length) {
        warn(`“${run.fontRawName}” cannot write some of the new text, so ${swapped[0]} was used for it.`)
      } else if (unsupported) {
        warn(`Some characters in “${text.slice(0, 20)}” have no glyph in any available font.`)
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
