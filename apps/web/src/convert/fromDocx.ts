// Word → PDF: reads a .docx and writes HTML that MuPDF lays out into pages.
// Covers the everyday parts of Word documents: styles, fonts, colours,
// alignment, spacing and indents, lists, tables (merged cells, borders,
// shading), pictures, page breaks and per-section paper size and margins.
import { readZip } from "./unzip";
import { child, elements, find, parseXml, textOf, type XmlNode } from "./xml";

export type HtmlPart = { html: string; width: number; height: number };

type RunProps = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  color?: string;
  highlight?: string;
  size?: number;
  font?: string;
  vertAlign?: string;
};
type Border = { width: number; color: string; style: string } | null;
type ParaProps = {
  align?: string;
  left?: number;
  right?: number;
  firstLine?: number;
  before?: number;
  after?: number;
  line?: { value: number; rule: string };
  numId?: string;
  level?: number;
  pageBreakBefore?: boolean;
  contextual?: boolean;
  borderTop?: Border;
  borderBottom?: Border;
  shade?: string;
};
type Style = { type: string; basedOn?: string; para: ParaProps; run: RunProps; table?: XmlNode };
type Level = { format: string; text: string; start: number; left?: number; hanging?: number; run: RunProps };

const attr = (node: XmlNode | undefined, name: string) => node?.attrs[`w:${name}`] ?? node?.attrs[name];
const twip = (value: string | undefined) => (value === undefined || value === "" ? undefined : Number(value) / 20);
const on = (node: XmlNode | undefined) => (node ? !["0", "false", "off", "none"].includes(attr(node, "val") ?? "true") : undefined);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

const HIGHLIGHTS: Record<string, string> = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000" };
const SYMBOLS: Record<string, string> = { "": "•", "": "▪", "": "◦", "": "✓", "": "❖", "": "➢", "": "→", "": "■", "": "●", "": "–", "": "•", "§": "▪" };

/** MuPDF lays out with its built-in faces; pick the closest kind. */
export function fontStack(name: string | undefined) {
  if (!name) return "sans-serif";
  if (/mono|courier|consolas|menlo|lucida console|source code/i.test(name)) return "monospace";
  if (/times|georgia|garamond|cambria|caladea|book|palatino|serif|minion|baskerville|century|bodoni|didot|constantia|roman/i.test(name) && !/sans/i.test(name)) return "serif";
  return "sans-serif";
}

function readRun(rPr: XmlNode | undefined, theme: Record<string, string>): RunProps {
  if (!rPr) return {};
  const fonts = child(rPr, "w:rFonts");
  const themeFont = attr(fonts, "asciiTheme") ?? attr(fonts, "hAnsiTheme");
  const color = attr(child(rPr, "w:color"), "val");
  const highlight = attr(child(rPr, "w:highlight"), "val");
  const shade = attr(child(rPr, "w:shd"), "fill");
  const size = attr(child(rPr, "w:sz"), "val");
  const underline = child(rPr, "w:u");
  return defined({
    bold: on(child(rPr, "w:b")),
    italic: on(child(rPr, "w:i")),
    underline: underline ? attr(underline, "val") !== "none" : undefined,
    strike: on(child(rPr, "w:strike")) ?? on(child(rPr, "w:dstrike")),
    caps: on(child(rPr, "w:caps")),
    color: color && color !== "auto" ? `#${color}` : undefined,
    highlight: highlight && highlight !== "none" ? HIGHLIGHTS[highlight] : shade && shade !== "auto" ? `#${shade}` : undefined,
    size: size ? Number(size) / 2 : undefined,
    font: attr(fonts, "ascii") ?? attr(fonts, "hAnsi") ?? (themeFont ? theme[themeFont.startsWith("major") ? "major" : "minor"] : undefined),
    vertAlign: attr(child(rPr, "w:vertAlign"), "val"),
  });
}

