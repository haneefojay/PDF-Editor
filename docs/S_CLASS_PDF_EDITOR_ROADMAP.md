# S-Class PDF Editor Roadmap

## Product bar

Paperless should remain local-first while matching the interaction quality users expect from WPS, Acrobat, Foxit, and Xodo. “Feature complete” means the exported PDF is independently validated, mobile interactions work by touch, and edits preserve the source layout rather than merely looking correct inside the editor.

## Competitive baseline

Official product pages consistently converge on these capabilities:

- WPS: font/layout matching, text and image editing, OCR, organize/merge/split, conversion, compression, forms, signatures, watermarks, and security.
- Adobe Acrobat: text replacement and formatting, font matching, OCR for scans, find/replace, image/object editing, forms, compression, and protected-document behavior.
- Foxit: paragraph reflow, text fitting, layout/object control, OCR, conversion, forms, redaction, password security, comments/reviews, search, e-signatures, and batch workflows.
- Xodo: cross-platform editing, annotation, crop, forms/signing, OCR, conversion, encryption, and offline batch tools.

Sources:
- https://www.wps.com/feature/edit-pdf
- https://www.wps.com/feature/free-pdf-open-app
- https://helpx.adobe.com/au/acrobat/using/edit-text-pdfs.html
- https://www.adobe.com/acrobat/features/modify-pdfs.html
- https://www.foxit.com/pdf-editor/advanced-editing
- https://www.foxit.com/pdf-editor
- https://xodo.com/pdf-editor
- https://xodo.com/pdf-studio

## Delivery phases

### Phase A — Editing fidelity and mobile UX

- [x] Select and edit original text lines.
- [x] Inherit detected font name, size, weight, italic style, and colour.
- [x] Bundle licensed sans/serif/mono font variants for valid, consistent exports.
- [x] Show document fonts plus a broader font library.
- [x] Allow temporary empty values in font-size fields; validate only on blur/Enter.
- [x] Pinch-to-zoom around the gesture midpoint while preserving one-finger panning.
- [x] Deselect objects and text by tapping empty canvas space.
- [x] Explain when a page has no selectable text layer.
- [x] Character/run-level editing inside mixed-style lines.
- [x] Paragraph boxes with reflow, alignment, line spacing, character spacing, and text fitting.
- [x] Find and replace across pages.

**Exit gate:** edits round-trip through independent PDF parsers without corrupt resources; visual regression tests cover mobile and desktop.

### Phase B — OCR and search

- [ ] On-device OCR for image-only pages with language selection.
- [ ] Searchable invisible text layer and confidence review.
- [ ] Full-document search with results, page navigation, and replace workflow.
- [ ] Deskew, rotate, contrast cleanup, and scan enhancement.

**Exit gate:** OCR output remains local, searchable, selectable, and exportable; low-confidence text is surfaced instead of silently accepted.

### Phase C — Professional annotation and review

- [ ] Highlight, underline, strikeout, squiggly, callout, sticky note, stamp, and attachment tools.
- [ ] Comment sidebar, author/date metadata, filtering, import/export, and resolved state.
- [ ] Measurement tools and configurable presets.
- [ ] Flatten selected annotations and print-safe appearance validation.

### Phase D — Page, image, and layout tools

- [ ] Replace/extract images, opacity, rotation, crop, arrange, and alignment guides.
- [ ] Insert blank pages and pages from files; duplicate, extract, and batch reorder.
- [ ] Headers, footers, Bates numbering, backgrounds, and watermarks.
- [ ] Compression with previewable quality profiles and file-size estimates.

### Phase E — Forms, signatures, and security

- [ ] Create and edit form fields, validation, tab order, calculations, and flattening.
- [ ] Typed/drawn/image signatures plus certificate-backed digital signatures.
- [ ] Password encryption, permissions, metadata sanitation, and secure redaction audit.
- [ ] Signature validation and explicit warnings when an edit invalidates a signature.

### Phase F — Conversion, accessibility, and automation

- [ ] PDF ↔ Word/image/text conversion with layout validation.
- [ ] Tagged PDF structure, reading order, alt text, language, and accessibility checks.
- [ ] Compare documents and generate a change report.
- [ ] Batch operations, reusable presets, and optional local AI assistance.

## Engineering rules

1. Never claim a visual overlay is a true edit unless exported source content is removed or replaced correctly.
2. Preserve original font metadata; when an embedded proprietary font cannot be reused, use an explicit metric-compatible fallback and expose that fact.
3. Keep all document processing local by default. Any optional cloud capability must require explicit consent.
4. Every phase must ship with fixture PDFs, independent-parser validation, touch tests, and Android/web CI.
5. Avoid enabling controls before the underlying operation is complete and validated.
