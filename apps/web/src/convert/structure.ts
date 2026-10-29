// Turns the raw page content the engine reports into document structure:
// lines, paragraphs, headings, tables and images in reading order. The
// Word, Excel and PowerPoint writers all start from this.
import type { LayoutImage, LayoutSpan, LayoutTable, PageLayout } from "@paperless/pdf-engine";
import { officeFont } from "./ooxml";

export type Run = { text: string; size: number; color: string; font: string; bold: boolean; italic: boolean } | { tab: true };
export type Line = { spans: LayoutSpan[]; x: number; right: number; top: number; bottom: number; baseline: number; size: number };
export type Paragraph = {
  kind: "paragraph";
  lines: Line[];
  runs: Run[];
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
  alignment: "left" | "center" | "right" | "justify";
  /** First line's start relative to the other lines; negative for a hanging indent. */
  firstLineIndent: number;
  /** Baseline distance between lines, 0 for a single line. */
  lineGap: number;
  /** Positions of tab stops from the page's left edge. */
  tabs: number[];
  heading: 0 | 1 | 2 | 3;
  /** A drawn rule under the paragraph, such as a title underline. */
  borderBelow?: { color: string; width: number; space: number };
};
export type Table = {
  kind: "table";
  x: number;
  y: number;
  width: number;
  height: number;
  columns: number[];
  rows: number[];
  cells: Paragraph[][][];
  fills: (string | null)[][];
  ruled: boolean;
};
export type Picture = LayoutImage & { kind: "image" };
export type Item = Paragraph | Table | Picture;
export type PageStructure = {
  width: number;
  height: number;
  items: Item[];
  margins: { left: number; right: number; top: number; bottom: number };
};

/** Index of the last value that passes, or -1. */
export const lastIndex = <T,>(values: T[], test: (value: T) => boolean) => {
  for (let index = values.length - 1; index >= 0; index -= 1) if (test(values[index]!)) return index;
  return -1;
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** The usual body text size: the size most characters are set in. */
export function bodySize(layouts: PageLayout[]) {
  const weight = new Map<number, number>();
  for (const layout of layouts)
    for (const span of layout.spans) {
      const size = Math.round(span.size * 2) / 2;
      weight.set(size, (weight.get(size) ?? 0) + span.text.length);
    }
  let best = 11;
  let most = 0;
  weight.forEach((count, size) => {
    if (count > most) {
      most = count;
      best = size;
    }
  });
  return best;
}

function toLines(spans: LayoutSpan[]): Line[] {
  const grouped = new Map<string, LayoutSpan[]>();
  for (const span of spans) {
    const key = `${span.block}:${span.line}`;
    grouped.set(key, [...(grouped.get(key) ?? []), span]);
  }
  return [...grouped.values()].map((items) => {
    const sorted = [...items].sort((a, b) => a.x - b.x);
    return {
      spans: sorted,
      x: Math.min(...sorted.map((span) => span.x)),
      right: Math.max(...sorted.map((span) => span.x + span.width)),
      top: Math.min(...sorted.map((span) => span.y)),
      bottom: Math.max(...sorted.map((span) => span.y + span.height)),
      baseline: median(sorted.map((span) => span.baseline)),
      size: Math.max(...sorted.map((span) => span.size)),
    };
  });
}

/** Joins lines sitting on one row (a bullet and its text, a label and its value). */
function mergeRowLines(lines: Line[]): Line[] {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const merged: Line[] = [];
  for (const line of sorted) {
    const last = merged.at(-1);
    const size = Math.max(line.size, last?.size ?? 0);
    const sameRow = last && (Math.abs(line.baseline - last.baseline) < size * 0.35 || Math.abs((line.top + line.bottom) / 2 - (last.top + last.bottom) / 2) < size * 0.3);
    if (last && sameRow && (line.x >= last.right - 1 || line.right <= last.x + 1)) {
      const spans = [...last.spans, ...line.spans].sort((a, b) => a.x - b.x);
      merged[merged.length - 1] = {
        spans,
        x: Math.min(last.x, line.x),
        right: Math.max(last.right, line.right),
        top: Math.min(last.top, line.top),
        bottom: Math.max(last.bottom, line.bottom),
        // The bigger text decides the row's baseline (bullets are often smaller).
        baseline: line.size > last.size ? line.baseline : last.baseline,
        size,
      };
    } else merged.push(line);
  }
  return merged;
}

/** Symbol-font bullets live in the private use area; show them as real characters. */
const SYMBOLS: Record<string, string> = { "\uf0b7": "•", "\uf0a7": "▪", "\uf0a8": "◦", "\uf0fc": "✓", "\uf076": "❖", "\uf0d8": "➢", "\uf0e0": "→", "\uf06e": "■", "\uf06c": "●", "\uf0be": "–" };
const readable = (text: string) => text.replace(/[\ue000-\uf8ff]/g, (char) => SYMBOLS[char] ?? "•");

const sameStyle = (a: Run, b: Run) =>
  !("tab" in a) && !("tab" in b) && a.font === b.font && a.size === b.size && a.color === b.color && a.bold === b.bold && a.italic === b.italic;

const MARKER = /^([•▪◦●■–\-*➢✓❖→]|[\ue000-\uf8ff]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]{1,4}[.)])$/;

