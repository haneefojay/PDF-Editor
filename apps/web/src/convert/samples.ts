// Test documents for the converters, built with MuPDF.
import * as mupdf from "mupdf";

const fonts = (doc: mupdf.PDFDocument) => {
  const resources = doc.newDictionary();
  const table = doc.newDictionary();
  table.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  table.put("F2", doc.addSimpleFont(new mupdf.Font("Helvetica-Bold")));
  table.put("F3", doc.addSimpleFont(new mupdf.Font("Times-Roman")));
  table.put("F4", doc.addSimpleFont(new mupdf.Font("Times-Italic")));
  resources.put("Font", table);
  return resources;
};

const text = (font: string, size: number, x: number, y: number, value: string, color = "0 g") => `${color} BT /${font} ${size} Tf ${x} ${y} Td (${value}) Tj ET`;

export const BODY = [
  "Revenue grew steadily across every region this",
  "quarter, led by strong demand in the north and a",
  "recovering market in the south. Costs stayed flat,",
  "so margins improved for the third quarter in a row.",
];

/** A report: title, subtitle, a justified paragraph, a ruled table with a shaded header, a photo and a caption. */
export function reportPdf() {
  const doc = new mupdf.PDFDocument();
  const resources = fonts(doc);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 320, 200], false);
  const pixels = pixmap.getPixels();
  for (let index = 0; index < pixels.length; index += 3) {
    const x = (index / 3) % 320;
    pixels[index] = 40 + (x % 120);
    pixels[index + 1] = 120;
    pixels[index + 2] = 200 - (x % 90);
  }
  const xobjects = doc.newDictionary();
  xobjects.put("Im1", doc.addImage(new mupdf.Image(pixmap)));
  resources.put("XObject", xobjects);
  const content = [
    text("F2", 26, 72, 716, "Quarterly Report"),
    text("F4", 14, 72, 690, "Prepared for the board, October 2026", "0.3 0.3 0.3 rg"),
    ...BODY.map((line, index) => text("F3", 12, 72, 650 - index * 15, line)),
    text("F2", 16, 72, 570, "Results by region"),
    "0.85 0.9 1 rg 72 520 360 24 re f",
    "0 0 0 RG 0.75 w 72 544 m 432 544 l S 72 520 m 432 520 l S 72 496 m 432 496 l S 72 472 m 432 472 l S",
    "72 472 m 72 544 l S 252 472 m 252 544 l S 432 472 m 432 544 l S",
    text("F2", 11, 80, 528, "Region"),
    text("F2", 11, 260, 528, "Revenue"),
    text("F1", 11, 80, 504, "North"),
    text("F1", 11, 360, 504, "$1,200,000"),
    text("F1", 11, 80, 480, "South"),
    text("F1", 11, 371, 480, "$980,000"),
    "q 240 0 0 150 186 280 cm /Im1 Do Q",
    text("F4", 10, 266, 264, "Figure 1: Sales mix"),
    text("F1", 11, 72, 220, "Total"),
    text("F1", 11, 400, 220, "$2,180,000"),
  ].join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content));
  // A second, landscape page.
  doc.insertPage(-1, doc.addPage([0, 0, 792, 612], 0, resources, [text("F2", 20, 72, 530, "Appendix"), text("F3", 12, 72, 500, "Notes on the method used for this report.")].join("\n")));
  const bytes = new Uint8Array(doc.saveToBuffer("compress").asUint8Array());
  doc.destroy();
  return bytes.buffer;
}

/** Two columns of text under a full-width title. */
export function columnsPdf() {
  const doc = new mupdf.PDFDocument();
  const resources = fonts(doc);
  const content = [text("F2", 22, 72, 720, "Two Column Article")];
  for (let line = 0; line < 8; line += 1) {
    content.push(text("F3", 11, 72, 680 - line * 14, `Left column line ${line + 1} of the text.`));
    content.push(text("F3", 11, 320, 680 - line * 14, `Right column line ${line + 1} of the text.`));
  }
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content.join("\n")));
  const bytes = new Uint8Array(doc.saveToBuffer("").asUint8Array());
  doc.destroy();
  return bytes.buffer;
}

/** Bullets and numbers set apart from their text, and a table whose borders are thin filled boxes. */
export function listsPdf() {
  const doc = new mupdf.PDFDocument();
  const resources = fonts(doc);
  const content = [text("F2", 16, 72, 720, "Goals")];
  ["Grow fresh vegetables", "Teach children about soil", "Create a quiet green space"].forEach((item, index) => {
    // \225 is the bullet in WinAnsi.
    content.push(text("F1", 11, 72, 696 - index * 15, "\\225"), text("F3", 11, 90, 696 - index * 15, item));
  });
  ["Build the beds", "First planting"].forEach((item, index) => content.push(text("F3", 11, 72, 630 - index * 15, `${index + 1}.`), text("F3", 11, 90, 630 - index * 15, item)));
  // Table borders drawn as 0.5pt-thick filled rectangles.
  const top = 560;
  for (let row = 0; row <= 3; row += 1) content.push(`0 g 72 ${top - row * 18} 300 0.5 re f`);
  for (const x of [72, 222, 371.5]) content.push(`0 g ${x} ${top - 54} 0.5 54.5 re f`);
  [["Item", "Cost"], ["Beds", "$2,400"], ["Soil", "$900"]].forEach((cells, row) =>
    cells.forEach((cell, column) => content.push(text("F3", 11, 78 + column * 150, top - 13 - row * 18, cell))),
  );
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content.join("\n")));
  const bytes = new Uint8Array(doc.saveToBuffer("").asUint8Array());
  doc.destroy();
  return bytes.buffer;
}
