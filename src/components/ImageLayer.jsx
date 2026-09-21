import { useEffect, useRef, useState } from 'react'
import { currentRect, imageChanged } from '../lib/images.js'

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

/**
 * Lift the image off the page as a cutout with its transparency intact.
 *
 * The rendered page has the image already composited onto whatever is
 * behind it, so cropping it would drag that background along and paint an
 * opaque rectangle wherever the image is moved to. Comparing the crop
 * against the same slice of the page rendered *without* its images leaves
 * only the pixels the image itself contributed.
 */
function liftImage(pageCanvas, plate, entry, image, origin, viewport) {
  const scale = pageCanvas.width / viewport.width
  const w = Math.max(1, Math.round(origin.width * scale))
  const h = Math.max(1, Math.round(origin.height * scale))

  const lifted = document.createElement('canvas')
  lifted.width = w
  lifted.height = h
  const ctx = lifted.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(
    pageCanvas,
    origin.left * scale, origin.top * scale,
    Math.max(1, origin.width * scale), Math.max(1, origin.height * scale),
    0, 0, w, h,
  )

  const behind = document.createElement('canvas')
  behind.width = w
  behind.height = h
  if (!plate.drawSlice(entry, image.rect, behind)) return lifted

  try {
    const front = ctx.getImageData(0, 0, w, h)
    const back = behind.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h)
    for (let i = 0; i < front.data.length; i += 4) {
      const diff = Math.abs(front.data[i] - back.data[i]) +
        Math.abs(front.data[i + 1] - back.data[i + 1]) +
        Math.abs(front.data[i + 2] - back.data[i + 2])
      if (diff < 14) front.data[i + 3] = 0
    }
    ctx.putImageData(front, 0, 0)
  } catch {
    /* tainted canvas: fall back to the plain crop */
  }
  return lifted
}
const HANDLES = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
]

/**
 * One image on the page: a hit target while untouched, and once it has been
 * moved, resized or replaced, the patch that hides where it used to be plus a
 * preview of where it is now.
 */
export default function ImageLayer({
  image, viewport, edit, selected, plate, plateReady, pageCanvasRef,
  onSelect, onEdit,
}) {
  const patchRef = useRef(null)
  const previewRef = useRef(null)
  const dragRef = useRef(null)
  const changed = imageChanged(edit)
  const rect = currentRect(image, edit)
  const box = screenRect(rect, viewport)
  const origin = screenRect(image.rect, viewport)

  // restore what the page looks like without this image, where it used to be
  useEffect(() => {
    if (!changed || !plate || !plateReady || !patchRef.current) return
    let cancelled = false
    plate.getPage(image.pageIndex).then((entry) => {
      if (cancelled || !entry || !patchRef.current) return
      plate.paintInto(entry, image.rect, patchRef.current, origin.width, origin.height)
    })
    return () => { cancelled = true }
  }, [changed, plate, plateReady, image, viewport])

  // the cutout is expensive, so it is made once and then just re-drawn
  const [cutout, setCutout] = useState(null)
  useEffect(() => {
    if (!changed || edit?.replacement || cutout) return
    const pageCanvas = pageCanvasRef.current
    if (!pageCanvas || !plate || !plateReady) return
    let cancelled = false
    plate.getPage(image.pageIndex).then((entry) => {
      if (cancelled || !entry) return
      setCutout(liftImage(pageCanvas, plate, entry, image, origin, viewport))
    })
    return () => { cancelled = true }
  }, [changed, edit?.replacement, cutout, plate, plateReady, image])

  // preview: the replacement file, or the image lifted off the page
  useEffect(() => {
    const canvas = previewRef.current
    if (!changed || edit?.deleted || !canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(box.width * dpr))
    canvas.height = Math.max(1, Math.round(box.height * dpr))
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'

    if (edit?.replacement?.url) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      img.src = edit.replacement.url
      return
    }
    if (cutout) ctx.drawImage(cutout, 0, 0, canvas.width, canvas.height)
  }, [changed, edit, cutout, box.width, box.height])
  function startDrag(event, handle) {
    event.preventDefault()
    event.stopPropagation()
    onSelect(image.id)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      base: { dx: edit?.dx || 0, dy: edit?.dy || 0, dw: edit?.dw || 0, dh: edit?.dh || 0 },
    }
  }

  function onMove(event) {
    const drag = dragRef.current
    if (!drag) return
    const scale = viewport.scale || 1
    const dx = (event.clientX - drag.startX) / scale
    const dy = -(event.clientY - drag.startY) / scale // PDF space grows upward
    const { base, handle } = drag

    if (!handle) {
      onEdit(image.id, { dx: base.dx + dx, dy: base.dy + dy })
      return
    }
    // corner drags keep the opposite corner pinned
    const right = handle.x === 1
    const top = handle.y === 0
    const dw = right ? dx : -dx
    const dh = top ? dy : -dy
    onEdit(image.id, {
      dw: base.dw + dw,
      dh: base.dh + dh,
      dx: right ? base.dx : base.dx + dx,
      dy: top ? base.dy : base.dy + dy,
    })
  }

  const endDrag = () => { dragRef.current = null }

  return (
    <>
      {changed && (
        <canvas
          ref={patchRef}
          style={{
            position: 'absolute',
            left: `${origin.left}px`,
            top: `${origin.top}px`,
            width: `${origin.width}px`,
            height: `${origin.height}px`,
            background: plateReady ? undefined : '#ffffff',
            pointerEvents: 'none',
          }}
        />
      )}

      {changed && !edit?.deleted && (
        <canvas
          ref={previewRef}
          style={{
            position: 'absolute',
            left: `${box.left}px`,
            top: `${box.top}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
            pointerEvents: 'none',
          }}
        />
      )}

      <div
        data-image-id={image.id}
        onPointerDown={(e) => startDrag(e, null)}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={[
          'absolute',
          selected ? 'cursor-move ring-2 ring-violet-500' : 'hover:ring-2 hover:ring-violet-400/70',
          edit?.deleted ? 'ring-2 ring-dashed ring-rose-400' : '',
        ].join(' ')}
        style={{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
        }}
      >
        {selected && !image.rotated && !edit?.deleted && HANDLES.map((handle) => (
          <div
            key={handle.id}
            onPointerDown={(e) => startDrag(e, handle)}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{
              position: 'absolute',
              left: `${handle.x * 100}%`,
              top: `${handle.y * 100}%`,
              width: 11,
              height: 11,
              marginLeft: -6,
              marginTop: -6,
              cursor: handle.cursor,
              background: '#fff',
              border: '2px solid rgb(139 92 246)',
              borderRadius: 2,
            }}
          />
        ))}
      </div>
    </>
  )
}
