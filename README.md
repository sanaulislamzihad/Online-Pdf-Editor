# Online PDF Editor

Edit the text inside a PDF in place, in the browser. Open a file, click any
line, type over it — the rest of the page stays exactly as it was: same fonts,
same colours, same images, same layout. Nothing is uploaded; the file never
leaves the machine it is opened on.

## Running it

```bash
npm install
npm run dev        # http://localhost:5175
```

```bash
npm run build      # static site in dist/ - host it anywhere
```

## What you can do to a line

Where consecutive lines are clearly one paragraph - one font, one left
margin, evenly spaced, each line but the last reaching the right margin -
the whole paragraph is offered as a single block, and typing into it wraps.
The text is broken again to the measure the page uses and each line is put
back on the baseline it had, justified at the spaces if the paragraph was.
A paragraph is only treated this way when re-setting it untouched reproduces
the lines it already has, so one that is not understood is left as ordinary
lines rather than rearranged wrongly.

Everything else - a heading, a cell of a table - keeps its own line until
what has been typed no longer fits between where it starts and where the
page's text ends, and then it wraps too rather than running off the edge.
The margin it wraps at is the furthest right the document itself reaches.

Text that has gained a line needs room that a page of fixed positions does
not have, so the page is opened up to give it: everything below the line that
grew moves down by the height of what it gained, and if there is not enough
margin left at the foot of the page, the page itself is made that much
taller. Nothing is redrawn to do it - the page's own drawing instructions are
put into a form and drawn twice, once clipped to what is above the break and
left where it is, once clipped to what is below and translated down - so
text, images and the rule under a heading alike come through as the very
objects they were, only lower. The editor shows the page the same way, since
the page being edited has to be the page that comes out.

Everything else - headings, table cells, single lines - is offered as the
sentences it contains, and a link or a coloured word
within one is offered separately - pdf.js reports a change of font or position
as a new piece of text but not a change of colour, so where the ink changes
part way through a line it is found by reading the drawn page character by
character. Greys all count as one ink, since how dark a sample comes out says
more about the glyph than its colour; a hue is what marks a link.

A line is offered as the sentences it contains. PDFs report text in whatever
pieces they happen to draw it in - sometimes a fragment per word - so those
are joined back together when they share a baseline, a font and a size, then
cut again at full stops. Each piece sits exactly where it does on the page,
because the widths come from the font the page was laid out with; a line
whose font cannot be measured that precisely is left whole rather than split
at a guessed position.

While a line is being edited it is shown in the very face the page was drawn
with: pdf.js has already loaded each embedded font into the browser, so the
overlay asks for that first and anything it has no glyph for falls through to
the next name by itself - the same thing the export does. Where a stand-in is
used and it measures differently, the difference is put into the gaps between
words rather than into the letters, since a justified line carries its extra
width there anyway and stretching the glyphs is exactly what makes a
substituted face look like a different one. Failing that, the browser is
asked for the document's own
typeface by name, and where it is not installed the substitute is measured
against the original and stretched to match, so the text does not jump
larger the moment it becomes editable.

Click it and it becomes editable where it sits. The panel on the right changes
font size, colour, bold and italic, nudges the line a point at a time, deletes
it, or resets it to the original. `Ctrl`+`Z` undoes, `Del` removes the selected
line, `Esc` deselects. The page you see while editing is what the exported file
contains.

## What you can do to an image

Click any image to select it. Drag it to move, drag a corner to resize, or use
the panel to replace it with a PNG or JPEG, nudge it, or delete it. A moved or
resized image is re-drawn through the very same object already in the file, so
its pixels are never decoded or re-encoded - only a replacement brings in new
data. Images inside form XObjects, and pages drawn as one flat picture, are
not offered for editing.

## Reading text off the picture

Two things on a page are pixels rather than text: a scan, and any picture
with words in it. Both can be read back.

A page that is one big picture gets a banner offering to read the whole of
it. Select an image and the panel offers to read just that image, which is
how the words in a screenshot become editable lines sitting where they are
drawn.

An image is read three ways, because each way misses something else. Laid
out as blocks, so that a code panel and the column of prose beside it stay
apart; as a single column, which catches the odd line block analysis passed
over; and flattened to plain black on white, which brings back the coloured
words that syntax highlighting makes both of the others drop altogether.
Where two readings cover the same line the fuller one is kept, unless it is
so much wider that it has run into the column beside it - that is two lines
glued, not a better reading. Whatever survives is then looked at once more on
its own, at line scale, in the untouched picture, where nothing around it can
interfere.

Recognition says what the words are, never what they looked like, so a line
read off a picture used to come back as sans-serif regular whatever it was,
at a size guessed from how tall its letters happened to be - a line of
lower-case with no ascenders came out a third too small, and changing one
word re-set the whole line in the wrong face at the wrong size. The pixels
are still there to be asked. Each of the three families every PDF reader has
is drawn at the size that fills the line's own box and compared with the ink
that is really there; the one that covers it best is the face the line is set
in, and the size that made it fit is the size it is set at. Weight is settled
separately, by how much ink there is rather than where it is: a picture has
been screenshotted, scaled and softened on its way here, and that moves ink
about without adding any, so the middle of a stroke survives what its edges
do not.

Small type, softened that way, often fits two families about as well as a
third. Deciding line by line then sets one line of a code block in a monospace
and the next in a sans, which reads far worse than being wrong the same way
throughout - so the lines are grouped by the colour behind them, which is what
marks out a region of a picture, and each group is settled by the lines in it
that were surest.

