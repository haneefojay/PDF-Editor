import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import type { Overlay } from "@paperless/editor-core";
import { createEngine } from "./engine";
import { PASSWORD_INCORRECT, PASSWORD_REQUIRED, type ExportRequest } from "./protocol";

type PageSpec = {
  mediaBox?: [number, number, number, number];
  rotate?: 0 | 90 | 180 | 270;
  cropBox?: [number, number, number, number];
  content?: string;
};

function makePdf(pages: PageSpec[], saveOptions = "") {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  resources.put("Font", fonts);
  for (const spec of pages) {
    const page = doc.addPage(
      spec.mediaBox ?? [0, 0, 600, 800],
      spec.rotate ?? 0,
      resources,
      spec.content ?? "",
    );
    if (spec.cropBox) {
      const box = doc.newArray();
      spec.cropBox.forEach((value) => box.push(value));
      page.put("CropBox", box);
    }
    doc.insertPage(-1, page);
  }
  const bytes = doc.saveToBuffer(saveOptions).asUint8Array();
  doc.destroy();
  return new Uint8Array(bytes).buffer;
}

const textOverlay = (
  text: string,
  x: number,
  y: number,
  extra: Partial<Extract<Overlay, { kind: "text" }>> = {},
): Overlay => ({
  id: crypto.randomUUID(),
  page: 0,
  kind: "text",
  x,
  y,
  width: 0.5,
  height: 0.05,
  text,
  size: 20,
  color: "#000000",
  fontFamily: "Helvetica",
  fontName: null,
  bold: false,
  italic: false,
  underline: false,
  alignment: "left",
  lineHeight: 1.2,
  letterSpacing: 0,
  fitMode: "overflow",
  ...extra,
});

const request = (overrides: Partial<ExportRequest> = {}): ExportRequest => ({
  overlays: [],
  rotations: {},
  pageOrder: [0],
  crops: {},
  metadata: { title: "", author: "", subject: "", keywords: "" },
  formValues: {},
  ...overrides,
});

/** Normalized display-space bounding box of the first occurrence of `needle`. */
function findText(bytes: Uint8Array, needle: string, pageIndex = 0, password?: string) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (password) doc.authenticatePassword(password);
  const page = doc.loadPage(pageIndex);
  const bounds = page.getBounds();
  const chars: { c: string; quad: number[] }[] = [];
  const structured = page.toStructuredText("preserve-whitespace");
  structured.walk({
    onChar: (c, _origin, _font, _size, quad) => chars.push({ c, quad: [...quad] }),
  });
  const text = chars.map((item) => item.c).join("");
  const start = text.indexOf(needle);
  structured.destroy();
  page.destroy();
  doc.destroy();
  if (start < 0) return null;
  const hit = chars.slice(start, start + needle.length);
  const xs = hit.flatMap((item) => [item.quad[0]!, item.quad[2]!, item.quad[4]!, item.quad[6]!]);
  const ys = hit.flatMap((item) => [item.quad[1]!, item.quad[3]!, item.quad[5]!, item.quad[7]!]);
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  return {
    x: (Math.min(...xs) - bounds[0]) / width,
    y: (Math.min(...ys) - bounds[1]) / height,
    right: (Math.max(...xs) - bounds[0]) / width,
    bottom: (Math.max(...ys) - bounds[1]) / height,
    text,
  };
}

function pageText(bytes: Uint8Array, pageIndex = 0) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const page = doc.loadPage(pageIndex);
  const text = page.toStructuredText("").asText();
  page.destroy();
  doc.destroy();
  return text;
}

/** Average darkness (0 white – 1 black) of a normalized region. */
function darkness(bytes: Uint8Array, region: { x: number; y: number; width: number; height: number }) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const page = doc.loadPage(0);
  const pixmap = page.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceGray, false, true);
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const samples = pixmap.getPixels();
  let total = 0;
  let count = 0;
  for (let y = Math.floor(region.y * height); y < Math.ceil((region.y + region.height) * height); y += 1)
    for (let x = Math.floor(region.x * width); x < Math.ceil((region.x + region.width) * width); x += 1) {
      total += 1 - samples[y * width + x]! / 255;
      count += 1;
    }
  pixmap.destroy();
  page.destroy();
  doc.destroy();
  return total / Math.max(1, count);
}

