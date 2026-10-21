# ADR 0005: Transform-mapped export and shared text layout

## Status
Accepted

## Context
Overlays are stored in coordinates normalized to the page as MuPDF displays it. The exporter used to write content-stream geometry as `bounds.height - y`. That only matches PDF user space for unrotated, uncropped pages whose MediaBox starts at the origin. It also applied the editor's rotation and crop before mapping overlays, and it estimated text width with a fixed per-character factor, so line breaks in the editor and in the export differed.

## Decision
- Before changing anything, the exporter captures each page's display bounds and the inverse of `PDFPage.getTransform()`. All drawn content is emitted inside a `cm` that maps display points (top-left origin, y down) to user space. Annotations are created while the page still has its original transform.
- Rotation and crop are applied last. Rotation is added to the source `/Rotate`, and the CropBox is written in user space.
- Original page content is wrapped in `q … Q` so unbalanced graphics state cannot leak into added content.
- Redactions run before any content is added. Text-edit erasures remove text only (`eraseText`), image replacement removes pixels only (`eraseImage`), and security redaction removes everything it touches.
- Text layout lives in `@paperless/editor-core/text-layout` and takes a measuring function. The worker measures with MuPDF glyph advances. The editor measures with the same bundled fonts loaded as `FontFace`s.
- Text is embedded with `addFont` (Type0, Identity-H, ToUnicode), using the bundled Liberation font with a base-14 fallback for wider Latin, Greek and Cyrillic coverage.

## Consequences
Exports match the editor on all page geometries, and these cases are covered by engine tests. Scripts outside the bundled fonts' coverage (for example Arabic or CJK) are reported as missing glyphs rather than exported as `?`. Covering them needs additional fonts.
