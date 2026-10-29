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
    // Stretched to cover its whole box, like the scanned words it represents.
    const found = findText(result.bytes, "Hidden layer");
    expect(found!.right).toBeCloseTo(0.6, 1);
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
    expect(doc.loadPage(0).getBounds().map(Math.round)).toEqual([0, 0, 842, 595]);
    doc.destroy();
  });

  it("sizes image pages as asked", async () => {
    const engine = createEngine(mupdf);
    const size = async (pageSize: "a4" | "letter" | "fit") => {
      const doc = mupdf.Document.openDocument(await engine.createFromImages([png], pageSize), "application/pdf");
      const bounds = doc.loadPage(0).getBounds().map(Math.round);
      doc.destroy();
      return bounds;
    };
    expect(await size("letter")).toEqual([0, 0, 792, 612]);
    // Shaped like the 2:1 image, long edge as on A4.
    expect(await size("fit")).toEqual([0, 0, 842, 421]);
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

describe("navigation", () => {
  function linkedPdf() {
    const doc = new mupdf.PDFDocument();
    for (let index = 0; index < 3; index += 1) doc.insertPage(-1, doc.addPage([0, 0, 600, 800], 0, doc.newDictionary(), ""));
    const first = doc.loadPage(0);
    first.createLink([50, 50, 150, 70], doc.formatLinkURI({ type: "XYZ", chapter: 0, page: 2, x: 0, y: 400, width: 0, height: 0, zoom: 0 }));
    first.createLink([50, 100, 150, 120], "https://example.com/report");
    first.createLink([50, 150, 150, 170], "javascript:alert(1)");
    const outline = doc.outlineIterator();
    outline.insert({ title: "Introduction", uri: doc.formatLinkURI({ type: "Fit", chapter: 0, page: 0, x: 0, y: 0, width: 0, height: 0, zoom: 0 }), open: true });
    outline.insert({ title: "Results", uri: doc.formatLinkURI({ type: "Fit", chapter: 0, page: 2, x: 0, y: 0, width: 0, height: 0, zoom: 0 }), open: true });
    outline.destroy();
    const bytes = doc.saveToBuffer("").asUint8Array();
    doc.destroy();
    return new Uint8Array(bytes).buffer;
  }

  it("reads the outline with target pages", async () => {
    const engine = await engineWith(linkedPdf());
    const outline = await engine.getOutline();
    expect(outline.map((entry) => [entry.title, entry.page, entry.depth])).toEqual([
      ["Introduction", 0, 0],
      ["Results", 2, 0],
    ]);
  });

  it("lists internal and safe external links", async () => {
    const engine = await engineWith(linkedPdf());
    const links = await engine.getLinks(0);
    expect(links).toHaveLength(2);
    const internal = links.find((link) => link.page !== undefined)!;
    expect(internal.page).toBe(2);
    expect(internal.x).toBeCloseTo(50 / 600, 3);
    expect(internal.y).toBeCloseTo(50 / 800, 3);
    expect(links.find((link) => link.uri)?.uri).toBe("https://example.com/report");
    expect(await engine.getLinks(1)).toEqual([]);
  });
});

describe("erasing one line of tightly spaced text", () => {
  const lines = ["First line of the paragraph", "Second line to replace", "Third line stays put."];
  const body = lines.map((line, index) => `${index ? "0 -14 Td " : ""}(${line}) Tj`).join(" ");
  const source = makePdf([{ content: `BT /F1 12 Tf 72 680 Td ${body} ET` }]);

  it("leaves the neighbouring lines alone when erasing a baseline band", async () => {
    const engine = await engineWith(source);
    const extracted = await engine.extractTextLines(0);
    const target = extracted.find((line) => line.text.startsWith("Second"))!;
    // The band the editor erases: from just under the x-height to the baseline.
    const top = target.baseline - (0.7 * target.size) / 800;
    const result = await engine.exportDocument(
      request({
        overlays: [{ id: "e", page: 0, kind: "redact", x: target.x, y: top, width: target.width, height: (0.65 * target.size) / 800, color: "#ffffff", mode: "eraseText" }],
      }),
    );
    const text = pageText(result.bytes);
    expect(text).not.toContain("Second");
    expect(text).toContain("First line of the paragraph");
    expect(text).toContain("Third line stays put.");
  });
});

describe("removing embedded images", () => {
  function imagePdf() {
    const doc = new mupdf.PDFDocument();
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
    pixmap.clear(0);
    const resources = doc.newDictionary();
    const xobjects = doc.newDictionary();
    xobjects.put("Im1", doc.addImage(new mupdf.Image(pixmap)));
    resources.put("XObject", xobjects);
    // A blue panel with the image drawn on it, and the same image again below.
    const content = "0 0 1 rg 50 400 300 200 re f q 100 0 0 80 100 450 cm /Im1 Do Q q 50 0 0 50 400 100 cm /Im1 Do Q";
    doc.insertPage(-1, doc.addPage([0, 0, 600, 800], 0, resources, content));
    const bytes = doc.saveToBuffer("").asUint8Array();
    doc.destroy();
    return new Uint8Array(bytes).buffer;
  }
  const colourAt = (bytes: Uint8Array, x: number, y: number) => {
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const pixmap = doc.loadPage(0).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
    const offset = (Math.round(y * pixmap.getHeight()) * pixmap.getWidth() + Math.round(x * pixmap.getWidth())) * pixmap.getNumberOfComponents();
    const pixels = pixmap.getPixels();
    return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
  };

  it("lists images with their positions", async () => {
    const engine = await engineWith(imagePdf());
    const images = await engine.listPageImages(0);
    expect(images).toHaveLength(2);
    expect(images[0]!.x).toBeCloseTo(100 / 600, 3);
    expect(images[0]!.y).toBeCloseTo((800 - 530) / 800, 3);
  });

  it("removes just the chosen image and keeps what is behind it", async () => {
    const engine = await engineWith(imagePdf());
    const [first] = await engine.listPageImages(0);
    const result = await engine.exportDocument(
      request({ overlays: [{ id: "e", page: 0, kind: "redact", x: first!.x, y: first!.y, width: first!.width, height: first!.height, color: "#ffffff", mode: "eraseImage" }] }),
    );
    // The blue panel shows where the image was, instead of a white hole.
    expect(colourAt(result.bytes, (first!.x + first!.width / 2), first!.y + first!.height / 2)).toEqual([0, 0, 255]);
    // The second copy of the same image is still drawn.
    expect(colourAt(result.bytes, 425 / 600, (800 - 125) / 800)).toEqual([0, 0, 0]);
  });
});

describe("highlighter strokes", () => {
  it("exports ink opacity", async () => {
    const engine = await engineWith(makePdf([{}]));
    const result = await engine.exportDocument(
      request({ overlays: [{ id: "h", page: 0, kind: "ink", points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }], color: "#ffd400", width: 14, opacity: 0.4 }] }),
    );
    const doc = mupdf.Document.openDocument(result.bytes, "application/pdf") as mupdf.PDFDocument;
    const [annotation] = doc.loadPage(0).getAnnotations();
    expect(annotation!.getType()).toBe("Ink");
    expect(annotation!.getOpacity()).toBeCloseTo(0.4, 2);
    doc.destroy();
  });
});

