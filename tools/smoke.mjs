/**
 * End-to-end smoke test.
 *
 * Opens a PDF in the running dev server, edits a line of text, restyles it,
 * exports, and renders the result with Chrome's own PDF engine so the check
 * does not lean on the same library the editor uses.
 *
 *   npm run dev            # in one terminal
 *   npm run smoke -- <file.pdf> [outDir]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const SRC = process.argv[2]
const OUT = process.argv[3] || path.join(os.tmpdir(), 'pdf-editor-smoke')
const URL = process.env.EDITOR_URL || 'http://localhost:5175/'

if (!SRC) {
  console.error('usage: npm run smoke -- <file.pdf> [outDir]')
  process.exit(1)
}
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 1500, height: 1050 },
  acceptDownloads: true,
})
const page = await context.newPage()
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))

await page.goto(URL)
await page.setInputFiles('input[type=file]', SRC)
await page.waitForSelector('div[style*="caret-color"]', { timeout: 60000 })
await page.waitForTimeout(3000)
console.log('loaded:', (await page.textContent('footer')).trim())

const runs = page.locator('div[style*="caret-color"]')
const total = await runs.count()
let target = null
let original = ''
for (let i = 0; i < total; i += 1) {
  const text = (await runs.nth(i).textContent()) || ''
  if (text.trim().length > 12) { target = runs.nth(i); original = text; break }
}
if (!target) throw new Error('no editable run long enough to test with')
console.log(`${total} runs; editing ${JSON.stringify(original)}`)

await target.click()
await page.keyboard.press('Control+A')
await page.keyboard.type('Edited by the smoke test')
await page.fill('input[type=number]', '14')
await page.locator('aside button[title="#b91c1c"]').click()
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(OUT, 'editor.png') })

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.getByRole('button', { name: /Download/ }).click(),
])
const saved = path.join(OUT, 'edited.pdf')
await download.saveAs(saved)
await page.waitForTimeout(500)
console.log('after save:', (await page.textContent('footer')).trim())

// render the export with Chrome's PDF viewer, which is not pdf.js
const viewer = await context.newPage()
await viewer.goto(pathToFileURL(saved).href)
await viewer.waitForTimeout(4000)
await viewer.screenshot({ path: path.join(OUT, 'exported.png') })

await browser.close()
console.log('screenshots in', OUT)
if (problems.length) {
  console.error('page errors:\n' + problems.join('\n'))
  process.exit(1)
}
