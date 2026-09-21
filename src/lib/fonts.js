import fontkit from '@pdf-lib/fontkit'
import { StandardFonts } from 'pdf-lib'
import { nativeWriter } from './nativeText.js'

/**
 * Font selection for redrawn text.
 *
 * First choice is always the page's own font resource, written through
 * nativeText, so an edited line is indistinguishable from the ones around
 * it. That only covers characters the document already had a code for:
 * embedded fonts are subsets of what was printed, often without so much as
 * a space glyph. So text is split into runs of one script and each run gets
 * the first font in the chain that can really draw it, with the pieces laid
 * out end to end.
 */

const STANDARD = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
}

function standardNameFor(run, bold, italic) {
  const family = STANDARD[run.fontKind] || STANDARD.sans
  return family[(bold ? 1 : 0) + (italic ? 2 : 0)]
}

/** Characters the 14 built-in PDF fonts can write (WinAnsi). */
const WIN_ANSI = /^[\x20-\x7e -ÿŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™\t\n\r]*$/

/**
 * Scripts whose glyphs are rearranged by shaping rules. A PDF stores such
 * text already shaped, in visual order, so the character codes it uses are
 * not something we can regenerate from what the user types - those runs need
 * a font with real shaping tables rather than the page's own codes.
 */
const COMPLEX_SCRIPT = /[ऀ-෿؀-ۿ܀-ݏ฀-๿ក-៿က-႟]/

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

/** Can this candidate draw every glyph of `text`? Shaped with the same
 *  engine pdf-lib uses when writing, so a pass here means no blank boxes. */
function covers(cand, text) {
  if (cand.native) return !COMPLEX_SCRIPT.test(text) && cand.native.covers(text)
  if (!cand.fk) return WIN_ANSI.test(text)
  try {
    const glyphs = cand.fk.layout(text).glyphs
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
export async function fontChain({ pdfDoc, pdfLibPage, pdfjsPage, run, bold, italic, text, cache }) {
  const chain = []

  // embedding is deferred: a candidate only becomes a real font object in the
  // output if a segment actually ends up using it
  const lazy = (key, make) => () => {
    if (!cache.has(key)) cache.set(key, make())
    return cache.get(key)
  }

  // 1. the page's own font resource, when weight and slant are unchanged
  if (bold === run.bold && italic === run.italic) {
    let obj = null
    try {
      obj = pdfjsPage.commonObjs.has(run.fontName) ? pdfjsPage.commonObjs.get(run.fontName) : null
    } catch {
      obj = null
    }
    const writer = nativeWriter({
      pdfLibPage,
      fontObj: obj,
      fk: obj?.data?.length ? parse(obj.data) : null,
      run,
    })
    if (writer) chain.push({ native: writer })
  }

  // 2. a bundled face for any script present in the text
  for (const fb of FALLBACK_FONTS) {
    if (!fb.test.test(text)) continue
    const data = await fetchFont(fb.url)
    const fk = data ? parse(data) : null
    if (!fk) continue
    chain.push({
      fk,
      label: fb.label,
      embed: lazy(`file:${fb.url}`, async () => {
        try {
          return await pdfDoc.embedFont(data, { subset: true })
        } catch {
          return pdfDoc.embedFont(data, { subset: false })
        }
      }),
    })
  }

  // 3. a built-in font, which always encodes plain Latin text
  const name = standardNameFor(run, bold, italic)
  chain.push({ embed: lazy(`std:${name}`, () => pdfDoc.embedFont(name)) })

  return { chain }
}

/** Assign each script run the first font in the chain that can draw it. */
export function assignFonts(text, chain) {
  const parts = scriptRuns(text)

  // the page's own font is all-or-nothing for a line: falling back on just
  // the words whose glyphs are missing would leave one line in two typefaces
  const ink = parts.filter((p) => p.cls !== 'space')
  let usable = chain
  if (chain[0]?.native && !ink.every((p) => covers(chain[0], p.text))) {
    usable = chain.slice(1)
  }

  const segments = []
  const swapped = new Set()
  let unsupported = false
  for (const part of parts) {
    let chosen = usable.find((cand) => covers(cand, part.text))
    if (!chosen) {
      unsupported = true
      chosen = usable[usable.length - 1]
    }
    if (chosen.label && part.text.trim()) swapped.add(chosen.label)
    const last = segments[segments.length - 1]
    if (last && last.cand === chosen) last.text += part.text
    else segments.push({ text: part.text, cand: chosen, native: chosen.native })
  }
  return { segments, unsupported, swapped: [...swapped] }
}