async function engineWith(bytes: ArrayBuffer, password?: string) {
  const engine = createEngine(mupdf);
  await engine.loadDocument(bytes, password);
  return engine;
}

describe("export geometry", () => {
  const cases: [string, PageSpec][] = [
    ["a plain page", {}],
    ["a MediaBox away from the origin", { mediaBox: [100, 200, 700, 1000] }],
    ["a page rotated in the source", { rotate: 90 }],
    ["a page with an existing CropBox", { cropBox: [50, 100, 450, 700] }],
    ["unbalanced source graphics state", { content: "1 0 0 1 120 -80 cm 0.5 0 0 0.5 0 0 cm" }],
  ];
  it.each(cases)("places text where the editor shows it on %s", async (_name, spec) => {
    const engine = await engineWith(makePdf([spec]));
    const result = await engine.exportDocument(
      request({ overlays: [textOverlay("Placed", 0.25, 0.4)] }),
    );
    const found = findText(result.bytes, "Placed");
    expect(found).not.toBeNull();
    expect(found!.x).toBeCloseTo(0.25, 1);
    expect(found!.y).toBeGreaterThan(0.39);
    expect(found!.y).toBeLessThan(0.43);
  });

  it("adds user rotation to the source rotation and keeps edits attached", async () => {
    const engine = await engineWith(makePdf([{ rotate: 90 }]));
    const result = await engine.exportDocument(
      request({ overlays: [textOverlay("Turned", 0.2, 0.3)], rotations: { 0: 90 } }),
    );
    const doc = mupdf.Document.openDocument(result.bytes, "application/pdf") as mupdf.PDFDocument;
    expect(doc.loadPage(0).getObject().getInheritable("Rotate").asNumber()).toBe(180);
    doc.destroy();
    // A further 90° clockwise turn maps display (x, y) to (1 - y, x).
    const found = findText(result.bytes, "Turned");
    expect(found!.right).toBeCloseTo(1 - 0.3, 1);
    expect(found!.y).toBeCloseTo(0.2, 1);
  });

  it("crops relative to the displayed page and keeps edits in place", async () => {
    const engine = await engineWith(makePdf([{ mediaBox: [30, 40, 630, 840] }]));
    const result = await engine.exportDocument(
      request({
        overlays: [textOverlay("Cropped", 0.3, 0.4)],
        crops: { 0: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } },
      }),
    );
    const found = findText(result.bytes, "Cropped");
    expect(found!.x).toBeCloseTo(0.4, 1);
    expect(found!.y).toBeGreaterThan(0.59);
    expect(found!.y).toBeLessThan(0.65);
  });
});

describe("text export", () => {
  it("embeds Unicode text that extracts back unchanged", async () => {
    const engine = await engineWith(makePdf([{}]));
    const result = await engine.exportDocument(
      request({ overlays: [textOverlay("Café Привет ΑΒΓ € ž", 0.1, 0.1, { width: 0.8 })] }),
    );
    expect(pageText(result.bytes)).toContain("Café Привет ΑΒΓ € ž");
    expect(result.missingGlyphs).toEqual([]);
  });

  it("reports characters no bundled font can draw", async () => {
    const engine = await engineWith(makePdf([{}]));
    const result = await engine.exportDocument(
      request({ overlays: [textOverlay("Hi 中文", 0.1, 0.1)] }),
    );
    expect(result.missingGlyphs).toEqual(["中", "文"]);
  });

  it("wraps text inside its box using real glyph widths", async () => {
    const engine = await engineWith(makePdf([{}]));
    const result = await engine.exportDocument(
      request({
        overlays: [
          textOverlay("alpha beta gamma delta epsilon zeta eta theta", 0.1, 0.1, {
            width: 0.3,
            fitMode: "auto",
          }),
        ],
      }),
    );
    const first = findText(result.bytes, "alpha");
    const last = findText(result.bytes, "theta");
    expect(last!.y).toBeGreaterThan(first!.y + 0.02);
    for (const word of ["alpha", "gamma", "epsilon", "theta"])
      expect(findText(result.bytes, word)!.right).toBeLessThan(0.41);
  });

  it("keeps invisible OCR text searchable", async () => {
    const engine = await engineWith(makePdf([{}]));
    const result = await engine.exportDocument(
      request({ overlays: [textOverlay("Hidden layer", 0.1, 0.1, { invisible: true })] }),
    );
    expect(pageText(result.bytes)).toContain("Hidden layer");
    expect(darkness(result.bytes, { x: 0.1, y: 0.1, width: 0.3, height: 0.04 })).toBeLessThan(0.01);
  });
});

