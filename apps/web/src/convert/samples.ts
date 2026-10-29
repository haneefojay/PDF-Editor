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

/**
 * A 16:9 presentation built the way PowerPoint saves one: a theme, a master
 * with text styles and a footer, and a layout whose placeholders the slides
 * fill. Slide 1 has a title, bullets, a turned shape and a table; slide 2 is
 * hidden; slide 3 has a cropped picture on a dark background and a slide number.
 */
export async function presentationPptx() {
  const { writePackage } = await import("./ooxml");
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const rels = (items: [string, string][]) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([type, target], index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;
  const xfrm = (x: number, y: number, w: number, h: number, extra = "") => `<a:xfrm${extra}><a:off x="${x * 12700}" y="${y * 12700}"/><a:ext cx="${w * 12700}" cy="${h * 12700}"/></a:xfrm>`;
  const placeholder = (id: number, type: string, attrs: string, spPr: string, body = "<a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p>") =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${type} ${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${attrs}/></p:nvPr></p:nvSpPr><p:spPr>${spPr}</p:spPr><p:txBody>${body}</p:txBody></p:sp>`;
  const tree = (shapes: string) => `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree>`;
  const run = (text: string, props = "") => `<a:r><a:rPr lang="en-US"${props}/><a:t>${text}</a:t></a:r>`;
  const colored = (text: string, size: number, color: string) => `<a:r><a:rPr lang="en-US" sz="${size * 100}"><a:solidFill>${color}</a:solidFill></a:rPr><a:t>${text}</a:t></a:r>`;

  const theme = `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Sample"><a:themeElements><a:clrScheme name="Sample"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="2E7D32"/></a:accent1><a:accent2><a:srgbClr val="C62828"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Sample"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Sample"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst/><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const master = `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${tree(
    placeholder(2, "title", "", xfrm(36, 20, 648, 60), '<a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr/></a:p>') +
      placeholder(3, "body", ' idx="1"', xfrm(36, 100, 648, 260)) +
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Footer band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 385, 720, 20)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>`,
  )}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8211;"/><a:defRPr sz="1600"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl2pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  const layout = `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout ${NS} type="obj"><p:cSld name="Title and Content">${tree(placeholder(2, "title", "", "") + placeholder(3, "body", ' idx="1"', xfrm(36, 100, 400, 260)))}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

  const cell = (text: string) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(text, ' sz="1200"')}</a:p></a:txBody><a:tcPr/></a:tc>`;
  const slide1 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS}><p:cSld>${tree(
    placeholder(2, "title", "", "", `<a:bodyPr/><a:lstStyle/><a:p>${run("Garden Plan")}</a:p>`) +
      placeholder(3, "body", ' idx="1"', "", `<a:bodyPr/><a:lstStyle/><a:p>${run("Build the beds")}</a:p><a:p><a:pPr lvl="1"/>${run("Cedar, not pine")}</a:p><a:p>${run("Plant in ")}${run("spring", ' b="1"')}</a:p>`) +
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Badge"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(480, 110, 160, 60, ' rot="-600000"')}<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>${colored("Budget OK", 18, '<a:schemeClr val="lt1"/>')}</a:p></p:txBody></p:sp>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Costs"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${480 * 12700}" y="${220 * 12700}"/><a:ext cx="${200 * 12700}" cy="${60 * 12700}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="${100 * 12700}"/><a:gridCol w="${100 * 12700}"/></a:tblGrid><a:tr h="${30 * 12700}">${cell("Item")}${cell("Cost")}</a:tr><a:tr h="${30 * 12700}">${cell("Soil")}${cell("$900")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
  )}</p:cSld></p:sld>`;
  const slide2 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS} show="0"><p:cSld>${tree(placeholder(2, "title", "", "", `<a:bodyPr/><a:lstStyle/><a:p>${run("Hidden draft")}</a:p>`))}</p:cSld></p:sld>`;
  const slide3 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></p:bgPr></p:bg>${tree(
    `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="50000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(60, 60, 200, 200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Caption"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(300, 60, 360, 200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="b"/><a:lstStyle/><a:p><a:pPr marL="342900" indent="-342900"><a:buAutoNum type="arabicPeriod"/></a:pPr>${colored("Dig", 24, '<a:srgbClr val="FFFFFF"/>')}</a:p><a:p><a:pPr marL="342900" indent="-342900"><a:buAutoNum type="arabicPeriod"/></a:pPr>${colored("Water", 24, '<a:srgbClr val="FFFFFF"/>')}</a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Number"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(640, 350, 60, 30)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{1}" type="slidenum"><a:rPr lang="en-US"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>`,
  )}</p:cSld></p:sld>`;

  // A picture whose left half is red and right half blue; the slide shows only the blue half.
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
  const pixels = pixmap.getPixels();
  for (let index = 0; index < pixels.length; index += 3) {
    const left = (index / 3) % 40 < 20;
    pixels[index] = left ? 220 : 30;
    pixels[index + 1] = 40;
    pixels[index + 2] = left ? 30 : 220;
  }
  const png = new Uint8Array(pixmap.asPNG());
  const ct = "application/vnd.openxmlformats-officedocument.presentationml";
  return writePackage([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="${ct}.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="${ct}.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="${ct}.slide+xml"/><Override PartName="/ppt/slides/slide3.xml" ContentType="${ct}.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${ct}.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${ct}.slideMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>` },
    { name: "_rels/.rels", data: rels([["officeDocument", "ppt/presentation.xml"]]) },
    { name: "ppt/presentation.xml", data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { name: "ppt/_rels/presentation.xml.rels", data: rels([["slideMaster", "slideMasters/slideMaster1.xml"], ["slide", "slides/slide1.xml"], ["slide", "slides/slide2.xml"], ["slide", "slides/slide3.xml"]]) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([["slideLayout", "../slideLayouts/slideLayout1.xml"], ["theme", "../theme/theme1.xml"]]) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([["slideMaster", "../slideMasters/slideMaster1.xml"]]) },
    { name: "ppt/theme/theme1.xml", data: theme },
    ...[slide1, slide2, slide3].flatMap((data, index) => [
      { name: `ppt/slides/slide${index + 1}.xml`, data },
      { name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: rels(index === 2 ? [["slideLayout", "../slideLayouts/slideLayout1.xml"], ["image", "../media/image1.png"]] : [["slideLayout", "../slideLayouts/slideLayout1.xml"]]) },
    ]),
    { name: "ppt/media/image1.png", data: png },
  ]);
}