describe("resizing pages", () => {
  it("fits content and annotations into the new size and reports the mapping", async () => {
    const doc = new mupdf.PDFDocument();
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
    resources.put("Font", fonts);
    doc.insertPage(-1, doc.addPage([0, 0, 600, 800], 0, resources, "BT /F1 20 Tf 100 700 Td (Corner) Tj ET"));
    const page = doc.loadPage(0);
    const ink = page.createAnnotation("Ink");
    ink.setInkList([[[300, 400], [400, 400]]]);
    ink.update();
    const bytes = new Uint8Array(doc.saveToBuffer("").asUint8Array()).buffer;
    doc.destroy();

    const engine = await engineWith(bytes);
    const before = (await engine.extractTextLines(0))[0]!;
    const result = await engine.appendPages({ type: "resize", sources: [0], width: 300, height: 300 });
    expect(result.firstIndex).toBe(1);
    expect(result.pages[1]).toEqual({ width: 300, height: 300 });
    const [mapping] = result.mappings!;
    expect(mapping!.scale).toBeCloseTo(0.375);
    expect(mapping!.offsetX).toBeCloseTo((300 - 225) / 2 / 300);
    expect(mapping!.offsetY).toBeCloseTo(0);

    const after = (await engine.extractTextLines(1))[0]!;
    expect(after.text).toBe("Corner");
    expect(after.x).toBeCloseTo(before.x * mapping!.scaleX + mapping!.offsetX, 2);
    expect(after.baseline).toBeCloseTo(before.baseline * mapping!.scaleY + mapping!.offsetY, 2);
    expect(after.size).toBeCloseTo(20 * 0.375, 1);

    const exported = await engine.exportDocument(request({ pageOrder: [1] }));
    const out = mupdf.Document.openDocument(exported.bytes, "application/pdf") as mupdf.PDFDocument;
    const [annotation] = out.loadPage(0).getAnnotations();
    const start = (annotation!.getInkList() as [number, number][][])[0]![0];
    // (300, 400) user → display (300, 400) → scaled and centred.
    expect(start![0]).toBeCloseTo(300 * 0.375 + 37.5, 0);
    expect(start![1]).toBeCloseTo(400 * 0.375, 0);
    out.destroy();
  });
});

