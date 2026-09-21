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

// a single line of body text is only ~30px tall even at the page scale used
// for recognition, and Tesseract reads small type badly - crops are enlarged
// until they are worth reading
const MIN_LINE_PIXELS = 70
const CROP_PAD = 6

const PSM_COLUMN = '4' // a column of text in mixed sizes
const PSM_LINE = '7' // one line and nothing else

/**
 * Start one recogniser and hand a read() to the caller.
 *
 * Loading a language model is the expensive part, so a job that looks at a
 * picture more than once - which is how colour-coded text gets read at all -
 * has to do it over a single worker.
 */
async function withRecogniser(language, onProgress, label, job) {
  const worker = await createWorker(language, 1, {
    logger: (message) => {
      if (message.status === 'recognizing text') {
        onProgress?.(`Reading ${label}… ${Math.round(message.progress * 100)}%`)
      } else if (message.status) {
        onProgress?.(`${message.status}…`)
      }
    },
  })
  try {
    return await job(async (canvas, psm) => {
      await worker.setParameters({ tessedit_pageseg_mode: psm })
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false })
      return linesOf(data)
    })
  } finally {
    await worker.terminate()
  }
}

/** A tight crop around one recognised line, for a closer second look. */
function cropLine(canvas, bbox) {
  const pad = Math.max(2, Math.round((bbox.y1 - bbox.y0) * 0.25))
  const left = Math.max(0, bbox.x0 - pad)
  const top = Math.max(0, bbox.y0 - pad)
  const width = Math.min(canvas.width - left, bbox.x1 - bbox.x0 + pad * 2)
  const height = Math.min(canvas.height - top, bbox.y1 - bbox.y0 + pad * 2)
  if (width < 4 || height < 4) return null
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  out.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, width, height)
  return out
}

/**
 * Cut one rectangle of the page out as its own canvas, enlarged if it is too
 * small to read. Returns the crop plus what is needed to map a point in it
 * back to the page.
 */
function cropRegion(canvas, viewport, rect) {
  const [ax, ay] = viewport.convertToViewportPoint(rect.x, rect.y + rect.h)
  const [bx, by] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y)
  const left = Math.max(0, Math.floor(Math.min(ax, bx)) - CROP_PAD)
  const top = Math.max(0, Math.floor(Math.min(ay, by)) - CROP_PAD)
  const width = Math.min(canvas.width - left, Math.ceil(Math.abs(bx - ax)) + CROP_PAD * 2)
  const height = Math.min(canvas.height - top, Math.ceil(Math.abs(by - ay)) + CROP_PAD * 2)
  if (width < 2 || height < 2) return null

  const zoom = Math.max(1, Math.ceil(MIN_LINE_PIXELS / height))
  const crop = document.createElement('canvas')
  crop.width = width * zoom
  crop.height = height * zoom
  const ctx = crop.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, left, top, width, height, 0, 0, crop.width, crop.height)
  return { crop, left, top, zoom }
}

/**
 * Flatten a crop to black text on white paper, whichever way round it was.
 *
 * Recognition is trained on dark ink on light paper, and a screenshot is
 * frequently the other way round - or, in a page that embeds one, both at
 * once. Comparing every pixel against the average of its neighbourhood sees
 * text either way: characters differ sharply from what surrounds them, flat
 * background does not. It also throws away syntax colouring, which layout
 * analysis otherwise mistakes for pictures.
 */
function binarise(source) {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0)
  let pixels
  try {
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    return canvas
  }

  // a heavily downscaled copy, stretched back up, is a cheap local average
  // the neighbourhood has to be comfortably larger than a line of text, or
  // headings blur into their own background and come out as solid blocks
  const window = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) / 10))
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(canvas.width / window))
  small.height = Math.max(1, Math.round(canvas.height / window))
  const smallCtx = small.getContext('2d', { willReadFrequently: true })
  smallCtx.imageSmoothingQuality = 'high'
  smallCtx.drawImage(canvas, 0, 0, small.width, small.height)

  const blurred = document.createElement('canvas')
  blurred.width = canvas.width
  blurred.height = canvas.height
  const blurredCtx = blurred.getContext('2d', { willReadFrequently: true })
  blurredCtx.imageSmoothingQuality = 'high'
  blurredCtx.drawImage(small, 0, 0, canvas.width, canvas.height)

  let local
  try {
    local = blurredCtx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    return canvas
  }

  const luma = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
  const { data } = pixels
  for (let i = 0; i < data.length; i += 4) {
    const ink = Math.abs(luma(data, i) - luma(local.data, i)) > 16 ? 0 : 255
    data[i] = ink
    data[i + 1] = ink
    data[i + 2] = ink
    data[i + 3] = 255
  }
  ctx.putImageData(pixels, 0, 0)
  return canvas
}

