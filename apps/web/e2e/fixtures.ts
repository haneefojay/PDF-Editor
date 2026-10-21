import * as mupdf from "mupdf";

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
    };
    page.destroy();
    return info;
  });
  doc.destroy();
  return { needsPassword, pages };
}
