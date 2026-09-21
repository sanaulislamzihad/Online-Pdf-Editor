import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { findXObjectOps } from './contentStream.js'
import { pageContentBytes, unitSquareBox } from './pdfBytes.js'

/**
 * Every image a page paints, where it sits, and the operator that drew it.
 *
 * A Do operator changes nothing about the graphics state, so its bytes can be
 * lifted straight out of the stream - which is how an image gets moved,
 * resized or removed without re-encoding anything else on the page.
 */

const MIN_POINTS = 3 // ignore hairline spacers and 1px shims

/** The image XObject a name refers to in these resources, if it is one. */
export function imageStreamIn(ctx, resources, name) {
  let xobjects
  try {
    xobjects = resources?.lookup(PDFName.of('XObject'), PDFDict)
  } catch {
    return null
  }
  if (!xobjects) return null

  let stream
  try {
    const entry = xobjects.get(PDFName.of(name))
    stream = entry instanceof PDFRawStream ? entry : ctx.lookup(entry, PDFRawStream)
  } catch {
    return null
  }
  if (!stream?.dict) return null
  if (String(stream.dict.lookup(PDFName.of('Subtype'))) !== '/Image') return null
  return stream
}

function imageStream(page, name) {
  let resources
  try {
    resources = page.node.Resources()
  } catch {
    return null
  }
  return imageStreamIn(page.node.context, resources, name)
}

export async function extractImages(originalBytes) {
  let doc
  try {
    doc = await PDFDocument.load(originalBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    })
  } catch {
    return []
  }

  const perPage = []
  doc.getPages().forEach((page, pageIndex) => {
    const found = []
    const bytes = pageContentBytes(page)
    if (!bytes) { perPage.push(found); return }

    for (const op of findXObjectOps(bytes)) {
      const stream = imageStream(page, op.name)
      if (!stream) continue

      const box = unitSquareBox(op.ctm)
      if (box.w < MIN_POINTS || box.h < MIN_POINTS) continue

      found.push({
        id: `p${pageIndex}_x${op.index}`,
        pageIndex,
        name: op.name,
        opIndex: op.index,
        ctm: op.ctm,
        rect: box,
        pixelWidth: stream.dict.lookup(PDFName.of('Width'))?.asNumber?.() ?? 0,
        pixelHeight: stream.dict.lookup(PDFName.of('Height'))?.asNumber?.() ?? 0,
        // a matrix with shear or rotation cannot be described by a plain box,
        // so those are shown but not resized
        rotated: Math.abs(op.ctm[1]) > 0.01 || Math.abs(op.ctm[2]) > 0.01,
      })
    }
    perPage.push(found)
  })

  return perPage
}

/** Has this image been moved, resized, replaced or removed? */
export function imageChanged(edit) {
  if (!edit) return false
  return !!edit.deleted || !!edit.replacement || !!edit.dx || !!edit.dy || !!edit.dw || !!edit.dh
}

/** Where the image sits now, after any move or resize. */
export function currentRect(image, edit) {
  const rect = image.rect
  if (!edit) return rect
  return {
    x: rect.x + (edit.dx || 0),
    y: rect.y + (edit.dy || 0),
    w: Math.max(2, rect.w + (edit.dw || 0)),
    h: Math.max(2, rect.h + (edit.dh || 0)),
  }
}
