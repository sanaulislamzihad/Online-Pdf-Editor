import fontkit from '@pdf-lib/fontkit'
import { StandardFonts } from 'pdf-lib'

/**
 * Font selection for redrawn text.
 *
 * First choice is always the document's own embedded typeface, so an edited
 * line keeps the exact shapes of the lines around it. Embedded fonts in a PDF
 * are subsets holding only the glyphs that were actually printed, though -
 * frequently not even a space, because the original spacing came from text
 * positioning rather than from a space glyph. So the text is split into runs
 * of one script and each run gets the best font that can actually draw it,
 * with the pieces laid out end to end.
 */

const STANDARD = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
}

function standardNameFor(run, bold, italic) {
  const fam = /Times|serif/i.test(run.fontFamily) ? 'serif'
    : /Courier|mono/i.test(run.fontFamily) ? 'mono' : 'sans'
  return STANDARD[fam][(bold ? 1 : 0) + (italic ? 2 : 0)]
}

/** Characters the 14 built-in PDF fonts can write (WinAnsi). */
const WIN_ANSI = /^[\x20-\x7e -ÿŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™\t\n\r]*$/

/** Bundled faces for scripts the built-in fonts cannot write. */
const FALLBACK_FONTS = [
  { test: /[ঀ-৿]/, url: 'fonts/NotoSansBengali.ttf', label: 'Noto Sans Bengali' },
]

const fileCache = new Map()

function fetchFont(url) {
  if (!fileCache.has(url)) {
    fileCache.set(url, fetch(`${import.meta.env.BASE_URL}${url}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
      .then((b) => new Uint8Array(b))
      .catch(() => null))
  }
  return fileCache.get(url)
}

function parse(bytes) {
  try {
    return fontkit.create(bytes)
  } catch {
    return null
  }
}

/** Can this font draw every glyph of `text`? Shaped with the same engine
 *  pdf-lib uses when writing, so a pass here means no blank boxes. */
function covers(fk, text) {
  if (!fk) return false
  try {
    const glyphs = fk.layout(text).glyphs
    return glyphs.length > 0 && glyphs.every((g) => g.id !== 0)
  } catch {
    return false
  }
}

/** Split text into runs of a single script, keeping whitespace separate. */
export function scriptRuns(text) {
  const classOf = (ch) => {
    if (/\s/.test(ch)) return 'space'
    if (/[ঀ-৿]/.test(ch)) return 'beng'
    return 'other'
  }
  const out = []
  for (const ch of text) {
    const cls = classOf(ch)
    const last = out[out.length - 1]
    if (last && last.cls === cls) last.text += ch
    else out.push({ cls, text: ch })
  }
  return out
}

/**
 * Build the ordered list of fonts available for a run: the document's own
 * face first, then a bundled face for the scripts present, then a built-in.
 */
export async function fontChain({ pdfDoc, pdfjsPage, run, bold, italic, text, cache }) {
  const chain = []
  const notes = []

  const add = async (key, make, fk) => {
    if (cache.has(key)) { chain.push(cache.get(key)); return true }
    try {
      const entry = { font: await make(), fk }
      cache.set(key, entry)
      chain.push(entry)
      return true
    } catch {
      return false
    }
  }

  // 1. the document's own font, when weight and slant are unchanged
  if (bold === run.bold && italic === run.italic) {
    let data = null
    try {
      data = pdfjsPage.commonObjs.has(run.fontName)
        ? pdfjsPage.commonObjs.get(run.fontName)?.data ?? null
        : null
    } catch {
      data = null
    }
    const fk = data?.length ? parse(data) : null
    if (fk) await add(`embedded:${run.fontName}`, () => pdfDoc.embedFont(data, { subset: false }), fk)
  }

  // 2. a bundled face for any script present in the text
  for (const fb of FALLBACK_FONTS) {
    if (!fb.test.test(text)) continue
    const data = await fetchFont(fb.url)
    const fk = data ? parse(data) : null
    if (!fk) continue
    const ok = await add(`file:${fb.url}`, async () => {
      try {
        return await pdfDoc.embedFont(data, { subset: true })
      } catch {
        return pdfDoc.embedFont(data, { subset: false })
      }
    }, fk)
    if (ok) notes.push(fb.label)
  }

  // 3. a built-in font, which always encodes plain Latin text
  const name = standardNameFor(run, bold, italic)
  await add(`std:${name}`, () => pdfDoc.embedFont(name), null)

  return { chain, notes }
}

/** Assign each script run the first font in the chain that can draw it. */
export function assignFonts(text, chain) {
  const segments = []
  let unsupported = false
  for (const part of scriptRuns(text)) {
    let chosen = null
    for (const cand of chain) {
      const ok = cand.fk ? covers(cand.fk, part.text) : WIN_ANSI.test(part.text)
      if (ok) { chosen = cand; break }
    }
    if (!chosen) {
      unsupported = true
      chosen = chain[chain.length - 1]
    }
    const last = segments[segments.length - 1]
    if (last && last.font === chosen.font) last.text += part.text
    else segments.push({ text: part.text, font: chosen.font })
  }
  return { segments, unsupported }
}
