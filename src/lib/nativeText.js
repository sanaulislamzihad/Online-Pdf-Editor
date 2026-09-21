import {
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
} from 'pdf-lib'

/**
 * Writing replacement text with the page's *existing* font resource.
 *
 * Re-embedding a typeface is where fidelity goes to die: the only copy of a
 * font available in the browser is the one pdf.js rebuilt for rendering, and
 * round-tripping that through a new font object shifts glyph ids in some
 * readers even when the file is technically valid. Reusing the font object
 * already in the document avoids the question entirely - the new text is
 * written exactly the way the original was, with the same resource, encoding
 * and character codes, so every reader draws it like the line it replaced.
 */

const isSpace = (text) => /^\s+$/.test(text)

// building one of these walks the whole ToUnicode table, and callers ask for
// it per character when measuring
const encodingCache = new WeakMap()

/** Unicode character -> the character code this font uses for it. */
export function encodingMapFor(fontObj) {
  if (fontObj && encodingCache.has(fontObj)) return encodingCache.get(fontObj)
  const built = buildEncodingMap(fontObj)
  if (fontObj) encodingCache.set(fontObj, built)
  return built
}

function buildEncodingMap(fontObj) {
  const source = fontObj?.toUnicode?._map
  if (!source) return null
  const map = new Map()
  for (const key of Object.keys(source)) {
    const unicode = source[key]
    if (typeof unicode !== 'string' || !unicode) continue
    if (!map.has(unicode)) map.set(unicode, Number(key))
  }
  return map.size ? map : null
}

/**
 * Find the resource name (/F1, /C0_2 …) the page uses for this typeface.
 *
 * A page can carry several resources with the same BaseFont, each subset with
 * its own encoding, where one character code means different things. The font
 * object pdf.js hands back does not say which one drew a given run, so an
 * ambiguous name counts as no match rather than a guess: writing codes
 * against the wrong resource prints the wrong glyphs, or nothing at all.
 */
function resourceNameFor(pdfLibPage, baseFont) {
  if (!baseFont) return null
  let fonts
  try {
    fonts = pdfLibPage.node.Resources()?.lookup(PDFName.of('Font'), PDFDict)
  } catch {
    return null
  }
  if (!fonts) return null

  const ctx = pdfLibPage.node.context
  const matches = []
  for (const [name, value] of fonts.entries()) {
    let dict
    try {
      dict = value instanceof PDFDict ? value : ctx.lookup(value, PDFDict)
    } catch {
      continue
    }
    if (dict?.lookup(PDFName.of('BaseFont'))?.decodeText?.() === baseFont) matches.push(name)
  }
  return matches.length === 1 ? matches[0] : null
}

/** Width of the given character codes, in text-space units at `size`. */
function widthOfCodes(fontObj, codes, size) {
  const widths = fontObj.widths || {}
  const fallback = fontObj.defaultWidth || 0
  let total = 0
  for (const code of codes) {
    const w = widths[code]
    total += typeof w === 'number' ? w : fallback
  }
  return (total / 1000) * size
}

/**
 * Which characters does this font really have a glyph for?
 *
 * A subset's ToUnicode table routinely describes the whole original encoding
 * while the font file itself only carries the handful of glyphs that were
 * printed, so a character code existing proves nothing - the rebuilt font
 * from pdf.js is checked instead. Anything the run already displays needs no
 * checking at all: it was drawn, so the glyph is there. That also covers the
 * private-use characters pdf.js falls back to for glyphs its table cannot
 * name, which is what lets an unreadable line be written back untouched.
 */
function glyphTest(fontObj, fk, run) {
  const toFontChar = fontObj.toFontChar || []
  const drawn = new Set([...run.text])
  if (!fk) return (ch) => drawn.has(ch)

  const cache = new Map()
  return (ch, code) => {
    if (drawn.has(ch)) return true
    if (cache.has(ch)) return cache.get(ch)
    let ok = false
    try {
      const point = toFontChar[code]
      const glyph = fk.glyphForCodePoint(point === undefined ? code : point)
      ok = !!glyph && glyph.id !== 0
    } catch {
      ok = false
    }
    cache.set(ch, ok)
    return ok
  }
}

