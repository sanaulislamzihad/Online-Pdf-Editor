import { createWorker } from 'tesseract.js'
import { sampleColors } from './extract.js'

/**
 * Reading the text off a page that is only a picture of text.
 *
 * A scan has no text objects at all: the words are pixels. Recognition gives
 * us back where each line sits and what it says, which is enough to offer the
 * same editing as a real text layer - with the difference that erasing a line
 * means painting over the paper, since there is no glyph to hide.
 */

export const OCR_LANGUAGES = [
  { id: 'eng', label: 'English' },
  { id: 'ben', label: 'Bangla' },
  { id: 'ben+eng', label: 'Bangla + English' },
]

const OCR_SCALE = 3 // recognition wants noticeably more resolution than display

// tesseract.js defaults to treating a page as one uniform block, which
// quietly drops anything set much larger than the body - a CV loses its name
// off the top. Mode 4 reads a single column of mixed sizes instead.
const PAGE_SEGMENTATION = '4'

/** Does this page look like a scan rather than a text document? */
export function looksScanned(page, runs, images) {
  const view = page.view || [0, 0, 612, 792]
  const area = Math.abs((view[2] - view[0]) * (view[3] - view[1]))
  if (!area) return false
  const covered = images.some((image) => image.rect.w * image.rect.h > area * 0.4)
  const words = runs.reduce((n, run) => n + run.text.trim().split(/\s+/).length, 0)
  return covered && words < 25
}

async function renderForOcr(page) {
  const viewport = page.getViewport({ scale: OCR_SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise
  return { canvas, viewport }
}

function linesOf(data) {
  const lines = []
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) lines.push(line)
    }
  }
  return lines
}

/**
 * Recognise one page and return runs in the same shape the text layer uses,
 * so everything downstream - selection, editing, export - treats them alike.
 */
export async function recognisePage({ page, pageIndex, language, onProgress }) {
  const { canvas, viewport } = await renderForOcr(page)

  const worker = await createWorker(language, 1, {
    logger: (message) => {
      if (message.status === 'recognizing text') {
        onProgress?.(`Reading page ${pageIndex + 1}… ${Math.round(message.progress * 100)}%`)
      } else if (message.status) {
        onProgress?.(`${message.status}…`)
      }
    },
  })

  let data
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PAGE_SEGMENTATION })
    const result = await worker.recognize(canvas, {}, { blocks: true, text: false })
    data = result.data
  } finally {
    await worker.terminate()
  }

  const runs = []
  for (const line of linesOf(data)) {
    const text = (line.text || '').replace(/\s+$/, '')
    if (!text.trim() || line.confidence < 40) continue

    const { bbox } = line
    // the recognised baseline is a segment across the line; only fall back to
    // guessing from the descender height when it is missing
    const baselineY = Number.isFinite(line.baseline?.y0)
      ? (line.baseline.y0 + line.baseline.y1) / 2
      : bbox.y1 - Math.abs(line.rowAttributes?.descenders ?? 0)

    const [x0, y0] = viewport.convertToPdfPoint(bbox.x0, baselineY)
    const [x1] = viewport.convertToPdfPoint(bbox.x1, baselineY)
    const [, topY] = viewport.convertToPdfPoint(bbox.x0, bbox.y0)
    const [, bottomY] = viewport.convertToPdfPoint(bbox.x1, bbox.y1)

    // cap height is about 0.72 em for most faces, and the distance from the
    // baseline to the top of the line is the best measure of it we have
    const ascent = Math.abs(topY - y0)
    const fontSize = Math.max(4, ascent / 0.72)

    runs.push({
      id: `p${pageIndex}_o${runs.length}`,
      pageIndex,
      opIndex: -1,
      source: 'ocr',
      confidence: line.confidence,
      text,
      x: x0,
      y: y0,
      width: Math.abs(x1 - x0),
      height: fontSize,
      // exactly what the recogniser saw as ink, which is what has to be
      // painted over: derived font metrics are only an estimate
      inkBox: {
        x: Math.min(x0, x1),
        y: Math.min(topY, bottomY),
        w: Math.abs(x1 - x0),
        h: Math.abs(topY - bottomY),
      },
      fontSize,
      angle: 0,
      fontName: null,
      fontRawName: 'Recognised text',
      fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      fontKind: 'sans',
      bold: false,
      italic: false,
      scrambled: false,
      color: '#000000',
      bg: '#ffffff',
    })
  }

  sampleColors(runs, canvas, viewport, 1)
  return runs
}
