# Paperless PDF Editor

A local-first, privacy-first PDF editor for the web and Android, licensed under AGPL-3.0. PDF bytes stay on your device; no account or backend is required. The one exception is the optional AI assistant, which sends page text only when you set it up and press Send.

## What it does

**Read**
- Continuous scrolling through the whole document; only pages near the screen are rendered, so long files stay fast.
- Navigate with the document outline (bookmarks), clickable internal and web links, thumbnails and search.
- Night and sepia reading themes, plus full-screen reading on phones (tap the page).
- Read aloud with the device's own speech engine, highlighting and following each sentence across pages, with speed and voice choices. Auto-scroll for hands-free reading; any touch pauses it.
- Add, rename, nest, reorder and delete bookmarks; they are saved into the exported PDF.
- The Comments panel also lists the notes, highlights and other annotations already in the file, and jumps to each one.
- Optional AI assistant (web only, off by default): summarize or translate chosen pages with Claude, using your own Anthropic API key. Nothing is sent until you have turned it on, agreed to it, and pressed Send; the key is remembered only if you ask.

**Edit**
- Click existing text to change it, keeping its font, size and colour. Whole paragraphs reflow inside their original width; tables, rules and backgrounds around the text are left intact.
- Move, resize, rotate or delete images that are part of the page, without leaving a hole.
- Add text, images, shapes (with fill), lines and arrows, freehand drawing and a highlighter pen; erase strokes with the eraser.
- Text is previewed with the exact fonts and line breaks used in the exported PDF. Unicode text (accents, Greek, Cyrillic, €…) is embedded properly, and characters no bundled font can draw are reported instead of silently replaced.
- Find & replace across the whole document.
- Secure redaction that removes content, not just covers it.

**Scan**
- Scan paper with the camera: the page is outlined live, then straightened with its real proportions, even when photographed at an angle.
- Adjust the corners with a magnifier, pick a filter (Document, Auto colour, Original, Grayscale, B&W) and rotate.
- Scan several pages in one go, reorder or retake them, then create a PDF or insert them into the open one. Photos from the gallery work too.
- Optional on-device OCR makes the scan searchable straight away.

**Convert**
- PDF to Word (.docx) with editable paragraphs, headings, lists, tables and pictures, one Word page per PDF page.
- PDF to Excel (.xlsx): tables cell for cell, printed numbers stored as numbers with their currency, percent and grouping formats.
- PDF to PowerPoint (.pptx): one slide per page, pictures and drawings as the slide background, text as editable text boxes.
- Open Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files as PDFs, or insert them into an open PDF. Slides keep their layout, theme colours and fonts, shapes, pictures, tables and slide numbers; hidden slides are left out.
- Everything converts on the device; the converters load only when first used.

**Comment & review**
- Highlight, underline, strikeout and squiggly markup that snaps to text lines.
- Sticky notes, text callouts, stamps, measurements and file attachments.
- Comments panel with author, date, resolve/reopen, filters, and JSON import/export.

**Fill & sign**
- Fill existing form fields, or design new text, dropdown, checkbox, radio and signature fields with validation, calculations and tab order.
- Drawn, typed or image signatures, plus certificate-backed digital signatures (PKCS#12).

**Pages**
- Real thumbnails; drag to reorder; rotate, crop, delete, duplicate and insert blank pages.
- Change the paper size (A3–A5, Letter, Legal or custom), scaling content and edits to fit.
- Insert or append other PDFs, or photos as pages. Every page operation is undoable.
- Headers, footers, page numbers, watermarks and Bates numbering that update as pages change.
- Extract pages, split into several PDFs by ranges or every N pages (saved as a ZIP), or save a page as an image.

**Tools**
- Open password-protected PDFs; encrypt exports with passwords and permissions.
- On-device OCR that makes scans searchable, with confidence review.
- Compression profiles, metadata editing and sanitising, print, text export, and creating PDFs from images.

**Workflow**
- Autosave to device storage with recent projects and crash recovery.
- Full undo/redo, keyboard shortcuts (press `?`), pinch, double-tap and Ctrl+scroll zoom, fit width/page, dark mode.
- A phone layout with a bottom toolbar, tool trays and options in reach of your thumb; a desktop layout with tabbed tool groups. Installable as an app.
- Built for long documents: a 1,000-page PDF opens in under a second on a desktop and in about two seconds on a slow phone, and memory stays flat however far you scroll, because only the pages and thumbnails near the screen exist and rendered pages are kept within a pixel budget that shrinks on low-memory phones.
- Accessible: tested against WCAG 2.1 AA with axe on desktop and phone, in light and dark themes; dialogs keep keyboard focus inside and hide the editor behind them from screen readers.

Every export is re-opened and rendered before it is handed to you; a document that fails validation is never saved.

## Development

Requirements: Node 22+, pnpm 10+.

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # lint, typecheck, unit tests, build
pnpm test:e2e     # browser tests (first run: pnpm exec playwright install chromium)
```

The unit tests in `packages/pdf-engine` build real PDFs with MuPDF and inspect what the exporter writes. The Playwright suite in `apps/web/e2e` drives the editor in Chromium (desktop and mobile) and checks the exported files. To reuse an existing Chromium binary, set `PLAYWRIGHT_CHROMIUM=/path/to/chromium`.

## Architecture

- `apps/web`: React/Vite editor
  - `App.tsx`: document state, tools and dialogs
  - `DocumentView.tsx`: continuous page column; positions come from page sizes, so only pages near the screen are in the DOM
  - `thumbnails.tsx`: the capped thumbnail cache and windowed thumbnail lists
  - `device.ts`: memory budgets for rendered pages on low-memory phones
  - `PageCanvas.tsx`: page interaction
  - `readAloud.ts`, `ReadingBar.tsx`: sentence splitting, the speech adapter (browser or Android), read-aloud and auto-scroll controls
  - `ai.ts`, `AiAssistant.tsx`: the optional AI assistant
  - `textMetrics.ts`: font-accurate text preview
  - `scan/`: page detection, perspective correction and filters, plus the scanner screen
  - `convert/`: document structure from PDF pages, and Office readers and writers (DOCX, XLSX, PPTX)
  - `layout.ts`: generated headers and footers
- `packages/editor-core`: serializable document model, undoable commands, and the text layout shared by the editor and the exporter
- `packages/pdf-engine`: MuPDF in a Web Worker
  - `engine.ts`: rendering, text extraction, export, page assembly, page analysis for conversion, HTML layout for Word and Excel files, and slide drawing for PowerPoint files
  - `mupdf.worker.ts`: loads WebAssembly and exposes the engine
- `docs/adr`: architecture decisions

Edits are stored as overlays in normalized page coordinates and applied only when exporting, so the source PDF is never modified in place. See [ROADMAP.md](ROADMAP.md), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

## Android

The native project is generated from committed source, so Capacitor build output and binary Gradle assets don't need to be versioned.

```bash
pnpm android:prepare   # build web assets, generate/sync android/
pnpm android:apk       # also create a debug APK
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions runs the same build and uploads `paperless-pdf-editor-debug-apk` as an artifact. Release signing requires a private keystore supplied through CI secrets; no signing keys belong in this repository.

On Android, PDFs are selected through the system file chooser. The scanner asks for camera access the first time it opens; the camera is optional, and photos can be imported instead. Exports, images and text files are written to the app cache and handed to Android's system save/share sheet, which also offers printing. No broad storage permission is requested.