/**
 * Width of `text` in this font, in points at `size`, or null when the font
 * has no code for something in it. Exact: these are the widths the page
 * itself was laid out with.
 */
export function textWidthIn(fontObj, text, size) {
  const map = encodingMapFor(fontObj)
  if (!map) return null
  const codes = []
  for (const ch of text) {
    const code = map.get(ch)
    if (code === undefined) return null
    codes.push(code)
  }
  return widthOfCodes(fontObj, codes, size)
}

/**
 * Build a writer for a run, or null when the page's own font cannot be used
 * (no usable encoding, a Type 3 font, or an ambiguous resource).
 */
export function nativeWriter({ pdfLibPage, fontObj, fk, run }) {
  if (!fontObj || fontObj.isType3Font) return null
  const map = encodingMapFor(fontObj)
  if (!map) return null
  const name = resourceNameFor(pdfLibPage, fontObj.name)
  if (!name) return null

  const bytes = fontObj.composite ? 2 : 1
  const limit = bytes === 1 ? 0xff : 0xffff
  const hasGlyph = glyphTest(fontObj, fk, run)

  const encode = (text) => {
    const codes = []
    for (const ch of text) {
      const code = map.get(ch)
      if (code === undefined || code > limit) return null
      if (!/\s/.test(ch) && !hasGlyph(ch, code)) return null
      codes.push(code)
    }
    return codes
  }

  // Subset fonts routinely have no space glyph - the original spacing came
  // from text positioning instead. Recover what a space is worth here by
  // taking the run's known width and subtracting everything that is not one.
  const chars = [...run.text]
  const spaceCount = chars.filter((c) => /\s/.test(c)).length
  const inkCodes = encode(chars.filter((c) => !/\s/.test(c)).join(''))
  if (!inkCodes || !inkCodes.length) return null
  const inkWidth = widthOfCodes(fontObj, inkCodes, run.fontSize)
  const runWidth = Math.abs(run.width)
  if (!runWidth) return null

  let spaceWidth = 0
  if (spaceCount) {
    spaceWidth = (runWidth - inkWidth) / spaceCount
    // a space worth less than a hairline or more than half an em means these
    // are not the codes this run was drawn with
    if (spaceWidth < run.fontSize * 0.05 || spaceWidth > run.fontSize * 0.6) return null
  } else if (!inkWidth || Math.abs(inkWidth - runWidth) / runWidth > 0.15) {
    return null
  }

  const spaceAt = (size) => (size / run.fontSize) * spaceWidth

  return {
    name,
    encode,
    covers: (text) => (isSpace(text) ? spaceWidth > 0 || encode(text) !== null : encode(text) !== null),
    widthOf: (text, size) => {
      const codes = encode(text)
      if (codes) return widthOfCodes(fontObj, codes, size)
      return isSpace(text) ? [...text].length * spaceAt(size) : 0
    },
    hex: (codes) => codes.map((c) => c.toString(16).padStart(bytes * 2, '0')).join(''),
  }
}

/**
 * Emit one piece of text with the page's own font resource. Whitespace the
 * font has no glyph for is left as a gap, exactly as the original had it.
 */
export function pushNativeText(pdfLibPage, writer, { text, x, y, size, color, angle }) {
  const codes = writer.encode(text)
  if (!codes) return isSpace(text)

  const cos = Math.cos(angle || 0)
  const sin = Math.sin(angle || 0)
  const num = (v) => PDFNumber.of(Math.round(v * 1000) / 1000)

  pdfLibPage.pushOperators(
    PDFOperator.of(Ops.PushGraphicsState),
    PDFOperator.of(Ops.BeginText),
    PDFOperator.of(Ops.NonStrokingColorRgb, [num(color.red), num(color.green), num(color.blue)]),
    PDFOperator.of(Ops.SetFontAndSize, [writer.name, num(size)]),
    PDFOperator.of(Ops.SetTextMatrix, [num(cos), num(sin), num(-sin), num(cos), num(x), num(y)]),
    PDFOperator.of(Ops.ShowText, [PDFHexString.of(writer.hex(codes))]),
    PDFOperator.of(Ops.EndText),
    PDFOperator.of(Ops.PopGraphicsState),
  )
  return true
}
