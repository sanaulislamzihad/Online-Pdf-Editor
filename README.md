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

Click it and it becomes editable where it sits. The panel on the right changes
font size, colour, bold and italic, nudges the line a point at a time, deletes
it, or resets it to the original. `Ctrl`+`Z` undoes, `Del` removes the selected
line, `Esc` deselects. The page you see while editing is what the exported file
contains.

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

When it is refused the line is drawn with a built-in PDF font of the same
class, or with the bundled Noto Sans Bengali for Bengali, and the status bar
says which substitute was used. Weight and slant changes also take this path,
since the original face has no bold or italic to offer.

## Known limits

- Replacement text that is wider than the original will run into whatever sits
  next to it — there is no reflow.
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
| `src/lib/plateBuild.js` | builds the text-free background plate |
| `src/lib/plate.js` | renders and caches plate pages, hands out slices |
| `src/lib/nativeText.js` | writes text with the page's own font resource |
| `src/lib/fonts.js` | picks a font per script run, with fallbacks |
| `src/lib/export.js` | erases and redraws the edited lines, saves the file |

Built with pdf.js (reading and rendering), pdf-lib (writing) and React.
`public/fonts/NotoSansBengali.ttf` is Noto Sans Bengali, SIL Open Font License.
