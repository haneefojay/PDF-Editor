# Plan: WPS-level PDF tool, mobile first

WPS Office's PDF tool sets the bar this plan aims for. It covers reading, editing, annotating, converting, scanning and protecting PDFs on phones and desktops. This document compares Paperless with that bar and orders the work. Paperless stays local-first: nothing leaves the device unless a user explicitly opts into an online feature.

## Where Paperless stands

| Area | WPS | Paperless today | Gap |
| --- | --- | --- | --- |
| Reading | Continuous scroll, outline, links, night mode, full screen, read aloud | One page at a time, thumbnails, search | Large: the reader is the first thing people use |
| Mobile UI | Bottom toolbar, tool trays, gestures, immersive reading | Responsive desktop layout | Large |
| Edit text | Paragraph editing with reflow | Line/run editing, font-faithful export | Medium |
| Edit objects | Move, resize, replace, delete existing images | Replace/extract only | Medium |
| Annotate | Highlight, pens, highlighter pen, eraser, shapes, notes, stamps | All except highlighter pen and eraser | Small |
| Fill & sign | Fill, create fields, signatures | Done, including certificates | — |
| Pages | Merge, split, insert, extract, rotate, crop, resize | All except split into files and page resize | Small |
| Protect | Encrypt, permissions, redact | Done | — |
| Convert | PDF ↔ Word/Excel/PPT, images, text | Images ↔ PDF, text | Large: Word/Excel/PPT |
| Scan | Camera capture, edge detection, perspective fix, OCR | OCR on existing pages | Large on mobile |
| Extras | AI summary/translate, cloud sync | — | Optional; must respect local-first |

## Milestones

### M1. Mobile-first reader shell (done)
- Continuous, virtualized vertical scrolling. Only visible pages are rendered, and text is cached per page.
- Mobile layout:
  - a bottom toolbar of tool groups
  - a tool tray above it
  - options in a bottom tray
  - a compact top bar
- Immersive reading: tap the page to hide or show the chrome, with a floating page indicator.
- Double-tap to zoom, plus the existing pinch and fit-width zoom.
- Navigate with the document outline (bookmarks) and with clickable internal and external links.
- Night and sepia reading themes for the page.

### M2. Editing depth
- Paragraph editing: group lines into paragraphs and reflow them inside the original box.
- Move, resize, rotate and delete existing images, with the original removed safely.
- A semi-transparent highlighter pen, and an eraser for ink strokes.
- Split a document into files by page ranges or every N pages, and change page size.

### M3. Scan to PDF (mobile)
- Camera capture with automatic edge detection.
- Perspective correction and enhancement filters.
- Multi-page scan sessions, with OCR straight into searchable PDFs.

### M4. Conversion
- PDF → DOCX locally, using reading-order text, styles and images.
- PDF → XLSX for tables, and PDF → PPTX with one page per slide.
- Office → PDF as an optional, lazily loaded module. Running a full office engine in the browser is large, so it must stay out of the main bundle.

### M5. Reading extras
- Read aloud with the system speech engine, and auto-scroll.
- Edit bookmarks and keep an annotation list.
- Optional AI summary and translation, only with explicit consent and a user-provided endpoint, never on by default.

### M6. Scale and polish
- Fast on 1,000-page documents, with memory caps for rendered pages.
- Accessibility: screen-reader labels, focus order, and contrast.
- Real-device Android testing on low-end phones.

## Engineering rules
1. Every PDF-changing feature ships with engine tests on generated PDFs.
2. Every user flow ships with a Playwright test on desktop and mobile viewports.
3. Do not regress export fidelity: what is on screen is what is in the file.
