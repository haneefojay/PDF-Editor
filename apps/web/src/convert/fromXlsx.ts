// Excel → PDF: each visible sheet's used range becomes a table, with cell
// formatting, number formats, merged cells and column widths, laid out by
// MuPDF. Wide sheets are turned landscape and scaled to fit the page.
import { fontStack, type HtmlPart } from "./fromDocx";
import { readZip } from "./unzip";
import { child, elements, find, parseXml, textOf, type XmlNode } from "./xml";

type Font = { bold: boolean; italic: boolean; underline: boolean; size: number; color: string | null; name: string };
type Edge = { style: string; color: string } | null;
type Format = { numFmt: number; font: Font; fill: string | null; borders: Record<"left" | "right" | "top" | "bottom", Edge>; align: string | null; vertical: string | null; wrap: boolean };

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 49: "@",
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const colorOf = (node: XmlNode | undefined) => {
  const rgb = node?.attrs.rgb;
  return rgb && rgb.length >= 6 ? `#${rgb.slice(-6)}` : null;
};

/** Spreadsheet serial date to a JavaScript date (1900 system). */
const serialDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));

/** Formats a cell value with an Excel number format, covering the common cases. */
export function formatValue(value: number, code: string): string {
  if (code === "General" || !code) {
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toPrecision(10)));
  }
  const sections = code.split(";");
  let section = sections[0]!;
  let number = value;
  if (value < 0 && sections[1] !== undefined) {
    section = sections[1];
    number = -value;
  } else if (value === 0 && sections[2] !== undefined) section = sections[2];
  section = section.replace(/\[(Red|Black|Blue|Green|Magenta|Cyan|White|Yellow|Color\s*\d+)\]/gi, "").replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, "$1");
  const plain = section.replace(/"[^"]*"|\\./g, "");
  if (/[dy]|m{3,}|h|s/i.test(plain) && !/[#0?]/.test(plain.replace(/[hms]/gi, ""))) {
    const date = serialDate(number);
    const hours = date.getUTCHours();
    const ampm = /AM\/PM/i.test(section);
    let out = section.replace(/AM\/PM/gi, "\ue000");
    const tokens: [RegExp, () => string][] = [
      // Minutes first: "mm" next to hours or seconds is minutes, elsewhere months.
      [/(?<=[h\]]\W?)mm|mm(?=\W?ss)/gi, () => String(date.getUTCMinutes()).padStart(2, "0")],
      [/yyyy/gi, () => String(date.getUTCFullYear())],
      [/yy/gi, () => String(date.getUTCFullYear()).slice(-2)],
      [/mmmm/gi, () => MONTHS[date.getUTCMonth()]!],
      [/mmm/gi, () => MONTHS[date.getUTCMonth()]!.slice(0, 3)],
      [/dddd/gi, () => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()]!],
      [/ddd/gi, () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()]!],
      [/dd/gi, () => String(date.getUTCDate()).padStart(2, "0")],
      [/(?<![a-z])d(?![a-z])/gi, () => String(date.getUTCDate())],
      [/hh/gi, () => String(ampm ? hours % 12 || 12 : hours).padStart(2, "0")],
      [/(?<![a-z])h(?![a-z])/gi, () => String(ampm ? hours % 12 || 12 : hours)],
      [/ss/gi, () => String(date.getUTCSeconds()).padStart(2, "0")],
      [/mm/gi, () => String(date.getUTCMonth() + 1).padStart(2, "0")],
      [/(?<![a-z])m(?![a-z])/gi, () => String(date.getUTCMonth() + 1)],
    ];
    for (const [pattern, make] of tokens) out = out.replace(pattern, () => `\ue001${make()}\ue002`);
    return out.replace(/[\ue001\ue002]/g, "").replace(/\ue000/g, hours < 12 ? "AM" : "PM").replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1");
  }
  if (section === "@") return String(value);
  const percent = plain.includes("%");
  if (percent) number *= 100;
  const scientific = /E\+/i.test(plain);
  const decimalsMatch = /\.([0#?]+)/.exec(plain);
  const decimals = decimalsMatch ? decimalsMatch[1]!.replace(/[#?]/g, "").length + (decimalsMatch[1]!.match(/[#?]/g)?.length ? 0 : 0) : 0;
  let digits: string;
  if (scientific) digits = number.toExponential(decimals).replace("e", "E").replace(/E([+-])(\d)$/, "E$10$2");
  else {
    digits = number.toFixed(decimals);
    if (/#,##|0,0/.test(plain)) {
      const [whole, fraction] = digits.split(".");
      digits = `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
    }
  }
  // Literal text around the number placeholder stays: "$", "€", " kg"…
  const first = section.search(/[#0?]/);
  const last = section.length - [...section].reverse().join("").search(/[#0?%]/);
  const literal = (text: string) => text.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1").replace(/_./g, " ").replace(/\*./g, "").replace(/[#0?,.%]/g, "");
  const prefix = first >= 0 ? literal(section.slice(0, first)) : "";
  const suffix = literal(section.slice(last));
  const sign = value < 0 && sections[1] === undefined ? "-" : "";
  return `${sign}${prefix}${digits.replace(/^-/, "")}${percent ? "%" : ""}${suffix}`.trim();
}

const columnIndex = (reference: string) => {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  return [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
};
const rowIndex = (reference: string) => Number(/\d+/.exec(reference)?.[0] ?? 1) - 1;

export async function xlsxToHtml(bytes: Uint8Array): Promise<HtmlPart[]> {
  const files = await readZip(bytes);
  const read = (name: string) => {
    const data = files.get(name);
    return data ? parseXml(new TextDecoder().decode(data)) : undefined;
  };
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new Error("This file is not an Excel workbook.");
  const relationships = new Map<string, string>();
  for (const rel of elements(find(read("xl/_rels/workbook.xml.rels"), "Relationships"), "Relationship")) {
    const target = rel.attrs.Target ?? "";
    relationships.set(rel.attrs.Id ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const date1904 = find(workbook, "workbookPr")?.attrs.date1904 === "1";
  const strings = elements(find(read("xl/sharedStrings.xml"), "sst"), "si").map((item) => textOf({ name: "si", attrs: {}, children: [...elements(item, "t"), ...elements(item, "r").map((run) => child(run, "t")!).filter(Boolean)] }));

  const stylesXml = find(read("xl/styles.xml"), "styleSheet");
  const formats = new Map<number, string>(Object.entries(BUILTIN_FORMATS).map(([id, code]) => [Number(id), code]));
  for (const format of elements(child(stylesXml, "numFmts"), "numFmt")) formats.set(Number(format.attrs.numFmtId), format.attrs.formatCode ?? "General");
  const fonts: Font[] = elements(child(stylesXml, "fonts"), "font").map((font) => ({
    bold: Boolean(child(font, "b")) && child(font, "b")!.attrs.val !== "0",
    italic: Boolean(child(font, "i")) && child(font, "i")!.attrs.val !== "0",
    underline: Boolean(child(font, "u")),
    size: Number(child(font, "sz")?.attrs.val ?? 11),
    color: colorOf(child(font, "color")),
    name: child(font, "name")?.attrs.val ?? "Calibri",
  }));
  const fills = elements(child(stylesXml, "fills"), "fill").map((fill) => {
    const pattern = child(fill, "patternFill");
    return pattern && pattern.attrs.patternType && pattern.attrs.patternType !== "none" ? colorOf(child(pattern, "fgColor")) : null;
  });
  const borders = elements(child(stylesXml, "borders"), "border").map((border) => {
    const edge = (name: string): Edge => {
      const node = child(border, name);
      const style = node?.attrs.style;
      return style && style !== "none" ? { style, color: colorOf(child(node, "color")) ?? "#000000" } : null;
    };
    return { left: edge("left"), right: edge("right"), top: edge("top"), bottom: edge("bottom") };
  });
  const defaultFont: Font = fonts[0] ?? { bold: false, italic: false, underline: false, size: 11, color: null, name: "Calibri" };
  const cellFormats: Format[] = elements(child(stylesXml, "cellXfs"), "xf").map((xf) => {
    const alignment = child(xf, "alignment");
    return {
      numFmt: Number(xf.attrs.numFmtId ?? 0),
      font: fonts[Number(xf.attrs.fontId ?? 0)] ?? defaultFont,
      fill: fills[Number(xf.attrs.fillId ?? 0)] ?? null,
      borders: borders[Number(xf.attrs.borderId ?? 0)] ?? { left: null, right: null, top: null, bottom: null },
      align: alignment?.attrs.horizontal ?? null,
      vertical: alignment?.attrs.vertical ?? null,
      wrap: alignment?.attrs.wrapText === "1",
    };
  });
  const plainFormat: Format = { numFmt: 0, font: defaultFont, fill: null, borders: { left: null, right: null, top: null, bottom: null }, align: null, vertical: null, wrap: false };

  const sheets = elements(find(workbook, "sheets"), "sheet").filter((sheet) => sheet.attrs.state !== "hidden" && sheet.attrs.state !== "veryHidden");
  const parts: HtmlPart[] = [];
  for (const sheet of sheets) {
    const xml = read(relationships.get(sheet.attrs["r:id"] ?? "") ?? "");
    const data = child(find(xml, "worksheet"), "sheetData");
    if (!data) continue;
    type Cell = { text: string; numeric: boolean; format: Format };
    const cells = new Map<string, Cell>();
    let maxRow = -1;
    let maxColumn = -1;
    const rowHeights = new Map<number, number>();
    for (const row of elements(data, "row")) {
      if (row.attrs.ht && row.attrs.customHeight === "1") rowHeights.set(Number(row.attrs.r) - 1, Number(row.attrs.ht));
      for (const cell of elements(row, "c")) {
        const reference = cell.attrs.r ?? "A1";
        const type = cell.attrs.t ?? "n";
        const raw = textOf(child(cell, "v"));
        const format = cellFormats[Number(cell.attrs.s ?? 0)] ?? plainFormat;
        let text = "";
        let numeric = false;
        if (type === "s") text = strings[Number(raw)] ?? "";
        else if (type === "inlineStr") text = textOf(child(cell, "is"));
        else if (type === "str" || type === "e") text = raw;
        else if (type === "b") text = raw === "1" ? "TRUE" : "FALSE";
        else if (raw !== "") {
          let value = Number(raw);
          const code = formats.get(format.numFmt) ?? "General";
          if (date1904 && /[dy]/i.test(code)) value += 1462;
          text = formatValue(value, code);
          numeric = true;
        }
        const r = rowIndex(reference);
        const c = columnIndex(reference);
        cells.set(`${r}:${c}`, { text, numeric, format });
        // Borders and fills count towards the printed range; empty unstyled cells do not.
        if (text || format.fill || Object.values(format.borders).some(Boolean)) {
          maxRow = Math.max(maxRow, r);
          maxColumn = Math.max(maxColumn, c);
        }
      }
    }
    if (maxRow < 0) continue;
    const merges = new Map<string, { rows: number; columns: number }>();
    const covered = new Set<string>();
    for (const merge of elements(find(xml, "mergeCells"), "mergeCell")) {
      const [start, end] = (merge.attrs.ref ?? "").split(":");
      if (!start || !end) continue;
      const [r0, c0, r1, c1] = [rowIndex(start), columnIndex(start), rowIndex(end), columnIndex(end)];
      merges.set(`${r0}:${c0}`, { rows: r1 - r0 + 1, columns: c1 - c0 + 1 });
      for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) if (r !== r0 || c !== c0) covered.add(`${r}:${c}`);
    }
    const widths = Array.from({ length: maxColumn + 1 }, () => 8.43);
    for (const column of elements(find(xml, "cols"), "col"))
      for (let index = Number(column.attrs.min) - 1; index < Math.min(Number(column.attrs.max), maxColumn + 1); index += 1)
        widths[index] = column.attrs.hidden === "1" ? 0 : Number(column.attrs.width ?? 8.43);
    // Column widths are in characters of the default font: about 7 px each.
    const points = widths.map((width) => (width ? width * 5.25 + 3.75 : 0));
    const tableWidth = points.reduce((sum, value) => sum + value, 0);
    const margin = 36;
    const portrait = { width: 612, height: 792 };
    const page = tableWidth > portrait.width - margin * 2 ? { width: 792, height: 612 } : portrait;
    const scale = Math.min(1, (page.width - margin * 2) / tableWidth);
    const pt = (value: number) => `${(value * scale).toFixed(2)}pt`;
    const edge = (value: Edge) => (value ? `${pt(/medium/.test(value.style) ? 1.5 : /thick/.test(value.style) ? 2.25 : 0.75)} ${/double/.test(value.style) ? "double" : /dot/.test(value.style) ? "dotted" : /dash/.test(value.style) ? "dashed" : "solid"} ${value.color}` : "none");

    const rows: string[] = [];
    for (let r = 0; r <= maxRow; r += 1) {
      const row: string[] = [];
      for (let c = 0; c <= maxColumn; c += 1) {
        const key = `${r}:${c}`;
        if (covered.has(key) || !points[c]) continue;
        const cell = cells.get(key);
        const merge = merges.get(key);
        const format = cell?.format ?? plainFormat;
        const width = points.slice(c, c + (merge?.columns ?? 1)).reduce((sum, value) => sum + value, 0);
        const align = format.align && format.align !== "general" ? (format.align === "centerContinuous" ? "center" : format.align) : cell?.numeric ? "right" : "left";
        const style = [
          `width:${pt(Math.max(1, width - 4))}`,
          `padding:${pt(1)} ${pt(2)}`,
          `text-align:${["left", "right", "center", "justify"].includes(align) ? align : "left"}`,
          `vertical-align:${format.vertical === "center" ? "middle" : format.vertical === "top" ? "top" : "bottom"}`,
          `font-family:${fontStack(format.font.name)}`,
          `font-size:${pt(format.font.size)}`,
          format.font.bold ? "font-weight:bold" : "",
          format.font.italic ? "font-style:italic" : "",
          format.font.underline ? "text-decoration:underline" : "",
          format.font.color ? `color:${format.font.color}` : "",
          format.fill ? `background-color:${format.fill}` : "",
          `border-left:${edge(format.borders.left)}`,
          `border-right:${edge(format.borders.right)}`,
          `border-top:${edge(format.borders.top)}`,
          `border-bottom:${edge(format.borders.bottom)}`,
          rowHeights.has(r) ? `height:${pt(rowHeights.get(r)!)}` : "",
          // Like Excel, text stays on one line unless the cell wraps.
          format.wrap ? "" : "white-space:nowrap",
        ].filter(Boolean);
        const text = cell?.text ? escape(cell.text).replace(/\n/g, "<br/>") : "&#160;";
        row.push(`<td${merge && merge.columns > 1 ? ` colspan="${merge.columns}"` : ""}${merge && merge.rows > 1 ? ` rowspan="${merge.rows}"` : ""} style="${style.join(";")}">${text}</td>`);
      }
      rows.push(`<tr>${row.join("")}</tr>`);
    }
    const title = sheets.length > 1 ? `<p style="font-family:sans-serif;font-size:9pt;color:#666666;margin:0 0 6pt 0">${escape(sheet.attrs.name ?? "")}</p>` : "";
    parts.push({
      ...page,
      html: `<html><head><style>@page{margin:${margin}pt} body{margin:0} table{border-collapse:collapse} td{overflow:hidden}</style></head><body>${title}<table>${rows.join("")}</table></body></html>`,
    });
  }
  if (!parts.length) parts.push({ width: 612, height: 792, html: "<html><body><p>This workbook has no data.</p></body></html>" });
  return parts;
}
