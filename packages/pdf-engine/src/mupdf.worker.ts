/// <reference lib="webworker" />
import * as Comlink from "comlink";
import type { ExportOverlay, ExportRequest, FormField, PdfMetadata, PdfWorkerApi, PositionedTextLine } from "./protocol";
import type * as Mupdf from "mupdf";
import wasmUrl from "../node_modules/mupdf/dist/mupdf-wasm.wasm?url";
import { bundledFontBase64 } from "./fontData";

const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
const workerGlobal = globalThis as unknown as { process?: unknown; $libmupdf_wasm_Module?: { wasmBinary: Uint8Array } };
workerGlobal.process = undefined;
workerGlobal.$libmupdf_wasm_Module = { wasmBinary };
const mupdf = await import("mupdf");
const fontKeys = {
  sans: {
    regular: "Sans_Regular",
    bold: "Sans_Bold",
    italic: "Sans_Italic",
    boldItalic: "Sans_BoldItalic",
  },
  serif: {
    regular: "Serif_Regular",
    bold: "Serif_Bold",
    italic: "Serif_Italic",
    boldItalic: "Serif_BoldItalic",
  },
  mono: {
    regular: "Mono_Regular",
    bold: "Mono_Bold",
    italic: "Mono_Italic",
    boldItalic: "Mono_BoldItalic",
  },
} as const satisfies Record<string, Record<string, keyof typeof bundledFontBase64>>;
const fontBytes = new Map<string, Uint8Array>();

