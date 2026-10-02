# Paperless PDF Editor

A local-first, privacy-first PDF editor for the web, licensed under AGPL-3.0. PDF bytes stay on your device; no account or backend is required.

## Current vertical slice

- Opens local PDFs by picker or drag-and-drop
- Parses and renders pages in a dedicated MuPDF.js Web Worker
- Page rail, keyboard navigation, zoom, fit, and rotation preview
- Command-based overlay editing for text, freehand ink, rectangles, and redactions
- Undo/redo with deterministic command history
- Untouched-document download with a guarded export path (edited overlays are never falsely claimed as embedded)
- Responsive desktop/mobile shell and offline app manifest

> This is an honest early vertical slice, not a finished release. Edited-document PDF serialization, page-tree operations, persistence, Android packaging, forms, signatures, merge/split, and the full regression corpus remain on the roadmap.

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
