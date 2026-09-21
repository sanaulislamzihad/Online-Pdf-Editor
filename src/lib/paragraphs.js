import { textWidthIn } from './nativeText.js'

/**
 * Finding the paragraph a line belongs to, and setting one again.
 *
 * Typing into a line used to run it off the edge of the page, because a PDF
 * has no paragraphs - only lines at fixed positions. They can be recognised
 * though: consecutive lines in one font, starting at one left margin, evenly
 * spaced. Once a paragraph is known, an edit to any of its lines can be set
 * again across all of them, which is what makes text wrap.
 */

const SAME = 0.05 // how close two sizes must be to count as one

function sameStyle(a, b) {
  return a.fontName === b.fontName &&
    Math.abs(a.fontSize - b.fontSize) <= a.fontSize * SAME &&
    !a.angle && !b.angle &&
    a.pageIndex === b.pageIndex
}

/** Lines, in order, with the runs that sit on each. */
function linesOf(runs) {
  const lines = []
  for (const run of runs) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - run.y) < run.fontSize * 0.2 && sameStyle(last.runs[0], run)) {
      last.runs.push(run)
      last.right = Math.max(last.right, run.x + Math.abs(run.width))
      continue
    }
    lines.push({ y: run.y, left: run.x, right: run.x + Math.abs(run.width), runs: [run] })
  }
  return lines
}

/**
 * Group a page's lines into paragraphs: same font and size, an even drop from
 * one baseline to the next, and a shared left margin - allowing the first
 * line an indent, which is exactly what an indent is for.
 */
export function findParagraphs(runs) {
  const lines = linesOf(runs)
  const paragraphs = []
  let current = null

  for (const line of lines) {
    const previous = current?.lines[current.lines.length - 1]
    const drop = previous ? previous.y - line.y : 0
    const size = line.runs[0].fontSize
    // a paragraph ends at a line that does not reach the margin - that is
    // what a last line is - so nothing may follow one
    const fits = previous && !current.closed &&
      sameStyle(previous.runs[0], line.runs[0]) &&
      drop > size * 0.9 && drop < size * 2.2 &&
      (!current.drop || Math.abs(drop - current.drop) < size * 0.15) &&
      Math.abs(line.left - current.left) < size * 2.5 &&
      line.right < current.right + size * 0.6

    if (fits) {
      if (line.right < current.right - size * 1.5) current.closed = true
      current.lines.push(line)
      current.drop = current.drop || drop
      current.left = Math.min(current.left, line.left)
      current.right = Math.max(current.right, line.right)
      continue
    }
    if (current && current.lines.length > 1) paragraphs.push(current)
    current = { lines: [line], left: line.left, right: line.right, drop: 0, closed: false }
  }
  if (current && current.lines.length > 1) paragraphs.push(current)

  return paragraphs.filter(runsFullWidth).map((paragraph) => ({
    ...paragraph,
    // a first line that starts further in than the rest is an indent, and the
    // width to set to is what the other lines use
    indent: paragraph.lines[0].left - paragraph.left,
    width: paragraph.right - paragraph.left,
    runIds: new Set(paragraph.lines.flatMap((line) => line.runs.map((run) => run.id))),
  }))
}

/**
 * Is this really flowing text, or a column of a table?
 *
 * Both are evenly spaced lines in one font. What tells them apart is that
 * prose fills its measure: every line but the last reaches the right margin,
 * because that is why it broke. A table's cells stop wherever their content
 * ends.
 */
function runsFullWidth(paragraph) {
  const width = paragraph.right - paragraph.left
  const size = paragraph.lines[0].runs[0].fontSize
  if (width < size * 12) return false
  return paragraph.lines
    .slice(0, -1)
    .every((line) => line.right - paragraph.left > width * 0.86)
}

/** Break `text` into lines no wider than the space each one has. */
export function breakLines(text, widthOf, widthFor) {
  const words = text.split(' ')
  const lines = []
  let line = ''
  let index = 0

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && widthOf(candidate) > widthFor(index)) {
      lines.push(line)
      index += 1
      line = word
    } else {
      line = candidate
    }
  }
  lines.push(line)
  return lines
}

/**
 * The text of a paragraph as one string, and the lines it is currently set
 * in, so the two can be compared.
 */
export function paragraphText(paragraph, edits = {}) {
  const lines = paragraph.lines.map((line) => line.runs
    .map((run) => (edits[run.id]?.deleted ? '' : edits[run.id]?.text ?? run.text))
    .join(''))
  return {
    lines,
    text: lines.join(' ').split(/[ ]+/).join(' ').trim(),
  }
}

