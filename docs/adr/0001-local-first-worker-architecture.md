# ADR 0001: local-first worker architecture

- Status: accepted
- Date: 2026-10-02

## Decision
Use React for UI, a serializable command model outside React, and the official `mupdf` WebAssembly package behind a Comlink worker boundary. Keep source bytes outside React state. Core workflows require no backend.

## Consequences
MuPDF failures cannot directly block React rendering; large transferable buffers avoid copies. Export must be implemented in the worker and independently verified before download. AGPL source availability is mandatory.
