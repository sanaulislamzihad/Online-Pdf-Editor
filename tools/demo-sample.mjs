/**
 * Build the sample the demo is recorded on.
 *
 * A made-up one-page report: a heading, a paragraph set to a measure, a table
 * of fields and a picture with words in it - one of each thing the editor
 * does something to, and nobody's real document.
 */
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import { PDFDocument } from 'pdf-lib'

const shot = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; width: 720px; font-family: "Segoe UI", system-ui, sans-serif; }
  .card { background: #10131c; border-radius: 10px; overflow: hidden; }
  .bar { display: flex; gap: 7px; padding: 9px 12px; background: #191d29; align-items: center; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .name { margin-left: auto; color: #8992a8; font-size: 12px; font-family: "Courier New", monospace; }
  pre { margin: 0; padding: 16px 18px; color: #d5dae6; font-size: 14px; line-height: 1.7;
        font-family: "Courier New", monospace; }
  .k { color: #e5576f } .t { color: #57b2f0 } .s { color: #e0b877 } .c { color: #7b8496; font-style: italic }
</style><div class="card">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="name">totals.py</span></div>
<pre><span class="c"># quarterly totals, rounded to whole pounds</span>
<span class="k">def</span> <span class="t">total</span>(rows):
    <span class="k">return</span> <span class="t">round</span>(<span class="t">sum</span>(r.amount <span class="k">for</span> r <span class="k">in</span> rows))

<span class="k">print</span>(<span class="s">"Quarter total:"</span>, total(ledger))</pre>
</div>`

const report = (png) => `<!doctype html><meta charset="utf-8"><style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1a1d23; font-size: 11.5pt; }
  h1 { font-size: 20pt; margin: 0 0 2pt; letter-spacing: -0.2pt; }
  .sub { color: #6b7280; font-size: 10pt; margin: 0 0 18pt; font-family: "Segoe UI", sans-serif; }
  h2 { font-size: 13pt; margin: 20pt 0 7pt; }
  p { text-align: justify; line-height: 1.5; margin: 0 0 9pt; }
  table { border-collapse: collapse; width: 100%; font-size: 10.5pt; }
  td { padding: 4pt 0; }
  td.k { width: 38%; color: #374151; }
  .rule { border: 0; border-top: 1px solid #c8a94a; margin: 12pt 0; }
  img { width: 100%; margin-top: 8pt; border-radius: 4px; }
  .note { color: #1d4ed8; }
</style>
<h1>Northwind Quarterly Review</h1>
<p class="sub">Prepared for the operations meeting &middot; Q3</p>
<hr class="rule">

<h2>1. Summary</h2>
<p>Revenue rose across all three regions this quarter, with the strongest
growth in the north, where two new accounts opened in July. Costs held flat
against the previous quarter despite the additional headcount, so the margin
widened by rather more than the board had been asked to expect. The figures
below are unaudited and will be restated once the year-end close is done.</p>

<h2>2. Key figures</h2>
<table>
  <tr><td class="k">Revenue</td><td>&pound;1,284,000</td></tr>
  <tr><td class="k">Cost of sales</td><td>&pound;731,500</td></tr>
  <tr><td class="k">Gross margin</td><td>43.0 per cent</td></tr>
  <tr><td class="k">Headcount</td><td>48</td></tr>
  <tr><td class="k">Prepared by</td><td class="note">operations@example.com</td></tr>
</table>

<h2>3. How the total is worked out</h2>
<p>The figure above comes straight out of the ledger, rounded once at the end
rather than per line:</p>
<img src="data:image/png;base64,${png}">
`

const browser = await chromium.launch({ channel: 'chrome' })
const shooter = await browser.newPage({ viewport: { width: 720, height: 240 }, deviceScaleFactor: 2 })
await shooter.setContent(shot)
await shooter.waitForTimeout(300)
const png = (await shooter.locator('.card').screenshot()).toString('base64')

const maker = await browser.newPage()
await maker.setContent(report(png))
await maker.waitForTimeout(400)
const bytes = await maker.pdf({ format: 'A4', printBackground: true })
await browser.close()

// keep it to one page even if the renderer disagrees
const doc = await PDFDocument.load(bytes)
while (doc.getPageCount() > 1) doc.removePage(doc.getPageCount() - 1)
fs.writeFileSync(process.argv[2], await doc.save())
console.log('written', process.argv[2], fs.statSync(process.argv[2]).size, 'bytes')
