import { useState } from 'react'
import { Button, Icon } from './ui.jsx'

const POINTS = [
  { icon: 'text', title: 'Edit the text in place', body: 'Click any line and type. The font, the size and the colour it was set in stay as they were.' },
  { icon: 'image', title: 'Move and replace pictures', body: 'Drag an image, pull a corner to resize it, or swap it for another one.' },
  { icon: 'eye', title: 'Read words off a scan', body: 'A page that is only a picture, or a screenshot inside one, can be read and then edited like any other text.' },
]

/** The screen before a file is open: drop one here, or click to choose. */
export default function StartScreen({ onPick, onFile, busy }) {
  const [over, setOver] = useState(false)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-10">
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          onFile(e.dataTransfer.files?.[0])
        }}
        className={[
          'group w-full rounded-2xl border-2 border-dashed px-8 py-14 text-center',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60',
          over
            ? 'border-blue-500 bg-blue-50/80'
            : 'border-slate-300 bg-white/70 hover:border-slate-400 hover:bg-white',
          busy ? 'cursor-wait opacity-60' : 'cursor-pointer',
        ].join(' ')}
      >
        <span
          className={[
            'mx-auto grid h-14 w-14 place-items-center rounded-2xl transition-colors',
            over ? 'bg-blue-600 text-white' : 'bg-slate-900 text-white group-hover:bg-slate-800',
          ].join(' ')}
        >
          <Icon name="open" className="h-6 w-6" />
        </span>

        <span className="mt-5 block text-lg font-semibold tracking-tight text-slate-900">
          {busy ? 'Opening…' : 'Drop a PDF here, or click to choose one'}
        </span>
        <span className="mt-1.5 block text-sm text-slate-500">
          Any PDF on this computer — a CV, a report, a ticket, a scan.
        </span>

        <span className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[12px] font-medium text-slate-600">
          <Icon name="lock" className="h-3.5 w-3.5" />
          Nothing is uploaded — the file never leaves this browser
        </span>
      </button>

      <div className="mt-4 flex justify-center">
        <Button variant="primary" size="lg" icon="open" onClick={onPick} disabled={busy}>
          Choose a PDF
        </Button>
      </div>

      <div className="mt-12 grid w-full gap-4 sm:grid-cols-3">
        {POINTS.map((point) => (
          <div key={point.title} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-slate-700">
              <Icon name={point.icon} className="h-4 w-4" />
            </span>
            <p className="mt-3 text-[13px] font-semibold text-slate-900">{point.title}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{point.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
