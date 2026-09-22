import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadPdf, extractRuns } from './lib/extract.js'
import { exportPdf, planGrowths } from './lib/export.js'
import { PlateStore } from './lib/plate.js'
import { coverRect } from './lib/plateBuild.js'
import { describeFont } from './lib/fonts.js'
import { hasChanges } from './lib/edits.js'
import { currentRect, extractImages, imageChanged } from './lib/images.js'
import {
  OCR_LANGUAGES, looksScanned, recogniseImage, recogniseLine, recognisePage,
} from './lib/ocr.js'
import PageCanvas from './components/PageCanvas'
import Inspector from './components/Inspector'
import StartScreen from './components/StartScreen.jsx'
import { Button, Divider, Icon } from './components/ui.jsx'

const EMPTY = []

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
  const [customFonts, setCustomFonts] = useState([])
  const [confirming, setConfirming] = useState(null)
  const [dragging, setDragging] = useState(false)
  // whether everything edited so far has been downloaded, so that leaving is
  // only worth asking about when it would actually lose something
  const [saved, setSaved] = useState(false)
  const bytesRef = useRef(null)
  const plateRef = useRef(null)
  const imagePlateRef = useRef(null)
  const historyRef = useRef([])
  const inputRef = useRef(null)
  const replaceInputRef = useRef(null)
  const fontInputRef = useRef(null)

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

  // where each page has to open up to hold text that has gained a line, so
  // the page on screen matches the file that will come out of it
  const growthsByPage = useMemo(() => {
    const map = new Map()
    for (const p of pages) {
      const { growths } = planGrowths(p, edits)
      map.set(p.index, growths)
    }
    return map
  }, [pages, edits])

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
      setSaved(false)
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

  /** Put the editor back to its opening screen, ready for another file. */
  const closeFile = useCallback(() => {
    bytesRef.current = null
    plateRef.current = null
    imagePlateRef.current = null
    historyRef.current = []
    setPages([])
    setImages([])
    setEdits({})
    setImageEdits({})
    setSelectedId(null)
    setSelectedImageId(null)
    setPlateReady(false)
    setImagePlateReady(false)
    setFileName('')
    setStatus('')
  }, [])

  const snapshot = useCallback((nextEdits, nextImageEdits) => {
    historyRef.current.push({ edits: nextEdits, imageEdits: nextImageEdits })
    if (historyRef.current.length > 100) historyRef.current.shift()
  }, [])

  const editRun = useCallback((id, patch) => {
    setSaved(false)
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
    setSaved(false)
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

  async function addFonts(files) {
    const added = []
    for (const file of files || []) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      added.push({ ...describeFont(file, bytes), bytes })
    }
    if (!added.length) return
    setCustomFonts((prev) => {
      const byId = new Map(prev.map((f) => [f.id, f]))
      for (const font of added) byId.set(font.id, font)
      return [...byId.values()]
    })
    setStatus(`${added.map((f) => f.name).join(', ')} will be used where the document's own font runs out.`)
  }

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

  const changedCount =
    Object.entries(edits).filter(([id, e]) => !isPristine(e, runById.get(id))).length +
    Object.values(imageEdits).filter(imageChanged).length

  /**
   * Leaving this file behind - to go back, or to open another one.
   *
   * Edits live only in this tab, so walking away from them loses them: an
   * edited file that has not been downloaded is asked about first.
   */
  const leaveFile = useCallback((what, go) => {
    if (!pages.length || !changedCount || saved) { go(); return }
    setConfirming({
      title: `Leave ${changedCount} unsaved change${changedCount === 1 ? '' : 's'}?`,
      body: `Nothing has been downloaded yet. ${what} will lose the edits made to “${fileName}”.`,
      go,
    })
  }, [pages.length, changedCount, fileName, saved])

  const pickFile = useCallback(() => {
    leaveFile('Opening another PDF', () => inputRef.current?.click())
  }, [leaveFile])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && confirming) {
        setConfirming(null)
        return
      }
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
  }, [undo, selectedId, selectedImageId, editRun, editImage, confirming])

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
        customFonts,
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
      setSaved(true)
      setStatus(warnings.length ? `Downloaded. ${warnings[0]}` : 'Downloaded.')
    } catch (err) {
      console.error(err)
      setStatus(`Export failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const open = pages.length > 0

  return (
    <div className="flex h-full flex-col bg-slate-100 text-slate-800">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = '' }}
      />
      <input
        ref={fontInputRef}
        type="file"
        accept=".ttf,.otf,font/ttf,font/otf"
        multiple
        className="hidden"
        onChange={(e) => { addFonts([...(e.target.files || [])]); e.target.value = '' }}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => { replaceSelectedImage(e.target.files?.[0]); e.target.value = '' }}
      />

      <header className="z-20 flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 shadow-sm">
        {open ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              icon="back"
              title="Close this PDF and go back"
              aria-label="Close this PDF and go back"
              onClick={() => leaveFile('Going back', closeFile)}
            />
            <div className="flex min-w-0 max-w-[260px] items-center gap-2 rounded-lg bg-slate-100 py-1.5 pl-2 pr-3">
              <Icon name="file" className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium leading-4 text-slate-900" title={fileName}>
                  {fileName}
                </p>
                <p className="text-[11px] leading-4 text-slate-500">
                  {pages.length} page{pages.length === 1 ? '' : 's'}
                  {changedCount > 0 && ` · ${changedCount} edit${changedCount === 1 ? '' : 's'}`}
                </p>
              </div>
            </div>
            <Button size="md" icon="open" onClick={pickFile} className="hidden sm:inline-flex">
              Open another
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-white">
              <Icon name="text" className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[15px] font-semibold leading-4 tracking-tight text-slate-900">PDF Editor</p>
              <p className="text-[11px] leading-4 text-slate-500">Edit a PDF in place, in your browser</p>
            </div>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {open && (
            <>
              <div className="flex items-center rounded-lg border border-slate-300 bg-white shadow-sm">
                <button
                  onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))}
                  title="Zoom out"
                  className="grid h-9 w-8 place-items-center rounded-l-lg text-slate-600 hover:bg-slate-50"
                >
                  <Icon name="minus" />
                </button>
                <button
                  onClick={() => setZoom(1.3)}
                  title="Reset zoom"
                  className="h-9 w-14 border-x border-slate-200 text-[12.5px] font-medium tabular-nums text-slate-700 hover:bg-slate-50"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  onClick={() => setZoom((z) => Math.min(4, +(z + 0.15).toFixed(2)))}
                  title="Zoom in"
                  className="grid h-9 w-8 place-items-center rounded-r-lg text-slate-600 hover:bg-slate-50"
                >
                  <Icon name="plus" />
                </button>
              </div>

              <Divider />

              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                title="Language used when reading text off a picture"
                className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-[13px] text-slate-700 shadow-sm hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
              >
                {OCR_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>

              <Button icon="undo" onClick={undo} title="Undo (Ctrl+Z)">Undo</Button>

              <Button
                variant="primary"
                icon="download"
                onClick={download}
                disabled={busy}
                title="Download the edited PDF"
              >
                Download{changedCount ? ` (${changedCount})` : ''}
              </Button>
            </>
          )}
          {!open && (
            <Button variant="solid" icon="open" onClick={pickFile} disabled={busy}>
              Open PDF
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main
          className={`relative flex-1 overflow-auto ${open ? 'bg-slate-200 p-6' : ''}`}
          onMouseDown={() => { selectRun(null); setSelectedImageId(null) }}
          onDragOver={(e) => { if (open) { e.preventDefault(); setDragging(true) } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (!open) return
            e.preventDefault()
            setDragging(false)
            const file = e.dataTransfer.files?.[0]
            if (file) leaveFile('Opening another PDF', () => openFile(file))
          }}
        >
          {!open ? (
            <StartScreen onPick={pickFile} onFile={openFile} busy={busy} />
          ) : (
            <div className="flex flex-col items-center gap-8">
              {pages.map((p) => (
                <div key={p.index} className="flex flex-col items-center gap-2">
                  <PageCanvas
                    pageData={p}
                    zoom={zoom}
                    edits={edits}
                    growths={growthsByPage.get(p.index) || EMPTY}
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
                    onRunsReady={(index, runs) => setPages((cur) => cur.map(
                      (page) => (page.index === index ? { ...page, runs } : page),
                    ))}
                  />
                  <span className="rounded-full bg-slate-900/5 px-2.5 py-0.5 text-[11px] font-medium text-slate-500">
                    Page {p.index + 1} of {pages.length}
                  </span>
                </div>
              ))}
            </div>
          )}

          {dragging && open && (
            <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-50/80">
              <p className="text-sm font-semibold text-blue-700">Drop to open this PDF instead</p>
            </div>
          )}
        </main>

        {open && (
          <Inspector
            run={selectedRun}
            edit={selectedId ? edits[selectedId] : null}
            image={selectedImage}
            imageEdit={selectedImageId ? imageEdits[selectedImageId] : null}
            busy={reading}
            customFonts={customFonts}
            onAddFont={() => fontInputRef.current?.click()}
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
        )}
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-4 text-[12px] text-slate-500">
        {busy && (
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
        )}
        <span className="truncate">
          {status || (open
            ? 'Click any text to edit it, or any image to move, resize or replace it.'
            : 'Open a PDF to begin. Everything happens in this browser.')}
        </span>
        {changedCount > 0 && (
          saved ? (
            <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
              <Icon name="check" className="h-3 w-3" />
              Downloaded
            </span>
          ) : (
            <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              {changedCount} unsaved
            </span>
          )
        )}
      </footer>

      {confirming && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
          onMouseDown={() => setConfirming(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl ring-1 ring-black/5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700">
                <Icon name="alert" className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-slate-900">{confirming.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{confirming.body}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setConfirming(null)}>Stay here</Button>
              <Button
                variant="danger"
                onClick={() => { const { go } = confirming; setConfirming(null); go() }}
              >
                Discard changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
