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

/**
 * What the picture was set in.
 *
 * Recognition says what the words are, never what they looked like, so a line
 * read off a picture used to come back as sans-serif regular whatever it was:
 * change one word and the whole line was re-set in the wrong face at a size
 * guessed from how tall its letters happened to be. A line of lower-case with
 * no ascenders came out a third too small.
 *
 * The pixels are still there to be asked. Each candidate is drawn at the size
 * that fills the line's own box and compared with the ink that is really
 * there, and the one that covers it best is the face to set the line in -
 * which settles its weight and its slant at the same time. Only the three
 * families every PDF reader has are offered, so what is drawn on screen and
 * what is written into the file are the same widths.
 */
const FACES = [
  { css: '"Times New Roman", Times, serif', kind: 'serif', label: 'Times New Roman' },
  { css: 'Arial, Helvetica, sans-serif', kind: 'sans', label: 'Arial' },
  { css: '"Courier New", Courier, monospace', kind: 'mono', label: 'Courier New' },
]
const STYLES = [
  { bold: false, italic: false },
  { bold: true, italic: false },
  { bold: false, italic: true },
  { bold: true, italic: true },
]

// the built-in faces write Latin and little else, so a line in another script
// is left to the font its own script picks rather than measured against them
const NON_LATIN = /[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}\p{Cc}]/u

/**
 * How much ink there is at each pixel of a rectangle of the picture, 0 to 1.
 *
 * Grey, not black and white: the edge of a letter is half covered, and how
 * much of it is covered is what tells a bold face from a regular one. How far
 * a pixel is from the paper, rather than how dark it is, so that syntax
 * colouring on a dark background reads as writing and not as half of it.
 */
function inkField(canvas, box) {
  let data
  try {
    data = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(box.x, box.y, box.w, box.h).data
  } catch {
    return null
  }
  const count = box.w * box.h

  // the paper is the colour most of the rectangle is
  const bins = new Uint32Array(4096)
  const binOf = (i) => ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
  for (let i = 0; i < data.length; i += 4) bins[binOf(i)] += 1
  let paper = 0
  for (let k = 1; k < bins.length; k += 1) if (bins[k] > bins[paper]) paper = k
  let pr = 0
  let pg = 0
  let pb = 0
  let seen = 0
  for (let i = 0; i < data.length; i += 4) {
    if (binOf(i) !== paper) continue
    pr += data[i]
    pg += data[i + 1]
    pb += data[i + 2]
    seen += 1
  }
  pr /= seen
  pg /= seen
  pb /= seen

  const away = new Float32Array(count)
  const spread = new Uint32Array(256)
  for (let i = 0, p = 0; p < count; i += 4, p += 1) {
    const d = Math.max(
      Math.abs(data[i] - pr), Math.abs(data[i + 1] - pg), Math.abs(data[i + 2] - pb),
    )
    away[p] = d
    spread[Math.min(255, Math.round(d))] += 1
  }

  // what solid ink looks like here: the very darkest pixels, since anything
  // lower is the edge of a letter rather than the middle of one, and taking
  // an edge for solid ink makes every blurred line look bold
  let above = 0
  let level = 255
  for (let v = 255; v >= 0; v -= 1) {
    above += spread[v]
    if (above > count * 0.005) { level = v; break }
  }
  if (level < 24) return null // no writing here to compare against

  const field = new Float32Array(count)
  for (let p = 0; p < count; p += 1) field[p] = Math.min(1, away[p] / level)
  return { field, paper: [pr, pg, pb] }
}

