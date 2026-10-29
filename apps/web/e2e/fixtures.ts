import * as mupdf from "mupdf";
import { inflateRawSync } from "node:zlib";
import { homography, project } from "../src/scan/geometry";

/** A small report with a heading, a table, a coloured block and a rotated page. */
export function samplePdf(saveOptions = "garbage=3,compress=yes") {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  resources.put("Font", fonts);
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  fonts.put("F2", doc.addSimpleFont(new mupdf.Font("Helvetica-Bold")));
  fonts.put("F3", doc.addSimpleFont(new mupdf.Font("Times-Roman")));
  const first = [
    "BT /F2 26 Tf 60 730 Td (Quarterly Report) Tj ET",
    "BT /F1 12 Tf 60 700 Td (Prepared for the board of directors, October 2026.) Tj ET",
    "BT /F3 12 Tf 60 670 Td (Revenue grew steadily across every region this quarter.) Tj ET",
    "0.2 0.2 0.2 RG 1 w 60 600 m 540 600 l S 60 570 m 540 570 l S 60 540 m 540 540 l S 60 510 m 540 510 l S",
    "60 510 m 60 600 l S 300 510 m 300 600 l S 540 510 m 540 600 l S",
    "BT /F2 12 Tf 70 580 Td (Region) Tj ET BT /F2 12 Tf 310 580 Td (Revenue) Tj ET",
    "BT /F1 12 Tf 70 550 Td (North) Tj ET BT /F1 12 Tf 310 550 Td ($1,200,000) Tj ET",
    "BT /F1 12 Tf 70 520 Td (South) Tj ET BT /F1 12 Tf 310 520 Td ($980,000) Tj ET",
    "0.84 0.29 0.21 rg 60 380 200 90 re f 1 1 1 rg BT /F2 16 Tf 80 420 Td (Highlights) Tj ET",
  ].join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, first));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, "BT /F1 14 Tf 60 720 Td (Page two: appendix and notes.) Tj ET 0 0 1 rg 60 600 150 80 re f"));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 90, resources, "BT /F1 14 Tf 60 720 Td (Page three is rotated in the source.) Tj ET"));
  const bytes = Buffer.from(doc.saveToBuffer(saveOptions).asUint8Array());
  doc.destroy();
  return bytes;
}

export function pngImage(width = 400, height = 200, gray = 160) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  pixmap.clear(gray);
  return Buffer.from(pixmap.asPNG());
}

export function inspectPdf(bytes: Buffer, password?: string) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
  const needsPassword = doc.needsPassword();
  if (password) doc.authenticatePassword(password);
  const pages = Array.from({ length: doc.countPages() }, (_, index) => {
    const page = doc.loadPage(index);
    const info = {
      text: page.toStructuredText("").asText(),
      annotations: page.getAnnotations().map((annotation) => annotation.getType()),
      widgets: page.getWidgets().length,
      rotate: page.getObject().getInheritable("Rotate").valueOf(),
      size: [page.getBounds()[2] - page.getBounds()[0], page.getBounds()[3] - page.getBounds()[1]].map((value) => Math.round(value)),
    };
    page.destroy();
    return info;
  });
  doc.destroy();
  return { needsPassword, pages };
}

/** Twelve chapters with an outline, an internal link and a web link on page 1. */
export function longPdf() {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  resources.put("Font", fonts);
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  for (let index = 0; index < 12; index += 1) {
    const lines = [`BT /F1 24 Tf 60 730 Td (Chapter ${index + 1}) Tj ET`];
    for (let line = 0; line < 20; line += 1) lines.push(`BT /F1 11 Tf 60 ${690 - line * 26} Td (Line ${line + 1} of chapter ${index + 1}) Tj ET`);
    if (index === 0) lines.push("BT /F1 12 Tf 60 120 Td (Go to chapter 9) Tj ET BT /F1 12 Tf 60 95 Td (Visit example.com) Tj ET");
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, lines.join("\n")));
  }
  const destination = (page: number) => doc.formatLinkURI({ type: "Fit", chapter: 0, page, x: 0, y: 0, width: 0, height: 0, zoom: 0 });
  const first = doc.loadPage(0);
  first.createLink([60, 657, 200, 675], destination(8));
  first.createLink([60, 682, 200, 700], "https://example.com/");
  const outline = doc.outlineIterator();
  for (const [title, page] of [["Introduction", 0], ["Methods", 3], ["Results", 6], ["Appendix", 11]] as const)
    outline.insert({ title, uri: destination(page), open: true });
  outline.destroy();
  const bytes = Buffer.from(doc.saveToBuffer("garbage=3,compress=yes").asUint8Array());
  doc.destroy();
  return bytes;
}

