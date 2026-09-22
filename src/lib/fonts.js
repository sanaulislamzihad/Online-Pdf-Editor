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

/**
 * Stand-ins for the typefaces documents are actually set in.
 *
 * An embedded font is a subset of what was printed with it, so a face used
 * for a handful of headings has a handful of letters - type a new word into
 * one and there is no glyph for half of it. These are metric-for-metric
 * clones of the fonts that turn up most: same widths, same shapes, so a line
 * finished in one sits exactly where the original would have and reads as
 * the same typeface. The built-in Helvetica and Times already serve that
 * role for Arial and Times New Roman.
 */
const CLONE_FONTS = [
  {
    test: /^calibri/i,
    label: 'Carlito',
    files: ['Carlito-Regular', 'Carlito-Bold', 'Carlito-Italic', 'Carlito-BoldItalic'],
  },
  {
    test: /^cambria/i,
    label: 'Caladea',
    files: ['Caladea-Regular', 'Caladea-Bold', 'Caladea-Italic', 'Caladea-BoldItalic'],
  },
]

/**
 * A font the reader supplied themselves.
 *
 * No bundled set can cover every typeface a PDF might be set in, so a file
 * can be handed in - straight out of the system's own font folder, usually -
 * and it is then preferred over any stand-in of ours. Weight and slant are
 * read from the file name, so dropping in the regular and the bold of a
 * family lets each line take the right one.
 */
export function describeFont(file, bytes) {
  const dot = file.name.lastIndexOf('.')
  const filename = dot > 0 ? file.name.slice(0, dot) : file.name
  const id = `${filename}:${file.size}`

  // the file says what it is; the name it was saved under often does not
  const fk = parse(bytes)
  if (!fk) return { id, name: filename, bold: false, italic: false }

  const style = `${fk.subfamilyName || ''}`.toLowerCase()
  const weight = fk['OS/2']?.usWeightClass ?? 400
  const slant = fk.post?.italicAngle ?? 0
  return {
    id,
    name: fk.fullName || fk.familyName || filename,
    family: fk.familyName || filename,
    bold: style.includes('bold') || weight >= 600,
    italic: style.includes('italic') || style.includes('oblique') || slant !== 0,
  }
}

const plainName = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Choose among the fonts the reader supplied.
 *
 * One that names the same family as the run is the real article and beats
 * any stand-in of ours. One that does not is still better than a built-in,
 * but only after a clone of the run's actual typeface has had its turn -
 * supplying Calibri to fix a heading should not put the body's Cambria into
 * Calibri as well.
 */
function pickCustom(fonts, bold, italic, family) {
  if (!fonts?.length) return null
  const matching = family
    ? fonts.filter((f) => plainName(f.family).startsWith(plainName(family)))
    : fonts
  if (!matching.length) return null
  return matching.find((f) => f.bold === bold && f.italic === italic) ||
    matching.find((f) => f.bold === bold) ||
    matching[0]
}

const familyOf = (run) => (run.fontRawName || '').split(/[-,]/)[0]

function cloneFor(run, bold, italic) {
  const entry = CLONE_FONTS.find((clone) => clone.test.test(run.fontRawName || ''))
  if (!entry) return null
  return {
    label: entry.label,
    url: `fonts/${entry.files[(bold ? 1 : 0) + (italic ? 2 : 0)]}.ttf`,
  }
}

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

/**
 * Can this candidate draw every glyph of `text`?
 *
 * Shaped with the same engine pdf-lib uses when writing, so a pass here means
 * no blank boxes. `kept` marks text carried over untouched from the page: the
 * page's own font wrote it once already, character code for character code,
 * so writing it back is exact - shaping rules do not come into it. Newly
 * typed text in a script that needs shaping does need a font with the tables
 * to do it, since the original codes are in painting order.
 */
function covers(cand, text, kept) {
  if (cand.native) return (kept || !COMPLEX_SCRIPT.test(text)) && cand.native.covers(text)
  if (!cand.fk) return WIN_ANSI.test(text)
  try {
    const glyphs = cand.fk.layout(text).glyphs
    return glyphs.length > 0 && glyphs.every((g) => g.id !== 0)
  } catch {
    return false
  }
}