/** The same text drawn in one candidate face, filling the same box. */
function drawnField(ctx, text, box, baseline, face, style) {
  const weight = style.bold ? '700' : '400'
  const slant = style.italic ? 'italic' : 'normal'
  ctx.font = `${slant} ${weight} 100px ${face.css}`
  const unit = ctx.measureText(text).width
  if (!(unit > 0)) return null
  const size = (100 * box.w) / unit

  ctx.clearRect(0, 0, box.w, box.h)
  ctx.fillStyle = '#000000'
  ctx.font = `${slant} ${weight} ${size}px ${face.css}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, 0, baseline)

  let data
  try {
    data = ctx.getImageData(0, 0, box.w, box.h).data
  } catch {
    return null
  }
  const field = new Float32Array(box.w * box.h)
  for (let i = 3, p = 0; p < field.length; i += 4, p += 1) field[p] = data[i] / 255
  return { field, size }
}

/** Cosine similarity: ink put where there is none counts against as much. */
function cosine(want, drawn) {
  let dot = 0
  let a = 0
  let b = 0
  for (let p = 0; p < want.length; p += 1) {
    dot += want[p] * drawn[p]
    a += want[p] * want[p]
    b += drawn[p] * drawn[p]
  }
  return a && b ? dot / Math.sqrt(a * b) : 0
}

/** How much ink stands in each column of the box. */
function columns(field, width) {
  const profile = new Float32Array(width)
  for (let p = 0; p < field.length; p += 1) profile[p % width] += field[p]
  return profile
}

/**
 * How alike two fields are.
 *
 * Half of it is pixel for pixel, which knows a serif from a sans. The other
 * half is the columns each puts its ink in, which knows a monospace from a
 * proportional face and, unlike the pixels, does not mind the baseline being
 * read a little high or low - that alone used to lose whole lines of code to
 * whichever face happened to be nearest.
 */
function similarity(want, drawn, width) {
  return 0.5 * cosine(want, drawn) + 0.5 * cosine(columns(want, width), columns(drawn, width))
}

/**
 * How much of the box the strokes themselves cover.
 *
 * Only what is more than half covered counts. Blurring spreads a stroke out
 * without widening its middle, so the middle is what can be compared between
 * a picture that has been scaled about and a letter drawn here and now - and
 * how wide the middle of a stroke is, is what weight means.
 */
const strokeArea = (field) => {
  let total = 0
  for (let p = 0; p < field.length; p += 1) if (field[p] > 0.5) total += 1
  return total
}

/**
 * How well each family fits one line, and what size it would be set at.
 *
 * The family and the slant are judged by where the ink is - a serif, a
 * monospace and a slanted face put it in quite different places. The weight is
 * judged by how much of it there is: a picture has been screenshotted, scaled
 * and softened on its way here, which moves ink about without adding any, so
 * mass survives what shape does not. Comparing shapes alone reads every
 * blurred line as bold.
 */
function measureFaces(canvas, box, baseline, text) {
  if (box.w < 10 || box.h < 6 || NON_LATIN.test(text)) return null
  const picture = inkField(canvas, box)
  if (!picture) return null
  const want = picture.field

  const scratch = document.createElement('canvas')
  scratch.width = box.w
  scratch.height = box.h
  const ctx = scratch.getContext('2d', { willReadFrequently: true })

  const kinds = []
  for (const face of FACES) {
    let pick = null
    for (const italic of [false, true]) {
      const drawn = drawnField(ctx, text, box, baseline, face, { bold: false, italic })
      if (!drawn) continue
      const score = similarity(want, drawn.field, box.w)
      // Upright is the ordinary case and a false slant is glaring, so a
      // slanted face has to be well clear - small type softened by whatever
      // the picture has been through swings either way by less than this.
      const earned = italic ? score - 0.1 : score
      if (!pick || earned > pick.earned) {
        pick = { earned, score, italic, size: drawn.size, mass: strokeArea(drawn.field) }
      }
    }
    if (!pick) continue
    const heavy = drawnField(ctx, text, box, baseline, face, { bold: true, italic: pick.italic })
    kinds.push({
      face,
      italic: pick.italic,
      score: pick.score,
      size: pick.size,
      mass: pick.mass,
      boldSize: heavy ? heavy.size : null,
      boldMass: heavy ? strokeArea(heavy.field) : null,
    })
  }
  if (!kinds.length) return null

  kinds.sort((a, b) => b.score - a.score)
  return {
    kinds,
    paper: picture.paper,
    area: strokeArea(want),
    margin: kinds.length > 1 ? kinds[0].score - kinds[1].score : 1,
  }
}

const CLEAR = 0.12 // how far ahead a line has to be to answer for itself

/**
 * Settle on a face for every line of one picture.
 *
 * Small type, softened by whatever the picture has been through, often fits
 * two families about as well as a third - and deciding line by line then sets
 * one line of a code block in a monospace and the next in a sans, which reads
 * far worse than being wrong the same way throughout.
 *
 * What a picture is made of is regions, and what marks a region out is what it
 * is written on: a code block on its dark panel, a caption on the paper. So
 * the lines are grouped by the colour behind them and each group is settled by
 * the lines in it that were surest, unless a line is surer still on its own.
 */
function settleFaces(measured) {
  const groups = []
  const near = (a, b) => Math.max(
    Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]),
  ) < 40

  for (const m of measured) {
    if (!m.faces) continue
    const group = groups.find((g) => near(g.paper, m.faces.paper))
    if (group) group.members.push(m)
    else groups.push({ paper: m.faces.paper, members: [m] })
  }

  for (const group of groups) {
    const votes = new Map()
    for (const m of group.members) {
      const kind = m.faces.kinds[0].face.kind
      votes.set(kind, (votes.get(kind) || 0) + m.faces.margin)
    }
    group.kind = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  return measured.map((m) => {
    if (!m.faces) return null
    const group = groups.find((g) => g.members.includes(m))
    const kind = m.faces.margin >= CLEAR ? m.faces.kinds[0].face.kind : group.kind

    const chosen = m.faces.kinds.find((k) => k.face.kind === kind) || m.faces.kinds[0]
    const bolder = chosen.boldMass !== null &&
      Math.abs(chosen.boldMass - m.faces.area) < Math.abs(chosen.mass - m.faces.area) * 0.92
    return {
      face: chosen.face,
      italic: chosen.italic,
      bold: bolder,
      size: bolder ? chosen.boldSize : chosen.size,
    }
  })
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
  const measured = []
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

    const top = Math.round(pTop)
    measured.push({
      line,
      text,
      x0,
      y0,
      x1,
      topY,
      bottomY,
      y: y0,
      faces: measureFaces(
        canvas,
        { x: Math.round(px0), y: top, w: Math.round(px1 - px0), h: Math.round(pBottom) - top },
        pBase - top,
        text,
      ),
    })
  }

  const settled = settleFaces(measured)

  const runs = measured.map((m, index) => {
    const face = settled[index]
    // cap height is about 0.72 em for most faces, and the distance from the
    // baseline to the top of the line is the best measure of it we have -
    // until the writing itself is compared with the faces it might be in,
    // which says what size it is however few of its letters are tall
    const fontSize = face
      ? face.size / viewport.scale
      : Math.max(4, Math.abs(m.topY - m.y0) / 0.72)

    return {
      id: `${idPrefix}${index}`,
      pageIndex,
      opIndex: -1,
      source: 'ocr',
      confidence: m.line.confidence,
      text: m.text,
      x: m.x0,
      y: m.y0,
      width: Math.abs(m.x1 - m.x0),
      height: fontSize,
      // exactly what the recogniser saw as ink, which is what has to be
      // painted over: derived font metrics are only an estimate
      inkBox: {
        x: Math.min(m.x0, m.x1),
        y: Math.min(m.topY, m.bottomY),
        w: Math.abs(m.x1 - m.x0),
        h: Math.abs(m.topY - m.bottomY),
      },
      fontSize,
      angle: 0,
      fontName: null,
      fontRawName: face ? `Recognised - ${face.face.label}` : 'Recognised text',
      fontFamily: face ? face.face.css : '"Helvetica Neue", Helvetica, Arial, sans-serif',
      fontKind: face ? face.face.kind : 'sans',
      bold: !!face?.bold,
      italic: !!face?.italic,
      scrambled: false,
      color: '#000000',
      bg: '#ffffff',
    }
  })

  sampleColors(null, runs, canvas, viewport, 1)
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