const toColor = (hex: string): Mupdf.AnnotColor => {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match ? [Number.parseInt(match[1]!, 16) / 255, Number.parseInt(match[2]!, 16) / 255, Number.parseInt(match[3]!, 16) / 255] : [0, 0, 0];
};
const pagePoint = (point: { x: number; y: number }, bounds: Mupdf.Rect): Mupdf.Point => [bounds[0] + point.x * (bounds[2] - bounds[0]), bounds[1] + point.y * (bounds[3] - bounds[1])];
const normalizedRect = (rect: { x: number; y: number; width: number; height: number }, bounds: Mupdf.Rect): Mupdf.Rect => {
  const [x, y] = pagePoint(rect, bounds);
  return [x, y, x + rect.width * (bounds[2] - bounds[0]), y + rect.height * (bounds[3] - bounds[1])];
};
const dataUrlBytes = (dataUrl: string) => {
  const encoded = dataUrl.split(",")[1];
  if (!encoded) throw new Error("Image data is invalid.");
  const raw = atob(encoded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};
const extractedColor = (color: Mupdf.Color) => {
  const rgb = color.length === 1 ? [color[0]!, color[0]!, color[0]!] : color.length === 3 ? color : [0, 0, 0];
  return `#${rgb.slice(0, 3).map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0")).join("")}`;
};
const extractedFont = (name: string) => {
  const clean = name.replace(/^[A-Z]{6}\+/, "");
  const lower = clean.toLowerCase();
  const family = clean
    .replace(/(?:-|,)?(?:bolditalic|boldoblique|semibolditalic|semibold|bold|italic|oblique|regular|roman|medium|book|mt)$/i, "")
    .replace(/MT$/i, "") || clean;
  return {
    fontName: clean,
    fontFamily: family,
    bold: lower.includes("bold") || lower.includes("black") || lower.includes("semibold"),
    italic: lower.includes("italic") || lower.includes("oblique"),
  };
};
const metadataOf = (doc: Mupdf.Document): PdfMetadata => ({
  title: doc.getMetaData(mupdf.Document.META_INFO_TITLE) ?? "",
  author: doc.getMetaData(mupdf.Document.META_INFO_AUTHOR) ?? "",
  subject: doc.getMetaData(mupdf.Document.META_INFO_SUBJECT) ?? "",
  keywords: doc.getMetaData(mupdf.Document.META_INFO_KEYWORDS) ?? "",
});
const appendTextContent = async (doc: Mupdf.PDFDocument, page: Mupdf.PDFPage, overlay: Extract<ExportOverlay, { kind: "text" }>, resourceName: string) => {
  const pageObject = page.getObject(); const bounds = page.getBounds(); const width = bounds[2] - bounds[0]; const height = bounds[3] - bounds[1];
  const mono = overlay.fontFamily.toLowerCase().includes("courier") || overlay.fontFamily.toLowerCase().includes("mono");
  const serif = overlay.fontFamily.toLowerCase().includes("times") || overlay.fontFamily.toLowerCase().includes("serif") || overlay.fontFamily.toLowerCase().includes("georgia") || overlay.fontFamily.toLowerCase().includes("garamond") || overlay.fontFamily.toLowerCase().includes("cambria");
  const category = mono ? "mono" : serif ? "serif" : "sans"; const variant = overlay.bold && overlay.italic ? "boldItalic" : overlay.bold ? "bold" : overlay.italic ? "italic" : "regular";
  const fontKey = fontKeys[category][variant];
  let data = fontBytes.get(fontKey);
  if (!data) { const raw = atob(bundledFontBase64[fontKey]); data = Uint8Array.from(raw, (character) => character.charCodeAt(0)); fontBytes.set(fontKey, data); }
  const font = new mupdf.Font(`Liberation ${category}`, data);
  const fontReference = doc.addSimpleFont(font, mupdf.Font.SIMPLE_ENCODING_LATIN);
  let resources = pageObject.get("Resources");
  if (resources.isNull()) resources = pageObject.getInheritable("Resources");
  if (resources.isNull()) { resources = doc.newDictionary(); pageObject.put("Resources", resources); }
  resources = resources.resolve();
  let fonts = resources.get("Font");
  if (fonts.isNull()) { fonts = doc.newDictionary(); resources.put("Font", fonts); }
  fonts.resolve().put(resourceName, fontReference);
  const [red, green, blue] = toColor(overlay.color) as [number, number, number];
  const boxX = bounds[0] + overlay.x * width; const boxWidth = overlay.width * width; const top = bounds[1] + overlay.y * height;
  const widthFactor = category === "mono" ? 0.62 : category === "serif" ? 0.52 : 0.56; const factor = widthFactor + (overlay.bold ? 0.03 : 0);
  const longestSourceLine = Math.max(...overlay.text.split(/\r?\n/).map((line) => line.length), 1);
  const naturalWidth = longestSourceLine * overlay.size * factor + Math.max(0, longestSourceLine - 1) * overlay.letterSpacing;
  const effectiveSize = overlay.fitMode === "shrink" && naturalWidth > boxWidth ? Math.max(6, overlay.size * boxWidth / naturalWidth) : overlay.size;
  const maxCharacters = Math.max(1, Math.floor((boxWidth + overlay.letterSpacing) / (effectiveSize * factor + overlay.letterSpacing)));
  const sourceLines = overlay.text.split(/\r?\n/);
  const lines = (overlay.fitMode === "auto" ? sourceLines.flatMap((paragraph) => {
    if (paragraph.length <= maxCharacters) return [paragraph];
    const output: string[] = []; let current = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (current && current.length + word.length > maxCharacters) { output.push(current.trimEnd()); current = word.trimStart(); }
      else current += word;
      while (current.length > maxCharacters) { output.push(current.slice(0, maxCharacters)); current = current.slice(maxCharacters); }
    }
    output.push(current); return output;
  }) : sourceLines);
  const commands = ["q", "BT", `/${resourceName} ${effectiveSize} Tf`, `${overlay.letterSpacing} Tc`, `${red} ${green} ${blue} rg`, overlay.invisible ? "3 Tr" : "0 Tr"];
  lines.forEach((line, index) => {
    const encoded = Array.from(line, (character) => { const code = character.codePointAt(0) ?? 63; return code > 0 && code <= 255 ? code : 63; });
    const hex = encoded.map((code) => code.toString(16).padStart(2, "0")).join("");
    const lineWidth = line.length * effectiveSize * factor + Math.max(0, line.length - 1) * overlay.letterSpacing;
    const x = overlay.alignment === "center" ? boxX + Math.max(0, (boxWidth - lineWidth) / 2) : overlay.alignment === "right" ? boxX + Math.max(0, boxWidth - lineWidth) : boxX;
    const y = bounds[3] - top - effectiveSize - index * effectiveSize * overlay.lineHeight;
    const spaces = (line.match(/ /g) ?? []).length; const justifySpacing = overlay.alignment === "justify" && index < lines.length - 1 && spaces > 0 ? Math.max(0, (boxWidth - lineWidth) / spaces) : 0;
    commands.push(`${justifySpacing} Tw`, `1 0 0 1 ${x} ${y} Tm`, `<${hex}> Tj`);
    if (overlay.underline) commands.push("ET", `${Math.max(0.7, effectiveSize / 14)} w`, `${x} ${y - 2} m ${x + Math.min(boxWidth, lineWidth + justifySpacing * spaces)} ${y - 2} l S`, "BT", `/${resourceName} ${effectiveSize} Tf`, `${overlay.letterSpacing} Tc`, `${red} ${green} ${blue} rg`);
  });
  commands.push("ET", "Q");
  const stream = doc.addStream(new TextEncoder().encode(commands.join("\n")), doc.newDictionary());
  const contents = pageObject.get("Contents");
  if (contents.isNull()) pageObject.put("Contents", stream);
  else if (contents.resolve().isArray()) contents.resolve().push(stream);
  else { const array = doc.newArray(); array.push(contents); array.push(stream); pageObject.put("Contents", array); }
  font.destroy();
};