/**
 * Would setting this paragraph again reproduce the lines it already has?
 *
 * Only then is it understood well enough to re-set after an edit. Anything
 * else - a hanging indent, a line broken by hand, a measure we have read
 * slightly wrong - leaves it alone rather than rearranging it wrongly.
 */
export function reflowable(paragraph, measure) {
  if (!measure) return false
  const { lines, text } = paragraphText(paragraph)
  const widthFor = (index) => paragraph.width - (index === 0 ? paragraph.indent : 0)
  const width = (value) => measure.natural(value) ?? Number.POSITIVE_INFINITY
  const again = breakLines(text, width, widthFor)
  return again.length === lines.length &&
    again.every((line, i) => line.trim() === lines[i].trim())
}

/** Measure text in the font a run is set in, or null if it cannot be. */
export function measurerFor(run, fontObj) {
  if (!fontObj) return null
  const probe = textWidthIn(fontObj, run.text, run.fontSize)
  if (probe === null) return null

  // the space the page actually set, which is wider than the font's own on a
  // justified line
  const chars = [...run.text]
  const spaces = chars.filter((c) => c === ' ').length
  const ink = textWidthIn(fontObj, chars.filter((c) => c !== ' ').join(''), run.fontSize)
  const fontSpace = textWidthIn(fontObj, ' ', run.fontSize) ?? 0
  const space = spaces && ink !== null
    ? Math.max(fontSpace, (Math.abs(run.width) - ink) / spaces)
    : fontSpace

  // A letter the font was never subset with cannot be measured from it, and
  // a newly typed word is full of those. Breaking lines is not the place to
  // be exact about it: an average of what the font does declare keeps the
  // measure honest enough to decide where a line ends.
  // A letter the font was never subset with has to be guessed at, and erring
  // wide is the cheap way round: a line that breaks early is stretched back
  // to the margin by justification, while one that breaks late runs off the
  // page. Capitals and digits take about three quarters of an em in most
  // text faces, lowercase a little over half.
  const guess = (ch) => {
    if (/[A-Z0-9@#&%]/.test(ch)) return run.fontSize * 0.75
    if (/[ilj.,;:'!|]/.test(ch)) return run.fontSize * 0.3
    if (/[mw]/.test(ch)) return run.fontSize * 0.85
    return run.fontSize * 0.56
  }
  const each = new Map()
  const widthOfChar = (ch) => {
    // the font's own space: justification is added afterwards, per line
    if (ch === ' ') return fontSpace || space || run.fontSize * 0.25
    if (!each.has(ch)) each.set(ch, textWidthIn(fontObj, ch, run.fontSize) ?? guess(ch))
    return each.get(ch)
  }

  return {
    space,
    natural: (value) => {
      let total = 0
      for (const ch of value) total += widthOfChar(ch)
      return total
    },
  }
}

/**
 * Fold a paragraph into a single editable block.
 *
 * Its lines are positions, not content: the text belongs to the paragraph,
 * and where the breaks fall is decided again every time it is set. Holding
 * it as one run is what lets typing push words onto the next line instead of
 * off the edge of the page.
 */
export function paragraphRun(paragraph, measure) {
  const { lines, text } = paragraphText(paragraph)
  const first = paragraph.lines[0].runs[0]
  const last = paragraph.lines[paragraph.lines.length - 1]

  return {
    ...first,
    id: `${first.id}para`,
    text,
    x: paragraph.left + paragraph.indent,
    y: paragraph.lines[0].y,
    width: paragraph.width - paragraph.indent,
    paragraph: {
      left: paragraph.left,
      indent: paragraph.indent,
      width: paragraph.width,
      drop: paragraph.drop,
      baselines: paragraph.lines.map((line) => line.y),
      bottom: last.y - first.fontSize * 0.3,
      // the line this paragraph is set in now, to measure a space by
      probe: {
        text: lines[0],
        width: paragraph.lines[0].right - paragraph.lines[0].left,
        fontSize: first.fontSize,
      },
      justified: paragraph.lines.length > 1 &&
        Math.abs(paragraph.lines[0].right - paragraph.right) < first.fontSize * 0.4,
    },
    scrambled: paragraph.lines.some((line) => line.runs.some((run) => run.scrambled)),
    space: measure.space,
  }
}
