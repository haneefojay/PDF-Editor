# Roadmap

## Phase 0 — foundation (complete in this slice)
- AGPL licensing, monorepo, strict TypeScript, CI
- Worker-isolated MuPDF rendering
- Command model and editor shell

## Phase 1 — safe export
- Map overlays into PDF coordinates
- Embed text, ink, shapes, and redaction using MuPDF
- Reopen, independently render, and structurally validate every export

## Phase 2 — page operations and persistence
- Reorder, rotate, delete, crop, merge, split
- OPFS + IndexedDB autosave and crash recovery

## Phase 3 — editing depth
- Existing text replacement with explicit limitations
- Images, annotations, forms, signatures, metadata, encrypted PDFs

## Phase 4 — Android and hardening
- Capacitor Android file workflows and signed APK pipeline
- Compatibility corpus, visual regression, accessibility and security audits

A feature ships only when it performs the promised PDF operation and survives export validation.