/** A bullet or number starting the line, set apart from the text after it. */
function markerOf(line: Line): { split: number } | { textX: number } | null {
  const [first, second] = line.spans;
  if (!first || !second) {
    // "1. Text" can arrive as one span.
    const match = first && /^((?:\d{1,3}|[a-zA-Z])[.)]|[•▪◦●■➢✓❖→])\s+\S/.exec(first.text);
    return match ? { split: match[1]!.length } : null;
  }
  return MARKER.test(first.text.trim()) && second.x - (first.x + first.width) > first.size * 0.25 ? { textX: second.x } : null;
}

/** Runs of text for lines that flow together, with tabs across wide gaps. */
function runsOf(lines: Line[], tabs: number[]) {
  const runs: Run[] = [];
  const push = (run: Run) => {
    const last = runs.at(-1);
    if (last && !("tab" in run) && !("tab" in last) && sameStyle(last, run)) last.text += run.text;
    else runs.push(run);
  };
  lines.forEach((line, lineIndex) => {
    line.spans.forEach((span, index) => {
      let text = span.text;
      const previous = index ? line.spans[index - 1]! : null;
      if (previous) {
        const gap = span.x - (previous.x + previous.width);
        const afterMarker = index === 1 && lineIndex === 0 && markerOf(line) !== null;
        if (gap > span.size * 1.5 || afterMarker) {
          push({ tab: true });
          tabs.push(span.x);
        } else if (gap > span.size * 0.12) text = ` ${text}`;
      } else if (lineIndex) {
        // Lines of a paragraph join with a space, or undo a hyphenated break.
        const last = runs.at(-1);
        if (last && !("tab" in last) && /[A-Za-zÀ-ÿ]-$/.test(last.text) && /^[a-zà-ÿ]/.test(text)) last.text = last.text.slice(0, -1);
        else text = ` ${text}`;
      }
      const symbol = /[\ue000-\uf8ff]/.test(text);
      push({ text: readable(text), size: Math.round(span.size * 2) / 2, color: span.color, font: symbol ? "Arial" : officeFont(span), bold: span.bold, italic: span.italic });
    });
  });
  return runs;
}

function alignmentOf(lines: Line[], region: { left: number; right: number }): Paragraph["alignment"] {
  const size = lines[0]!.size;
  const tolerance = size * 0.6;
  if (lines.length > 1) {
    const lefts = lines.map((line) => line.x);
    const rights = lines.map((line) => line.right);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const leftAligned = spread(lefts.slice(1)) < tolerance;
    if (leftAligned && lines.length > 2 && spread(rights.slice(0, -1)) < size * 0.4) return "justify";
    if (leftAligned) return "left";
    if (spread(lines.map((line) => (line.x + line.right) / 2)) < tolerance) return "center";
    if (spread(rights) < tolerance) return "right";
    return "left";
  }
  const line = lines[0]!;
  const leftGap = line.x - region.left;
  const rightGap = region.right - line.right;
  if (leftGap > size * 2 && Math.abs(leftGap - rightGap) < Math.max(size, (region.right - region.left) * 0.04)) return "center";
  if (leftGap > (region.right - region.left) * 0.35 && rightGap < size * 2) return "right";
  return "left";
}

