/// <reference lib="webworker" />
import * as Comlink from "comlink";
import type { ExportOverlay, ExportRequest, FormField, PdfMetadata, PdfWorkerApi, PositionedTextLine } from "./protocol";
import type * as Mupdf from "mupdf";
import wasmUrl from "../node_modules/mupdf/dist/mupdf-wasm.wasm?url";

const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
const workerGlobal = globalThis as unknown as { process?: unknown; $libmupdf_wasm_Module?: { wasmBinary: Uint8Array } };
workerGlobal.process = undefined;
workerGlobal.$libmupdf_wasm_Module = { wasmBinary };
const mupdf = await import("mupdf");

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
  const lower = name.toLowerCase();
  return {
    fontFamily: (lower.includes("courier") || lower.includes("mono") ? "Courier" : lower.includes("times") || lower.includes("serif") ? "Times" : "Helvetica") as PositionedTextLine["fontFamily"],
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
const appendTextContent = (doc: Mupdf.PDFDocument, page: Mupdf.PDFPage, overlay: Extract<ExportOverlay, { kind: "text" }>, resourceName: string) => {
  const pageObject = page.getObject(); const bounds = page.getBounds(); const width = bounds[2] - bounds[0]; const height = bounds[3] - bounds[1];
  const fontName = overlay.fontFamily === "Courier" ? overlay.bold ? "Courier-Bold" : overlay.italic ? "Courier-Oblique" : "Courier" : overlay.fontFamily === "Times" ? overlay.bold ? "Times-Bold" : overlay.italic ? "Times-Italic" : "Times-Roman" : overlay.bold ? "Helvetica-Bold" : overlay.italic ? "Helvetica-Oblique" : "Helvetica";
  const font = new mupdf.Font(fontName); const fontReference = doc.addSimpleFont(font, mupdf.Font.SIMPLE_ENCODING_LATIN);
  let resources = pageObject.get("Resources");
  if (resources.isNull()) resources = pageObject.getInheritable("Resources");
  if (resources.isNull()) { resources = doc.newDictionary(); pageObject.put("Resources", resources); }
  resources = resources.resolve();
  let fonts = resources.get("Font");
  if (fonts.isNull()) { fonts = doc.newDictionary(); resources.put("Font", fonts); }
  fonts.resolve().put(resourceName, fontReference);
  const [red, green, blue] = toColor(overlay.color) as [number, number, number];
  const x = bounds[0] + overlay.x * width; const top = bounds[1] + overlay.y * height;
  const lines = overlay.text.split(/\r?\n/); const commands = ["q", "BT", `/${resourceName} ${overlay.size} Tf`, `${red} ${green} ${blue} rg`];
  lines.forEach((line, index) => {
    const encoded = Array.from(line, (character) => {
      const code = character.codePointAt(0) ?? 63;
      return code > 0 && code <= 255 ? code : 63;
    });
    const hex = encoded.map((code) => code.toString(16).padStart(2, "0")).join("");
    const y = bounds[3] - top - overlay.size - index * overlay.size * 1.2;
    commands.push(`1 0 0 1 ${x} ${y} Tm`, `<${hex}> Tj`);
    if (overlay.underline) commands.push("ET", `${Math.max(0.7, overlay.size / 14)} w`, `${x} ${y - 2} m ${x + overlay.width * width} ${y - 2} l S`, "BT", `/${resourceName} ${overlay.size} Tf`, `${red} ${green} ${blue} rg`);
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
    let current: { bbox: Mupdf.Rect; text: string; size: number; color: string; fontName: string } | null = null;
    structured.walk({
      beginLine: (bbox) => { current = { bbox, text: "", size: 12, color: "#171714", fontName: "Helvetica" }; },
      onChar: (char, _origin, font, size, _quad, color) => {
        if (!current) return;
        current.text += char;
        if (!current.fontName || current.text.length === 1) { current.fontName = font.getName(); current.size = size; current.color = extractedColor(color); }
      },
      endLine: () => {
        if (!current || !current.text.trim()) { current = null; return; }
        const font = extractedFont(current.fontName); const [x0, y0, x1, y1] = current.bbox;
        lines.push({ id: `${index}-${lines.length}`, text: current.text, x: (x0 - bounds[0]) / pageWidth, y: (y0 - bounds[1]) / pageHeight, width: Math.max(0.005, (x1 - x0) / pageWidth), height: Math.max(0.005, (y1 - y0) / pageHeight), size: current.size, color: current.color, ...font });
        current = null;
      },
    });
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
      const page = doc.loadPage(overlay.page); appendTextContent(doc, page, overlay, `PEF${annotationCount + 1}`); page.update(); page.destroy(); annotationCount += 1;
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
