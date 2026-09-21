import { PDFArray, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'

/** The page's content stream, decoded, with an array of streams joined. */
export function pageContentBytes(page) {
  const contents = page.node.Contents()
  if (!contents) return null
  const ctx = page.node.context

  const decodeOne = (obj) => {
    const stream = obj instanceof PDFRawStream ? obj : ctx.lookup(obj, PDFRawStream)
    return decodePDFRawStream(stream).decode()
  }

  try {
    if (!(contents instanceof PDFArray)) return decodeOne(contents)

    const parts = []
    for (let i = 0; i < contents.size(); i += 1) {
      parts.push(decodeOne(contents.get(i)), new Uint8Array([0x0a]))
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) { out.set(part, offset); offset += part.length }
    return out
  } catch {
    return null // a stream we cannot decode is one we must not rewrite
  }
}

/** Replace a page's content with the given bytes. */
export function setPageContent(pdfDoc, page, bytes) {
  const stream = pdfDoc.context.flateStream(bytes)
  page.node.set(PDFName.of('Contents'), pdfDoc.context.register(stream))
}

/** Corners of the unit square mapped through a matrix, as a bounding box. */
export function unitSquareBox(m) {
  const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ])
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