/** A plain document with many pages, for checking that long files stay light. */
export function manyPagesPdf(pages: number) {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  resources.put("Font", fonts);
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  for (let index = 0; index < pages; index += 1) {
    const lines = [`BT /F1 24 Tf 60 730 Td (Page ${index + 1}) Tj ET`];
    for (let line = 0; line < 20; line += 1) lines.push(`BT /F1 10 Tf 60 ${690 - line * 22} Td (Line ${line + 1} of page ${index + 1}) Tj ET`);
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, lines.join("\n")));
  }
  const bytes = Buffer.from(doc.saveToBuffer("garbage=3,compress=yes").asUint8Array());
  doc.destroy();
  return bytes;
}

export const PARAGRAPH_LINES = [
  "Paperless keeps every document on your own device. Nothing is",
  "uploaded, so private contracts, medical letters and bank papers",
  "never leave the phone or computer you are working on, and the",
  "editor works the same way with or without a network connection.",
];

/** A heading followed by a wrapped paragraph of four lines. */
export function paragraphPdf() {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  resources.put("Font", fonts);
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  fonts.put("F2", doc.addSimpleFont(new mupdf.Font("Helvetica-Bold")));
  const body = PARAGRAPH_LINES.map((line, index) => `${index ? "0 -16 Td " : ""}(${line}) Tj`).join(" ");
  const content = `BT /F2 20 Tf 72 720 Td (Privacy first) Tj ET BT /F1 12 Tf 72 680 Td ${body} ET`;
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content));
  const bytes = Buffer.from(doc.saveToBuffer("").asUint8Array());
  doc.destroy();
  return bytes;
}

/** A black image drawn on a blue panel. */
export function imageOnPanelPdf() {
  const doc = new mupdf.PDFDocument();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 40], false);
  pixmap.clear(0);
  const resources = doc.newDictionary();
  const xobjects = doc.newDictionary();
  xobjects.put("Im1", doc.addImage(new mupdf.Image(pixmap)));
  resources.put("XObject", xobjects);
  const content = "0 0 1 rg 60 400 400 300 re f q 120 0 0 120 100 500 cm /Im1 Do Q";
  doc.insertPage(-1, doc.addPage([0, 0, 600, 800], 0, resources, content));
  const bytes = Buffer.from(doc.saveToBuffer("").asUint8Array());
  doc.destroy();
  return bytes;
}

/** RGB of a page pixel at normalized coordinates. */
export function colourAt(bytes: Buffer, x: number, y: number, page = 0) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pixmap = doc.loadPage(page).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const offset = (Math.round(y * (pixmap.getHeight() - 1)) * pixmap.getWidth() + Math.round(x * (pixmap.getWidth() - 1))) * pixmap.getNumberOfComponents();
  const pixels = pixmap.getPixels();
  const rgb = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
  doc.destroy();
  return rgb;
}

/** Files in a ZIP archive, stored or deflated. */
export function readStoredZip(bytes: Buffer) {
  const files: { name: string; data: Buffer }[] = [];
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const method = bytes.readUInt16LE(at + 8);
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extra = bytes.readUInt16LE(at + 28);
    const start = at + 30 + nameLength + extra;
    const raw = bytes.subarray(start, start + size);
    files.push({ name: bytes.subarray(at + 30, at + 30 + nameLength).toString("utf8"), data: method === 8 ? inflateRawSync(raw) : raw });
    at = start + size;
  }
  return files;
}
export const zipText = (bytes: Buffer, name: string) => readStoredZip(bytes).find((file) => file.name === name)?.data.toString("utf8") ?? "";

/** Where a 300×400 page lands in a photo taken by a pinhole camera, tilted back and turned a little. */
function photographedCorners(width: number, height: number) {
  const tilt = (30 * Math.PI) / 180;
  const turn = (6 * Math.PI) / 180;
  const focal = 0.95 * width;
  const distance = 1.6 * focal * (400 / height);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const [x0, y0] = [sx * 150, sy * 200];
    const [x1, y1] = [x0 * Math.cos(turn) - y0 * Math.sin(turn), x0 * Math.sin(turn) + y0 * Math.cos(turn)];
    const z = distance - y1 * Math.sin(tilt);
    return { x: (focal * x1) / z + width / 2, y: (focal * y1 * Math.cos(tilt)) / z + height / 2 };
  });
}

/**
 * A photo of a printed page lying at an angle on a dark desk: luminance values
 * row by row. The page reads "INVOICE" and a total in large type.
 */
export function scanScene(width = 640, height = 480) {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  resources.put("Font", fonts);
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica-Bold")));
  doc.insertPage(-1, doc.addPage([0, 0, 300, 400], 0, resources, "BT /F1 50 Tf 30 300 Td (INVOICE) Tj ET BT /F1 34 Tf 30 200 Td (TOTAL 250) Tj ET 0 g 30 120 240 6 re f"));
  const pixmap = doc.loadPage(0).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceGray, false, true);
  const page = { width: pixmap.getWidth(), height: pixmap.getHeight(), pixels: pixmap.getPixels() };
  const corners = photographedCorners(width, height);
  const toPage = homography(corners, [
    { x: 0, y: 0 },
    { x: page.width, y: 0 },
    { x: page.width, y: page.height },
    { x: 0, y: page.height },
  ]);
  const luma = new Uint8Array(width * height);
  let seed = 3;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 20;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const point = project(toPage, { x: x + 0.5, y: y + 0.5 });
      const onPage = point.x >= 0 && point.y >= 0 && point.x < page.width && point.y < page.height;
      // Light falls off to the left, as from a window.
      const light = 0.78 + 0.22 * (x / width);
      luma[y * width + x] = onPage ? page.pixels[Math.floor(point.y) * page.width + Math.floor(point.x)]! * light : 55 + noise();
    }
  doc.destroy();
  return { width, height, luma };
}

