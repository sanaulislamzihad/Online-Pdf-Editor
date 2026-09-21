import {
  PDFArray,
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

/** The widths a font dictionary declares, as code -> width in 1/1000 em. */
function declaredWidths(ctx, dict) {
  const widths = new Map()
  try {
    if (String(dict.lookup(PDFName.of('Subtype'))) === '/Type0') {
      const descendants = dict.lookup(PDFName.of('DescendantFonts'), PDFArray)
      const cidFont = ctx.lookup(descendants.get(0), PDFDict)
      const w = cidFont.lookup(PDFName.of('W'), PDFArray)
      if (!w) return widths
      let i = 0
      while (i < w.size()) {
        const first = w.lookup(i)?.asNumber?.()
        const second = w.lookup(i + 1)
        if (second instanceof PDFArray) {
          for (let k = 0; k < second.size(); k += 1) {
            widths.set(first + k, second.lookup(k)?.asNumber?.() ?? 0)
          }
          i += 2
        } else {
          const last = second?.asNumber?.()
          const value = w.lookup(i + 2)?.asNumber?.() ?? 0
          for (let c = first; c <= last && c - first < 4096; c += 1) widths.set(c, value)
          i += 3
        }
      }
      return widths
    }

    const first = dict.lookup(PDFName.of('FirstChar'))?.asNumber?.() ?? 0
    const list = dict.lookup(PDFName.of('Widths'), PDFArray)
    if (!list) return widths
    for (let k = 0; k < list.size(); k += 1) {
      widths.set(first + k, list.lookup(k)?.asNumber?.() ?? 0)
    }
  } catch {
    /* an unreadable dictionary simply scores nothing */
  }
  return widths
}

/**
 * Find the resource name (/F1, /C0_2 …) the page uses for this typeface.
 *
 * A page can carry several resources sharing one BaseFont, each subset with
 * its own encoding, and the font object pdf.js hands back does not say which
 * one drew a given run. Where the name alone is ambiguous they are told apart
 * by their declared widths: the right one agrees with the widths pdf.js read
 * for this very font, character for character. Still ambiguous means no
 * match, because writing codes against the wrong resource prints the wrong
 * glyphs, or nothing.
 */
function resourceNameFor(pdfLibPage, fontObj, codes) {
  const baseFont = fontObj?.name
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
    if (dict?.lookup(PDFName.of('BaseFont'))?.decodeText?.() === baseFont) matches.push([name, dict])
  }
  if (matches.length === 1) return matches[0][0]
  if (!matches.length || !codes?.length) return null

  const wanted = fontObj.widths || {}
  const sample = [...new Set(codes)].slice(0, 24).filter((code) => typeof wanted[code] === 'number')
  if (!sample.length) return null

  const agreeing = matches.filter(([, dict]) => {
    const declared = declaredWidths(ctx, dict)
    return sample.every((code) => Math.abs((declared.get(code) ?? -1) - wanted[code]) < 1)
  })
  return agreeing.length === 1 ? agreeing[0][0] : null
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

  // What a space is worth on this line, which is not what the font says.
  //
  // A justified line is set by widening its spaces, and a subset font often
  // has no space glyph at all because the original spacing came from text
  // positioning. Both are recovered the same way: take the width the page
  // gives this run and subtract everything in it that is not a space. The
  // difference from the font's own space is exactly the word spacing the
  // page had set, and writing it back is what keeps a justified line
  // justified after an edit.
  // a paragraph belongs to its lines, not to all of its text at once, so
  // it hands over the line it is set in to be measured by
  const measured = run.paragraph?.probe ?? run
  const chars = [...measured.text]
  const spaceCount = chars.filter((c) => /\s/.test(c)).length
  const inkCodes = encode(chars.filter((c) => !/\s/.test(c)).join(''))
  if (!inkCodes || !inkCodes.length) return null
  const name = resourceNameFor(pdfLibPage, fontObj, inkCodes)
  if (!name) return null

  const inkWidth = widthOfCodes(fontObj, inkCodes, measured.fontSize)
  const runWidth = Math.abs(measured.width)
  if (!runWidth) return null

  const spaceCodes = encode(' ')
  const fontSpace = spaceCodes ? widthOfCodes(fontObj, spaceCodes, run.fontSize) : 0

  let spaceWidth = fontSpace
  if (spaceCount) {
    spaceWidth = (runWidth - inkWidth) / spaceCount
    // a space worth less than a hairline or more than an em means these are
    // not the codes this run was drawn with
    if (spaceWidth < measured.fontSize * 0.05 || spaceWidth > measured.fontSize) return null
  } else if (!inkWidth || Math.abs(inkWidth - runWidth) / runWidth > 0.15) {
    return null
  }

  const extraPerSpace = spaceCount ? spaceWidth - fontSpace : 0
  const at = (value, size) => (size / measured.fontSize) * value
  const spacesIn = (text) => [...text].filter((c) => /\s/.test(c)).length

  return {
    name,
    encode,
    covers: (text) => (isSpace(text) ? spaceWidth > 0 || encode(text) !== null : encode(text) !== null),
    // the extra a space carries here, as the PDF word spacing it came from
    wordSpacingAt: (size) => at(extraPerSpace, size),
    spaceCode: spaceCodes ? spaceCodes[0] : null,
    bytes,
    widthOf: (text, size) => {
      const codes = encode(text)
      if (codes) return widthOfCodes(fontObj, codes, size) + spacesIn(text) * at(extraPerSpace, size)
      return isSpace(text) ? [...text].length * at(spaceWidth, size) : 0
    },
    hex: (codes) => codes.map((c) => c.toString(16).padStart(bytes * 2, '0')).join(''),
  }
}

/**
 * Emit one piece of text with the page's own font resource. Whitespace the
 * font has no glyph for is left as a gap, exactly as the original had it.
 */
export function pushNativeText(pdfLibPage, writer, { text, x, y, size, color, angle, wordSpacing }) {
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
    showText(pdfLibPage, writer, codes, size, wordSpacing),
    PDFOperator.of(Ops.EndText),
    PDFOperator.of(Ops.PopGraphicsState),
  )
  return true
}

/**
 * Draw the codes, widening the spaces to the width the line was set at.
 *
 * The word spacing operator would be the obvious way to do that, but it is
 * defined to act on the single byte 32 and so does nothing at all for the
 * two-byte codes most modern PDFs use. An adjusted show, which shifts the
 * pen between pieces of the string, works for either kind.
 */
function showText(pdfLibPage, writer, codes, size, override) {
  const extra = override ?? (writer.wordSpacingAt?.(size) || 0)
  const spaceCode = writer.spaceCode
  if (!extra || spaceCode === null || spaceCode === undefined) {
    return PDFOperator.of(Ops.ShowText, [PDFHexString.of(writer.hex(codes))])
  }

  // a positive number in the array moves the pen back, so widening is negative
  const shift = PDFNumber.of(Math.round((-extra / size) * 100000) / 100)
  const pieces = PDFArray.withContext(pdfLibPage.node.context)
  let chunk = []
  for (const code of codes) {
    chunk.push(code)
    if (code !== spaceCode) continue
    pieces.push(PDFHexString.of(writer.hex(chunk)))
    pieces.push(shift)
    chunk = []
  }
  if (chunk.length) pieces.push(PDFHexString.of(writer.hex(chunk)))

  return PDFOperator.of(Ops.ShowTextAdjusted, [pieces])
}
