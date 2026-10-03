/// <reference lib="webworker" />
import * as Comlink from "comlink";
import type { ExportOverlay, ExportRequest, PdfWorkerApi } from "./protocol";
import type * as Mupdf from "mupdf";

// MuPDF's generated loader can stall while resolving its WASM URL from a
// module worker. Supplying the binary explicitly keeps initialization
// deterministic across Vite dev and production builds.
import wasmUrl from "../node_modules/mupdf/dist/mupdf-wasm.wasm?url";
const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
const workerGlobal = globalThis as unknown as {
  process?: unknown;
  $libmupdf_wasm_Module?: { wasmBinary: Uint8Array };
};
workerGlobal.process = undefined;
workerGlobal.$libmupdf_wasm_Module = { wasmBinary };
const mupdf = await import("mupdf");

const toColor = (hex: string): Mupdf.AnnotColor => {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match ? [Number.parseInt(match[1]!, 16) / 255, Number.parseInt(match[2]!, 16) / 255, Number.parseInt(match[3]!, 16) / 255] : [0, 0, 0];
};

const pagePoint = (point: { x: number; y: number }, bounds: Mupdf.Rect): Mupdf.Point => [
  bounds[0] + point.x * (bounds[2] - bounds[0]),
  bounds[1] + point.y * (bounds[3] - bounds[1]),
];

const overlayRect = (overlay: Extract<ExportOverlay, { kind: "rect" | "redact" }>, bounds: Mupdf.Rect): Mupdf.Rect => {
  const [x, y] = pagePoint(overlay, bounds);
  return [x, y, x + overlay.width * (bounds[2] - bounds[0]), y + overlay.height * (bounds[3] - bounds[1])];
};

class Engine implements PdfWorkerApi {
  private doc: Mupdf.PDFDocument | null = null;

  async loadDocument(bytes: ArrayBuffer) {
    this.doc?.destroy();
    const opened = mupdf.Document.openDocument(bytes, "application/pdf");
    if (!opened.isPDF()) {
      opened.destroy();
      throw new Error("The selected file is not a PDF document.");
    }
    this.doc = opened as Mupdf.PDFDocument;
    const pageCount = this.doc.countPages();
    const pages = Array.from({ length: pageCount }, (_, index) => {
      const page = this.doc!.loadPage(index);
      const [x0, y0, x1, y1] = page.getBounds();
      const info = { width: x1 - x0, height: y1 - y0 };
      page.destroy();
      return info;
    });
    return { pageCount, pages };
  }

  async renderPage(index: number, scale: number) {
    if (!this.doc) throw new Error("No PDF is open");
    const page = this.doc.loadPage(index);
    const pixmap = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
    const png = new Uint8Array(pixmap.asPNG());
    pixmap.destroy();
    page.destroy();
    return png;
  }

  async extractText(index: number) {
    if (!this.doc) throw new Error("No PDF is open");
    const page = this.doc.loadPage(index);
    const text = page.toStructuredText("").asText();
    page.destroy();
    return text;
  }

  async exportDocument(request: ExportRequest) {
    if (!this.doc) throw new Error("No PDF is open");
    const doc = new mupdf.PDFDocument(this.doc);
    let annotationCount = 0;
    let redactionCount = 0;
    const pagesWithRedactions = new Set<number>();

    for (const [pageIndexText, rotation] of Object.entries(request.rotations)) {
      const pageIndex = Number(pageIndexText);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.countPages()) continue;
      const page = doc.loadPage(pageIndex);
      page.getObject().put("Rotate", ((rotation % 360) + 360) % 360);
      page.destroy();
    }

    for (const overlay of request.overlays) {
      if (overlay.page < 0 || overlay.page >= doc.countPages()) continue;
      const page = doc.loadPage(overlay.page);
      const bounds = page.getBounds();
      const color = toColor(overlay.color);

      if (overlay.kind === "text") {
        const annotation = page.createAnnotation("FreeText");
        const [x, y] = pagePoint(overlay, bounds);
        const width = Math.max(80, Math.min(bounds[2] - x, overlay.text.length * overlay.size * 0.7 + 16));
        annotation.setRect([x, Math.max(bounds[1], y - overlay.size * 1.25), x + width, y + overlay.size * 0.35]);
        annotation.setContents(overlay.text);
        annotation.setDefaultAppearance("Helv", overlay.size, color);
        annotation.setColor(color);
        annotation.setBorderWidth(0);
        annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
        annotation.update();
        annotation.destroy();
        annotationCount += 1;
      } else if (overlay.kind === "ink") {
        const annotation = page.createAnnotation("Ink");
        annotation.setInkList([overlay.points.map((point) => pagePoint(point, bounds))]);
        annotation.setColor(color);
        annotation.setBorderWidth(overlay.width);
        annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
        annotation.update();
        annotation.destroy();
        annotationCount += 1;
      } else if (overlay.kind === "rect") {
        const annotation = page.createAnnotation("Square");
        annotation.setRect(overlayRect(overlay, bounds));
        annotation.setColor(color);
        annotation.setBorderWidth(2);
        annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
        annotation.update();
        annotation.destroy();
        annotationCount += 1;
      } else {
        const annotation = page.createAnnotation("Redact");
        annotation.setRect(overlayRect(overlay, bounds));
        annotation.setColor([0, 0, 0]);
        annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
        annotation.update();
        annotation.destroy();
        pagesWithRedactions.add(overlay.page);
        redactionCount += 1;
      }
      page.update();
      page.destroy();
    }

    for (const pageIndex of pagesWithRedactions) {
      const page = doc.loadPage(pageIndex);
      page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      page.update();
      page.destroy();
    }

    // Bake visible annotations into page content so ordinary PDF readers retain
    // the edit even when annotation display is disabled.
    doc.bake(true, false);
    const saved = doc.saveToBuffer("garbage=4,compress=yes,clean=yes").asUint8Array();
    const bytes = new Uint8Array(saved.length);
    bytes.set(saved);

    // Structural validation: reopen the exact exported bytes and force a render.
    const verified = mupdf.Document.openDocument(bytes, "application/pdf");
    if (!verified.isPDF() || verified.countPages() !== doc.countPages()) {
      verified.destroy();
      throw new Error("Export validation failed: page structure changed unexpectedly.");
    }
    if (verified.countPages() > 0) {
      const first = verified.loadPage(0);
      const pixmap = first.toPixmap([0.25, 0, 0, 0.25, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
      pixmap.destroy();
      first.destroy();
    }
    const pageCount = verified.countPages();
    verified.destroy();
    doc.destroy();
    return { bytes, pageCount, annotationCount, redactionCount };
  }

  async destroy() {
    this.doc?.destroy();
    this.doc = null;
  }
}

Comlink.expose(new Engine());
postMessage({ type: "PDF_ENGINE_READY" });
