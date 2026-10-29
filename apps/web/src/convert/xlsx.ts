// PDF → Excel: one sheet per page, tables cell for cell, other text as rows
// split into columns at tab stops, numbers stored as numbers.
import type { PageLayout } from "@paperless/pdf-engine";
import { contentTypes, coreProperties, escapeXml, hexColor, packageRelationships, writePackage, XML_HEADER } from "./ooxml";
import { bodySize, lastIndex, structurePage, type Paragraph } from "./structure";

export type CellValue = { text: string } | { number: number; format: string };

/** Reads a number the way it was printed: 1,200, $980.50, (12), 7.5%. */
export function parseCell(raw: string): CellValue {
  const text = raw.trim();
  const match = /^(\()?\s*([-+−])?\s*([$€£¥])?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%)?\s*(\))?$/.exec(text);
  if (!match || Boolean(match[1]) !== Boolean(match[7])) return { text };
  const [, open, sign, currency, whole, fraction = "", percent] = match;
  let number = Number(`${whole!.replace(/,/g, "")}${fraction}`);
  if (open || sign === "-" || sign === "−") number = -number;
  const decimals = fraction ? `.${"0".repeat(Math.min(4, fraction.length - 1))}` : "";
  const grouped = whole!.includes(",") || Boolean(currency);
  let format = `${grouped ? "#,##0" : "0"}${decimals}`;
  if (currency) format = `"${currency}"${format}`;
  if (percent) {
    number /= 100;
    format = `0${decimals}%`;
  }
  if (open) format = `${format};(${format})`;
  return { number, format: format === "0" ? "General" : format };
}

type Style = { bold: boolean; fill: string | null; format: string; border: boolean; wrap: boolean; align: "left" | "center" | "right" | null };
/** `spill` cells hold running text that may overflow into empty neighbours. */
type Cell = { value: CellValue; style: Style; spill?: boolean };

const textOf = (paragraph: Paragraph) =>
  paragraph.runs
    .map((run) => ("tab" in run ? "\t" : run.text))
    .join("")
    .trim();

const column = (index: number) => {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
};