/** Splits a block's lines into paragraphs at spacing, size or indent changes. */
function paragraphsOf(lines: Line[]): Line[][] {
  const groups: Line[][] = [];
  let current: Line[] = [];
  for (const line of lines) {
    const last = current.at(-1);
    if (last) {
      const gap = line.baseline - last.baseline;
      const usual = current.length > 1 ? current[1]!.baseline - current[0]!.baseline : last.size * 1.25;
      const sizeChange = Math.abs(line.size - last.size) > last.size * 0.15;
      const spaced = gap > Math.max(usual * 1.35, last.size * 1.6) || gap < last.size * 0.5;
      const jump = current.length > 1 && Math.abs(line.x - current[1]!.x) > last.size * 4;
      if (sizeChange || spaced || jump || markerOf(line)) {
        groups.push(current);
        current = [];
      }
    }
    current.push(line);
  }
  if (current.length) groups.push(current);
  return groups;
}

function makeParagraph(lines: Line[], region: { left: number; right: number }, body: number): Paragraph {
  const tabs: number[] = [];
  const runs = runsOf(lines, tabs);
  const size = median(lines.map((line) => line.size));
  const text = runs.map((run) => ("tab" in run ? "\t" : run.text)).join("");
  const allBold = runs.every((run) => "tab" in run || run.bold);
  const ratio = size / body;
  const heading: Paragraph["heading"] =
    lines.length > 3 || text.length > 200 ? 0 : ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : ratio >= 1.1 && allBold ? 3 : 0;
  let x = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.right));
  // List items hang: the text lines up after the marker, wrapped lines too.
  const marker = markerOf(lines[0]!);
  let firstLineIndent = lines.length > 1 ? lines[0]!.x - lines[1]!.x : 0;
  if (marker && "textX" in marker) {
    const markerX = lines[0]!.x;
    x = marker.textX;
    firstLineIndent = markerX - marker.textX;
    tabs.push(marker.textX);
  }
  const top = Math.min(...lines.map((line) => line.top));
  const bottom = Math.max(...lines.map((line) => line.bottom));
  return {
    kind: "paragraph",
    lines,
    runs,
    x,
    y: top,
    width: right - x,
    height: bottom - top,
    size,
    alignment: alignmentOf(lines, region),
    firstLineIndent,
    lineGap: lines.length > 1 ? median(lines.slice(1).map((line, index) => line.baseline - lines[index]!.baseline)) : 0,
    tabs: [...new Set(tabs.map((tab) => Math.round(tab)))].sort((a, b) => a - b),
    heading,
  };
}

/** Single-line paragraphs on one baseline (a label and its value) become one line with tabs. */
function mergeRows(paragraphs: Paragraph[], region: { left: number; right: number }, body: number) {
  const result: Paragraph[] = [];
  const used = new Set<Paragraph>();
  for (const paragraph of paragraphs) {
    if (used.has(paragraph)) continue;
    if (paragraph.lines.length !== 1) {
      result.push(paragraph);
      continue;
    }
    const line = paragraph.lines[0]!;
    const partners = paragraphs.filter(
      (other) => other !== paragraph && !used.has(other) && other.lines.length === 1 && Math.abs(other.lines[0]!.baseline - line.baseline) < line.size * 0.3 && Math.abs(other.size - paragraph.size) < paragraph.size * 0.3,
    );
    if (!partners.length) {
      result.push(paragraph);
      continue;
    }
    partners.forEach((partner) => used.add(partner));
    const spans = [paragraph, ...partners].flatMap((item) => item.lines[0]!.spans).sort((a, b) => a.x - b.x);
    const merged = toLines(spans.map((span) => ({ ...span, block: -1, line: -1 })))[0]!;
    result.push(makeParagraph([merged], region, body));
  }
  return result;
}

