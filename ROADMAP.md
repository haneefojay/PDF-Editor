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

## Phase 3 — editing depth
- Existing text replacement with explicit limitations
- Images, annotations, forms, signatures, metadata, encrypted PDFs

## Phase 4 — Android and hardening
- Capacitor Android file workflows and signed APK pipeline
- Compatibility corpus, visual regression, accessibility and security audits

A feature ships only when it performs the promised PDF operation and survives export validation.