function readBorder(node: XmlNode | undefined): Border | undefined {
  if (!node) return undefined;
  const style = attr(node, "val") ?? "single";
  if (style === "nil" || style === "none") return null;
  const color = attr(node, "color");
  return { width: Math.max(0.25, Number(attr(node, "sz") ?? 4) / 8), color: color && color !== "auto" ? `#${color}` : "#000000", style: style === "double" ? "double" : /dot/.test(style) ? "dotted" : /dash/.test(style) ? "dashed" : "solid" };
}

function readPara(pPr: XmlNode | undefined): ParaProps {
  if (!pPr) return {};
  const indent = child(pPr, "w:ind");
  const spacing = child(pPr, "w:spacing");
  const numbering = child(pPr, "w:numPr");
  const borders = child(pPr, "w:pBdr");
  const hanging = twip(attr(indent, "hanging"));
  const firstLine = twip(attr(indent, "firstLine"));
  const line = attr(spacing, "line");
  const shade = attr(child(pPr, "w:shd"), "fill");
  const align = attr(child(pPr, "w:jc"), "val");
  return defined({
    align: align ? ({ both: "justify", distribute: "justify", center: "center", right: "right", end: "right", left: "left", start: "left" } as Record<string, string>)[align] : undefined,
    left: twip(attr(indent, "left") ?? attr(indent, "start")),
    right: twip(attr(indent, "right") ?? attr(indent, "end")),
    firstLine: hanging !== undefined ? -hanging : firstLine,
    before: attr(spacing, "beforeAutospacing") === "1" ? 14 : twip(attr(spacing, "before")),
    after: attr(spacing, "afterAutospacing") === "1" ? 14 : twip(attr(spacing, "after")),
    line: line ? { value: Number(line), rule: attr(spacing, "lineRule") ?? "auto" } : undefined,
    numId: attr(child(numbering, "w:numId"), "val"),
    level: numbering ? Number(attr(child(numbering, "w:ilvl"), "val") ?? 0) : undefined,
    pageBreakBefore: on(child(pPr, "w:pageBreakBefore")),
    contextual: on(child(pPr, "w:contextualSpacing")),
    borderTop: readBorder(child(borders, "w:top")),
    borderBottom: readBorder(child(borders, "w:bottom")),
    shade: shade && shade !== "auto" ? `#${shade}` : undefined,
  });
}

const roman = (value: number) => {
  const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [amount, letters] of table)
    while (value >= amount) {
      out += letters;
      value -= amount;
    }
  return out;
};
const letter = (value: number) => {
  let out = "";
  for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) out = String.fromCharCode(97 + ((rest - 1) % 26)) + out;
  return out;
};
function counterText(format: string, value: number) {
  if (format === "lowerLetter") return letter(value);
  if (format === "upperLetter") return letter(value).toUpperCase();
  if (format === "lowerRoman") return roman(value);
  if (format === "upperRoman") return roman(value).toUpperCase();
  if (format === "decimalZero") return String(value).padStart(2, "0");
  return String(value);
}

