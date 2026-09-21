import { useEffect, useRef, useState } from 'react'
import { renderPageToCanvas, sampleColors, runToScreenBox } from '../lib/extract'

export default function PageCanvas({
  pageData,
  zoom,
  edits,
  selectedId,
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
    if (!canvas) return
    ;(async () => {
      const { viewport: vp, dpr } = await renderPageToCanvas(pageData.page, canvas, zoom)
      if (cancelled) return
      if (!sampledRef.current) {
        sampledRef.current = true
        sampleColors(pageData.runs, canvas, vp, dpr)
        onColorsSampled?.(pageData.index)
      }
      setViewport(vp)
    })()
    return () => { cancelled = true }
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
              viewport={viewport}
              edit={edits[run.id]}
              selected={selectedId === run.id}
              onSelect={onSelect}
              onEditRun={onEditRun}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RunLayer({ run, viewport, edit, selected, onSelect, onEditRun }) {
  const ref = useRef(null)
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

  const common = {
    position: 'absolute',
    left: `${box.left + dx}px`,
    transform: box.angleDeg ? `rotate(${box.angleDeg}deg)` : undefined,
    transformOrigin: 'left bottom',
  }
  const coverWidth = Math.max(box.width, box.width * (fontSize / run.fontSize)) + fontPx * 0.3

  return (
    <>
      {touched && (
        <div
          style={{
            ...common,
            top: `${box.coverTop}px`,
            width: `${coverWidth}px`,
            height: `${box.coverHeight}px`,
            background: run.bg,
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
            : 'hover:ring-1 hover:ring-blue-400/70 hover:bg-blue-400/5',
          deleted ? 'ring-1 ring-dashed ring-rose-400/70' : '',
        ].join(' ')}
        style={{
          ...common,
          top: `${box.top - dy}px`,
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
