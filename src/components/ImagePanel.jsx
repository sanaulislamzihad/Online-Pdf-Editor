import { currentRect } from '../lib/images.js'

/** Controls for the selected image: move, resize, replace, remove. */
export default function ImagePanel({ image, edit, onEdit, onReplace, onReset }) {
  const rect = currentRect(image, edit)
  const deleted = !!edit?.deleted
  const nudge = (ddx, ddy) => onEdit({ dx: (edit?.dx ?? 0) + ddx, dy: (edit?.dy ?? 0) + ddy })
  const scale = (factor) => onEdit({
    dw: (edit?.dw ?? 0) + image.rect.w * (factor - 1),
    dh: (edit?.dh ?? 0) + image.rect.h * (factor - 1),
  })
  const dim = deleted ? 'pointer-events-none opacity-40' : ''

  return (
    <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l border-slate-200 bg-white p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-500">Selected image</p>
        <p className="mt-1 text-sm font-medium">{Math.round(rect.w)} × {Math.round(rect.h)} pt</p>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {image.pixelWidth} × {image.pixelHeight} px source
        </p>
        {edit?.replacement && (
          <p className="mt-1 truncate text-[11px] text-violet-600" title={edit.replacement.name}>
            replaced with {edit.replacement.name}
          </p>
        )}
      </div>

      <Group label="Size">
        <div className={`flex gap-1.5 ${image.rotated ? 'pointer-events-none opacity-40' : dim}`}>
          <button onClick={() => scale(0.9)} className="h-8 flex-1 rounded border border-slate-300 text-sm hover:bg-slate-50">Smaller</button>
          <button onClick={() => scale(1.1)} className="h-8 flex-1 rounded border border-slate-300 text-sm hover:bg-slate-50">Bigger</button>
        </div>
        {image.rotated && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            This image is rotated or skewed on the page, so it can be moved and
            replaced but not resized.
          </p>
        )}
      </Group>

      <Group label="Position">
        <div className={`grid w-[104px] grid-cols-3 gap-1 ${dim}`}>
          <span />
          <button onClick={() => nudge(0, 2)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">↑</button>
          <span />
          <button onClick={() => nudge(-2, 0)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">←</button>
          <button onClick={() => onEdit({ dx: 0, dy: 0 })} className="h-8 rounded border border-slate-300 text-xs hover:bg-slate-50">0</button>
          <button onClick={() => nudge(2, 0)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">→</button>
          <span />
          <button onClick={() => nudge(0, -2)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">↓</button>
          <span />
        </div>
        <p className="mt-1.5 text-[11px] text-slate-400">Or drag the image, and its corners to resize.</p>
      </Group>

      <div className="space-y-2 border-t border-slate-200 pt-3">
        <button
          onClick={onReplace}
          disabled={deleted}
          className="w-full rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          Replace image…
        </button>
        <button
          onClick={() => onEdit({ deleted: !deleted })}
          className={`w-full rounded-md px-3 py-2 text-sm font-medium ${deleted ? 'bg-slate-200 text-slate-700 hover:bg-slate-300' : 'bg-rose-600 text-white hover:bg-rose-500'}`}
        >
          {deleted ? 'Restore image' : 'Delete image'}
        </button>
        <button onClick={onReset} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
          Reset to original
        </button>
      </div>
    </aside>
  )
}

function Group({ label, children }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      {children}
    </div>
  )
}
