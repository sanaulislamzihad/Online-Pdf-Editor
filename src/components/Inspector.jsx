import ImagePanel from './ImagePanel.jsx'
import { fallbackNameFor } from '../lib/fonts.js'

const SWATCHES = ['#000000', '#374151', '#6b7280', '#b91c1c', '#c2410c', '#15803d', '#1d4ed8', '#7e22ce', '#ffffff']

export default function Inspector({
  run, edit, image, imageEdit, busy, customFonts, onEdit, onEditImage, onReplaceImage,
  onResetImage, onReset, onRecogniseRun, onRecogniseImage, onAddFont,
}) {
  if (image) {
    return (
      <ImagePanel
        image={image}
        edit={imageEdit}
        onEdit={onEditImage}
        onReplace={onReplaceImage}
        onReset={onResetImage}
        onRecognise={onRecogniseImage}
        busy={busy}
      />
    )
  }
  if (!run) {
    return (
      <aside className="w-64 shrink-0 border-l border-slate-200 bg-white p-4 text-sm text-slate-500">
        <p className="font-medium text-slate-700">Nothing selected</p>
        <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed">
          <li>• Click a line of text to edit it.</li>
          <li>• Type to replace, <kbd className="rounded bg-slate-100 px-1">Del</kbd> to remove.</li>
          <li>• Size, colour and style are on this panel.</li>
          <li>• Click an image to move, resize or replace it.</li>
          <li>• <kbd className="rounded bg-slate-100 px-1">Ctrl</kbd>+<kbd className="rounded bg-slate-100 px-1">Z</kbd> undoes.</li>
        </ul>
      </aside>
    )
  }

  const size = edit?.fontSize ?? run.fontSize
  const color = edit?.color ?? run.color
  const bold = edit?.bold ?? run.bold
  const italic = edit?.italic ?? run.italic
  const deleted = !!edit?.deleted
  // Characters the PDF does not describe properly still write back exactly,
  // through the font they came from - but only while the line keeps that
  // font, so changing weight or slant would drop them.
  const fragile = !!run.scrambled
  const standIn = fallbackNameFor(run, bold, italic, customFonts)

  const nudge = (ddx, ddy) => onEdit({ dx: (edit?.dx ?? 0) + ddx, dy: (edit?.dy ?? 0) + ddy })

  return (
    <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l border-slate-200 bg-white p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Selected text</p>
        <p className="mt-1 truncate text-sm font-medium" title={run.text}>{run.text}</p>
        <p className="mt-0.5 truncate text-[11px] text-slate-400" title={run.fontRawName}>{run.fontRawName}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          New letters this font has no glyph for are set in{' '}
          <span className="font-medium text-slate-600">{standIn}</span>.
        </p>
        <button
          onClick={onAddFont}
          className="mt-1.5 w-full rounded border border-slate-300 px-2 py-1 text-[12px] hover:bg-slate-50"
        >
          Use my own font file…
        </button>
      </div>

      {fragile && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12px] leading-relaxed text-amber-900">
          <p className="font-semibold">Some characters here are not spelled out</p>
          <p className="mt-1">
            The PDF does not say what a few of these glyphs are, so the text above
            reads wrongly. Editing is still safe — whatever you do not touch is put
            back exactly as it is now. To read and rewrite the whole line properly,
            have it read off the page instead.
          </p>
          <button
            onClick={onRecogniseRun}
            disabled={busy}
            className="mt-2 w-full rounded border border-amber-400 bg-white px-2 py-1.5 font-medium hover:bg-amber-100 disabled:opacity-50"
          >
            {busy ? 'Reading…' : 'Read this line from the page'}
          </button>
        </div>
      )}

      <Field label="Font size">
        <div className="flex items-center gap-1">
          <button onClick={() => onEdit({ fontSize: Math.max(2, +(size - 0.5).toFixed(1)) })} className="h-8 w-8 rounded border border-slate-300 hover:bg-slate-50">−</button>
          <input
            type="number"
            step="0.5"
            value={+size.toFixed(1)}
            onChange={(e) => onEdit({ fontSize: Math.max(2, parseFloat(e.target.value) || 2) })}
            className="h-8 w-full rounded border border-slate-300 px-2 text-sm tabular-nums"
          />
          <button onClick={() => onEdit({ fontSize: +(size + 0.5).toFixed(1) })} className="h-8 w-8 rounded border border-slate-300 hover:bg-slate-50">+</button>
        </div>
      </Field>

      <Field label="Style" disabled={fragile}>
        <div className={`flex gap-1.5 ${fragile ? 'pointer-events-none opacity-40' : ''}`}>
          <Toggle active={bold} onClick={() => onEdit({ bold: !bold })}><b>B</b></Toggle>
          <Toggle active={italic} onClick={() => onEdit({ italic: !italic })}><i>I</i></Toggle>
        </div>
      </Field>

      <Field label="Colour">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) => onEdit({ color: e.target.value })}
            className="h-8 w-10 cursor-pointer rounded border border-slate-300 bg-white p-0.5"
          />
          <span className="text-xs uppercase tabular-nums text-slate-500">{color}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SWATCHES.map((c) => (
            <button
              key={c}
              onClick={() => onEdit({ color: c })}
              style={{ background: c }}
              className="h-5 w-5 rounded border border-slate-300"
              title={c}
            />
          ))}
        </div>
      </Field>

      <Field label="Position">
        <div className="grid w-[104px] grid-cols-3 gap-1">
          <span />
          <button onClick={() => nudge(0, 1)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">↑</button>
          <span />
          <button onClick={() => nudge(-1, 0)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">←</button>
          <button onClick={() => onEdit({ dx: 0, dy: 0 })} className="h-8 rounded border border-slate-300 text-xs hover:bg-slate-50">0</button>
          <button onClick={() => nudge(1, 0)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">→</button>
          <span />
          <button onClick={() => nudge(0, -1)} className="h-8 rounded border border-slate-300 hover:bg-slate-50">↓</button>
          <span />
        </div>
      </Field>

      <div className="space-y-2 border-t border-slate-200 pt-3">
        <button
          onClick={() => onEdit({ deleted: !deleted })}
          className={`w-full rounded-md px-3 py-2 text-sm font-medium ${deleted ? 'bg-slate-200 text-slate-700 hover:bg-slate-300' : 'bg-rose-600 text-white hover:bg-rose-500'}`}
        >
          {deleted ? 'Restore text' : 'Delete text'}
        </button>
        <button onClick={onReset} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
          Reset to original
        </button>
      </div>
    </aside>
  )
}

function Field({ label, children, disabled }) {
  return (
    <div>
      <p className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${disabled ? 'text-slate-300' : 'text-slate-400'}`}>{label}</p>
      {children}
    </div>
  )
}

function Toggle({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`h-8 w-10 rounded border text-sm ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 hover:bg-slate-50'}`}
    >
      {children}
    </button>
  )
}