/** The scene as a Y4M video file for Chromium's fake camera. */
export function scanVideo() {
  const { width, height, luma } = scanScene();
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\nFRAME\n`);
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  return Buffer.concat([header, Buffer.from(luma), chroma]);
}

/** The scene as a PNG photo. */
export function scanPhoto(width = 640, height = 480) {
  const { luma } = scanScene(width, height);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const pixels = pixmap.getPixels();
  for (let index = 0; index < luma.length; index += 1) pixels[index * 3] = pixels[index * 3 + 1] = pixels[index * 3 + 2] = luma[index]!;
  return Buffer.from(pixmap.asPNG());
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';

/** A Word file: heading style, bullet list, a bordered table, a page break and a landscape second section. */
export async function wordFile() {
  const para = (text: string, props = "") => `<w:p><w:pPr>${props}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2880" w:type="dxa"/></w:tcPr>${para(text)}</w:tc>`;
  const body = [
    para("Meeting Notes", '<w:pStyle w:val="Heading1"/>'),
    `<w:p><w:r><w:t xml:space="preserve">We agreed the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>budget</w:t></w:r><w:r><w:t xml:space="preserve"> and the plan.</w:t></w:r></w:p>`,
    para("Order the beds", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    para("Book the van", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid><w:tr>${cell("Owner")}${cell("Task")}</w:tr><w:tr>${cell("Sam")}${cell("Soil delivery")}</w:tr></w:tbl>`,
    `<w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>Second page text</w:t></w:r><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:pPr></w:p>`,
    para("Landscape appendix"),
    `<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>`,
  ].join("");
  const { writePackage } = await import("../src/convert/ooxml");
  const bytes = await writePackage([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", data: `${RELS}<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `${RELS}<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>` },
    { name: "word/styles.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="36"/></w:rPr></w:style></w:styles>` },
    { name: "word/numbering.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>` },
  ]);
  return Buffer.from(bytes);
}

/** An Excel workbook with a currency column and a date. */
export async function excelFile() {
  const { writePackage } = await import("../src/convert/ooxml");
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr" s="1"><is><t>Item</t></is></c><c r="B1" t="inlineStr" s="1"><is><t>Cost</t></is></c><c r="C1" t="inlineStr" s="1"><is><t>Due</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Raised beds</t></is></c><c r="B2" s="2"><v>2400</v></c><c r="C2" s="3"><v>46083</v></c></row></sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/><xf numFmtId="15" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`;
  const bytes = await writePackage([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
    { name: "_rels/.rels", data: `${RELS}<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Costs" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", data: `${RELS}<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    { name: "xl/styles.xml", data: styles },
  ]);
  return Buffer.from(bytes);
}

/** The outline of a PDF as [title, page, depth] rows. */
export function outlineOf(bytes: Buffer) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const rows: [string, number | null, number][] = [];
  const walk = (items: ReturnType<mupdf.Document["loadOutline"]> | undefined, depth: number) => {
    for (const item of items ?? []) {
      rows.push([item.title ?? "", item.page ?? null, depth]);
      walk(item.down, depth + 1);
    }
  };
  walk(doc.loadOutline(), 0);
  doc.destroy();
  return rows;
}

/** Three pages; page 3 has a highlight with a comment and a sticky note from another app. */
export function annotatedPdf() {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  resources.put("Font", fonts);
  for (let index = 0; index < 3; index += 1)
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, `BT /F1 18 Tf 72 700 Td (Page ${index + 1} heading) Tj ET BT /F1 12 Tf 72 400 Td (The contract renews every year in March.) Tj ET`));
  const page = doc.loadPage(2);
  const highlight = page.createAnnotation("Highlight");
  highlight.setQuadPoints([[72, 378, 320, 378, 72, 396, 320, 396]]);
  highlight.setColor([1, 0.85, 0]);
  highlight.setAuthor("Lee");
  highlight.setContents("Is this still right?");
  highlight.update();
  const note = page.createAnnotation("Text");
  note.setRect([500, 80, 520, 100]);
  note.setContents("Signed copy is in the drawer.");
  note.setAuthor("Sam");
  note.update();
  const bytes = Buffer.from(doc.saveToBuffer("").asUint8Array());
  doc.destroy();
  return bytes;
}

/** A small PowerPoint deck: two shown slides and one hidden one. */
export async function presentationFile() {
  const { presentationPptx } = await import("../src/convert/samples");
  return Buffer.from(await presentationPptx());
}
