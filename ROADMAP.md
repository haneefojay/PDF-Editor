# Roadmap

## Phase 0 — foundation (complete in this slice)
- AGPL licensing, monorepo, strict TypeScript, CI
- Worker-isolated MuPDF rendering
- Command model and editor shell

## Phase 1 — safe export (complete)
- Map normalized editor overlays into MuPDF page coordinates
- Bake text, ink, and shapes into the exported PDF
- Apply destructive text redactions and persist page rotation
- Clone the source for repeatable exports
- Reopen, render, and structurally validate every export before download

## Phase 2 — page operations and persistence (complete)
- Undoable reorder, rotation, and deletion with validated export
- OPFS-first source storage with IndexedDB Blob fallback
- Debounced command snapshot autosave with Zod validation
- Recent-project library, reload recovery, and local cleanup

Crop, merge, and split move to Phase 3 alongside deeper document editing.

## Phase 3 — document editing depth (complete)
- Place PNG/JPEG images and bake them into page content
- Draw visual signatures and persist annotation appearance
- Set CropBox regions with undoable normalized geometry
- Inspect and fill text, choice, checkbox, and radio form fields
- Read and edit title, author, subject, and keywords metadata
- Merge another unlocked PDF and split the current page
- Independently validate all resulting PDFs

Existing-text replacement and password entry, deferred here, shipped in later phases.

## Phase 4 — Android and platform hardening (complete)
- Reproducible Capacitor Android project generation and verified debug APK
- System file chooser plus native save/share sheet with no broad storage permission
- Android back-button navigation, status/navigation bar integration, safe areas, and 44px touch targets
- Offline fonts/assets, disabled Android backup, and blocked cleartext traffic
- GitHub Actions APK artifact pipeline

Release signing remains operator-controlled: production keystores must be provided through repository secrets.

## Phase 5 — fidelity and usability overhaul (complete)
- Export geometry is mapped through each page's transform, so edits are placed correctly on rotated pages, cropped pages and pages whose MediaBox is not at the origin; user rotation is added to the source rotation
- Text is laid out with real glyph metrics shared by the editor preview and the exporter, embedded as Unicode fonts, with missing glyphs reported
- Editing original text erases only text, preserving table rules, images and backgrounds; security redaction remains destructive
- Placed images are drawn into page content with real opacity and rotation
- Password-protected PDFs open with a password prompt
- Page insertion, duplication, merging and image pages are undoable and keep all edits editable
- Headers, footers, watermarks and Bates numbers are a document setting that follows page changes
- Tabbed tool groups, inline text and comment editing, real thumbnails, zoom-aware rendering, keyboard shortcuts, undo coalescing, line/arrow tool, text-snapped highlights, print, image and text conversion, dark mode
- Engine tests on generated PDFs and a Playwright end-to-end suite in CI

## Phase 6 — WPS-level parity (complete, apart from real-device testing)
Milestones M1 to M6 in [docs/WPS_PARITY_PLAN.md](docs/WPS_PARITY_PLAN.md):
- M1: continuous virtualized scrolling, the phone layout, outline, links and reading themes
- M2: paragraph editing with reflow, editing existing images, highlighter and eraser, split and page size
- M3: camera scanning with edge detection, perspective correction and OCR
- M4: PDF to Word, Excel and PowerPoint, and Word, Excel and PowerPoint files opened as PDFs
- M5: read aloud, auto-scroll, editable bookmarks, an annotation list and an optional AI assistant
- M6: fast 1,000-page documents with memory caps, and an axe accessibility audit with no violations

## Next
- Testing on real low-end Android phones
- Document comparison with a change report
- Accessibility tagging of exported PDFs
- Several documents open at once
- PowerPoint charts and SmartArt; Word headers, footers and footnotes when opening Office files

A feature ships only when it performs the promised PDF operation and survives export validation.
