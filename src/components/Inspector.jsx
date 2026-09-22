import ImagePanel from './ImagePanel.jsx'
import { fallbackNameFor } from '../lib/fonts.js'
import { Button, Field, Icon } from './ui.jsx'

const SWATCHES = ['#000000', '#374151', '#6b7280', '#b91c1c', '#c2410c', '#15803d', '#1d4ed8', '#7e22ce', '#ffffff']

const SHELL = 'flex w-72 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white'

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
      <aside className={SHELL}>
        <PanelHead icon="text" label="Nothing selected" tone="slate" />
        <div className="space-y-3 p-4">
          {[
            ['Click a line of text', 'It becomes editable where it sits.'],
            ['Type to replace it', 'Del removes the line, Esc deselects.'],
            ['Click an image', 'Drag to move, pull a corner to resize.'],
            ['Ctrl + Z', 'Undoes the last change.'],
          ].map(([title, body]) => (
            <div key={title} className="rounded-lg bg-slate-50 px-3 py-2.5">
              <p className="text-[12.5px] font-semibold text-slate-700">{title}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">{body}</p>
            </div>
          ))}
        </div>
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
    <aside className={SHELL}>
      <PanelHead icon="text" label="Selected text" tone="blue" />

      <div className="space-y-5 p-4">
        <div>
          <p className="line-clamp-2 text-[13px] font-medium leading-snug text-slate-900" title={run.text}>
            {run.text || <span className="text-slate-400">(empty)</span>}
          </p>
          <p className="mt-1 truncate text-[11px] text-slate-400" title={run.fontRawName}>
            {run.fontRawName} · {size.toFixed(1)} pt
          </p>
        </div>

        {fragile && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-900">
              <Icon name="alert" className="h-4 w-4" />
              Some characters are not spelled out
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-amber-800">
              The PDF does not say what a few of these glyphs are, so the text
              above reads wrongly. Editing is still safe — whatever you do not
              touch is put back exactly. To rewrite the whole line properly,
              have it read off the page instead.
            </p>
            <Button
              size="sm"
              icon="eye"
              onClick={onRecogniseRun}
              disabled={busy}
              className="mt-2.5 w-full border-amber-300 text-amber-900 hover:bg-amber-100"
            >
              {busy ? 'Reading…' : 'Read this line from the page'}
            </Button>
          </div>
        )}

        <Field label="Font size">
          <div className="flex items-center gap-1.5">
            <Step icon="minus" onClick={() => onEdit({ fontSize: Math.max(2, +(size - 0.5).toFixed(1)) })} />
            <input
              type="number"
              step="0.5"
              value={+size.toFixed(1)}
              onChange={(e) => onEdit({ fontSize: Math.max(2, parseFloat(e.target.value) || 2) })}
              className="h-9 w-full rounded-lg border border-slate-300 px-2.5 text-[13px] tabular-nums shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
            <Step icon="plus" onClick={() => onEdit({ fontSize: +(size + 0.5).toFixed(1) })} />
          </div>
        </Field>

        <Field label="Style" muted={fragile} hint={fragile ? 'not for this line' : undefined}>
          <div className={`flex gap-1.5 ${fragile ? 'pointer-events-none opacity-40' : ''}`}>
            <Toggle active={bold} onClick={() => onEdit({ bold: !bold })}><b>B</b></Toggle>
            <Toggle active={italic} onClick={() => onEdit({ italic: !italic })}><i>I</i></Toggle>
          </div>
        </Field>

        <Field label="Colour" hint={color.toUpperCase()}>
          <input
            type="color"
            value={color}
            onChange={(e) => onEdit({ color: e.target.value })}
            className="h-9 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 shadow-sm"
          />
          <div className="mt-2 grid grid-cols-9 gap-1.5">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onEdit({ color: c })}
                style={{ background: c }}
                title={c}
                className={`h-5 w-full rounded ring-1 ring-inset ring-black/15 transition-transform hover:scale-110 ${
                  c.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-blue-500' : ''
                }`}
              />
            ))}
          </div>
        </Field>

        <Field label="Nudge" hint="1 pt">
          <Pad onMove={nudge} onReset={() => onEdit({ dx: 0, dy: 0 })} />
        </Field>
      </div>

      <div className="mt-auto space-y-2 border-t border-slate-200 p-4">
        <Button
          variant={deleted ? 'outline' : 'danger'}
          icon={deleted ? 'undo' : 'trash'}
          onClick={() => onEdit({ deleted: !deleted })}
          className="w-full"
        >
          {deleted ? 'Restore this text' : 'Delete this text'}
        </Button>
        <Button icon="undo" onClick={onReset} className="w-full">Reset to original</Button>
        <Button size="sm" onClick={onAddFont} variant="ghost" className="w-full">
          Use my own font file…
        </Button>
        <p className="text-[11px] leading-relaxed text-slate-400">
          A letter this font has no glyph for is set in{' '}
          <span className="font-medium text-slate-600">{standIn}</span>.
        </p>
      </div>
    </aside>
  )
}

export function PanelHead({ icon, label, tone }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700',
    violet: 'bg-violet-50 text-violet-700',
    slate: 'bg-slate-100 text-slate-500',
  }
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
      <span className={`grid h-7 w-7 place-items-center rounded-lg ${tones[tone]}`}>
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-500">{label}</p>
    </div>
  )
}

export function Step({ icon, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-300 bg-white text-slate-600 shadow-sm hover:border-slate-400 hover:bg-slate-50"
    >
      <Icon name={icon} />
    </button>
  )
}

/** The four arrows and a centre that puts everything back. */
export function Pad({ onMove, onReset, step = 1 }) {
  const cell = 'grid h-8 place-items-center rounded-md border border-slate-300 bg-white text-slate-600 shadow-sm hover:border-slate-400 hover:bg-slate-50'
  return (
    <div className="grid w-[116px] grid-cols-3 gap-1.5">
      <span />
      <button type="button" className={cell} onClick={() => onMove(0, step)}>↑</button>
      <span />
      <button type="button" className={cell} onClick={() => onMove(-step, 0)}>←</button>
      <button type="button" className={`${cell} text-[11px] font-medium`} onClick={onReset}>0</button>
      <button type="button" className={cell} onClick={() => onMove(step, 0)}>→</button>
      <span />
      <button type="button" className={cell} onClick={() => onMove(0, -step)}>↓</button>
      <span />
    </div>
  )
}

function Toggle({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 w-11 rounded-lg border text-[13px] shadow-sm transition-colors ${
        active
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  )
}
