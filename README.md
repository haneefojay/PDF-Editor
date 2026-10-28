# Paperless PDF Editor

A local-first, privacy-first PDF editor for the web and Android, licensed under AGPL-3.0. PDF bytes stay on your device; no account or backend is required.

## What it does

**Read**
- Continuous scrolling through the whole document; only pages near the screen are rendered, so long files stay fast.
- Navigate with the document outline (bookmarks), clickable internal and web links, thumbnails and search.
- Night and sepia reading themes, plus full-screen reading on phones (tap the page).

**Edit**
- Click any line of existing text to change it, keeping its font, size and colour. Tables, rules and backgrounds around the text are left intact.
- Add text, images, shapes (with fill), lines and arrows, and freehand drawing.
- Text is previewed with the exact fonts and line breaks used in the exported PDF. Unicode text (accents, Greek, Cyrillic, €…) is embedded properly, and characters no bundled font can draw are reported instead of silently replaced.
- Find & replace across the whole document.
- Secure redaction that removes content, not just covers it.

**Comment & review**
- Highlight, underline, strikeout and squiggly markup that snaps to text lines.
- Sticky notes, text callouts, stamps, measurements and file attachments.
- Comments panel with author, date, resolve/reopen, filters, and JSON import/export.

**Fill & sign**
- Fill existing form fields, or design new text, dropdown, checkbox, radio and signature fields with validation, calculations and tab order.
- Drawn, typed or image signatures, plus certificate-backed digital signatures (PKCS#12).

**Pages**
- Real thumbnails; drag to reorder; rotate, crop, delete, duplicate and insert blank pages.
- Insert or append other PDFs, or photos as pages. Every page operation is undoable.
- Headers, footers, page numbers, watermarks and Bates numbering that update as pages change.
- Extract pages, or save a page as an image.

**Tools**
- Open password-protected PDFs; encrypt exports with passwords and permissions.
- On-device OCR that makes scans searchable, with confidence review.
- Compression profiles, metadata editing and sanitising, print, text export, and creating PDFs from images.

**Workflow**
- Autosave to device storage with recent projects and crash recovery.
- Full undo/redo, keyboard shortcuts (press `?`), pinch, double-tap and Ctrl+scroll zoom, fit width/page, dark mode.
- A phone layout with a bottom toolbar, tool trays and options in reach of your thumb; a desktop layout with tabbed tool groups. Installable as an app.

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
  - `DocumentView.tsx`: continuous, virtualized page column
  - `PageCanvas.tsx`: page interaction
  - `textMetrics.ts`: font-accurate text preview
  - `layout.ts`: generated headers and footers
- `packages/editor-core`: serializable document model, undoable commands, and the text layout shared by the editor and the exporter
- `packages/pdf-engine`: MuPDF in a Web Worker
  - `engine.ts`: rendering, text extraction, export and page assembly
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

On Android, PDFs are selected through the system file chooser. Exports, images and text files are written to the app cache and handed to Android's system save/share sheet, which also offers printing. No broad storage permission is requested.