/** What a run's new text would be set in if its own font runs out. */
export function fallbackNameFor(run, bold, italic, customFonts) {
  const exact = pickCustom(customFonts, bold, italic, familyOf(run))
  if (exact) return exact.name
  const clone = cloneFor(run, bold, italic)
  if (clone) return clone.label
  return pickCustom(customFonts, bold, italic, null)?.name ||
    standardNameFor(run, bold, italic)
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
export async function fontChain({
  pdfDoc, pdfLibPage, pdfjsPage, run, bold, italic, text, cache, customFonts,
}) {
  const chain = []

  // embedding is deferred: a candidate only becomes a real font object in the
  // output if a segment actually ends up using it
  const lazy = (key, make) => () => {
    if (!cache.has(key)) cache.set(key, make())
    return cache.get(key)
  }

  // 1. the page's own font resource, when weight and slant are unchanged
  if (run.fontName && bold === run.bold && italic === run.italic) {
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

  const addCustom = (font) => {
    if (!font) return null
    const fk = parse(font.bytes)
    if (!fk) return null
    chain.push({
      fk,
      label: font.name,
      embed: lazy(`custom:${font.id}`, () => pdfDoc.embedFont(font.bytes, { subset: false })),
    })
    return font
  }

  // 2. the reader's own copy of this very typeface, if they supplied one
  const exact = addCustom(pickCustom(customFonts, bold, italic, familyOf(run)))

  // 3. a clone of the document's own typeface, for what its subset lacks
  const clone = cloneFor(run, bold, italic)
  if (clone) {
    const data = await fetchFont(clone.url)
    const fk = data ? parse(data) : null
    if (fk) {
      chain.push({
        fk,
        label: clone.label,
        embed: lazy(`file:${clone.url}`, () => pdfDoc.embedFont(data, { subset: false })),
      })
    }
  }

  // 4. any other font they supplied, still better than a built-in
  const generic = pickCustom(customFonts, bold, italic, null)
  if (generic && generic !== exact) addCustom(generic)

  // 5. a bundled face for any script present in the text
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

  // 6. a built-in font, which always encodes plain Latin text
  const name = standardNameFor(run, bold, italic)
  chain.push({ embed: lazy(`std:${name}`, () => pdfDoc.embedFont(name)) })

  return { chain }
}

/**
 * Split an edited line into what was kept and what was typed.
 *
 * Everything outside the edit is still the document's own characters, and it
 * matters that they stay so: a line the PDF describes badly - missing
 * conjuncts, vowel signs in painting order - reads as mojibake but writes
 * back perfectly through the font it came from. Only the span that actually
 * changed needs a font chosen for it.
 */
function editedSpan(original, text) {
  const before = [...original]
  const after = [...text]

  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1
  }
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1
  }

  return [
    { text: after.slice(0, start).join(''), kept: true },
    { text: after.slice(start, after.length - end).join(''), kept: false },
    { text: after.slice(after.length - end).join(''), kept: true },
  ].filter((part) => part.text)
}

/**
 * The chain newly typed text may be set in.
 *
 * The page's own font is all-or-nothing: falling back on only the words whose
 * glyphs are missing would leave one piece of text set in two typefaces. What
 * counts as one piece is the caller's to say - a line on its own, or a whole
 * block being set again across several of them.
 */
export function usableChain(chain, text) {
  if (!chain[0]?.native) return chain
  const ink = scriptRuns(text).filter((part) => part.cls !== 'space')
  return ink.every((part) => covers(chain[0], part.text, false)) ? chain : chain.slice(1)
}

/**
 * Work out which font draws each part of the line, keeping untouched text on
 * the page's own font and giving anything newly typed a font that can shape
 * it.
 */
export function planSegments({ original, text, chain }) {
  const segments = []
  const swapped = new Set()
  let unsupported = false
  let lost = false

  for (const span of editedSpan(original ?? text, text)) {
    const parts = scriptRuns(span.text)

    const usable = span.kept ? chain : usableChain(chain, span.text)

    for (const part of parts) {
      let chosen = usable.find((cand) => covers(cand, part.text, span.kept))
      if (!chosen) {
        unsupported = true
        if (span.kept) lost = true
        chosen = usable[usable.length - 1]
      }
      if (chosen.label && part.text.trim()) swapped.add(chosen.label)

      const last = segments[segments.length - 1]
      if (last && last.cand === chosen) last.text += part.text
      else segments.push({ text: part.text, cand: chosen, native: chosen.native })
    }
  }

  return { segments, unsupported, lost, swapped: [...swapped] }
}
