import { currentRect } from '../lib/images.js'
import { Button, Field } from './ui.jsx'
import { Pad, PanelHead } from './Inspector.jsx'

/** Controls for the selected image: move, resize, replace, remove. */
export default function ImagePanel({ image, edit, onEdit, onReplace, onReset, onRecognise, busy }) {
  const rect = currentRect(image, edit)
  const deleted = !!edit?.deleted
  const nudge = (ddx, ddy) => onEdit({ dx: (edit?.dx ?? 0) + ddx, dy: (edit?.dy ?? 0) + ddy })
  const scale = (factor) => onEdit({
    dw: (edit?.dw ?? 0) + image.rect.w * (factor - 1),
    dh: (edit?.dh ?? 0) + image.rect.h * (factor - 1),
  })
  const dim = deleted ? 'pointer-events-none opacity-40' : ''

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
      <PanelHead icon="image" label="Selected image" tone="violet" />

      <div className="space-y-5 p-4">
        <div>
          <p className="text-[13px] font-medium text-slate-900 tabular-nums">
            {Math.round(rect.w)} × {Math.round(rect.h)} pt
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400 tabular-nums">
            {image.pixelWidth} × {image.pixelHeight} px source
          </p>
          {edit?.replacement && (
            <p className="mt-1.5 truncate rounded-md bg-violet-50 px-2 py-1 text-[11px] text-violet-700" title={edit.replacement.name}>
              replaced with {edit.replacement.name}
            </p>
          )}
        </div>

        <Field label="Size" muted={image.rotated} hint={image.rotated ? 'rotated' : undefined}>
          <div className={`flex gap-1.5 ${image.rotated ? 'pointer-events-none opacity-40' : dim}`}>
            <Button className="flex-1" onClick={() => scale(0.9)}>Smaller</Button>
            <Button className="flex-1" onClick={() => scale(1.1)}>Bigger</Button>
          </div>
          {image.rotated && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              This image is rotated or skewed on the page, so it can be moved
              and replaced but not resized.
            </p>
          )}
        </Field>

        <Field label="Nudge" hint="2 pt">
          <div className={dim}>
            <Pad step={2} onMove={nudge} onReset={() => onEdit({ dx: 0, dy: 0 })} />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Or drag the image itself, and its corners to resize.
          </p>
        </Field>

        <Field label="Text inside">
          <Button
            icon="eye"
            onClick={onRecognise}
            disabled={busy || deleted}
            className="w-full"
          >
            {busy ? 'Reading…' : 'Read text in this image'}
          </Button>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            Words drawn inside a picture are pixels, not text. Reading them
            makes each line editable where it sits, in the face the picture
            is written in.
          </p>
        </Field>
      </div>

      <div className="mt-auto space-y-2 border-t border-slate-200 p-4">
        <Button variant="violet" icon="image" onClick={onReplace} disabled={deleted} className="w-full">
          Replace image…
        </Button>
        <Button
          variant={deleted ? 'outline' : 'danger'}
          icon={deleted ? 'undo' : 'trash'}
          onClick={() => onEdit({ deleted: !deleted })}
          className="w-full"
        >
          {deleted ? 'Restore this image' : 'Delete this image'}
        </Button>
        <Button icon="undo" onClick={onReset} className="w-full">Reset to original</Button>
      </div>
    </aside>
  )
}
