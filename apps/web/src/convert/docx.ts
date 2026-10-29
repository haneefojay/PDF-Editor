// PDF → Word: flowing, editable paragraphs, headings, tables and pictures,
// one PDF page per Word page.
import type { PageLayout } from "@paperless/pdf-engine";
import { contentTypes, coreProperties, emu, escapeXml, hexColor, packageRelationships, twips, writePackage, XML_HEADER, type PackagePart } from "./ooxml";
import { bodySize, structurePage, type Item, type PageStructure, type Paragraph, type Run, type Table } from "./structure";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function runXml(run: Run) {
  if ("tab" in run) return "<w:r><w:tab/></w:r>";
  const font = escapeXml(run.font);
  return `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/>${run.bold ? "<w:b/><w:bCs/>" : ""}${run.italic ? "<w:i/><w:iCs/>" : ""}<w:color w:val="${hexColor(run.color)}"/><w:sz w:val="${Math.max(2, Math.round(run.size * 2))}"/><w:szCs w:val="${Math.max(2, Math.round(run.size * 2))}"/></w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

type Place = { before: number; left: number; right: number; pageBreak: boolean };

function paragraphXml(paragraph: Paragraph, place: Place, inCell = false) {
  const jc = { left: "left", center: "center", right: "right", justify: "both" }[paragraph.alignment];
  const spacing =
    paragraph.lineGap > 0
      ? `<w:spacing w:before="${twips(place.before)}" w:after="0" w:line="${twips(paragraph.lineGap)}" w:lineRule="atLeast"/>`
      : `<w:spacing w:before="${twips(place.before)}" w:after="0" w:line="240" w:lineRule="auto"/>`;
  const indent =
    paragraph.alignment === "center" || inCell
      ? ""
      : `<w:ind w:left="${twips(Math.max(0, place.left))}" w:right="${twips(Math.max(0, place.right))}"${
          paragraph.firstLineIndent > 1 ? ` w:firstLine="${twips(paragraph.firstLineIndent)}"` : paragraph.firstLineIndent < -1 ? ` w:hanging="${twips(-paragraph.firstLineIndent)}"` : ""
        }/>`;
  const tabs = paragraph.tabs.length
    ? `<w:tabs>${paragraph.tabs.map((tab) => `<w:tab w:val="left" w:pos="${twips(Math.max(0, tab - (paragraph.x - place.left)))}"/>`).join("")}</w:tabs>`
    : "";
  const style = paragraph.heading ? `<w:pStyle w:val="Heading${paragraph.heading}"/>` : "";
  const border = paragraph.borderBelow
    ? `<w:pBdr><w:bottom w:val="single" w:sz="${Math.min(96, Math.max(2, Math.round(paragraph.borderBelow.width * 8)))}" w:space="${Math.min(31, Math.round(paragraph.borderBelow.space))}" w:color="${hexColor(paragraph.borderBelow.color)}"/></w:pBdr>`
    : "";
  return `<w:p><w:pPr>${style}${place.pageBreak ? "<w:pageBreakBefore/>" : ""}${border}${tabs}${spacing}${indent}<w:jc w:val="${jc}"/></w:pPr>${paragraph.runs.map(runXml).join("")}</w:p>`;
}

function tableXml(table: Table, left: number) {
  const widths = table.columns.slice(1).map((x, index) => Math.max(10, x - table.columns[index]!));
  const border = table.ruled ? "single" : "none";
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="${border}" w:sz="4" w:space="0" w:color="000000"/>`).join("");
  const rows = table.cells
    .map((row, rowIndex) => {
      const height = table.rows[rowIndex + 1]! - table.rows[rowIndex]!;
      const cells = row
        .map((paragraphs, column) => {
          const fill = table.fills[rowIndex]![column];
          const content = paragraphs.length ? paragraphs.map((paragraph) => paragraphXml(paragraph, { before: 0, left: 0, right: 0, pageBreak: false }, true)).join("") : "<w:p/>";
          return `<w:tc><w:tcPr><w:tcW w:w="${twips(widths[column]!)}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${hexColor(fill)}"/>` : ""}<w:vAlign w:val="center"/></w:tcPr>${content}</w:tc>`;
        })
        .join("");
      return `<w:tr><w:trPr><w:trHeight w:val="${twips(height)}" w:hRule="atLeast"/></w:trPr>${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${twips(table.width)}" w:type="dxa"/><w:tblInd w:w="${twips(Math.max(0, left))}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="20" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="20" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${twips(width)}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`;
}

/** A tiny paragraph, for page breaks before tables and after them. */
const spacer = (pageBreak: boolean) => `<w:p><w:pPr>${pageBreak ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;

const sectionXml = (page: PageStructure) =>
  `<w:sectPr><w:pgSz w:w="${twips(page.width)}" w:h="${twips(page.height)}"${page.width > page.height ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${twips(page.margins.top)}" w:right="${twips(page.margins.right)}" w:bottom="${twips(Math.min(page.margins.bottom, 36))}" w:left="${twips(page.margins.left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;

export async function buildDocx(layouts: PageLayout[], title: string) {
  const body = bodySize(layouts);
  const pages = layouts.map((layout) => structurePage(layout, body));
  const media: PackagePart[] = [];
  const relationships: string[] = [];
  let drawing = 0;

  const imageXml = (item: Extract<Item, { kind: "image" }>, page: PageStructure, place: Place) => {
    drawing += 1;
    const id = `rIdImage${drawing}`;
    const extension = item.mimeType === "image/png" ? "png" : "jpeg";
    media.push({ name: `word/media/image${drawing}.${extension}`, data: item.data, compress: false });
    relationships.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${drawing}.${extension}"/>`);
    const room = page.width - page.margins.left - page.margins.right;
    const scale = Math.min(1, room / item.width);
    const [cx, cy] = [emu(item.width * scale), emu(item.height * scale)];
    const centred = Math.abs(item.x + item.width / 2 - page.width / 2) < page.width * 0.04 && item.width < room * 0.9;
    return `<w:p><w:pPr>${place.pageBreak ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="${twips(place.before)}" w:after="0"/>${centred ? '<w:jc w:val="center"/>' : `<w:ind w:left="${twips(Math.max(0, Math.min(place.left, room - item.width * scale)))}"/>`}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawing}" name="Picture ${drawing}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawing}" name="image${drawing}.${extension}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  };

  const parts: string[] = [];
  pages.forEach((page, pageIndex) => {
    let previousBottom = page.margins.top;
    let previousBaseline: number | null = null;
    const contentRight = page.width - page.margins.right;
    page.items.forEach((item, index) => {
      const pageBreak = pageIndex > 0 && index === 0;
      // Vertical space is kept as space before each item: between lines of
      // text from baseline to baseline, otherwise from the boxes.
      const before =
        item.kind === "paragraph" && previousBaseline !== null
          ? item.lines[0]!.baseline - previousBaseline - item.size * 1.15
          : item.y - previousBottom - (item.kind === "paragraph" ? item.size * 0.2 : 0);
      // Multi-line text keeps its width, so lines break where they did.
      const right = item.kind === "paragraph" && item.lines.length > 1 && item.alignment !== "center" ? contentRight - (item.x + item.width) - item.size * 0.5 : 0;
      const place: Place = { before: Math.min(Math.max(0, before), 400), left: item.x - page.margins.left, right, pageBreak };
      if (item.kind === "paragraph") parts.push(paragraphXml(item, place));
      else if (item.kind === "image") parts.push(imageXml(item, page, place));
      else {
        if (pageBreak || before > 2) parts.push(spacer(pageBreak).replace('w:before="0"', `w:before="${twips(Math.min(before, 400))}"`));
        parts.push(tableXml(item, item.x - page.margins.left), spacer(false));
      }
      previousBottom = Math.max(previousBottom, item.y + item.height);
      previousBaseline = item.kind === "paragraph" ? item.lines.at(-1)!.baseline : null;
    });
    if (!page.items.length) parts.push(`<w:p>${pageIndex ? "<w:pPr><w:pageBreakBefore/></w:pPr>" : ""}</w:p>`);
    // A change of paper size starts a new section.
    const next = pages[pageIndex + 1];
    if (next && (Math.abs(next.width - page.width) > 1 || Math.abs(next.height - page.height) > 1)) parts.push(`<w:p><w:pPr>${sectionXml(page)}</w:pPr></w:p>`);
  });

  const last = pages.at(-1) ?? { width: 612, height: 792, margins: { left: 72, right: 72, top: 72, bottom: 72 }, items: [] };
  const document = `${XML_HEADER}<w:document ${W}><w:body>${parts.join("")}${sectionXml(last)}</w:body></w:document>`;
  const mostUsedFont = (() => {
    const counts = new Map<string, number>();
    for (const page of pages)
      for (const item of page.items)
        if (item.kind === "paragraph") for (const run of item.runs) if (!("tab" in run)) counts.set(run.font, (counts.get(run.font) ?? 0) + run.text.length);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Arial";
  })();
  const font = escapeXml(mostUsedFont);
  const heading = (level: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`;
  const styles = `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${Math.round(body * 2)}"/><w:szCs w:val="${Math.round(body * 2)}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${[1, 2, 3].map(heading).join("")}<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const settings = `${XML_HEADER}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const documentRelationships = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${relationships.join("")}</Relationships>`;

  return writePackage([
    {
      name: "[Content_Types].xml",
      data: contentTypes(
        [
          ["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
          ["/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"],
          ["/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"],
        ],
        true,
      ),
    },
    { name: "_rels/.rels", data: packageRelationships({ type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "word/document.xml" }) },
    ...coreProperties(title, "Paperless PDF Editor"),
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: styles },
    { name: "word/settings.xml", data: settings },
    { name: "word/_rels/document.xml.rels", data: documentRelationships },
    ...media,
  ]);
}
