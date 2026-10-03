# Paperless PDF Editor

A local-first, privacy-first PDF editor for the web, licensed under AGPL-3.0. PDF bytes stay on your device; no account or backend is required.

## Current vertical slice

- Opens local PDFs by picker or drag-and-drop
- Parses and renders pages in a dedicated MuPDF.js Web Worker
- Page rail, keyboard navigation, zoom, persisted rotation, reorder, and delete
- Command-based overlay editing for text, freehand ink, rectangles, and redactions
- Undo/redo with deterministic command history
- Validated edited-PDF export for text, ink, signatures, images, rectangles, destructive redactions, crop, forms, metadata, and page rotation
- Every export is reopened and rendered before download; repeat exports clone the source document
- Merge PDFs and split the current page without a backend
- OPFS-first autosave with IndexedDB fallback, recent projects, and reload recovery
- Responsive desktop/mobile shell and offline app manifest

> This is an honest early vertical slice, not a finished release. Android packaging, existing-text replacement, encrypted-PDF password entry, advanced annotation types, and the full regression corpus remain on the roadmap.

## Development

Requirements: Node 22+, pnpm 10+.

```bash
pnpm install
pnpm dev
pnpm check
```

Open `http://localhost:5173`. The first MuPDF load may take a moment while WebAssembly initializes.

## Architecture

- `apps/web`: React/Vite product shell
- `packages/editor-core`: serializable command and geometry model
- `packages/pdf-engine`: typed MuPDF worker boundary
- `docs/adr`: architecture decisions

See [ROADMAP.md](ROADMAP.md), [SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