class Engine implements PdfWorkerApi {
  private doc: Mupdf.PDFDocument | null = null;
  private sourceBytes: Uint8Array | null = null;

  async loadDocument(bytes: ArrayBuffer) {
    this.doc?.destroy();
    this.sourceBytes = new Uint8Array(bytes.byteLength);
    this.sourceBytes.set(new Uint8Array(bytes));
    const opened = mupdf.Document.openDocument(this.sourceBytes, "application/pdf");
    if (!opened.isPDF()) { opened.destroy(); throw new Error("The selected file is not a PDF document."); }
    if (opened.needsPassword()) { opened.destroy(); throw new Error("This PDF is password protected. Password entry is not yet available in this build."); }
    this.doc = opened as Mupdf.PDFDocument;
    const pageCount = this.doc.countPages();
    const pages = Array.from({ length: pageCount }, (_, index) => {
      const page = this.doc!.loadPage(index); const [x0, y0, x1, y1] = page.getBounds(); const info = { width: x1 - x0, height: y1 - y0 }; page.destroy(); return info;
    });
    const formFields: FormField[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      const page = this.doc.loadPage(index);
      for (const widget of page.getWidgets()) {
        const type: FormField["type"] = widget.isText() ? "text" : widget.isChoice() ? "choice" : widget.isRadioButton() ? "radio" : "checkbox";
        formFields.push({ page: index, name: widget.getName(), label: widget.getLabel(), type, value: widget.getValue(), options: widget.isChoice() ? widget.getOptions() : [], readOnly: widget.isReadOnly() });
        widget.destroy();
      }
      page.destroy();
    }
    return { pageCount, pages, metadata: metadataOf(this.doc), formFields, encrypted: false };
  }