The same button appears on a line of real text the PDF describes badly.
Bengali files whose producer wrote the character map in painting order come
out as mojibake with their conjuncts missing, and no amount of care with the
file can undo that - but the page still draws the line correctly, so reading
that picture gives back text that can be read and edited.

## Scanned pages

A page that is one big picture with no text objects gets a banner offering to
read it. Recognition runs in the browser (Tesseract), in English, Bangla, or
both - pick the language in the toolbar before reading. The first run
downloads the language model from a CDN; the page image itself never leaves
the machine. Each recognised line then edits like any other, with one
difference: there is no text layer to peel back, so erasing one paints over
it with the paper colour sampled from around it. That is invisible on a clean
scan and can show as a patch on a heavily textured one.

## How it stays faithful to the original

Nothing is re-rendered or rebuilt on export. The uploaded file is kept as-is
and only the edited lines are touched.

**Erasing.** Covering old text with a white rectangle fails the moment a page
has a coloured block, a photo or a gradient behind it. Instead the document is
re-saved once with every glyph switched to invisible render mode — page
contents and form XObjects alike — and rendered. That "plate" is the page with
its text peeled off, so erasing a line means stamping the matching slice of it
back over the old glyphs. Whatever was underneath comes back exactly.

**Rewriting.** The replacement is written with the *same font resource* that
drew the original, using that font's own character codes, so no new font is
embedded and every reader draws the new text like the line it replaced. That
path is refused, rather than guessed at, when it cannot be trusted:

- when a page has several font resources sharing one BaseFont, since a
  character code means something different in each and pdf.js does not say
  which one drew the run;
- when the font is a subset without a glyph for something newly typed — very
  common, subsets only carry what was printed;
- for Bengali, Devanagari, Arabic and other shaped scripts, whose text a PDF
  stores already shaped in visual order.

A justified line keeps its justification: the width its spaces were widened
to is recovered from the run itself and written back, through an adjusted
show rather than the word-spacing operator, which is defined to act on a
single byte and so does nothing for the two-byte codes most PDFs use.

Only the span that actually changed is given a font this way. Everything
else on the line is still the document's own characters and is written back
through the font it came from, code for code. That matters most where a PDF
describes its text badly - Bengali files whose producer wrote the ToUnicode
table in painting order read as mojibake and lose their conjuncts, yet the
untouched parts of such a line still come back out exactly as they went in,
so a word can be changed in the middle of one without damaging the rest.

When the page's own font is refused, the replacement is set in the closest
thing to it available. An embedded font is only a subset of what was printed
with it, so a face used for a handful of headings has a handful of letters -
type a new word into one and half of it has no glyph. Carlito and Caladea are
bundled for that: metric-for-metric clones of Calibri and Cambria, the two
fonts Word documents are usually set in, so a finished line sits exactly
where the original would have and reads as the same typeface. Helvetica and
Times already serve that role for Arial and Times New Roman. Anything else
falls back to a built-in of the same class.

If none of those is the right face, hand the editor the font itself with
"Use my own font file…" - straight out of the system font folder, usually.
Its weight and slant are read from the file rather than its name, so the
regular and the bold of a family each go where they belong, and a font is
only preferred over a bundled clone for the family it actually names:
supplying Calibri to finish a heading does not put the body's Cambria into
Calibri as well. The panel names, for whatever line is selected, the face
its new letters would be set in.

When it is refused the line is drawn with a built-in PDF font of the same
class, or with the bundled Noto Sans Bengali for Bengali, and the status bar
says which substitute was used. Weight and slant changes also take this path,
since the original face has no bold or italic to offer.

## Known limits

- Replacement text still runs into whatever sits beside it on the same line:
  a page is opened up downwards, never sideways.
- The strip a page opens up is filled with the colour the page has just above
  it, which is the paper on all but a few pages.
- While typing, the overlay uses a system font of the right class, so on-screen
  letter widths are close to, not identical to, the exported ones.
- Scanned PDFs have no text to edit. Encrypted files fall back to flat colour
  patches, since their streams cannot be rewritten to build a plate.

## Testing

With the dev server running:

```bash
npm run smoke -- path/to/file.pdf [outDir]
```

It opens the file, edits and restyles a line, exports, then renders the export
with Chrome's own PDF engine — deliberately not pdf.js, so a bug in how the
file is written cannot hide behind the library that wrote it. Screenshots of
the editor and of the exported file land in `outDir`.

## Layout

| Path | What it does |
| --- | --- |
| `src/lib/extract.js` | loads a PDF, renders pages, pulls out text runs and their colours |
| `src/lib/contentStream.js` | content-stream tokeniser; finds and hides text operators |
| `src/lib/reflow.js` | opens a page up under text that has gained a line |
| `src/lib/plateBuild.js` | builds the text-free background plate |
| `src/lib/plate.js` | renders and caches plate pages, hands out slices |
| `src/lib/nativeText.js` | writes text with the page's own font resource |
| `src/lib/fonts.js` | picks a font per script run, with fallbacks |
| `src/lib/images.js` | finds the images on a page and where they sit |
| `src/lib/ocr.js` | reads the text off a scanned page |
| `src/lib/export.js` | erases and redraws the edited lines, saves the file |

Built with pdf.js (reading and rendering), pdf-lib (writing) and React.
The fonts in `public/fonts/` - Noto Sans Bengali, Carlito and Caladea - are
all under the SIL Open Font License; each licence is alongside them.
