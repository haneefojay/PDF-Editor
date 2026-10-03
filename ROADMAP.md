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

Existing-text replacement and password entry remain explicitly deferred until they can meet the same integrity bar.

## Phase 4 — Android and hardening
- Capacitor Android file workflows and signed APK pipeline
- Compatibility corpus, visual regression, accessibility and security audits

A feature ships only when it performs the promised PDF operation and survives export validation.
