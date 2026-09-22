/**
 * Record the demo that sits in the README.
 *
 *   npm run dev                       # in one terminal
 *   node tools/demo.mjs <outDir>
 *
 * Drives the editor through one edit of each kind on docs/sample-report.pdf
 * and writes a frame every 250ms, plus the browser's own video of the run.
 * `tools/demo-gif.py` turns the frames into the animation the README shows.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const OUT = process.argv[2] || 'demo-out'
const SAMPLE = path.resolve('docs/sample-report.pdf')
const FRAMES = path.join(OUT, 'frames')
fs.rmSync(FRAMES, { recursive: true, force: true })
fs.mkdirSync(FRAMES, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  acceptDownloads: true,
})
const page = await context.newPage()

let shot = 0
let recording = false
async function record() {
  while (recording) {
    const at = Date.now()
    try {
      await page.screenshot({ path: path.join(FRAMES, String(shot).padStart(4, '0') + '.png') })
      shot += 1
    } catch { /* a screenshot during navigation is no loss */ }
    const left = 250 - (Date.now() - at)
    if (left > 0) await page.waitForTimeout(left)
  }
}

/** A caption for whoever is watching, plainly not part of the editor. */
async function say(text) {
  await page.evaluate((words) => {
    let el = document.getElementById('demo-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'demo-caption'
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '52px', transform: 'translateX(-50%)',
        background: 'rgba(15, 23, 42, 0.92)', color: '#fff', padding: '11px 20px',
        borderRadius: '999px', zIndex: '99999', pointerEvents: 'none', whiteSpace: 'nowrap',
        font: '500 15.5px/1.2 "Segoe UI", system-ui, sans-serif',
        boxShadow: '0 10px 30px rgba(15, 23, 42, 0.3)',
      })
      document.body.appendChild(el)
    }
    el.textContent = words
  }, text)
}

const runs = () => page.locator('div[style*="caret-color"]')
const pick = async (match) => runs().filter({ hasText: new RegExp(match) }).first()

await page.goto('http://localhost:5175/')
await page.waitForTimeout(600)
recording = true
const tape = record()

// 1. opening a file
await say('Open any PDF — it never leaves your browser')
await page.waitForTimeout(1300)
await page.locator('button:has-text("Choose a PDF")').hover()
await page.waitForTimeout(500)
await page.setInputFiles('input[type=file]', SAMPLE)
await page.waitForSelector('div[style*="caret-color"]', { timeout: 60000 })
await page.waitForTimeout(900)
// a whole page at once reads better than a corner of one
for (let i = 0; i < 3; i += 1) {
  await page.locator('button[title="Zoom out"]').click()
  await page.waitForTimeout(220)
}
await page.waitForTimeout(700)

// 2. typing over a line, in the document's own face
await say('Click a line and type — it keeps the font it was set in')
const title = await pick('Northwind Quarterly Review')
await title.click()
await page.waitForTimeout(600)
await page.keyboard.press('End')
await page.keyboard.type(' 2026', { delay: 90 })
await page.waitForTimeout(1400)

// 3. text that outgrows its line
await say('Text that outgrows its line wraps, and the page opens up below')
const cell = await pick('Gross margin')
await cell.click()
await page.keyboard.press('End')
await page.keyboard.type(' before the exceptional items are taken out', { delay: 32 })
await page.waitForTimeout(1800)

// 4. the panel
await say('Size, colour and weight are on the panel')
const heading = await pick('Key figures')
await heading.click()
await page.waitForTimeout(500)
await page.locator('aside button[title="#1d4ed8"]').click()
await page.waitForTimeout(500)
await page.locator('aside button').filter({ hasText: /^B$/ }).click()
await page.waitForTimeout(1100)

// 5. an image
await say('Drag a picture to move it, or a corner to resize it')
const image = page.locator('div[data-image-id]').first()
await image.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
const box = await image.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 14, { steps: 14 })
await page.mouse.up()
await page.waitForTimeout(900)
await page.locator('aside button:has-text("Smaller")').click()
await page.waitForTimeout(1100)

// 6. words inside the picture
await say('Words inside a picture can be read, then edited where they sit')
await page.locator('aside button:has-text("Read text in this image")').click()
await page.waitForFunction(
  () => /Read \d+ line/.test(document.querySelector('footer')?.textContent || ''),
  null,
  { timeout: 120000 },
)
await page.waitForTimeout(900)
const line = runs().filter({ hasText: /Quarter total/ }).first()
if (await line.count()) {
  await line.click()
  await page.keyboard.press('End')
  await page.keyboard.type('!', { delay: 60 })
}
await page.waitForTimeout(1400)

// 7. out again
await say('Download — everything you did not touch is untouched')
await page.mouse.click(120, 500)
await page.waitForTimeout(600)
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.getByRole('button', { name: /Download/ }).click(),
])
await download.saveAs(path.join(OUT, 'edited.pdf'))
await page.waitForTimeout(2200)

recording = false
await tape
const video = page.video()
await context.close()
if (video) fs.renameSync(await video.path(), path.join(OUT, 'demo.webm'))
await browser.close()
console.log(`${shot} frames (${(shot * 0.25).toFixed(1)}s) in ${FRAMES}`)
