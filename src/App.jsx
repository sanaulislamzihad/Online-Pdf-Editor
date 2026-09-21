import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadPdf, extractRuns } from './lib/extract.js'
import { exportPdf } from './lib/export.js'
import { PlateStore } from './lib/plate.js'
import PageCanvas from './components/PageCanvas'
import Inspector from './components/Inspector'

export default function App() {
  const [fileName, setFileName] = useState('')
  const [pages, setPages] = useState([])
  const [edits, setEdits] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [zoom, setZoom] = useState(1.3)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [plateReady, setPlateReady] = useState(false)
  const bytesRef = useRef(null)
  const plateRef = useRef(null)
  const historyRef = useRef([])
  const inputRef = useRef(null)

  const runById = useMemo(() => {
    const map = new Map()
    for (const p of pages) for (const r of p.runs) map.set(r.id, r)
    return map
  }, [pages])
  const selectedRun = selectedId ? runById.get(selectedId) || null : null

  const selectedIdRef = useRef(null)
  selectedIdRef.current = selectedId

  async function openFile(file) {
    if (!file) return
    setBusy(true)
    setStatus('Reading PDF…')
    try {
      const buf = await file.arrayBuffer()
      bytesRef.current = buf
      const doc = await loadPdf(buf)
      const next = []
      for (let i = 1; i <= doc.numPages; i += 1) {
        setStatus(`Extracting text… page ${i}/${doc.numPages}`)
        const page = await doc.getPage(i)
        const runs = await extractRuns(page, i - 1)
        next.push({ index: i - 1, page, runs })
      }
      setPages(next)
      setEdits({})
      setPlateReady(false)
      historyRef.current = []
      setSelectedId(null)
      setFileName(file.name)
      setStatus(`${doc.numPages} page(s), ${next.reduce((n, p) => n + p.runs.length, 0)} editable text blocks`)

      // build the text-free background plate in the background; edits can
      // start immediately and the patches sharpen once it is ready
      const plate = new PlateStore()
      plateRef.current = plate
      plate.load(buf).then((ok) => setPlateReady(ok))
    } catch (err) {
      console.error(err)
      setStatus(`Could not open this PDF: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const pushHistory = useCallback((prev) => {
    historyRef.current.push(prev)
    if (historyRef.current.length > 100) historyRef.current.shift()
  }, [])

  const editRun = useCallback((id, patch) => {
    setEdits((prev) => {
      pushHistory(prev)
      return { ...prev, [id]: { ...(prev[id] || {}), ...patch } }
    })
  }, [pushHistory])

  const isPristine = (edit, run) =>
    edit &&
    run &&
    !edit.deleted &&
    (edit.text === undefined || edit.text === run.text) &&
    edit.fontSize === undefined &&
    edit.color === undefined &&
    edit.bold === undefined &&
    edit.italic === undefined &&
    !edit.dx &&
    !edit.dy

  const selectRun = useCallback((id) => {
    const prevId = selectedIdRef.current
    if (prevId === id) return
    setEdits((prev) => {
      const next = { ...prev }
      // drop the placeholder created on selection if nothing was changed
      if (prevId && next[prevId] && isPristine(next[prevId], runById.get(prevId))) {
        delete next[prevId]
      }
      if (id && !next[id]) next[id] = {}
      return next
    })
    setSelectedId(id)
  }, [runById])

  const undo = useCallback(() => {
    const prev = historyRef.current.pop()
    if (prev) setEdits(prev)
  }, [])

  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
      if (e.key === 'Delete' && selectedId && document.activeElement?.tagName !== 'INPUT') {
        const active = document.activeElement
        if (active && active.isContentEditable) return
        editRun(selectedId, { deleted: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, selectedId, editRun])

  async function download() {
    if (!bytesRef.current) return
    setBusy(true)
    setStatus('Building edited PDF…')
    try {
      const dirty = {}
      for (const [id, edit] of Object.entries(edits)) {
        if (!isPristine(edit, runById.get(id))) dirty[id] = edit
      }
      const { bytes, warnings } = await exportPdf({
        originalBytes: bytesRef.current,
        pages,
        edits: dirty,
        plate: plateRef.current,
        onProgress: setStatus,
      })
      const blob = new Blob([bytes], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName.replace(/\.pdf$/i, '') + '-edited.pdf'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
      setStatus(warnings.length ? `Saved. ${warnings[0]}` : 'Saved.')
    } catch (err) {
      console.error(err)
      setStatus(`Export failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const changedCount = Object.entries(edits).filter(
    ([id, e]) => !isPristine(e, runById.get(id)),
  ).length

  return (
    <div className="flex h-full flex-col bg-slate-100 text-slate-800">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 shadow-sm">
        <span className="text-[15px] font-semibold tracking-tight">PDF Editor</span>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => openFile(e.target.files?.[0])}
        />
        <button
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Open PDF
        </button>

        {fileName && <span className="max-w-[220px] truncate text-sm text-slate-500">{fileName}</span>}

        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))} className="h-8 w-8 rounded border border-slate-300 bg-white text-lg leading-none hover:bg-slate-50">−</button>
          <span className="w-14 text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(4, +(z + 0.15).toFixed(2)))} className="h-8 w-8 rounded border border-slate-300 bg-white text-lg leading-none hover:bg-slate-50">+</button>
          <button onClick={undo} className="ml-2 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm hover:bg-slate-50">Undo</button>
          <button
            onClick={download}
            disabled={!pages.length || busy}
            className="ml-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            Download {changedCount ? `(${changedCount})` : ''}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main
          className="flex-1 overflow-auto p-6"
          onMouseDown={() => selectRun(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); openFile(e.dataTransfer.files?.[0]) }}
        >
          {!pages.length ? (
            <div className="mx-auto mt-16 max-w-md rounded-xl border-2 border-dashed border-slate-300 bg-white/60 p-10 text-center">
              <p className="text-base font-medium">Drop a PDF here</p>
              <p className="mt-1 text-sm text-slate-500">
                or use “Open PDF”. Everything stays in your browser — no upload.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6">
              {pages.map((p) => (
                <PageCanvas
                  key={p.index}
                  pageData={p}
                  zoom={zoom}
                  edits={edits}
                  selectedId={selectedId}
                  plate={plateRef.current}
                  plateReady={plateReady}
                  onSelect={selectRun}
                  onEditRun={editRun}
                  onColorsSampled={() => setPages((cur) => [...cur])}
                />
              ))}
            </div>
          )}
        </main>

        <Inspector
          run={selectedRun}
          edit={selectedId ? edits[selectedId] : null}
          onEdit={(patch) => selectedId && editRun(selectedId, patch)}
          onReset={() => {
            if (!selectedId) return
            setEdits((prev) => {
              pushHistory(prev)
              const next = { ...prev }
              next[selectedId] = {}
              return next
            })
          }}
        />
      </div>

      <footer className="border-t border-slate-200 bg-white px-4 py-1.5 text-xs text-slate-500">
        {busy ? '⏳ ' : ''}{status || 'Click any text on the page to edit it in place.'}
      </footer>
    </div>
  )
}