/** Cell paragraphs, aligned within the cell. */
function cellParagraphs(spans: LayoutSpan[], left: number, right: number, body: number) {
  if (!spans.length) return [];
  const lines = mergeRowLines(toLines(spans));
  return paragraphsOf(lines).map((group) => {
    const paragraph = makeParagraph(group, { left, right }, body);
    // Cells are narrow: decide alignment from the space on either side.
    const leftGap = paragraph.x - left;
    const rightGap = right - (paragraph.x + paragraph.width);
    paragraph.alignment = leftGap > rightGap * 2.5 && rightGap < Math.max(paragraph.size * 2, (right - left) * 0.15) ? "right" : Math.abs(leftGap - rightGap) < paragraph.size && leftGap > paragraph.size ? "center" : paragraph.alignment === "justify" ? "justify" : "left";
    paragraph.heading = 0;
    return paragraph;
  });
}

/** Keeps only grid lines that a drawn rule confirms, when the rules are there to check. */
function snapToRules(table: LayoutTable, layout: PageLayout): LayoutTable {
  const rules = layout.rects.filter((rect) => Math.min(rect.width, rect.height) < 3);
  const height = table.rows.at(-1)! - table.rows[0]!;
  const width = table.columns.at(-1)! - table.columns[0]!;
  const vertical = (x: number) => rules.some((rule) => rule.height > height * 0.3 && Math.abs(rule.x + rule.width / 2 - x) < 2.5);
  const horizontal = (y: number) => rules.some((rule) => rule.width > width * 0.3 && Math.abs(rule.y + rule.height / 2 - y) < 2.5);
  const keep = (values: number[], ruled: (value: number) => boolean) => {
    const confirmed = values.filter((value, index) => index === 0 || index === values.length - 1 || ruled(value));
    return values.filter(ruled).length >= 2 ? confirmed : values;
  };
  return { ...table, columns: keep(table.columns, vertical), rows: keep(table.rows, horizontal) };
}

function makeTable(source: LayoutTable, spans: LayoutSpan[], layout: PageLayout, body: number): Table {
  const table = snapToRules(source, layout);
  const { columns, rows } = table;
  const cellSpans = rows.slice(1).map(() => columns.slice(1).map(() => [] as LayoutSpan[]));
  for (const span of spans) {
    const cx = span.x + span.width / 2;
    const cy = span.y + span.height / 2;
    const column = Math.max(0, lastIndex(columns, (x) => x <= cx));
    const row = Math.max(0, lastIndex(rows, (y) => y <= cy));
    cellSpans[Math.min(row, rows.length - 2)]![Math.min(column, columns.length - 2)]!.push(span);
  }
  const fills = rows.slice(1).map((bottom, row) =>
    columns.slice(1).map((cellRight, column) => {
      const cell = { x: columns[column]!, y: rows[row]!, right: cellRight, bottom };
      const area = (cell.right - cell.x) * (cell.bottom - cell.y);
      const fill = layout.rects.find((rect) => {
        if (rect.stroked || rect.width < 4 || rect.height < 4) return false;
        const overlap = Math.max(0, Math.min(rect.x + rect.width, cell.right) - Math.max(rect.x, cell.x)) * Math.max(0, Math.min(rect.y + rect.height, cell.bottom) - Math.max(rect.y, cell.y));
        return overlap > area * 0.8 && rect.width * rect.height < area * 4;
      });
      return fill && fill.color.toLowerCase() !== "#ffffff" ? fill.color : null;
    }),
  );
  return {
    kind: "table",
    x: columns[0]!,
    y: rows[0]!,
    width: columns.at(-1)! - columns[0]!,
    height: rows.at(-1)! - rows[0]!,
    columns,
    rows,
    cells: cellSpans.map((row) => row.map((items, column) => cellParagraphs(items, columns[column]!, columns[column + 1]!, body))),
    fills,
    ruled: table.ruled,
  };
}

/**
 * A block can hold lines of side-by-side columns in turn. Lines that never
 * overlap horizontally form separate columns when they are text-width;
 * short ones are left together as rows (a label and its value).
 */