describe("copying pages with annotations", () => {
  const annotated = () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 400, 400], 0, doc.newDictionary(), ""));
    const page = doc.loadPage(0);
    const note = page.createAnnotation("Text");
    note.setRect([50, 300, 70, 320]);
    note.setContents("Look here");
    note.update();
    const field = page.createAnnotation("Widget");
    field.setRect([50, 100, 250, 130]);
    const object = field.getObject();
    object.put("FT", doc.newName("Tx"));
    object.put("T", doc.newString("name"));
    object.put("V", doc.newString("Ada"));
    const root = doc.getTrailer().get("Root");
    const form = doc.newDictionary();
    const fields = doc.newArray();
    fields.push(object);
    form.put("Fields", fields);
    root.put("AcroForm", form);
    field.update();
    const bytes = new Uint8Array(doc.saveToBuffer("").asUint8Array()).buffer;
    doc.destroy();
    return bytes;
  };

  const inspect = (bytes: Uint8Array, index: number) => {
    const out = mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
    const page = out.loadPage(index);
    const notes = page.getAnnotations().map((annotation) => annotation.getContents());
    const widgets = page.getWidgets().map((widget) => widget.getValue());
    const fieldCount = out.getTrailer().get("Root").get("AcroForm").get("Fields").length;
    out.destroy();
    return { notes, widgets, fieldCount };
  };

  it("keeps notes and form fields on duplicated pages", async () => {
    const engine = await engineWith(annotated());
    const copy = await engine.appendPages({ type: "copy", source: 0 });
    expect(inspect(copy.bytes, 1)).toEqual({ notes: ["Look here"], widgets: ["Ada"], fieldCount: 2 });
    const exported = await engine.exportDocument(request({ pageOrder: [0, 1] }));
    expect(inspect(exported.bytes, 1)).toEqual({ notes: ["Look here"], widgets: ["Ada"], fieldCount: 2 });
    // Exporting a subset keeps only the fields on exported pages.
    const subset = await engine.exportDocument(request({ pageOrder: [1] }));
    expect(inspect(subset.bytes, 0)).toEqual({ notes: ["Look here"], widgets: ["Ada"], fieldCount: 1 });
  });

  it("keeps them when inserting another PDF", async () => {
    const engine = await engineWith(makePdf([{}]));
    const imported = await engine.appendPages({ type: "pdf", bytes: annotated() });
    expect(inspect(imported.bytes, 1)).toEqual({ notes: ["Look here"], widgets: ["Ada"], fieldCount: 1 });
  });
});

