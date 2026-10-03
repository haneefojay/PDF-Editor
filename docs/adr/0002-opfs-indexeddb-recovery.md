# ADR 0002: OPFS-first project recovery

- Status: accepted
- Date: 2026-10-03

## Decision

Store original PDF bytes in the Origin Private File System when available. Store project metadata and versioned, Zod-validated command snapshots in IndexedDB through Dexie. If OPFS is unavailable or denied, store the PDF bytes as an IndexedDB `ArrayBuffer` fallback.

Page identities remain stable source-page indexes. `pageOrder` is an ordered subset of those identities, making reorder and deletion non-destructive until export. Overlays and rotations continue to target source-page identities, so edits survive page movement without coordinate migration.

## Consequences

- Autosave never uploads documents or requires an account.
- A reload can recover the source bytes and editor commands independently.
- Schema migrations must validate snapshots before hydration.
- Browser storage eviction can remove projects; the UI describes them as local projects rather than cloud backups.
- Export applies edits to a clone, bakes annotations, rearranges the page tree, and validates the resulting page count.
