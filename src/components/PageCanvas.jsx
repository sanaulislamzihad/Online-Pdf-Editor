import { useEffect, useRef, useState } from 'react'
import { startPageRender, sampleColors, runToScreenBox } from '../lib/extract.js'
import { coverRect } from '../lib/plateBuild.js'

export default function PageCanvas({
  pageData,
  zoom,
  edits,
  selectedId,
  plate,
  plateReady,
  onSelect,
  onEditRun,
  onColorsSampled,
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
          sampleColors(pageData.runs, canvas, vp, dpr)
          onColorsSampled?.(pageData.index)
        }
        setViewport(vp)
      },
      (err) => {
        if (err?.name !== 'RenderingCancelledException') console.error(err)
      },
    )
    return () => { cancelled = true; task.cancel() }
  }, [pageData, zoom])

  return (
    <div className="relative mx-auto bg-white shadow-lg ring-1 ring-black/10">
      <canvas ref={canvasRef} className="block" />
      {viewport && (
        <div className="absolute inset-0">
          {pageData.runs.map((run) => (
            <RunLayer
              key={run.id}
              run={run}
              pageIndex={pageData.index}
              viewport={viewport}
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
  run, pageIndex, viewport, edit, selected, plate, plateReady, onSelect, onEditRun,
}) {
  const ref = useRef(null)
  const coverRef = useRef(null)
  const box = runToScreenBox(run, viewport)
  const touched = !!edit
  const deleted = !!edit?.deleted
  const text = deleted ? '' : edit?.text ?? run.text
  const fontSize = edit?.fontSize ?? run.fontSize
  const color = edit?.color ?? run.color
  const bold = edit?.bold ?? run.bold
  const italic = edit?.italic ?? run.italic
  const dx = (edit?.dx ?? 0) * viewport.scale
  const dy = (edit?.dy ?? 0) * viewport.scale
  const fontPx = box.fontPx * (fontSize / run.fontSize)

  // paint the erase patch with the real page background behind the text
  useEffect(() => {
    if (!touched || !plate || !plateReady) return
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
            top: `${cssCover.top}px`,
            width: `${cssCover.width}px`,
            height: `${cssCover.height}px`,
            background: plateReady ? undefined : run.bg,
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
          'cursor-text whitespace-pre outline-none',
          selected
            ? 'ring-2 ring-blue-500'
            : 'hover:bg-blue-400/10 hover:ring-1 hover:ring-blue-400/70',
          deleted ? 'ring-1 ring-rose-400/70' : '',
        ].join(' ')}
        style={{
          position: 'absolute',
          left: `${box.left + dx}px`,
          top: `${box.top - dy}px`,
          transform: box.angleDeg ? `rotate(${box.angleDeg}deg)` : undefined,
          transformOrigin: 'left top',
          minWidth: `${Math.max(10, box.width)}px`,
          height: `${fontPx * 1.2}px`,
          lineHeight: `${fontPx}px`,
          fontSize: `${fontPx}px`,
          fontFamily: run.fontFamily,
          fontWeight: bold ? 700 : 400,
          fontStyle: italic ? 'italic' : 'normal',
          // an untouched run stays invisible so the original pixels show through
          color: touched ? color : 'transparent',
          caretColor: color,
        }}
      />
    </>
  )
}