describe("page analysis for conversion", () => {
  const reportPdf = () => {
    const doc = new mupdf.PDFDocument();
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
    fonts.put("F2", doc.addSimpleFont(new mupdf.Font("Helvetica-Bold")));
    fonts.put("F3", doc.addSimpleFont(new mupdf.Font("Times-Italic")));
    resources.put("Font", fonts);
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 300, 200], false);
    pixmap.clear(90);
    const xobjects = doc.newDictionary();
    xobjects.put("Im1", doc.addImage(new mupdf.Image(pixmap)));
    resources.put("XObject", xobjects);
    const body = [
      "BT /F2 24 Tf 72 720 Td (Annual Report) Tj ET",
      "BT /F1 11 Tf 72 690 Td (Sales rose in every region.) Tj /F3 11 Tf ( Truly) Tj ET",
      "BT /F1 11 Tf 72 676 Td (The second line of the paragraph.) Tj ET",
      "0 0 0 RG 1 w 72 600 m 400 600 l S 72 575 m 400 575 l S 72 550 m 400 550 l S 72 550 m 72 600 l S 236 550 m 236 600 l S 400 550 m 400 600 l S",
      "BT /F2 11 Tf 80 582 Td (Region) Tj ET BT /F2 11 Tf 244 582 Td (Revenue) Tj ET",
      "BT /F1 11 Tf 80 557 Td (North) Tj ET BT /F1 11 Tf 244 557 Td (1,200) Tj ET",
      "q 150 0 0 100 72 400 cm /Im1 Do Q",
      "1 0 0 rg BT /F1 9 Tf 72 380 Td (Figure 1) Tj ET",
    ].join("\n");
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, body));
    const bytes = new Uint8Array(doc.saveToBuffer("").asUint8Array()).buffer;
    doc.destroy();
    return bytes;
  };

  it("reports styled spans, images, rules and table grids in points", async () => {
    const engine = createEngine(mupdf);
    const [page] = await engine.analyzeBytes(reportPdf());
    expect(page!.width).toBe(612);
    const heading = page!.spans.find((span) => span.text === "Annual Report")!;
    expect(heading).toMatchObject({ size: 24, bold: true, serif: false });
    expect(heading.baseline).toBeCloseTo(792 - 720, 0);
    const italic = page!.spans.find((span) => span.text.includes("Truly"))!;
    expect(italic).toMatchObject({ italic: true, serif: true });
    expect(page!.spans.find((span) => span.text === "Figure 1")!.color).toBe("#ff0000");
    // Words on one line keep their spaces; the two lines of the paragraph share a block.
    const first = page!.spans.find((span) => span.text.startsWith("Sales"))!;
    expect(first.text).toBe("Sales rose in every region.");
    expect(page!.spans.find((span) => span.text.startsWith("The second"))!.block).toBe(first.block);

    expect(page!.images).toHaveLength(1);
    expect(page!.images[0]).toMatchObject({ x: 72, width: 150, height: 100, mimeType: "image/jpeg" });
    expect(page!.images[0]!.y).toBeCloseTo(792 - 500, 0);

    const table = page!.tables.find((item) => item.ruled)!;
    [72, 236, 400].forEach((x, index) => expect(Math.abs(table.columns[index]! - x)).toBeLessThan(1));
    [192, 217, 242].forEach((y, index) => expect(Math.abs(table.rows[index]! - y)).toBeLessThan(1));
    expect(page!.rects.filter((rect) => rect.stroked).length).toBeGreaterThanOrEqual(6);
  });

  it("renders a page without its text", async () => {
    const engine = createEngine(mupdf);
    const png = await engine.renderBytesWithoutText(reportPdf(), 0, 1);
    const image = new mupdf.Image(png);
    const pixels = image.toPixmap();
    // The heading area is blank; the table rule is still there.
    const at = (x: number, y: number) => pixels.getPixels()[(y * pixels.getWidth() + x) * pixels.getNumberOfComponents()]!;
    let dark = 0;
    for (let x = 72; x < 230; x += 1) for (let y = 55; y < 75; y += 1) if (at(x, y) < 128) dark += 1;
    expect(dark).toBe(0);
    expect(Math.min(at(150, 191), at(150, 192), at(150, 193))).toBeLessThan(160);
  });
});

describe("HTML layout", () => {
  it("lays out parts on pages of their own size", async () => {
    const engine = createEngine(mupdf);
    const long = `<p>${"Many words to fill the page. ".repeat(400)}</p>`;
    const bytes = await engine.htmlToPdf([
      { html: `<html><head><style>@page{margin:72pt}</style></head><body><h1>Title</h1>${long}</body></html>`, width: 612, height: 792 },
      { html: "<html><body><p>Wide part</p></body></html>", width: 792, height: 612 },
    ]);
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const count = doc.countPages();
    expect(count).toBeGreaterThan(2);
    expect(doc.loadPage(0).getBounds()).toEqual([0, 0, 612, 792]);
    expect(doc.loadPage(count - 1).getBounds()).toEqual([0, 0, 792, 612]);
    expect(doc.loadPage(count - 1).toStructuredText("").asText()).toContain("Wide part");
    expect(doc.loadPage(0).toStructuredText("").asText()).toContain("Title");
    doc.destroy();
  });
});