describe("redaction modes", () => {
  // Text sits on a dark table rule that crosses the whole line.
  const source = makePdf([
    {
      content:
        "0 0 0 rg 40 556 520 8 re f BT /F1 18 Tf 60 560 Td (Secret value) Tj ET",
    },
  ]);
  const area = { x: 0.08, y: 0.28, width: 0.5, height: 0.035 };
  // The rule spans display y 0.295–0.305; sample its middle, right of the text.
  const rule = { x: 0.7, y: 0.297, width: 0.15, height: 0.006 };

  it("erasing text for an edit leaves table rules intact", async () => {
    const engine = await engineWith(source);
    const result = await engine.exportDocument(
      request({
        overlays: [{ id: "e", page: 0, kind: "redact", ...area, color: "#ffffff", mode: "eraseText" }],
      }),
    );
    expect(pageText(result.bytes)).not.toContain("Secret");
    expect(darkness(result.bytes, rule)).toBeGreaterThan(0.8);
    expect(result.redactionCount).toBe(0);
  });

  it("treats legacy white boxes as text erasure", async () => {
    const engine = await engineWith(source);
    const result = await engine.exportDocument(
      request({ overlays: [{ id: "e", page: 0, kind: "redact", ...area, color: "#ffffff" }] }),
    );
    expect(pageText(result.bytes)).not.toContain("Secret");
    expect(darkness(result.bytes, rule)).toBeGreaterThan(0.8);
  });

  it("security redaction removes text and touched line art", async () => {
    const engine = await engineWith(source);
    const result = await engine.exportDocument(
      request({ overlays: [{ id: "r", page: 0, kind: "redact", ...area, color: "#111111" }] }),
    );
    expect(pageText(result.bytes)).not.toContain("Secret");
    expect(darkness(result.bytes, rule)).toBeLessThan(0.1);
    expect(result.redactionCount).toBe(1);
    expect(result.redactionPages).toEqual([0]);
  });

  it("does not erase edits placed over erased text", async () => {
    const engine = await engineWith(source);
    const result = await engine.exportDocument(
      request({
        overlays: [
          { id: "e", page: 0, kind: "redact", ...area, color: "#ffffff", mode: "eraseText" },
          textOverlay("Public value", area.x, area.y, { size: 18 }),
        ],
      }),
    );
    expect(pageText(result.bytes)).toContain("Public value");
  });
});

describe("images", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  it("bakes placed images into page content", async () => {
    const engine = await engineWith(makePdf([{}]));
    const result = await engine.exportDocument(
      request({
        overlays: [
          { id: "i", page: 0, kind: "image", x: 0.2, y: 0.2, width: 0.2, height: 0.1, dataUrl: png, opacity: 1, rotation: 0 },
        ],
      }),
    );
    const doc = mupdf.Document.openDocument(result.bytes, "application/pdf") as mupdf.PDFDocument;
    const page = doc.loadPage(0);
    expect(page.getAnnotations()).toHaveLength(0);
    page.destroy();
    doc.destroy();
    expect(darkness(result.bytes, { x: 0.22, y: 0.22, width: 0.16, height: 0.06 })).toBeGreaterThan(0.2);
  });
});

