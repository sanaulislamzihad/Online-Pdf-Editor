import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadPdf, extractRuns } from './lib/extract.js'
import { exportPdf } from './lib/export.js'
import { PlateStore } from './lib/plate.js'
import { coverRect } from './lib/plateBuild.js'
import { hasChanges } from './lib/edits.js'
import { currentRect, extractImages, imageChanged } from './lib/images.js'
import {
  OCR_LANGUAGES, looksScanned, recogniseImage, recogniseLine, recognisePage,
} from './lib/ocr.js'
import PageCanvas from './components/PageCanvas'
import Inspector from './components/Inspector'

export default function App() {
  const [fileName, setFileName] = useState('')
  const [pages, setPages] = useState([])
  const [images, setImages] = useState([])
  const [edits, setEdits] = useState({})
  const [imageEdits, setImageEdits] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [selectedImageId, setSelectedImageId] = useState(null)
  const [zoom, setZoom] = useState(1.3)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [plateReady, setPlateReady] = useState(false)
  const [imagePlateReady, setImagePlateReady] = useState(false)
  const [language, setLanguage] = useState('eng')
  const [ocrPage, setOcrPage] = useState(null)
  const [reading, setReading] = useState(false)
  const bytesRef = useRef(null)
  const plateRef = useRef(null)
  const imagePlateRef = useRef(null)
  const historyRef = useRef([])
  const inputRef = useRef(null)
  const replaceInputRef = useRef(null)

  const runById = useMemo(() => {
    const map = new Map()
    for (const p of pages) for (const r of p.runs) map.set(r.id, r)
    return map
  }, [pages])
  const imageById = useMemo(() => {
    const map = new Map()
    for (const list of images) for (const image of list) map.set(image.id, image)
    return map
  }, [images])

  const selectedRun = selectedId ? runById.get(selectedId) || null : null
  const selectedImage = selectedImageId ? imageById.get(selectedImageId) || null : null

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
      const found = await extractImages(buf)

      setPages(next)
      setImages(found)
      setEdits({})
      setImageEdits({})
      setPlateReady(false)
      setImagePlateReady(false)
      imagePlateRef.current = null
      historyRef.current = []
      setSelectedId(null)
      setSelectedImageId(null)
      setFileName(file.name)
      const runCount = next.reduce((n, p) => n + p.runs.length, 0)
      const imageCount = found.reduce((n, list) => n + list.length, 0)
      setStatus(`${doc.numPages} page(s), ${runCount} text blocks, ${imageCount} image(s)`)

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

  const snapshot = useCallback((nextEdits, nextImageEdits) => {
    historyRef.current.push({ edits: nextEdits, imageEdits: nextImageEdits })
    if (historyRef.current.length > 100) historyRef.current.shift()
  }, [])

  const editRun = useCallback((id, patch) => {
    setEdits((prev) => {
      snapshot(prev, imageEdits)
      return { ...prev, [id]: { ...(prev[id] || {}), ...patch } }
    })
  }, [snapshot, imageEdits])

  // the plate that shows each page without its images is only needed once an
  // image is actually touched, and it costs a second render of the document
  const ensureImagePlate = useCallback(() => {
    if (imagePlateRef.current || !bytesRef.current) return
    const plate = new PlateStore({ hideText: false, dropImages: true })
    imagePlateRef.current = plate
    plate.load(bytesRef.current).then((ok) => setImagePlateReady(ok))
  }, [])

  const editImage = useCallback((id, patch) => {
    ensureImagePlate()
    setImageEdits((prev) => {
      snapshot(edits, prev)
      return { ...prev, [id]: { ...(prev[id] || {}), ...patch } }
    })
  }, [snapshot, edits, ensureImagePlate])

  const runOcr = useCallback(async (pageIndex) => {
    const target = pages.find((p) => p.index === pageIndex)
    if (!target || ocrPage !== null) return
    setOcrPage(pageIndex)
    setStatus('Loading the recognition model…')
    try {
      const found = await recognisePage({
        page: target.page,
        pageIndex,
        language,
        onProgress: setStatus,
      })
      setPages((prev) => prev.map((p) => (
        p.index === pageIndex
          ? { ...p, runs: [...p.runs, ...found], recognised: true }
          : p
      )))
      setStatus(found.length
        ? `Recognised ${found.length} line(s) on page ${pageIndex + 1}. They can be edited like any other text.`
        : `No text could be recognised on page ${pageIndex + 1}.`)
    } catch (err) {
      console.error(err)
      setStatus(`Text recognition failed: ${err.message}`)
    } finally {
      setOcrPage(null)
    }
  }, [pages, language, ocrPage])

  // Reading a line back off its own pixels. A PDF whose character map was
  // written badly gives mojibake no amount of care can undo, but the page
  // still draws the line correctly, and that picture can be read.
  const recogniseRun = useCallback(async () => {
    const run = selectedId ? runById.get(selectedId) : null
    const target = run ? pages.find((p) => p.index === run.pageIndex) : null
    if (!run || !target || reading) return
    setReading(true)
    try {
      const found = await recogniseLine({
        page: target.page,
        rect: coverRect(run),
        language,
        onProgress: setStatus,
      })
      if (found) {
        editRun(run.id, { text: found, recognised: true })
        setStatus(`Read as “${found}”. Edit it like any other line.`)
      } else {
        setStatus('Nothing could be read from that line.')
      }
    } catch (err) {
      console.error(err)
      setStatus(`Could not read that line: ${err.message}`)
    } finally {
      setReading(false)
    }
  }, [selectedId, runById, pages, language, reading, editRun])

  const recogniseInImage = useCallback(async () => {
    const image = selectedImageId ? imageById.get(selectedImageId) : null
    const target = image ? pages.find((p) => p.index === image.pageIndex) : null
    if (!image || !target || reading) return
    setReading(true)
    try {
      const found = await recogniseImage({
        page: target.page,
        pageIndex: image.pageIndex,
        rect: currentRect(image, imageEdits[image.id]),
        language,
        onProgress: setStatus,
        idPrefix: `${image.id}_t`,
      })
      setPages((prev) => prev.map((p) => (
        p.index === image.pageIndex ? { ...p, runs: [...p.runs, ...found] } : p
      )))
      setStatus(found.length
        ? `Read ${found.length} line(s) out of the image. They can be edited in place.`
        : 'No text could be read in that image.')
    } catch (err) {
      console.error(err)
      setStatus(`Could not read that image: ${err.message}`)
    } finally {
      setReading(false)
    }
  }, [selectedImageId, imageById, imageEdits, pages, language, reading])

  const isPristine = (edit, run) => !!edit && !hasChanges(edit, run)

  const selectRun = useCallback((id) => {
    const prevId = selectedIdRef.current
    if (id) setSelectedImageId(null)
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

  const selectImage = useCallback((id) => {
    setSelectedImageId(id)
    if (id) selectRun(null)
  }, [selectRun])

  const undo = useCallback(() => {
    const prev = historyRef.current.pop()
    if (!prev) return
    setEdits(prev.edits)
    setImageEdits(prev.imageEdits)
  }, [])

  function replaceSelectedImage(file) {
    if (!file || !selectedImageId) return
    file.arrayBuffer().then((buffer) => {
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      editImage(selectedImageId, {
        replacement: {
          bytes: new Uint8Array(buffer),
          type,
          url: URL.createObjectURL(file),
          name: file.name,
        },
      })
    })
  }

  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (e.key !== 'Delete') return
      const active = document.activeElement
      if (active && (active.isContentEditable || active.tagName === 'INPUT')) return
      if (selectedImageId) editImage(selectedImageId, { deleted: true })
      else if (selectedId) editRun(selectedId, { deleted: true })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, selectedId, selectedImageId, editRun, editImage])

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
        images,
        imageEdits,
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

  const changedCount =
    Object.entries(edits).filter(([id, e]) => !isPristine(e, runById.get(id))).length +
    Object.values(imageEdits).filter(imageChanged).length

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
        <input
          ref={replaceInputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => { replaceSelectedImage(e.target.files?.[0]); e.target.value = '' }}
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
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="Language used when reading scanned pages"
            className="ml-2 h-8 rounded border border-slate-300 bg-white px-2 text-sm"
          >
            {OCR_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
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
          onMouseDown={() => { selectRun(null); setSelectedImageId(null) }}
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
                  images={images[p.index] || []}
                  imageEdits={imageEdits}
                  selectedImageId={selectedImageId}
                  imagePlate={imagePlateRef.current}
                  imagePlateReady={imagePlateReady}
                  scanned={
                    !p.recognised && looksScanned(p.page, p.runs, images[p.index] || [])
                  }
                  ocrBusy={ocrPage === p.index}
                  onRunOcr={runOcr}
                  onSelect={selectRun}
                  onSelectImage={selectImage}
                  onEditRun={editRun}
                  onEditImage={editImage}
                  onColorsSampled={() => setPages((cur) => [...cur])}
                />
              ))}
            </div>
          )}
        </main>

        <Inspector
          run={selectedRun}
          edit={selectedId ? edits[selectedId] : null}
          image={selectedImage}
          imageEdit={selectedImageId ? imageEdits[selectedImageId] : null}
          busy={reading}
          onRecogniseRun={recogniseRun}
          onRecogniseImage={recogniseInImage}
          onEdit={(patch) => selectedId && editRun(selectedId, patch)}
          onEditImage={(patch) => selectedImageId && editImage(selectedImageId, patch)}
          onReplaceImage={() => replaceInputRef.current?.click()}
          onResetImage={() => selectedImageId && setImageEdits((prev) => {
            snapshot(edits, prev)
            return { ...prev, [selectedImageId]: {} }
          })}
          onReset={() => {
            if (!selectedId) return
            setEdits((prev) => {
              snapshot(prev, imageEdits)
              return { ...prev, [selectedId]: {} }
            })
          }}
        />
      </div>

      <footer className="border-t border-slate-200 bg-white px-4 py-1.5 text-xs text-slate-500">
        {busy ? '⏳ ' : ''}{status || 'Click any text to edit it, or any image to move, resize or replace it.'}
      </footer>
    </div>
  )
}