  async renderPage(index: number, scale: number) {
    if (!this.doc) throw new Error("No PDF is open");
    const page = this.doc.loadPage(index); const pixmap = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true); const png = new Uint8Array(pixmap.asPNG()); pixmap.destroy(); page.destroy(); return png;
  }

  async extractText(index: number) {
    if (!this.doc) throw new Error("No PDF is open");
    const page = this.doc.loadPage(index); const text = page.toStructuredText("").asText(); page.destroy(); return text;
  }

  async extractTextLines(index: number) {
    if (!this.doc) throw new Error("No PDF is open");
    const page = this.doc.loadPage(index); const bounds = page.getBounds(); const pageWidth = bounds[2] - bounds[0]; const pageHeight = bounds[3] - bounds[1];
    const structured = page.toStructuredText("preserve-whitespace");
    const lines: PositionedTextLine[] = [];
    let lineIndex = -1; let runIndex = 0;
    let run: { key: string; text: string; bbox: Mupdf.Rect; size: number; color: string; fontName: string; pendingSpace: { text: string; bbox: Mupdf.Rect } | null } | null = null;
    const unionRect = (a: Mupdf.Rect, b: Mupdf.Rect): Mupdf.Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
    const flushRun = () => {
      if (run?.pendingSpace) { run.text += run.pendingSpace.text; run.bbox = unionRect(run.bbox, run.pendingSpace.bbox); run.pendingSpace = null; }
      if (!run || !run.text.trim()) { run = null; return; }
      const font = extractedFont(run.fontName); const [x0, y0, x1, y1] = run.bbox;
      lines.push({ id: `${index}-${lineIndex}-${runIndex++}`, text: run.text, x: (x0 - bounds[0]) / pageWidth, y: (y0 - bounds[1]) / pageHeight, width: Math.max(0.005, (x1 - x0) / pageWidth), height: Math.max(0.005, (y1 - y0) / pageHeight), size: run.size, color: run.color, alignment: "left", lineHeight: 1.2, letterSpacing: 0, fitMode: "auto", ...font });
      run = null;
    };
    structured.walk({
      beginLine: () => { flushRun(); lineIndex += 1; runIndex = 0; },
      onChar: (char, _origin, font, size, quad, color) => {
        const fontName = font.getName(); const hex = extractedColor(color); const key = `${fontName}\u0000${Math.round(size * 100) / 100}\u0000${hex}`;
        const xs = [quad[0], quad[2], quad[4], quad[6]]; const ys = [quad[1], quad[3], quad[5], quad[7]];
        const charBox: Mupdf.Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        if (!char.trim() && run) {
          run.pendingSpace = run.pendingSpace ? { text: run.pendingSpace.text + char, bbox: unionRect(run.pendingSpace.bbox, charBox) } : { text: char, bbox: charBox };
          return;
        }
        const carriedSpace = run?.pendingSpace ?? null;
        if (run && run.key !== key) { run.pendingSpace = null; flushRun(); }
        if (!run) run = { key, text: carriedSpace?.text ?? "", bbox: carriedSpace ? unionRect(carriedSpace.bbox, charBox) : charBox, size, color: hex, fontName, pendingSpace: null };
        else if (run.pendingSpace) { run.text += run.pendingSpace.text; run.bbox = unionRect(run.bbox, run.pendingSpace.bbox); run.pendingSpace = null; }
        run.text += char;
        run.bbox = unionRect(run.bbox, charBox);
      },
      endLine: flushRun,
    });
    flushRun();
    structured.destroy(); page.destroy(); return lines;
  }

  async exportDocument(request: ExportRequest) {
    if (!this.doc || !this.sourceBytes) throw new Error("No PDF is open");
    const opened = mupdf.Document.openDocument(this.sourceBytes, "application/pdf");
    if (!opened.isPDF()) { opened.destroy(); throw new Error("The source PDF could not be reopened for export."); }
    const doc = opened as Mupdf.PDFDocument;
    let annotationCount = 0;
    let redactionCount = 0;
    const pagesWithRedactions = new Set<number>();
    const redactionFills: Extract<ExportOverlay, { kind: "redact" }>[] = [];
    const textOverlays: Extract<ExportOverlay, { kind: "text" }>[] = [];

    doc.setMetaData(mupdf.Document.META_INFO_TITLE, request.metadata.title);
    doc.setMetaData(mupdf.Document.META_INFO_AUTHOR, request.metadata.author);
    doc.setMetaData(mupdf.Document.META_INFO_SUBJECT, request.metadata.subject);
    doc.setMetaData(mupdf.Document.META_INFO_KEYWORDS, request.metadata.keywords);

    for (const [pageIndexText, rotation] of Object.entries(request.rotations)) {
      const pageIndex = Number(pageIndexText); if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.countPages()) continue;
      const page = doc.loadPage(pageIndex); page.getObject().put("Rotate", ((rotation % 360) + 360) % 360); page.destroy();
    }

    for (const [pageIndexText, crop] of Object.entries(request.crops)) {
      const pageIndex = Number(pageIndexText); if (pageIndex < 0 || pageIndex >= doc.countPages()) continue;
      const page = doc.loadPage(pageIndex); page.setPageBox(mupdf.Page.CROP_BOX, normalizedRect(crop, page.getBounds())); page.destroy();
    }

    for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex += 1) {
      const page = doc.loadPage(pageIndex);
      for (const widget of page.getWidgets()) {
        const value = request.formValues[widget.getName()];
        if (value !== undefined && !widget.isReadOnly()) {
          if (widget.isText()) widget.setTextValue(value);
          else if (widget.isChoice()) widget.setChoiceValue(value);
          else if ((widget.isCheckbox() || widget.isRadioButton()) && value !== widget.getValue()) widget.toggle();
          widget.update();
        }
        widget.destroy();
      }
      page.update(); page.destroy();
    }

    for (const overlay of request.overlays) {
      if (overlay.page < 0 || overlay.page >= doc.countPages()) continue;
      const page = doc.loadPage(overlay.page); const bounds = page.getBounds();
      if (overlay.kind === "text") {
        textOverlays.push(overlay);
      } else if (overlay.kind === "ink" || overlay.kind === "signature") {
        const annotation = page.createAnnotation("Ink"); annotation.setInkList([overlay.points.map((point) => pagePoint(point, bounds))]); annotation.setColor(toColor(overlay.color)); annotation.setBorderWidth(overlay.width); annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT); annotation.update(); annotation.destroy(); annotationCount += 1;
      } else if (overlay.kind === "rect") {
        const annotation = page.createAnnotation("Square"); annotation.setRect(normalizedRect(overlay, bounds)); annotation.setColor(toColor(overlay.color)); annotation.setBorderWidth(2); annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT); annotation.update(); annotation.destroy(); annotationCount += 1;
      } else if (overlay.kind === "shape") {
        const annotation = page.createAnnotation(overlay.shape === "circle" ? "Circle" : overlay.shape === "triangle" ? "Polygon" : "Square");
        const box = normalizedRect(overlay, bounds);
        if (overlay.shape === "triangle") annotation.setVertices([[(box[0] + box[2]) / 2, box[1]], [box[2], box[3]], [box[0], box[3]]]);
        else annotation.setRect(box);
        annotation.setColor(toColor(overlay.color)); if (overlay.fillColor) annotation.setInteriorColor(toColor(overlay.fillColor)); annotation.setBorderWidth(overlay.strokeWidth); annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT); annotation.update(); annotation.destroy(); annotationCount += 1;
      } else if (overlay.kind === "image") {
        const image = new mupdf.Image(dataUrlBytes(overlay.dataUrl)); const annotation = page.createAnnotation("Stamp"); annotation.setRect(normalizedRect(overlay, bounds)); annotation.setStampImage(image); annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT); annotation.update(); annotation.destroy(); image.destroy(); annotationCount += 1;
      } else if (overlay.kind === "redact") {
        const annotation = page.createAnnotation("Redact"); annotation.setRect(normalizedRect(overlay, bounds)); annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT); annotation.update(); annotation.destroy(); pagesWithRedactions.add(overlay.page); redactionFills.push(overlay); redactionCount += 1;
      }
      page.update(); page.destroy();
    }

    for (const pageIndex of pagesWithRedactions) { const page = doc.loadPage(pageIndex); page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, mupdf.PDFPage.REDACT_TEXT_REMOVE); page.update(); page.destroy(); }
    for (const fill of redactionFills) {
      if (fill.color.toLowerCase() === "#ffffff") continue;
      const page = doc.loadPage(fill.page); const annotation = page.createAnnotation("Square"); annotation.setRect(normalizedRect(fill, page.getBounds())); annotation.setColor(toColor(fill.color)); annotation.setInteriorColor(toColor(fill.color)); annotation.setBorderWidth(0); annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT); annotation.update(); annotation.destroy(); page.update(); page.destroy();
    }
    for (const overlay of textOverlays) {
      const page = doc.loadPage(overlay.page); await appendTextContent(doc, page, overlay, `PEF${annotationCount + 1}`); page.update(); page.destroy(); annotationCount += 1;
    }
    const uniquePages = new Set(request.pageOrder);
    if (request.pageOrder.length === 0 || uniquePages.size !== request.pageOrder.length || request.pageOrder.some((page) => page < 0 || page >= doc.countPages())) { doc.destroy(); throw new Error("Export validation failed: page order is invalid."); }
    doc.rearrangePages(request.pageOrder);
    const saved = doc.saveToBuffer("garbage=4,compress=yes,clean=yes").asUint8Array(); const bytes = new Uint8Array(saved.length); bytes.set(saved);
    const verified = mupdf.Document.openDocument(bytes, "application/pdf");
    if (!verified.isPDF() || verified.countPages() !== request.pageOrder.length) { verified.destroy(); doc.destroy(); throw new Error("Export validation failed: page structure changed unexpectedly."); }
    if (verified.countPages() > 0) { const first = verified.loadPage(0); const pixmap = first.toPixmap([0.25, 0, 0, 0.25, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true); pixmap.destroy(); first.destroy(); }
    const pageCount = verified.countPages(); verified.destroy(); doc.destroy(); return { bytes, pageCount, annotationCount, redactionCount };
  }

  async mergeDocument(bytes: ArrayBuffer, request: ExportRequest) {
    const current = await this.exportDocument(request);
    const targetOpened = mupdf.Document.openDocument(current.bytes, "application/pdf");
    const sourceOpened = mupdf.Document.openDocument(bytes, "application/pdf");
    if (!targetOpened.isPDF() || !sourceOpened.isPDF() || sourceOpened.needsPassword()) { targetOpened.destroy(); sourceOpened.destroy(); throw new Error("The merge file is not a supported, unlocked PDF."); }
    const target = targetOpened as Mupdf.PDFDocument; const source = sourceOpened as Mupdf.PDFDocument;
    for (let index = 0; index < source.countPages(); index += 1) target.graftPage(-1, source, index);
    const saved = target.saveToBuffer("garbage=4,compress=yes,clean=yes").asUint8Array(); const output = new Uint8Array(saved.length); output.set(saved); const pageCount = target.countPages(); target.destroy(); source.destroy(); return { bytes: output, pageCount };
  }

  async destroy() { this.doc?.destroy(); this.doc = null; this.sourceBytes = null; }
}

Comlink.expose(new Engine());
postMessage({ type: "PDF_ENGINE_READY" });