function splitColumns(lines: Line[], regionWidth: number): Line[][] {
  const groups: Line[][] = [];
  for (const line of lines) {
    const touching = groups.filter((group) => group.some((other) => other.x < line.right && line.x < other.right));
    const merged = [line, ...touching.flat()];
    touching.forEach((group) => groups.splice(groups.indexOf(group), 1));
    groups.push(merged);
  }
  if (groups.length < 2) return [lines];
  const wide = groups.every((group) => median(group.map((line) => line.right - line.x)) > regionWidth * 0.3);
  return wide ? groups.map((group) => group.sort((a, b) => a.baseline - b.baseline)) : [lines];
}

type Rule = { x: number; y: number; right: number; bottom: number; color: string };
const rulesOf = (layout: PageLayout) =>
  layout.rects
    .filter((rect) => Math.min(rect.width, rect.height) < 3 && Math.max(rect.width, rect.height) >= 8)
    .map((rect) => ({ x: rect.x, y: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, color: rect.color }));
const isHorizontal = (rule: Rule) => rule.right - rule.x > rule.bottom - rule.y;

/** Groups values within `tolerance` and returns each group's middle. */
function cluster(values: number[], tolerance: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const value of sorted) {
    const last = groups.at(-1);
    if (last && value - last.at(-1)! <= tolerance) last.push(value);
    else groups.push([value]);
  }
  return groups.map((group) => (group[0]! + group.at(-1)!) / 2);
}

/** Tables drawn with ruling lines: grids of crossing horizontal and vertical rules. */
export function ruledTables(layout: PageLayout): LayoutTable[] {
  const rules = rulesOf(layout);
  const parent = rules.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const touch = (a: Rule, b: Rule) => a.x <= b.right + 2 && b.x <= a.right + 2 && a.y <= b.bottom + 2 && b.y <= a.bottom + 2;
  rules.forEach((a, i) => rules.forEach((b, j) => j > i && touch(a, b) && (parent[find(i)] = find(j))));
  const groups = new Map<number, Rule[]>();
  rules.forEach((rule, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), rule]));
  const tables: LayoutTable[] = [];
  for (const group of groups.values()) {
    const horizontal = group.filter(isHorizontal);
    const vertical = group.filter((rule) => !isHorizontal(rule));
    if (horizontal.length < 2 || vertical.length < 2) continue;
    const columns = cluster(vertical.map((rule) => (rule.x + rule.right) / 2), 2.5);
    const rows = cluster(horizontal.map((rule) => (rule.y + rule.bottom) / 2), 2.5);
    if (columns.length < 2 || rows.length < 2 || (columns.length - 1) * (rows.length - 1) < 2) continue;
    tables.push({ columns, rows, ruled: true });
  }
  return tables;
}

const bottomOf = (item: Item) => item.y + item.height;
const rightOf = (item: Item) => item.x + item.width;

/**
 * Reading order: top to bottom, except that side-by-side columns of text are
 * read one column at a time between the full-width items around them.
 */
function readingOrder(items: Item[]) {
  const byTop = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const tall = items.filter((item): item is Paragraph => item.kind === "paragraph" && item.lines.length >= 3);
  const gutters: number[] = [];
  for (const a of tall)
    for (const b of tall)
      if (rightOf(a) < b.x - a.size && a.y < bottomOf(b) && b.y < bottomOf(a)) gutters.push((rightOf(a) + b.x) / 2);
  if (!gutters.length) return byTop;
  const gutter = median(gutters);
  const ordered: Item[] = [];
  let columns: [Item[], Item[]] = [[], []];
  const flush = () => {
    ordered.push(...columns[0], ...columns[1]);
    columns = [[], []];
  };
  for (const item of byTop) {
    if (rightOf(item) <= gutter) columns[0].push(item);
    else if (item.x >= gutter) columns[1].push(item);
    else {
      flush();
      ordered.push(item);
    }
  }
  flush();
  return ordered;
}

