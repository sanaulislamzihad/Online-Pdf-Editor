import { PDFDocument, degrees, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { coverRect } from './plateBuild.js'
import { currentRect, imageChanged } from './images.js'
import { findXObjectOps, removeRanges } from './contentStream.js'
import { pageContentBytes, setPageContent } from './pdfBytes.js'
import { PDFName, PDFNumber, PDFOperator, PDFOperatorNames as ImgOps } from 'pdf-lib'
import { fontChain, planSegments } from './fonts.js'
import { pushNativeText } from './nativeText.js'
import { breakLines, measurerFor } from './paragraphs.js'

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
const spacesIn = (text) => [...text].filter((c) => c === ' ').length

function drawSegments(page, segments, opts, warn) {
  const cos = Math.cos(opts.angle || 0)
  const sin = Math.sin(opts.angle || 0)
  let cursor = 0

  for (const seg of segments) {
    const x = opts.x + cursor * cos
    const y = opts.y + cursor * sin

    if (seg.native) {
      if (pushNativeText(page, seg.native, { ...opts, text: seg.text, x, y })) {
        cursor += seg.native.widthOf(seg.text, opts.size) +
          (opts.wordSpacing ? spacesIn(seg.text) * (opts.wordSpacing - (seg.native.wordSpacingAt?.(opts.size) || 0)) : 0)
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
 * Does this text need setting across more than the one line it is on?
 *
 * A paragraph always does. Anything else - a heading, a cell of a table -
 * only once what has been typed no longer fits between where it starts and
 * where the page's text ends, at which point running off the edge is the
 * one thing it must not do.
 */
function shapeFor(run, text, pdfjsPage) {
  if (run.paragraph) return run.paragraph
  if (!run.wrap) return null

  const available = run.wrap.right - run.x
  if (available < run.fontSize * 4) return null

  const fontObj = fontObjectFor(run, pdfjsPage)
  const measure = measurerFor(run, fontObj)
  if (!measure || measure.natural(text) <= available + 1) return null

  return {
    left: run.x,
    indent: 0,
    width: available,
    drop: run.wrap.leading,
    baselines: [run.y],
    bottom: run.y - run.fontSize * 0.3,
    justified: false,
    probe: run,
  }
}

function fontObjectFor(run, pdfjsPage) {
  try {
    return pdfjsPage.commonObjs.has(run.fontName) ? pdfjsPage.commonObjs.get(run.fontName) : null
  } catch {
    return null
  }
}

/**
 * Set a paragraph again across its own lines.
 *
 * Its text is broken to the measure the page uses, each line placed on the
 * baseline it had, and every line but the last widened at the spaces to
 * reach the margin if the paragraph was justified. Text that no longer fits
 * in the lines it had carries on below them, which is the one thing a page
 * of fixed positions cannot absorb quietly.
 */
function drawParagraph(page, run, text, chain, pdfjsPage, style, warn) {
  const shape = run.paragraph
  const fontObj = fontObjectFor(run, pdfjsPage)
  const measure = measurerFor({ ...run, ...shape.probe }, fontObj)
  const scale = style.size / run.fontSize
  const widthFor = (index) => shape.width - (index === 0 ? shape.indent : 0)
  const natural = (value) => (measure?.natural(value) ?? 0) * scale

  const lines = measure
    ? breakLines(text, natural, widthFor)
    : [text]

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const y = i < shape.baselines.length
      ? shape.baselines[i]
      : shape.baselines[shape.baselines.length - 1] - (i - shape.baselines.length + 1) * shape.drop
    const x = shape.left + (i === 0 ? shape.indent : 0)

    const spaces = [...line].filter((c) => c === ' ').length
    const slack = widthFor(i) - natural(line)
    const wordSpacing = shape.justified && i < lines.length - 1 && spaces && slack > 0
      ? slack / spaces
      : 0

    const { segments } = planSegments({ original: '', text: line, chain })
    drawSegments(page, segments, {
      x,
      y,
      size: style.size,
      color: style.color,
      angle: 0,
      wordSpacing,
    }, warn)
  }

  if (lines.length > shape.baselines.length) {
    warn('The edited text needed more lines than it had, so it now runs into what follows.')
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
export async function exportPdf({
  originalBytes, pages, edits, images = [], imageEdits = {},
  customFonts = [], plate, onProgress,
}) {
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
        pdfDoc, pdfLibPage: page, pdfjsPage, run, bold, italic, text,
        cache: fontCache, customFonts,
      })
      const { segments, unsupported, lost, swapped } = planSegments({
        // a line read back off the page has nothing in common with the
        // characters the file claimed, so none of it is carried over
        original: edit.recognised ? '' : run.text,
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
      const shape = shapeFor(run, text, pdfjsPage)
      if (shape) {
        drawParagraph(page, { ...run, paragraph: shape }, text, chain, pdfjsPage, {
          size: edit.fontSize ?? run.fontSize,
          color: hexToRgb(edit.color ?? run.color),
        }, warn)
        continue
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
