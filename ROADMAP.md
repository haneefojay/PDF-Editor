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

## Next
- Continuous (multi-page) scrolling view
- Editing the content of existing vector graphics and images in place
- PDF ↔ Word conversion, accessibility tagging, document comparison (see docs/S_CLASS_PDF_EDITOR_ROADMAP.md)

A feature ships only when it performs the promised PDF operation and survives export validation.
