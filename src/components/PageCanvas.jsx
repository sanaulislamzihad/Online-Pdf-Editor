import { useEffect, useRef, useState } from 'react'
import { startPageRender, sampleColors, runToScreenBox, finishRuns } from '../lib/extract.js'
import { coverRect } from '../lib/plateBuild.js'
import { hasChanges } from '../lib/edits.js'
import { shiftAt, totalGrowth } from '../lib/reflow.js'
import ImageLayer from './ImageLayer.jsx'

export default function PageCanvas({
  pageData,
  zoom,
  edits,
  growths,
  selectedId,
  plate,
  plateReady,
  images,
  imageEdits,
  scanned,
  ocrBusy,
  onRunOcr,
  selectedImageId,
  imagePlate,
  imagePlateReady,
  onSelect,
  onSelectImage,
  onEditRun,
  onEditImage,
  onRunsReady,
}) {
  const canvasRef = useRef(null)
  const [viewport, setViewport] = useState(null)
  const sampledRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const { task, viewport: vp, dpr } = startPageRender(pageData.page, canvas, zoom)
    task.promise.then(
      () => {
        if (cancelled) return
        if (!sampledRef.current) {
          sampledRef.current = true
          const sampled = sampleColors(pageData.page, pageData.runs, canvas, vp, dpr)
          const done = finishRuns(pageData.page, sampled)
          onRunsReady?.(pageData.index, done)
        }
        setViewport(vp)
      },
      (err) => {
        if (err?.name !== 'RenderingCancelledException') console.error(err)
      },
    )
    return () => { cancelled = true; task.cancel() }
  }, [pageData, zoom])

  const grown = viewport ? totalGrowth(growths) * viewport.scale : 0

  return (
    <div
      className="relative mx-auto bg-white shadow-lg ring-1 ring-black/10"
      style={grown ? { paddingBottom: `${grown}px` } : undefined}
    >
      <canvas ref={canvasRef} className="block" />

      {viewport && growths.length > 0 && (
        <ShiftLayer growths={growths} viewport={viewport} canvasRef={canvasRef} />
      )}

      {scanned && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-amber-100/95 px-3 py-2 text-[13px] text-amber-900 shadow">
          <span className="flex-1">
            This page is a picture of text, so there is nothing to select. Read it
            first and the lines become editable.
          </span>
          <button
            onClick={() => onRunOcr(pageData.index)}
            disabled={ocrBusy}
            className="shrink-0 rounded bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {ocrBusy ? 'Reading…' : 'Read this page'}
          </button>
        </div>
      )}
      {viewport && (
        <div className="absolute inset-0">
          {/* images sit under the text layer, as they do on the page */}
          {images.map((image) => (
            <ImageLayer
              key={image.id}
              image={image}
              viewport={viewport}
              shift={shiftAt(growths, image.rect.y + image.rect.h) * viewport.scale}
              edit={imageEdits[image.id]}
              selected={selectedImageId === image.id}
              plate={imagePlate}
              plateReady={imagePlateReady}
              pageCanvasRef={canvasRef}
              onSelect={onSelectImage}
              onEdit={onEditImage}
            />
          ))}
          {pageData.runs.map((run) => (
            <RunLayer
              key={run.id}
              run={run}
              pageIndex={pageData.index}
              viewport={viewport}
              shift={shiftAt(growths, run.y) * viewport.scale}
              edit={edits[run.id]}
              selected={selectedId === run.id}
              plate={plate}
              plateReady={plateReady}
              onSelect={onSelect}
              onEditRun={onEditRun}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Show the page opened up where an edit has outgrown the lines it had.
 *
 * The exported file moves everything below such an edit down, so the page on
 * screen has to move with it - otherwise the page being edited is not the
 * page that comes out. The rendered page is its own source: each band below a
 * growth point is copied out of it and painted lower, and the strip left
 * behind is filled with the paper that was there.
 */
function ShiftLayer({ growths, viewport, canvasRef }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    const source = canvasRef.current
    if (!canvas || !source || !growths.length) return

    const { scale, width, height } = viewport
    const dpr = source.width / width || 1
    const cuts = [...growths].sort((a, b) => b.y0 - a.y0)
    const cutAt = cuts.map((growth) => viewport.convertToViewportPoint(0, growth.y0)[1])
    const top = cutAt[0]
    const tall = height - top + totalGrowth(growths) * scale

    canvas.style.top = `${top}px`
    canvas.style.width = `${width}px`
    canvas.style.height = `${tall}px`
    canvas.width = Math.ceil(width * dpr)
    canvas.height = Math.ceil(tall * dpr)

    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = paperAbove(source, dpr, top)
    ctx.fillRect(0, 0, width, tall)

    let moved = 0
    for (let i = 0; i < cuts.length; i += 1) {
      moved += cuts[i].amount * scale
      const from = cutAt[i]
      const to = i + 1 < cuts.length ? cutAt[i + 1] : height
      if (to - from < 0.5) continue
      ctx.drawImage(
        source,
        0, from * dpr, source.width, (to - from) * dpr,
        0, from - top + moved, width, to - from,
      )
    }
  }, [growths, viewport, canvasRef])

  return (
    <canvas
      ref={ref}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
    />
  )
}

/** The colour of the page just above a cut, to fill the strip opened below it. */
function paperAbove(source, dpr, top) {
  try {
    const ctx = source.getContext('2d', { willReadFrequently: true })
    const y = Math.min(source.height - 1, Math.max(0, Math.round(top * dpr) - 2))
    const [r, g, b] = ctx.getImageData(2, y, 1, 1).data
    return `rgb(${r}, ${g}, ${b})`
  } catch {
    return '#ffffff'
  }
}

/**
 * How much narrower or wider the browser draws this run than the page does.
 *
 * The document's own typeface is asked for first, but it is often not
 * installed, and a stand-in at the same em size is a different width and
 * weight - which is why an edited line used to jump larger the moment it
 * became visible. Measuring the original text in whatever font the browser
 * actually picked gives the correction that puts it back.
 */
const fitCache = new Map()
let measuringContext = null

function fitToRun(run, viewport) {
  if (fitCache.has(run.id)) return fitCache.get(run.id)
  const fit = { scaleX: 1, wordSpacing: 0 }
  // a paragraph sets its own lines; there is no single width to match here
  if (run.paragraph) { fitCache.set(run.id, fit); return fit }
  const target = Math.abs(run.width) * viewport.scale

  if (target > 1 && run.text.trim()) {
    if (!measuringContext) {
      measuringContext = document.createElement('canvas').getContext('2d')
    }
    const size = run.fontSize * viewport.scale
    const style = run.italic ? 'italic ' : ''
    const weight = run.bold ? '700 ' : '400 '
    measuringContext.font = `${style}${weight}${size}px ${run.fontFamily}`
    const measured = measuringContext.measureText(run.text).width

    if (measured > 1) {
      const spaces = [...run.text].filter((ch) => ch === ' ').length
      const perSpace = spaces ? (target - measured) / spaces : 0
      // A justified line carries its extra width in the gaps between words,
      // and so should the correction: squeezing or stretching the glyphs
      // instead is what makes a substituted face look like a different one.
      if (spaces && Math.abs(perSpace) < size * 0.4) fit.wordSpacing = perSpace
      else fit.scaleX = Math.min(2, Math.max(0.5, target / measured))
    }
  }

  fitCache.set(run.id, fit)
  return fit
}
/** Map a PDF-space rectangle to a CSS box in the rendered page. */
function screenRect(rect, viewport) {
  const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y + rect.h)
  const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y)
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

function RunLayer({
  run, pageIndex, viewport, edit, selected, plate, plateReady, shift, onSelect, onEditRun,
}) {
  const ref = useRef(null)
  const coverRef = useRef(null)
  const box = runToScreenBox(run, viewport)
  // selecting a run must not disturb the page: the original pixels stay
  // until an actual change is made
  const touched = hasChanges(edit, run)
  const deleted = !!edit?.deleted
  const text = deleted ? '' : edit?.text ?? run.text
  const fontSize = edit?.fontSize ?? run.fontSize
  const color = edit?.color ?? run.color
  const bold = edit?.bold ?? run.bold
  const italic = edit?.italic ?? run.italic
  const dx = (edit?.dx ?? 0) * viewport.scale
  const dy = (edit?.dy ?? 0) * viewport.scale
  const fontPx = box.fontPx * (fontSize / run.fontSize)
  const fit = fitToRun(run, viewport)

  // paint the erase patch with the real page background behind the text
  useEffect(() => {
    if (!touched || run.source === 'ocr' || !plate || !plateReady) return
    let cancelled = false
    const rect = coverRect(run)
    const cssBox = screenRect(rect, viewport)
    plate.getPage(pageIndex).then((entry) => {
      if (cancelled || !entry || !coverRef.current) return
      plate.paintInto(entry, rect, coverRef.current, cssBox.width, cssBox.height)
    })
    return () => { cancelled = true }
  }, [touched, plate, plateReady, run, viewport, pageIndex])

  // the element owns its own text (contentEditable); only push updates in
  // when the user is not typing into it, otherwise the caret jumps
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const desired = touched ? text : run.text
    if (el.textContent !== desired && document.activeElement !== el) {
      el.textContent = desired
    }
  }, [text, touched, run.text])

  useEffect(() => {
    if (selected && ref.current && document.activeElement !== ref.current) {
      ref.current.focus()
    }
  }, [selected])

  const cssCover = screenRect(coverRect(run), viewport)

  return (
    <>
      {touched && (
        <canvas
          ref={coverRef}
          style={{
            position: 'absolute',
            left: `${cssCover.left}px`,
            top: `${cssCover.top + shift}px`,
            width: `${cssCover.width}px`,
            height: `${cssCover.height}px`,
            background: plateReady && run.source !== 'ocr' ? undefined : run.bg,
            pointerEvents: 'none',
          }}
        />
      )}

      <div
        ref={ref}
        contentEditable={selected && !deleted}
        suppressContentEditableWarning
        spellCheck={false}
        onMouseDown={(e) => { e.stopPropagation(); onSelect(run.id) }}
        onInput={(e) => onEditRun(run.id, { text: e.currentTarget.textContent })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault()
          if (e.key === 'Escape') { e.currentTarget.blur(); onSelect(null) }
        }}
        className={[
          'cursor-text outline-none',
          run.paragraph || run.wrap ? 'whitespace-pre-wrap' : 'whitespace-pre',
          selected
            ? run.scrambled ? 'ring-2 ring-amber-500' : 'ring-2 ring-blue-500'
            : run.scrambled
              ? 'hover:bg-amber-400/10 hover:ring-1 hover:ring-amber-400/80'
              : 'hover:bg-blue-400/10 hover:ring-1 hover:ring-blue-400/70',
          deleted ? 'ring-1 ring-rose-400/70' : '',
        ].join(' ')}
        style={{
          position: 'absolute',
          left: `${box.left + dx}px`,
          top: `${box.top - dy + shift}px`,
          transform: [
            box.angleDeg ? `rotate(${box.angleDeg}deg)` : '',
            Math.abs(fit.scaleX - 1) > 0.02 ? `scaleX(${fit.scaleX.toFixed(4)})` : '',
          ].filter(Boolean).join(' ') || undefined,
          transformOrigin: 'left top',
          minWidth: `${Math.max(10, box.width)}px`,
          width: run.paragraph ? `${box.width}px` : undefined,
          // a line that outgrows the text area wraps rather than running off
          // the page; the margin is the furthest right the document itself goes
          maxWidth: !run.paragraph && run.wrap
            ? `${Math.max(box.width, (run.wrap.right - run.x) * viewport.scale)}px`
            : undefined,
          textIndent: run.paragraph ? `${box.indent}px` : undefined,
          textAlign: run.paragraph?.justified ? 'justify' : undefined,
          height: run.paragraph ? `${box.coverHeight}px` : undefined,
          minHeight: run.paragraph ? undefined : `${fontPx * 1.2}px`,
          lineHeight: run.paragraph
            ? `${box.lineHeight}px`
            : `${run.wrap ? run.wrap.leading * viewport.scale : fontPx}px`,
          fontSize: `${fontPx}px`,
          fontFamily: run.fontFamily,
          fontWeight: bold ? 700 : 400,
          fontStyle: italic ? 'italic' : 'normal',
          wordSpacing: fit.wordSpacing ? `${fit.wordSpacing.toFixed(2)}px` : undefined,
          // an untouched run stays invisible so the original pixels show through
          color: touched ? color : 'transparent',
          caretColor: color,
        }}
      />
    </>
  )
}