export async function docxToHtml(bytes: Uint8Array): Promise<HtmlPart[]> {
  const files = await readZip(bytes);
  const read = (name: string) => {
    const data = files.get(name);
    return data ? parseXml(new TextDecoder().decode(data)) : undefined;
  };
  const document = read("word/document.xml");
  if (!document) throw new Error("This file is not a Word document.");
  const relationships = new Map<string, string>();
  for (const rel of elements(find(read("word/_rels/document.xml.rels"), "Relationships"), "Relationship")) {
    const target = rel.attrs.Target ?? "";
    relationships.set(rel.attrs.Id ?? "", rel.attrs.TargetMode === "External" ? target : target.startsWith("/") ? target.slice(1) : `word/${target}`);
  }

  // Theme fonts, then styles with their inheritance.
  const themeXml = read("word/theme/theme1.xml");
  const theme = {
    major: find(find(themeXml, "a:majorFont"), "a:latin")?.attrs.typeface ?? "Calibri Light",
    minor: find(find(themeXml, "a:minorFont"), "a:latin")?.attrs.typeface ?? "Calibri",
  };
  const stylesXml = read("word/styles.xml");
  const defaults = find(stylesXml, "w:docDefaults");
  const baseRun: RunProps = { size: 10, font: "Times New Roman", ...readRun(find(find(defaults, "w:rPrDefault"), "w:rPr"), theme) };
  const basePara: ParaProps = readPara(find(find(defaults, "w:pPrDefault"), "w:pPr"));
  const styles = new Map<string, Style>();
  let defaultParagraph: string | undefined;
  let defaultTable: string | undefined;
  for (const style of elements(find(stylesXml, "w:styles"), "w:style")) {
    const id = attr(style, "styleId") ?? "";
    const type = attr(style, "type") ?? "paragraph";
    if (attr(style, "default") === "1" && type === "paragraph") defaultParagraph = id;
    if (attr(style, "default") === "1" && type === "table") defaultTable = id;
    styles.set(id, { type, basedOn: attr(child(style, "w:basedOn"), "val"), para: readPara(child(style, "w:pPr")), run: readRun(child(style, "w:rPr"), theme), table: child(style, "w:tblPr") });
  }
  const resolved = (id: string | undefined, seen = new Set<string>()): { para: ParaProps; run: RunProps; table?: XmlNode } => {
    const style = id ? styles.get(id) : undefined;
    if (!style || seen.has(id!)) return { para: {}, run: {} };
    seen.add(id!);
    const base = resolved(style.basedOn, seen);
    return { para: { ...base.para, ...style.para }, run: { ...base.run, ...style.run }, table: style.table ?? base.table };
  };

  // Numbering definitions for lists.
  const numberingXml = find(read("word/numbering.xml"), "w:numbering");
  const abstract = new Map<string, Level[]>();
  for (const definition of elements(numberingXml, "w:abstractNum"))
    abstract.set(
      attr(definition, "abstractNumId") ?? "",
      elements(definition, "w:lvl").map((level) => {
        const indent = child(child(level, "w:pPr"), "w:ind");
        return {
          format: attr(child(level, "w:numFmt"), "val") ?? "decimal",
          text: attr(child(level, "w:lvlText"), "val") ?? "",
          start: Number(attr(child(level, "w:start"), "val") ?? 1),
          left: twip(attr(indent, "left") ?? attr(indent, "start")),
          hanging: twip(attr(indent, "hanging")),
          run: readRun(child(level, "w:rPr"), theme),
        };
      }),
    );
  const lists = new Map<string, string>();
  for (const num of elements(numberingXml, "w:num")) lists.set(attr(num, "numId") ?? "", attr(child(num, "w:abstractNumId"), "val") ?? "");
  const counters = new Map<string, number[]>();
  const marker = (numId: string, level: number) => {
    const levels = abstract.get(lists.get(numId) ?? "");
    const definition = levels?.[level];
    if (!definition || numId === "0") return null;
    const key = lists.get(numId)!;
    const values = counters.get(key) ?? [];
    values[level] = (values[level] ?? definition.start - 1) + 1;
    values.length = level + 1;
    counters.set(key, values);
    let text = definition.format === "bullet" ? definition.text : definition.text.replace(/%(\d)/g, (_, index: string) => {
      const at = Number(index) - 1;
      return counterText(levels[at]?.format ?? "decimal", values[at] ?? levels[at]?.start ?? 1);
    });
    if (definition.format === "none") text = "";
    text = [...text].map((char) => SYMBOLS[char] ?? (/[-]/.test(char) ? "•" : char)).join("");
    if (definition.format === "bullet" && definition.run.font && /symbol|wingdings/i.test(definition.run.font) && text === "§") text = "▪";
    if (definition.format === "bullet" && definition.text === "o" && /courier/i.test(definition.run.font ?? "")) text = "◦";
    return { text, left: definition.left, hanging: definition.hanging, run: definition.run };
  };

  const image = (id: string | undefined, width: number, height: number) => {
    const target = id ? relationships.get(id) : undefined;
    const data = target ? files.get(target) : undefined;
    const extension = target?.split(".").pop()?.toLowerCase();
    const mime = extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "gif" ? "image/gif" : extension === "bmp" ? "image/bmp" : null;
    if (!data || !mime || !width || !height) return "";
    let binary = "";
    for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
    return `<img src="data:${mime};base64,${btoa(binary)}" style="width:${width.toFixed(1)}pt;height:${height.toFixed(1)}pt"/>`;
  };

  const runCss = (props: RunProps) => {
    const css = [`font-family:${fontStack(props.font)}`, `font-size:${props.size ?? 11}pt`];
    if (props.bold) css.push("font-weight:bold");
    if (props.italic) css.push("font-style:italic");
    const decoration = [props.underline && "underline", props.strike && "line-through"].filter(Boolean).join(" ");
    if (decoration) css.push(`text-decoration:${decoration}`);
    if (props.color) css.push(`color:${props.color}`);
    if (props.highlight) css.push(`background-color:${props.highlight}`);
    if (props.caps) css.push("text-transform:uppercase");
    if (props.vertAlign === "superscript") css.push("vertical-align:super", `font-size:${((props.size ?? 11) * 0.65).toFixed(1)}pt`);
    if (props.vertAlign === "subscript") css.push("vertical-align:sub", `font-size:${((props.size ?? 11) * 0.65).toFixed(1)}pt`);
    return css.join(";");
  };

  // Content is cut into parts at page breaks; each part starts a new page.
  type Section = { width: number; height: number; margins: [number, number, number, number] };
  const sectionOf = (sectPr: XmlNode | undefined): Section => {
    const size = child(sectPr, "w:pgSz");
    const margin = child(sectPr, "w:pgMar");
    const width = twip(attr(size, "w")) ?? 612;
    const height = twip(attr(size, "h")) ?? 792;
    return { width, height, margins: [twip(attr(margin, "top")) ?? 72, twip(attr(margin, "right")) ?? 72, twip(attr(margin, "bottom")) ?? 72, twip(attr(margin, "left")) ?? 72] };
  };
  const parts: { section: Section; blocks: string[] }[] = [];
  let section: Section = sectionOf(undefined);
  const newPart = () => parts.push({ section, blocks: [] });
  const emit = (html: string) => {
    if (!parts.length) newPart();
    parts.at(-1)!.blocks.push(html);
  };

  /** Paragraph runs as HTML pieces; `null` marks a page break. */
  const runsHtml = (paragraph: XmlNode, paragraphRun: RunProps): (string | null)[] => {
    const pieces: (string | null)[] = [];
    const visit = (node: XmlNode, inherited: RunProps) => {
      for (const item of elements(node)) {
        if (item.name === "w:r") {
          const runStyle = attr(child(child(item, "w:rPr"), "w:rStyle"), "val");
          const props = { ...inherited, ...resolved(runStyle).run, ...readRun(child(item, "w:rPr"), theme) };
          let text = "";
          const flush = () => {
            if (text) pieces.push(`<span style="${runCss(props)}">${text}</span>`);
            text = "";
          };
          for (const part of elements(item)) {
            if (part.name === "w:t") text += escape(textOf(part));
            else if (part.name === "w:tab") text += "&#160;".repeat(6);
            else if (part.name === "w:noBreakHyphen") text += "-";
            else if (part.name === "w:sym") {
              const code = Number.parseInt(attr(part, "char") ?? "", 16);
              text += escape(Number.isFinite(code) ? (SYMBOLS[String.fromCharCode(code)] ?? String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code)) : "");
            } else if (part.name === "w:br" || part.name === "w:cr") {
              if (attr(part, "type") === "page") {
                flush();
                pieces.push(null);
              } else text += "<br/>";
            } else if (part.name === "w:drawing" || part.name === "w:pict" || part.name === "mc:AlternateContent") {
              flush();
              const extent = find(part, "wp:extent");
              const blip = find(part, "a:blip");
              if (extent && blip) pieces.push(image(blip.attrs["r:embed"], Number(extent.attrs.cx) / 12700, Number(extent.attrs.cy) / 12700));
              else {
                const shape = find(part, "v:shape");
                const data = find(part, "v:imagedata");
                const style = Object.fromEntries((shape?.attrs.style ?? "").split(";").map((rule) => rule.split(":").map((value) => value.trim())));
                const size = (value: string | undefined) => (value ? Number.parseFloat(value) * (value.endsWith("in") ? 72 : value.endsWith("cm") ? 28.35 : 1) : 0);
                if (data) pieces.push(image(data.attrs["r:id"], size(style.width), size(style.height)));
              }
            }
          }
          flush();
        } else if (["w:hyperlink", "w:smartTag", "w:ins", "w:fldSimple", "w:customXml", "w:sdt", "w:sdtContent", "w:bdo", "w:dir"].includes(item.name)) visit(item, inherited);
      }
    };
    visit(paragraph, paragraphRun);
    return pieces;
  };

  // Table styles also set the spacing and text of the paragraphs inside.
  const tableStyles: { para: ParaProps; run: RunProps }[] = [];
  const styleIdOf = (paragraph: XmlNode) => attr(child(child(paragraph, "w:pPr"), "w:pStyle"), "val") ?? defaultParagraph;

  const paragraphHtml = (paragraph: XmlNode, inCell: boolean, neighbours: { previous?: XmlNode; next?: XmlNode } = {}) => {
    const pPr = child(paragraph, "w:pPr");
    const styleId = styleIdOf(paragraph);
    const style = resolved(styleId);
    const direct = readPara(pPr);
    const tableStyle = inCell ? tableStyles.at(-1) : undefined;
    const props: ParaProps = { ...basePara, ...tableStyle?.para, ...style.para, ...direct };
    const run: RunProps = { ...baseRun, ...tableStyle?.run, ...style.run };
    // Contextual spacing drops the space between paragraphs of one style (list items).
    if (props.contextual) {
      if (neighbours.previous && styleIdOf(neighbours.previous) === styleId) props.before = 0;
      if (neighbours.next && styleIdOf(neighbours.next) === styleId) props.after = 0;
    }
    const list = props.numId ? marker(props.numId, props.level ?? 0) : null;
    if (list && direct.left === undefined && style.para.left === undefined) {
      props.left = list.left;
      props.firstLine = list.hanging !== undefined ? -list.hanging : props.firstLine;
    }
    if (props.pageBreakBefore && !inCell) newPart();
    const css = [`margin:${props.before ?? 0}pt ${props.right ?? 0}pt ${props.after ?? 0}pt ${props.left ?? 0}pt`];
    if (props.firstLine) css.push(`text-indent:${props.firstLine}pt`);
    if (props.align && props.align !== "left") css.push(`text-align:${props.align}`);
    const size = run.size ?? 11;
    if (props.line) {
      const height = props.line.rule === "auto" ? (props.line.value / 240) * size * 1.17 : props.line.value / 20;
      css.push(`line-height:${Math.max(props.line.rule === "atLeast" ? size * 1.17 : 1, height).toFixed(1)}pt`);
    }
    if (props.shade) css.push(`background-color:${props.shade}`);
    for (const [side, border] of [["top", props.borderTop], ["bottom", props.borderBottom]] as const)
      if (border) css.push(`border-${side}:${border.width}pt ${border.style} ${border.color}`, `padding-${side}:1pt`);
    const open = `<p style="${css.join(";")};font-size:${size}pt">`;
    // The marker hangs in the indent; spaces stand in for the tab after it.
    // (MuPDF's built-in fonts have no en or em spaces.)
    const markerSize = list?.run.size ?? run.size ?? 11;
    const gap = Math.max(1, Math.round((Math.abs(Math.min(0, props.firstLine ?? 0)) - [...(list?.text ?? "")].length * markerSize * 0.55) / (markerSize * 0.27)));
    const prefix =
      list && list.text
        ? `<span style="${runCss({ ...run, ...list.run, font: /symbol|wingdings/i.test(list.run.font ?? "") ? undefined : (list.run.font ?? run.font) })}">${escape(list.text)}</span>${"&#160;".repeat(gap)}`
        : "";
    const pieces = runsHtml(paragraph, run);
    // A page break inside the paragraph splits it across two parts.
    let current: string[] = [];
    let first = true;
    const close = () => {
      const content = current.join("") || "&#160;";
      emit(`${open}${first ? prefix : ""}${content}</p>`);
      first = false;
      current = [];
    };
    for (const piece of pieces) {
      if (piece === null) {
        if (inCell) continue;
        if (current.length || first) close();
        newPart();
      } else current.push(piece);
    }
    if (current.length || first) close();
  };

  const tableHtml = (table: XmlNode) => {
    const tblPr = child(table, "w:tblPr");
    const style = resolved(attr(child(tblPr, "w:tblStyle"), "val") ?? defaultTable);
    tableStyles.push(style);
    const borders = child(tblPr, "w:tblBorders") ?? child(style.table, "w:tblBorders");
    const edge = (name: string) => readBorder(child(borders, `w:${name}`)) ?? null;
    const tableBorders = { top: edge("top"), bottom: edge("bottom"), left: edge("left") ?? edge("start"), right: edge("right") ?? edge("end"), insideH: edge("insideH"), insideV: edge("insideV") };
    const cellMargins = child(tblPr, "w:tblCellMar") ?? child(style.table, "w:tblCellMar");
    const padLeft = twip(attr(child(cellMargins, "w:left") ?? child(cellMargins, "w:start"), "w")) ?? 5.4;
    const padRight = twip(attr(child(cellMargins, "w:right") ?? child(cellMargins, "w:end"), "w")) ?? 5.4;
    const grid = elements(child(table, "w:tblGrid"), "w:gridCol").map((column) => twip(attr(column, "w")) ?? 0);
    const indent = twip(attr(child(tblPr, "w:tblInd"), "w")) ?? 0;
    const align = attr(child(tblPr, "w:jc"), "val");
    const rows = elements(table, "w:tr");
    // Lay cells on the grid to work out vertical merges.
    type Cell = { node: XmlNode; column: number; span: number; merge: string | undefined };
    const layout: Cell[][] = rows.map((row) => {
      let column = 0;
      return elements(row, "w:tc").map((cell) => {
        const tcPr = child(cell, "w:tcPr");
        const span = Number(attr(child(tcPr, "w:gridSpan"), "val") ?? 1);
        const vMerge = child(tcPr, "w:vMerge");
        const item = { node: cell, column, span, merge: vMerge ? (attr(vMerge, "val") ?? "continue") : undefined };
        column += span;
        return item;
      });
    });
    const css = (border: Border | null | undefined) => (border ? `${border.width}pt ${border.style} ${border.color}` : "none");
    const html: string[] = [];
    rows.forEach((row, rowIndex) => {
      const height = twip(attr(child(child(row, "w:trPr"), "w:trHeight"), "val"));
      const cells = layout[rowIndex]!.map((cell, index, all) => {
        if (cell.merge === "continue") return "";
        let rowspan = 1;
        if (cell.merge === "restart")
          for (let next = rowIndex + 1; next < layout.length; next += 1) {
            const below = layout[next]!.find((item) => item.column === cell.column);
            if (below?.merge !== "continue") break;
            rowspan += 1;
          }
        const tcPr = child(cell.node, "w:tcPr");
        const own = child(tcPr, "w:tcBorders");
        const lastRow = rowIndex + rowspan >= rows.length;
        const lastColumn = index === all.length - 1;
        const side = (name: string, fallback: Border | null) => {
          const border = readBorder(child(own, `w:${name}`));
          return border === undefined ? fallback : border;
        };
        const width = grid.slice(cell.column, cell.column + cell.span).reduce((sum, value) => sum + value, 0);
        const fill = attr(child(tcPr, "w:shd"), "fill");
        const vAlign = attr(child(tcPr, "w:vAlign"), "val");
        const style = [
          `border-top:${css(side("top", rowIndex === 0 ? tableBorders.top : tableBorders.insideH))}`,
          `border-bottom:${css(side("bottom", lastRow ? tableBorders.bottom : tableBorders.insideH))}`,
          `border-left:${css(side("left", cell.column === 0 ? tableBorders.left : tableBorders.insideV))}`,
          `border-right:${css(side("right", lastColumn ? tableBorders.right : tableBorders.insideV))}`,
          `padding:0 ${padRight}pt 0 ${padLeft}pt`,
          width ? `width:${(width - padLeft - padRight).toFixed(1)}pt` : "",
          fill && fill !== "auto" ? `background-color:#${fill}` : "",
          `vertical-align:${vAlign === "center" ? "middle" : vAlign === "bottom" ? "bottom" : "top"}`,
          height ? `height:${height}pt` : "",
        ].filter(Boolean);
        const saved = parts.length ? parts.at(-1)!.blocks.length : 0;
        if (!parts.length) newPart();
        const holder = parts.at(-1)!;
        blocksOf(cell.node, true);
        const content = holder.blocks.splice(saved).join("") || "<p>&#160;</p>";
        return `<td${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""} style="${style.join(";")}">${content}</td>`;
      });
      html.push(`<tr>${cells.join("")}</tr>`);
    });
    tableStyles.pop();
    const total = grid.reduce((sum, value) => sum + value, 0);
    const margin = align === "center" ? "margin:0 auto" : `margin:0 0 0 ${indent}pt`;
    emit(`<table style="border-collapse:collapse;${total ? `width:${total.toFixed(1)}pt;` : ""}${margin}">${html.join("")}</table>`);
  };

  function blocksOf(container: XmlNode, inCell: boolean) {
    const nodes = elements(container);
    nodes.forEach((node, index) => {
      if (node.name === "w:p") paragraphHtml(node, inCell, { previous: nodes[index - 1]?.name === "w:p" ? nodes[index - 1] : undefined, next: nodes[index + 1]?.name === "w:p" ? nodes[index + 1] : undefined });
      else if (node.name === "w:tbl") tableHtml(node);
      else if (node.name === "w:sdt") blocksOf(child(node, "w:sdtContent") ?? node, inCell);
      else if (node.name === "w:customXml") blocksOf(node, inCell);
    });
  }

  // Sections end at a paragraph carrying their settings; the last one is the body's.
  const body = find(document, "w:body")!;
  const sections: { nodes: XmlNode[]; settings: XmlNode | undefined }[] = [{ nodes: [], settings: undefined }];
  for (const node of elements(body)) {
    if (node.name === "w:sectPr") {
      sections.at(-1)!.settings = node;
      continue;
    }
    sections.at(-1)!.nodes.push(node);
    const settings = node.name === "w:p" ? child(child(node, "w:pPr"), "w:sectPr") : undefined;
    if (settings) {
      sections.at(-1)!.settings = settings;
      sections.push({ nodes: [], settings: undefined });
    }
  }
  const last = elements(body, "w:sectPr")[0];
  for (const item of sections) {
    if (!item.nodes.length) continue;
    section = sectionOf(item.settings ?? last);
    newPart();
    blocksOf({ name: "section", attrs: {}, children: item.nodes }, false);
  }

  const pages = parts.filter((part, index) => part.blocks.length || index === 0);
  return pages.map(({ section: { width, height, margins }, blocks }) => ({
    width,
    height,
    html: `<html><head><style>@page{margin:${margins.map((value) => `${Math.max(0, value)}pt`).join(" ")}} body{margin:0;font-family:${fontStack(baseRun.font)};font-size:${baseRun.size ?? 11}pt} p{margin:0} table{border-collapse:collapse} td{vertical-align:top} img{vertical-align:bottom}</style></head><body>${blocks.join("")}</body></html>`,
  }));
}