export function structurePage(layout: PageLayout, body: number): PageStructure {
  const textChars = layout.spans.reduce((sum, span) => sum + span.text.length, 0);
  const pictures: Picture[] = layout.images
    .filter((image) => image.width >= 4 && image.height >= 4)
    // A full-page picture under plenty of text is a scan with recognised text.
    .filter((image) => !(image.width * image.height > layout.width * layout.height * 0.85 && textChars > 100))
    .map((image) => ({ ...image, kind: "image" as const }));
  const inTable = (span: LayoutSpan, table: LayoutTable) => {
    const cx = span.x + span.width / 2;
    const cy = span.y + span.height / 2;
    return cx >= table.columns[0]! - 1 && cx <= table.columns.at(-1)! + 1 && cy >= table.rows[0]! - 1 && cy <= table.rows.at(-1)! + 1;
  };
  const found = ruledTables(layout);
  const overlaps = (a: LayoutTable, b: LayoutTable) =>
    a.columns[0]! < b.columns.at(-1)! && b.columns[0]! < a.columns.at(-1)! && a.rows[0]! < b.rows.at(-1)! && b.rows[0]! < a.rows.at(-1)!;
  const grids = [...found, ...layout.tables.filter((table) => !found.some((other) => overlaps(table, other)))];
  const tables = grids.map((table) => makeTable(table, layout.spans.filter((span) => inTable(span, table)), layout, body));
  const free = layout.spans.filter((span) => !grids.some((table) => inTable(span, table)));

  const lines = toLines(free);
  const left = Math.min(layout.width * 0.2, ...lines.map((line) => line.x), ...tables.map((table) => table.x), ...pictures.map((picture) => picture.x));
  const right = Math.max(layout.width * 0.8, ...lines.map((line) => line.right), ...tables.map(rightOf), ...pictures.map(rightOf));
  // Alignment is judged against even side margins, like the page was set.
  const region = { left, right: Math.max(right, layout.width - left) };
  const blocks = new Map<number, Line[]>();
  for (const line of lines) {
    const block = line.spans[0]!.block;
    blocks.set(block, [...(blocks.get(block) ?? []), line]);
  }
  const paragraphs = mergeRows(
    [...blocks.values()].flatMap((blockLines) => splitColumns(blockLines, right - left)).map(mergeRowLines).flatMap((blockLines) => paragraphsOf([...blockLines].sort((a, b) => a.baseline - b.baseline)).map((group) => makeParagraph(group, region, body))),
    region,
    body,
  );
  // Rules outside tables underline the paragraph just above them.
  const inGrid = (rule: Rule) => grids.some((table) => rule.x >= table.columns[0]! - 3 && rule.right <= table.columns.at(-1)! + 3 && rule.y >= table.rows[0]! - 3 && rule.bottom <= table.rows.at(-1)! + 3);
  for (const rule of rulesOf(layout).filter((rule) => isHorizontal(rule) && rule.right - rule.x > (right - left) * 0.3 && !inGrid(rule))) {
    const above = paragraphs
      .filter((paragraph) => paragraph.y + paragraph.height <= rule.y + 2 && rule.y - (paragraph.y + paragraph.height) < 16 && paragraph.x < rule.right && rule.x < paragraph.x + Math.max(paragraph.width, 1))
      .sort((a, b) => b.y + b.height - (a.y + a.height))[0];
    if (above && !above.borderBelow) above.borderBelow = { color: rule.color, width: Math.max(0.25, rule.bottom - rule.y), space: Math.max(0, rule.y - (above.y + above.height)) };
  }
  const items = readingOrder([...paragraphs, ...tables, ...pictures]);
  const top = Math.min(...items.map((item) => item.y), layout.height * 0.1);
  const bottom = Math.max(...items.map(bottomOf), layout.height * 0.9);
  const clamp = (value: number) => Math.min(108, Math.max(18, value));
  // Pages are usually laid out with even side margins; narrower text keeps
  // its line breaks through right indents instead.
  const sideMargin = clamp(left);
  return {
    width: layout.width,
    height: layout.height,
    items,
    margins: { left: sideMargin, right: layout.width - right < sideMargin ? clamp(layout.width - right) : sideMargin, top: clamp(top), bottom: clamp(layout.height - bottom) },
  };
}
