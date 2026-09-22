import { PDFName } from 'pdf-lib'
import { pageContentBytes, setPageContent } from './pdfBytes.js'

/**
 * Making room for text that has outgrown its lines.
 *
 * A PDF has no flow. Every line sits at a fixed place, so text that needs one
 * more line than it was given has nowhere to put it and lands on top of
 * whatever comes next. The page can be opened up instead: everything below
 * the block that grew moves down by the height of the lines it gained.
 *
 * Nothing is redrawn to do it. The page's own content stream is put into a
 * form XObject and drawn twice - once clipped to what is above the break and
 * left where it is, once clipped to what is below and translated down. Text,
 * images and vector art alike come through exactly as they were, only lower,
 * because they are the very same objects.
 */

/** Where the page has to open up for one grown block, and by how much. */
export function growthFor({ shape, lineCount, size, runs }) {
  const extra = lineCount - shape.baselines.length
  if (extra <= 0 || !(shape.drop > 0)) return null

  const last = shape.baselines[shape.baselines.length - 1]

  // The cut falls just under the block's own last line - under the descenders
  // of everything sitting on it, a neighbouring cell set larger included, and
  // no lower. Anything drawn below that belongs to what comes next, the rule
  // under a heading as much as the next row of a table, and moves with it.
  let y0 = last - size * 0.32
  for (const run of runs) {
    if (Math.abs(run.y - last) < size * 0.5) y0 = Math.min(y0, run.y - run.fontSize * 0.32)
  }

  return { y0, amount: extra * shape.drop }
}

/** How far down content sitting at `y` ends up once the page is opened. */
export function shiftAt(growths, y) {
  let total = 0
  for (const growth of growths) if (y < growth.y0) total += growth.amount
  return total
}

export const totalGrowth = (growths) => growths.reduce((n, g) => n + g.amount, 0)

/** The lowest the page draws anything, so we know what room there is below. */
export function lowestInk(runs = [], images = []) {
  let low = Infinity
  for (const run of runs) {
    const bottom = run.paragraph ? run.paragraph.bottom : run.y - run.fontSize * 0.32
    low = Math.min(low, bottom)
  }
  for (const image of images) low = Math.min(low, image.rect.y)
  return low === Infinity ? null : low
}

/** A resource name for the form that no other XObject on the page uses. */
function freeName(page) {
  const taken = new Set()
  const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'))
  if (xobjects?.keys) for (const key of xobjects.keys()) taken.add(key.decodeText())
  let index = 0
  while (taken.has(`Reflow${index}`)) index += 1
  return `Reflow${index}`
}

const num = (v) => Math.round(v * 1000) / 1000

/**
 * Open the page up at each growth point.
 *
 * The page is cut into bands at the growth points and each band is drawn from
 * the form with the translation that has built up above it, so a band moves
 * down by everything that grew over it and nothing that grew under it. The
 * clip is applied in the translated space, which is the original page's own
 * coordinates, so each band selects exactly the content that was there.
 */
export function applyGrowth(pdfDoc, page, growths, { room, warn }) {
  if (!growths.length) return false

  const bytes = pageContentBytes(page)
  if (!bytes) {
    warn('The page\u2019s drawing instructions could not be read, so the text below the edit could not be moved down.')
    return false
  }

  const box = page.getMediaBox()
  const total = totalGrowth(growths)
  const { Resources } = page.node.normalizedEntries()

  const form = pdfDoc.context.flateStream(bytes, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [box.x, box.y, box.x + box.width, box.y + box.height],
    Resources,
  })
  const name = freeName(page)
  page.node.setXObject(PDFName.of(name), pdfDoc.context.register(form))

  const cuts = [...growths].sort((a, b) => b.y0 - a.y0)
  const bands = []
  let shift = 0
  let ceiling = box.y + box.height
  for (let i = 0; i <= cuts.length; i += 1) {
    const floor = i < cuts.length ? cuts[i].y0 : box.y - total
    bands.push(
      `q 1 0 0 1 0 ${num(-shift)} cm ` +
      `${num(box.x)} ${num(floor)} ${num(box.width)} ${num(ceiling - floor)} re W n ` +
      `/${name} Do Q`,
    )
    if (i === cuts.length) break
    shift += cuts[i].amount
    ceiling = cuts[i].y0
  }
  setPageContent(pdfDoc, page, new TextEncoder().encode(bands.join('\n')))

  // whatever will not fit in the margin at the foot of the page is added to
  // the page itself, so that moving text down never loses it
  const spare = room === null ? 0 : Math.max(0, room - box.y)
  const overflow = Math.max(0, total - spare)
  if (overflow > 0.5) {
    if (page.getRotation().angle % 360 !== 0) {
      warn('The page is rotated, so it could not be made taller and the text moved down may run past its foot.')
    } else {
      page.setMediaBox(box.x, box.y - overflow, box.width, box.height + overflow)
      const crop = page.node.CropBox()
      if (crop) {
        const c = page.getCropBox()
        page.setCropBox(c.x, Math.min(c.y, box.y - overflow), c.width, c.height + overflow)
      }
    }
  }
  return true
}