/** Do two recognised lines cover the same part of the picture? */
function overlaps(a, b) {
  const w = Math.min(a.bbox.x1, b.bbox.x1) - Math.max(a.bbox.x0, b.bbox.x0)
  const h = Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0)
  if (w <= 0 || h <= 0) return false
  const area = Math.max(1, (a.bbox.x1 - a.bbox.x0) * (a.bbox.y1 - a.bbox.y0))
  return (w * h) / area > 0.4
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
 * Read one line of the page back off its own pixels.
 *
 * Some PDFs describe their text so badly that what comes out is mojibake -
 * Bengali files whose producer wrote the character map in painting order lose
 * conjuncts altogether. The page still *draws* the line correctly, though, so
 * recognising that picture gives back text that can be read and edited, where
 * the file's own table cannot.
 */
export async function recogniseLine({ page, rect, language, onProgress }) {
  const { canvas, viewport } = await renderForOcr(page)
  const region = cropRegion(canvas, viewport, rect)
  if (!region) return ''

  const lines = await withRecogniser(language, onProgress, 'this line', async (read) => {
    const first = await read(region.crop, PSM_LINE)
    if (first.length) return first
    return read(binarise(region.crop), PSM_LINE)
  })
  return lines
    .map((line) => (line.text || '').trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Recognise the text inside one image and return it as editable runs, placed
 * where it sits on the page.
 */
export async function recogniseImage({ page, pageIndex, rect, language, onProgress, idPrefix }) {
  const { canvas, viewport } = await renderForOcr(page)
  const region = cropRegion(canvas, viewport, rect)
  if (!region) return []

  const lines = await withRecogniser(language, onProgress, 'this image', async (read) => {
    const found = await read(region.crop, PSM_COLUMN)

    // syntax colouring makes layout analysis skip whole lines, and flattening
    // the picture to plain black on white finds them. Flattening also smears
    // edges, so each line it alone saw is then read again from the untouched
    // crop, one line at a time, where nothing around it can interfere.
    const flattened = binarise(region.crop)
    for (const line of await read(flattened, PSM_COLUMN)) {
      if (found.some((seen) => overlaps(line, seen))) continue
      const tight = cropLine(region.crop, line.bbox)
      const closer = tight ? await read(tight, PSM_LINE) : []
      if (closer.length && closer[0].confidence > line.confidence) {
        line.text = closer[0].text
        line.confidence = closer[0].confidence
      }
      found.push(line)
    }
    return found
  })

  return runsFromLines({
    lines,
    viewport,
    pageIndex,
    toPage: (x, y) => [region.left + x / region.zoom, region.top + y / region.zoom],
    idPrefix,
    canvas,
  })
}

/**
 * Turn recognised lines into runs shaped exactly like the text layer's, so
 * everything downstream - selection, editing, export - treats them alike.
 * `toPage` maps a point in whatever canvas was read back onto the page's own
 * recognition canvas, which is all that differs between reading a whole page
 * and reading one cropped region of it.
 */
function runsFromLines({ lines, viewport, pageIndex, toPage, idPrefix, canvas }) {
  const runs = []
  for (const line of lines) {
    const text = (line.text || '').trimEnd()
    if (!text.trim() || line.confidence < 40) continue

    const { bbox } = line
    // the recognised baseline is a segment across the line; only fall back to
    // guessing from the descender height when it is missing
    const baselineY = Number.isFinite(line.baseline?.y0)
      ? (line.baseline.y0 + line.baseline.y1) / 2
      : bbox.y1 - Math.abs(line.rowAttributes?.descenders ?? 0)

    const [px0, pBase] = toPage(bbox.x0, baselineY)
    const [px1] = toPage(bbox.x1, baselineY)
    const [, pTop] = toPage(bbox.x0, bbox.y0)
    const [, pBottom] = toPage(bbox.x1, bbox.y1)

    const [x0, y0] = viewport.convertToPdfPoint(px0, pBase)
    const [x1] = viewport.convertToPdfPoint(px1, pBase)
    const [, topY] = viewport.convertToPdfPoint(px0, pTop)
    const [, bottomY] = viewport.convertToPdfPoint(px1, pBottom)

    // cap height is about 0.72 em for most faces, and the distance from the
    // baseline to the top of the line is the best measure of it we have
    const ascent = Math.abs(topY - y0)
    const fontSize = Math.max(4, ascent / 0.72)

    runs.push({
      id: `${idPrefix}${runs.length}`,
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

/**
 * Recognise a whole page and return its lines as editable runs.
 */
export async function recognisePage({ page, pageIndex, language, onProgress }) {
  const { canvas, viewport } = await renderForOcr(page)
  const lines = await withRecogniser(
    language, onProgress, `page ${pageIndex + 1}`, (read) => read(canvas, PSM_COLUMN),
  )
  return runsFromLines({
    lines,
    viewport,
    pageIndex,
    toPage: (x, y) => [x, y],
    idPrefix: `p${pageIndex}_o`,
    canvas,
  })
}
