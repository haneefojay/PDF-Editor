# Plan: WPS-level PDF tool, mobile first

WPS Office's PDF tool sets the bar this plan aims for. It covers reading, editing, annotating, converting, scanning and protecting PDFs on phones and desktops. This document compares Paperless with that bar and orders the work. Paperless stays local-first: nothing leaves the device unless a user explicitly opts into an online feature.

## Where Paperless stands

| Area | WPS | Paperless today | Gap |
| --- | --- | --- | --- |
| Reading | Continuous scroll, outline, links, night mode, full screen, read aloud | All except read aloud (M1) | Small |
| Mobile UI | Bottom toolbar, tool trays, gestures, immersive reading | Done (M1) | — |
| Edit text | Paragraph editing with reflow | Done (M2), with line editing for mixed-style text | — |
| Edit objects | Move, resize, replace, delete existing images | Done (M2) | — |
| Annotate | Highlight, pens, highlighter pen, eraser, shapes, notes, stamps | Done (M2) | — |
| Fill & sign | Fill, create fields, signatures | Done, including certificates | — |
| Pages | Merge, split, insert, extract, rotate, crop, resize | Done (M2) | — |
| Protect | Encrypt, permissions, redact | Done | — |
| Convert | PDF ↔ Word/Excel/PPT, images, text | Done (M4), except PowerPoint → PDF | Small |
| Scan | Camera capture, edge detection, perspective fix, OCR | Done (M3) | — |
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

### M2. Editing depth (done)
- Paragraph editing: group lines into paragraphs and reflow them inside the original box.
- Move, resize, rotate and delete existing images, with the original removed safely.
- A semi-transparent highlighter pen, and an eraser for ink strokes.
- Split a document into files by page ranges or every N pages, and change page size.
- Also fixed along the way: copied pages (duplicate, insert PDF, resize) keep their annotations and form fields, and exports keep the document's form, language and viewer settings.

### M3. Scan to PDF (mobile) (done)
- Camera capture with automatic edge detection.
- Perspective correction and enhancement filters.
- Multi-page scan sessions, with OCR straight into searchable PDFs.
- How it works: the page is the large, high-contrast, nearly four-sided region in a downscaled frame; its corners come from the convex hull. The true page proportions are recovered from the perspective (Zhang and He's whiteboard method), and the Document filter divides by an estimate of the paper brightness to remove shadows. Everything runs on the device.

### M4. Conversion (done)
- PDF → DOCX locally, using reading-order text, styles and images.
- PDF → XLSX for tables, and PDF → PPTX with one page per slide.
- Office → PDF as an optional, lazily loaded module. Running a full office engine in the browser is large, so it must stay out of the main bundle.
- How it works: the engine reports each page's styled text runs, images, ruled shapes and table grids. A shared structure pass (`apps/web/src/convert/structure.ts`) builds lines, paragraphs, headings, lists, tables (from ruling lines) and reading order, including two-column text. Small OOXML writers produce the files. Word and Excel files are read into HTML and laid out into pages by MuPDF's HTML engine.
- Not covered yet: PowerPoint → PDF; legacy .doc/.xls/.ppt; Word headers, footers and footnotes; floating text boxes; Excel formulas that have no saved result; charts.

### M5. Reading extras (done)
- Read aloud with the system speech engine, and auto-scroll.
- Edit bookmarks and keep an annotation list.
- Optional AI summary and translation, only with explicit consent and a user-provided endpoint, never on by default.
- How it works: read aloud splits each page's text lines into sentences (dehyphenated, with redacted text left out and added text included) and speaks them one at a time, through the Web Speech API in browsers and the native speech engine on Android. Bookmarks are written into the exported PDF's outline. File annotations are listed from MuPDF, with the text under highlights. The AI assistant uses the Anthropic SDK in the browser with the user's own key and an optional API address; it is web only, because the Android app has no internet permission by design.

### M6. Scale and polish (done, apart from real devices)
- Fast on 1,000-page documents, with memory caps for rendered pages.
- Accessibility: screen-reader labels, focus order, and contrast.
- Real-device Android testing on low-end phones.
- Results on a 1,000-page PDF, production build in Chromium:

  | | Before | After |
  | --- | --- | --- |
  | Open | 3.7 s | 0.8 s |
  | DOM nodes after opening | 23,213 | 365 |
  | JS heap after opening | 56 MB | 13 MB |
  | Scroll frame time, median / 95th percentile | 49 / 298 ms | 20 / 34 ms |
  | Jump to page 900 | 3.0 s | 0.17 s |
  | Heap after scrolling the whole thumbnail rail | 133 MB | 18 MB |
  | First / repeated search of the whole document | 9.5 s / 9.5 s | 7.0 s / 1.3 s |

  On a phone profile with the CPU slowed four times, it opens in 2.2 s and scrolls at 30 ms per frame (81 ms at the 95th percentile).
- How it works: the page column and the thumbnail lists only build the items near the screen, using positions computed from page sizes. Thumbnails live outside React state in a store capped at 160, so a finished thumbnail redraws only itself. Page text and links are cached for at most 48 pages. Rendered pages stay within a pixel budget (4, 8 or 16 megapixels, from the device's reported memory), and phones with 2 GB or less keep fewer rendered pages. Search runs in the engine in one call and remembers page text, so repeated searches skip pages that cannot match. Autosave rewrites the PDF only when the file itself changes, not after every edit.
- Accessibility: an axe audit (WCAG 2.1 A/AA and best practices) runs in the test suite on desktop and phone, in light and dark themes, with no exceptions. Text colours meet 4.5:1 on every surface; thumbnails no longer nest buttons; dialogs make the rest of the app inert, trap Tab and return focus to the control that opened them; the document name is the page's heading and the tool area is a landmark.
- Still to do: testing on real low-end Android phones, which needs devices. The phone emulation above is an estimate, not a substitute.

## Engineering rules
1. Every PDF-changing feature ships with engine tests on generated PDFs.
2. Every user flow ships with a Playwright test on desktop and mobile viewports.
3. Do not regress export fidelity: what is on screen is what is in the file.