describe("password protected documents", () => {
  const locked = makePdf([{ content: "BT /F1 18 Tf 60 560 Td (Locked text) Tj ET" }], "encrypt=aes-256,user-password=open,owner-password=owner");

  it("asks for a password and rejects the wrong one", async () => {
    const engine = createEngine(mupdf);
    await expect(engine.loadDocument(locked)).rejects.toThrow(PASSWORD_REQUIRED);
    await expect(engine.loadDocument(locked, "nope")).rejects.toThrow(PASSWORD_INCORRECT);
  });

  it("opens and exports with the right password", async () => {
    const engine = await engineWith(locked, "open");
    expect(await engine.extractText(0)).toContain("Locked text");
    const result = await engine.exportDocument(request({ overlays: [textOverlay("Added", 0.1, 0.1)] }));
    const reopened = mupdf.Document.openDocument(result.bytes, "application/pdf");
    expect(reopened.needsPassword()).toBe(false);
    reopened.destroy();
    expect(pageText(result.bytes)).toContain("Added");
  });
});

describe("appending pages", () => {
  it("adds blank, copied and imported pages after the existing ones", async () => {
    const engine = await engineWith(
      makePdf([{ content: "BT /F1 18 Tf 60 560 Td (First page) Tj ET" }, {}]),
    );
    const blank = await engine.appendPages({ type: "blank", width: 300, height: 400 });
    expect(blank.firstIndex).toBe(2);
    expect(blank.count).toBe(1);
    expect(blank.pages[2]).toEqual({ width: 300, height: 400 });
    const copy = await engine.appendPages({ type: "copy", source: 0 });
    expect(copy.firstIndex).toBe(3);
    expect(await engine.extractText(3)).toContain("First page");
    const imported = await engine.appendPages({ type: "pdf", bytes: makePdf([{}, {}, {}]) });
    expect(imported.firstIndex).toBe(4);
    expect(imported.count).toBe(3);
    expect(imported.pageCount).toBe(7);
    const result = await engine.exportDocument(request({ pageOrder: [3, 0, 6] }));
    expect(result.pageCount).toBe(3);
    expect(pageText(result.bytes, 0)).toContain("First page");
  });
});

describe("text extraction", () => {
  it("reports the baseline of each run", async () => {
    const engine = await engineWith(makePdf([{ content: "BT /F1 20 Tf 60 400 Td (Baseline) Tj ET" }]));
    const [line] = await engine.extractTextLines(0);
    expect(line!.text).toBe("Baseline");
    expect(line!.baseline).toBeCloseTo(400 / 800, 3);
    expect(line!.y).toBeLessThan(line!.baseline);
  });
});

describe("images to PDF", () => {
  // A 200×100 grey PNG.
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 200, 100], false);
  pixmap.clear(128);
  const png = new Uint8Array(pixmap.asPNG()).buffer;

  it("creates one fitted page per image", async () => {
    const engine = createEngine(mupdf);
    const bytes = await engine.createFromImages([png, png]);
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    expect(doc.countPages()).toBe(2);
    expect(doc.loadPage(0).getBounds()).toEqual([0, 0, 842, 595]);
    doc.destroy();
  });

  it("appends images as pages to an open document", async () => {
    const engine = await engineWith(makePdf([{}]));
    const result = await engine.appendPages({ type: "images", images: [png] });
    expect(result.firstIndex).toBe(1);
    expect(result.count).toBe(1);
  });
});

describe("conversion helpers", () => {
  it("renders and reads text from exported bytes", async () => {
    const engine = await engineWith(makePdf([{ content: "BT /F1 18 Tf 60 560 Td (Original) Tj ET" }, {}]));
    const exported = await engine.exportDocument(request({ overlays: [textOverlay("Added", 0.1, 0.1)], pageOrder: [0, 1] }));
    const text = await engine.textOfBytes(exported.bytes);
    expect(text).toHaveLength(2);
    expect(text[0]).toContain("Original");
    expect(text[0]).toContain("Added");
    const png = await engine.renderBytes(exported.bytes, 0, 0.5);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  });
});
