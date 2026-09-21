/**
 * Minimal PDF content-stream tokenizer.
 *
 * It exists for one job: find every text-showing operator (Tj, TJ, ' and ")
 * in a page's content stream, remember the exact byte range it occupies and
 * the text render mode in force at that point. Knowing the byte range lets us
 * neutralise a single line of text without touching anything else in the page
 * - no rasterising, no rewriting of graphics, images or layout.
 */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

const isWs = (c) => WHITESPACE.has(c)
const isDelim = (c) => DELIM.has(c)
const isRegular = (c) => !isWs(c) && !isDelim(c)

/** Tokenise a content stream into operands and operators with byte offsets. */
export function tokenize(bytes) {
  const tokens = []
  let i = 0
  const n = bytes.length

  while (i < n) {
    const c = bytes[i]

    if (isWs(c)) { i += 1; continue }

    if (c === 0x25) { // % comment
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1
      continue
    }

    const start = i

    if (c === 0x28) { // ( literal string )
      let depth = 0
      let len = 0
      i += 1
      depth = 1
      while (i < n && depth > 0) {
        const b = bytes[i]
        if (b === 0x5c) { i += 2; len += 1; continue } // escape
        if (b === 0x28) depth += 1
        else if (b === 0x29) { depth -= 1; if (depth === 0) { i += 1; break } }
        len += 1
        i += 1
      }
      tokens.push({ type: 'string', start, end: i, len })
      continue
    }

    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) { // << dict
        tokens.push({ type: 'dictOpen', start, end: i + 2 })
        i += 2
        continue
      }
      let len = 0
      i += 1
      while (i < n && bytes[i] !== 0x3e) {
        if (!isWs(bytes[i])) len += 1
        i += 1
      }
      i += 1
      tokens.push({ type: 'string', start, end: i, len: Math.ceil(len / 2) })
      continue
    }

    if (c === 0x3e && bytes[i + 1] === 0x3e) {
      tokens.push({ type: 'dictClose', start, end: i + 2 })
      i += 2
      continue
    }

    if (c === 0x2f) { // /Name
      i += 1
      while (i < n && isRegular(bytes[i])) i += 1
      tokens.push({ type: 'name', start, end: i, value: latin1(bytes, start + 1, i) })
      continue
    }

    if (c === 0x5b || c === 0x5d) {
      i += 1
      tokens.push({ type: c === 0x5b ? 'arrayOpen' : 'arrayClose', start, end: i })
      continue
    }

    if (c === 0x7b || c === 0x7d) { // PostScript function braces (type 4 fn)
      i += 1
      tokens.push({ type: 'brace', start, end: i })
      continue
    }

    // number or operator keyword
    i += 1
    while (i < n && isRegular(bytes[i])) i += 1
    const raw = latin1(bytes, start, i)
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) {
      tokens.push({ type: 'number', start, end: i, value: parseFloat(raw) })
      continue
    }

    if (raw === 'BI') {
      // inline image: skip past the binary payload to the matching EI
      const after = skipInlineImage(bytes, i)
      tokens.push({ type: 'op', start, end: after, value: 'BI' })
      i = after
      continue
    }

    tokens.push({ type: 'op', start, end: i, value: raw })
  }

  return tokens
}

function skipInlineImage(bytes, from) {
  let i = from
  const n = bytes.length
  // find the ID operator that starts the binary data
  while (i < n - 1) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && (i + 2 >= n || isWs(bytes[i + 2]) || isDelim(bytes[i + 2]))) {
      i += 3
      break
    }
    i += 1
  }
  // then the first whitespace-delimited EI
  while (i < n - 1) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x49 && isWs(bytes[i - 1] ?? 0x20) &&
        (i + 2 >= n || isWs(bytes[i + 2]) || isDelim(bytes[i + 2]))) {
      return i + 2
    }
    i += 1
  }
  return n
}

function latin1(bytes, from, to) {
  let s = ''
  for (let i = from; i < to; i += 1) s += String.fromCharCode(bytes[i])
  return s
}

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"'])

/**
 * Walk the tokens and return one entry per text-showing operator, in stream
 * order: the byte range covering its operands + operator, the render mode
 * active at that moment, and how many string bytes it draws.
 */
export function findShowOps(bytes) {
  const tokens = tokenize(bytes)
  const ops = []

  let renderMode = 0
  const trStack = []
  let operandStart = -1
  let stringBytes = 0

  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t]

    if (tok.type !== 'op') {
      if (operandStart < 0) operandStart = tok.start
      if (tok.type === 'string') stringBytes += tok.len
      continue
    }

    const op = tok.value
    const start = operandStart < 0 ? tok.start : operandStart

    if (op === 'q') trStack.push(renderMode)
    else if (op === 'Q') { if (trStack.length) renderMode = trStack.pop() }
    else if (op === 'Tr') {
      const prev = tokens[t - 1]
      if (prev && prev.type === 'number') renderMode = prev.value
    } else if (SHOW_OPS.has(op)) {
      ops.push({
        op,
        start,
        end: tok.end,
        renderMode,
        stringBytes,
        index: ops.length,
      })
    }

    operandStart = -1
    stringBytes = 0
  }

  return ops
}

const enc = new TextEncoder()

/**
 * Rewrite the stream so the listed operators draw nothing while still
 * advancing the text cursor exactly as before (render mode 3 = invisible).
 * Edits are applied back-to-front so earlier byte offsets stay valid.
 */
export function hideShowOps(bytes, ops) {
  const sorted = [...ops].sort((a, b) => a.start - b.start)
  const chunks = []
  let cursor = 0
  for (const op of sorted) {
    if (op.start < cursor) continue // overlapping range, already handled
    chunks.push(bytes.subarray(cursor, op.start))
    chunks.push(enc.encode(' 3 Tr '))
    chunks.push(bytes.subarray(op.start, op.end))
    chunks.push(enc.encode(` ${op.renderMode} Tr `))
    cursor = op.end
  }
  chunks.push(bytes.subarray(cursor))

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}