export async function buildXlsx(layouts: PageLayout[], title: string) {
  const body = bodySize(layouts);
  const styles: Style[] = [{ bold: false, fill: null, format: "General", border: false, wrap: false, align: null }];
  const styleIndex = (style: Style) => {
    const key = JSON.stringify(style);
    const found = styles.findIndex((item) => JSON.stringify(item) === key);
    if (found >= 0) return found;
    styles.push(style);
    return styles.length - 1;
  };
  const plain = (bold = false): Style => ({ bold, fill: null, format: "General", border: false, wrap: false, align: null });

  const sheets = layouts.map((layout, pageIndex) => {
    const page = structurePage(layout, body);
    const rows: Cell[][] = [];
    // Column starts shared by the tabbed lines of the page.
    const anchors: number[] = [];
    for (const item of page.items)
      if (item.kind === "paragraph" && item.tabs.length)
        for (const x of [item.x, ...item.tabs]) if (!anchors.some((anchor) => Math.abs(anchor - x) < 12)) anchors.push(x);
    anchors.sort((a, b) => a - b);
    const anchorOf = (x: number) => Math.max(0, lastIndex(anchors, (anchor) => anchor <= x + 12));

    for (const item of page.items) {
      if (item.kind === "image") continue;
      if (item.kind === "table") {
        if (rows.length) rows.push([]);
        item.cells.forEach((row, rowIndex) => {
          rows.push(
            row.map((paragraphs, columnIndex) => {
              const text = paragraphs.map(textOf).join("\n");
              const value = paragraphs.length === 1 ? parseCell(text) : { text };
              const bold = paragraphs.length > 0 && paragraphs.every((paragraph) => paragraph.runs.every((run) => "tab" in run || run.bold));
              const align = paragraphs[0]?.alignment === "center" ? "center" : paragraphs[0]?.alignment === "right" && "text" in value ? "right" : null;
              return {
                value,
                style: { bold, fill: item.fills[rowIndex]![columnIndex] ?? null, format: "format" in value ? value.format : "General", border: item.ruled, wrap: text.includes("\n"), align },
              };
            }),
          );
        });
        rows.push([]);
        continue;
      }
      const bold = item.runs.every((run) => "tab" in run || run.bold);
      if (!item.tabs.length) {
        rows.push([{ value: { text: textOf(item) }, style: plain(bold), spill: true }]);
        continue;
      }
      // A tabbed line becomes cells at the page's column starts.
      for (const line of item.lines) {
        const cells: Cell[] = [];
        let current: { column: number; text: string } | null = null;
        line.spans.forEach((span, index) => {
          const previous = line.spans[index - 1];
          const gap = previous ? span.x - (previous.x + previous.width) : Infinity;
          if (!current || gap > span.size * 1.5) {
            if (current) cells[current.column] = { value: parseCell(current.text), style: plain(bold) };
            current = { column: Math.max(anchorOf(span.x), cells.length), text: span.text };
          } else current.text += `${gap > span.size * 0.12 ? " " : ""}${span.text}`;
        });
        const last = current as { column: number; text: string } | null;
        if (last) cells[last.column] = { value: parseCell(last.text), style: plain(bold) };
        for (const cell of cells) if (cell && "number" in cell.value) cell.style = { ...cell.style, format: cell.value.format };
        rows.push(Array.from(cells, (cell) => cell ?? { value: { text: "" }, style: plain() }));
      }
    }
    while (rows.length && !rows.at(-1)!.length) rows.pop();

    const widths: number[] = [];
    rows.forEach((row) =>
      row.forEach((cell, index) => {
        if (cell.spill) return;
        const text = "text" in cell.value ? cell.value.text : String(cell.value.number);
        const longest = Math.max(...text.split("\n").map((part) => part.length));
        widths[index] = Math.max(widths[index] ?? 8, Math.min(60, longest * 1.1 + 2));
      }),
    );
    const sheetRows = rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell, columnIndex) => {
            const reference = `${column(columnIndex)}${rowIndex + 1}`;
            const style = styleIndex(cell.style);
            if ("number" in cell.value) return `<c r="${reference}" s="${style}"><v>${cell.value.number}</v></c>`;
            if (!cell.value.text && !style) return "";
            return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value.text)}</t></is></c>`;
          })
          .join("");
        return cells ? `<row r="${rowIndex + 1}">${cells}</row>` : "";
      })
      .join("");
    const cols = widths.length ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.round(width * 10) / 10}" customWidth="1"/>`).join("")}</cols>` : "";
    return {
      name: `Page ${pageIndex + 1}`,
      xml: `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"${pageIndex === 0 ? ' tabSelected="1"' : ""}/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${sheetRows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
    };
  });

  const formats = [...new Set(styles.map((style) => style.format).filter((format) => format !== "General"))];
  const formatId = (format: string) => (format === "General" ? 0 : 164 + formats.indexOf(format));
  const fills = [...new Set(styles.map((style) => style.fill).filter((fill): fill is string => Boolean(fill)))];
  const stylesXml = `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
    formats.length ? `<numFmts count="${formats.length}">${formats.map((format) => `<numFmt numFmtId="${formatId(format)}" formatCode="${escapeXml(format)}"/>`).join("")}</numFmts>` : ""
  }<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="${2 + fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills
    .map((fill) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hexColor(fill)}"/><bgColor indexed="64"/></patternFill></fill>`)
    .join("")}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${styles.length}">${styles
    .map((style) => {
      const alignment = style.wrap || style.align ? `<alignment${style.align ? ` horizontal="${style.align}"` : ""}${style.wrap ? ' wrapText="1"' : ""} vertical="top"/>` : "";
      return `<xf numFmtId="${formatId(style.format)}" fontId="${style.bold ? 1 : 0}" fillId="${style.fill ? 2 + fills.indexOf(style.fill) : 0}" borderId="${style.border ? 1 : 0}" xfId="0"${style.format !== "General" ? ' applyNumberFormat="1"' : ""}${style.bold ? ' applyFont="1"' : ""}${style.fill ? ' applyFill="1"' : ""}${style.border ? ' applyBorder="1"' : ""}${alignment ? ' applyAlignment="1"' : ""}>${alignment}</xf>`;
    })
    .join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbook = `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rIdSheet${index + 1}"/>`)
    .join("")}</sheets></workbook>`;
  const workbookRelationships = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, index) => `<Relationship Id="rIdSheet${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join("")}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  return writePackage([
    {
      name: "[Content_Types].xml",
      data: contentTypes(
        [
          ["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
          ["/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"],
          ...sheets.map((_, index): [string, string] => [`/xl/worksheets/sheet${index + 1}.xml`, "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"]),
        ],
        false,
      ),
    },
    { name: "_rels/.rels", data: packageRelationships({ type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "xl/workbook.xml" }) },
    ...coreProperties(title, "Paperless PDF Editor"),
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRelationships },
    { name: "xl/styles.xml", data: stylesXml },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet.xml })),
  ]);
}