describe("bookmarks", () => {
  it("replaces the outline with nested entries in export order", async () => {
    const engine = await engineWith(makePdf([{}, {}, {}]));
    const exported = await engine.exportDocument(
      request({
        pageOrder: [2, 0, 1],
        bookmarks: [
          { title: "Chapter A", page: 0, depth: 0 },
          { title: "Section A.1", page: 1, top: 0.5, depth: 1 },
          { title: "Deep jump", page: 2, depth: 3 },
          { title: "Website", page: null, depth: 0, uri: "https://example.com/" },
          { title: "   ", page: 0, depth: 0 },
          { title: "Missing page", page: 9, depth: 0 },
        ],
      }),
    );
    const engineAfter = await engineWith(new Uint8Array(exported.bytes).buffer);
    const outline = await engineAfter.getOutline();
    expect(outline.map((entry) => [entry.title, entry.page, entry.depth, entry.uri ?? null])).toEqual([
      ["Chapter A", 0, 0, null],
      ["Section A.1", 1, 1, null],
      ["Deep jump", 2, 2, null],
      ["Website", null, 0, "https://example.com/"],
    ]);
  });

  it("keeps the file's outline when bookmarks are not edited", async () => {
    const doc = new mupdf.PDFDocument();
    for (let index = 0; index < 2; index += 1) doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, doc.newDictionary(), ""));
    doc.outlineIterator().insert({ title: "Original", uri: "#page=2", open: true });
    const engine = await engineWith(new Uint8Array(doc.saveToBuffer("").asUint8Array()).buffer);
    const exported = await engine.exportDocument(request({ pageOrder: [0, 1] }));
    const outline = await (await engineWith(new Uint8Array(exported.bytes).buffer)).getOutline();
    expect(outline.map((entry) => entry.title)).toEqual(["Original"]);
  });
});

describe("annotation list", () => {
  it("lists notes and markup with the text they mark", async () => {
    const doc = new mupdf.PDFDocument();
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
    resources.put("Font", fonts);
    doc.insertPage(-1, doc.addPage([0, 0, 400, 400], 0, resources, "BT /F1 14 Tf 40 340 Td (Important sentence here) Tj ET BT /F1 14 Tf 40 300 Td (Other line) Tj ET"));
    const page = doc.loadPage(0);
    const highlight = page.createAnnotation("Highlight");
    highlight.setQuadPoints([[40, 46, 210, 46, 40, 64, 210, 64]]);
    highlight.setAuthor("Ada");
    highlight.setContents("Check this");
    highlight.setColor([1, 1, 0]);
    highlight.update();
    const note = page.createAnnotation("Text");
    note.setRect([300, 300, 320, 320]);
    note.setContents("A sticky note");
    note.update();
    const link = page.createLink([40, 100, 100, 110], "https://example.com");
    void link;
    const engine = await engineWith(new Uint8Array(doc.saveToBuffer("").asUint8Array()).buffer);
    const found = await engine.listAnnotations();
    expect(found.map((item) => [item.type, item.text, item.comment, item.author, item.color])).toEqual([
      ["Highlight", "Important sentence here", "Check this", "Ada", "#ffff00"],
      ["Text", "", "A sticky note", "", expect.any(String)],
    ]);
    expect(found[0]!.y).toBeCloseTo(46 / 400, 1);
  });
});

describe("document search", () => {
  it("finds lines on every page in one call, and again after caching", async () => {
    const engine = await engineWith(
      makePdf([
        { content: "BT /F1 12 Tf 60 700 Td (Annual Report) Tj ET BT /F1 12 Tf 60 680 Td (Nothing here) Tj ET" },
        { content: "BT /F1 12 Tf 60 700 Td (Summary of the report) Tj ET" },
        { content: "BT /F1 12 Tf 60 700 Td (Appendix) Tj ET" },
      ]),
    );
    const found = await engine.findText("report", false);
    expect(found.map((item) => [item.page, item.lines.map((line) => line.text.trim())])).toEqual([
      [0, ["Annual Report"]],
      [1, ["Summary of the report"]],
    ]);
    expect((await engine.findText("Report", true)).map((item) => item.page)).toEqual([0]);
    // The cached text still finds new terms on pages that matched nothing before.
    expect((await engine.findText("appendix", false)).map((item) => item.page)).toEqual([2]);
    expect(await engine.findText("", false)).toEqual([]);
  });
});
