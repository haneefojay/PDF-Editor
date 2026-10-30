# ADR 0003: bake document-level edits through MuPDF

- Status: accepted; partly superseded (see Update below)
- Date: 2026-10-03

## Decision

Represent images and visual signatures as serializable overlays targeting stable source-page identities. During export, reopen the immutable source bytes, apply metadata and form values, create printable annotations, apply destructive redactions, bake annotations/widgets, apply crop boxes, and finally rearrange the page tree.

Merge first exports the current command state, then grafts every page from the selected unlocked PDF into that validated result. Split uses the same export pipeline with a one-page order, so it preserves edits, crop, metadata, and form values without a second implementation.

## Consequences

- Split, merge, and ordinary export share validation and cannot silently diverge.
- Export never mutates the live rendering document or immutable source bytes.
- Image data is persisted locally as data URLs inside the project snapshot; large-image optimization remains future work.
- Password-protected input is rejected with an explicit error until a secure password workflow is implemented.
- Existing-text replacement remains out of this phase because covering text without removing the original would violate the no-fake-features rule.

## Later changes

Two consequences above no longer hold. Replacing existing text shipped on 2026-10-03, and since ADR 0005 it erases only the original text before drawing the new text ([ADR 0005](0005-transform-mapped-export.md)). Password-protected PDFs open after the user enters the password since 2026-10-21. The rest of this decision still stands.
