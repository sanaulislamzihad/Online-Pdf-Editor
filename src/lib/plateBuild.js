import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib'
import { findShowOps, findXObjectOps, hideShowOps, removeRanges } from './contentStream.js'
import { imageStreamIn } from './images.js'

/**
 * The "plate" is the same document with every glyph switched to invisible
 * render mode: the exact page background, with the text peeled off.
 *
 * Erasing a line of text then becomes a matter of stamping the corresponding
 * slice of the plate back over it, which reproduces whatever was underneath -
 * photos, gradients, table fills, coloured bars - instead of guessing at a
 * flat cover colour. No operator has to be matched to a specific line, so it
 * works on any PDF regardless of how its text is chopped up into operators.
 */
export async function buildPlateBytes(originalBytes, { hideText = true, dropImages = false } = {}) {
  const doc = await PDFDocument.load(originalBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  })
  if (doc.isEncrypted) return null

  const ctx = doc.context
  const visited = new Set()

  const blankStream = (stream, resources) => {
    let bytes
    try {
      bytes = decodePDFRawStream(stream).decode()
    } catch {
      return
    }
    let changed = false

    if (dropImages) {
      const drawn = findXObjectOps(bytes).filter((op) => imageStreamIn(ctx, resources, op.name))
      if (drawn.length) {
        bytes = removeRanges(bytes, drawn)
        changed = true
      }
    }
    if (hideText) {
      const ops = findShowOps(bytes)
      if (ops.length) {
        bytes = hideShowOps(bytes, ops)
        changed = true
      }
    }
    if (!changed) return

    stream.contents = bytes
    stream.dict.delete(PDFName.of('Filter'))
    stream.dict.delete(PDFName.of('DecodeParms'))
  }

  // text can also live inside form XObjects, which are separate streams
  const walkResources = (resources, depth) => {
    if (!resources || depth > 6) return
    let xobjects
    try {
      xobjects = resources.lookup(PDFName.of('XObject'), PDFDict)
    } catch {
      return
    }
    if (!xobjects) return
    for (const [, value] of xobjects.entries()) {
      let stream
      try {
        stream = value instanceof PDFRawStream ? value : ctx.lookup(value, PDFRawStream)
      } catch {
        continue
      }
      if (!stream || visited.has(stream)) continue
      visited.add(stream)
      const subtype = stream.dict.lookup(PDFName.of('Subtype'))
      if (String(subtype) !== '/Form') continue
      const nested = stream.dict.lookup(PDFName.of('Resources'), PDFDict)
      blankStream(stream, nested)
      walkResources(nested, depth + 1)
    }
  }

  for (const page of doc.getPages()) {
    let resources = null
    try {
      resources = page.node.Resources()
    } catch {
      resources = null
    }
    const contents = page.node.Contents()
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        try {
          blankStream(ctx.lookup(contents.get(i), PDFRawStream), resources)
        } catch {
          /* leave undecodable parts alone */
        }
      }
    } else if (contents) {
      try {
        blankStream(contents instanceof PDFRawStream ? contents : ctx.lookup(contents, PDFRawStream), resources)
      } catch {
        /* ignore */
      }
    }
    try {
      walkResources(resources, 0)
    } catch {
      /* ignore */
    }
  }

  return doc.save({ useObjectStreams: false })
}

/** Rectangle (PDF user space, y-up, origin = lower left) covering a run's ink. */
export function coverRect(run) {
  const fs = run.fontSize
  const w = Math.abs(run.width) + fs * 0.14
  const h = fs * 1.26
  const x = run.x - fs * 0.07
  const y = run.y - fs * 0.29

  if (!run.angle) return { x, y, w, h }

  // rotated run: take the axis-aligned box around the rotated rectangle
  const cos = Math.cos(run.angle)
  const sin = Math.sin(run.angle)
  const corners = [
    [0, 0], [w, 0], [0, h], [w, h],
  ].map(([cx, cy]) => [
    x + cx * cos - cy * sin,
    y + cx * sin + cy * cos,
  ])
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  }
}
