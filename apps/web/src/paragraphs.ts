import type { PageInfo, PositionedTextLine } from "@paperless/pdf-engine";

export type Paragraph = {
  lines: PositionedTextLine[];
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Baseline distance divided by font size. */
  lineHeight: number;
  alignment: "left" | "center" | "right" | "justify";
};

const styleKey = (line: PositionedTextLine) =>
  [line.fontName, Math.round(line.size * 10), line.color, line.bold, line.italic].join("|");

/** Joins wrapped lines, undoing hyphenation at line ends. */
export function joinLines(texts: string[]) {
  return texts.reduce((joined, raw) => {
    const text = raw.trim();
    if (!joined) return text;
    if (/[A-Za-zÀ-ÿ]-$/.test(joined) && /^[a-zà-ÿ]/.test(text)) return joined.slice(0, -1) + text;
    return `${joined} ${text}`;
  }, "");
}

/**
 * The paragraph containing `target`: consecutive lines of the same text block
 * that share one style, sit at an even line spacing and line up at an edge.
 * Lines mixing styles are left to line editing so no formatting is lost.
 */
export function findParagraph(lines: PositionedTextLine[], target: PositionedTextLine, info: PageInfo): Paragraph | null {
  if (target.block === undefined || target.line === undefined) return null;
  const runsPerLine = new Map<number, PositionedTextLine[]>();
  for (const line of lines)
    if (line.block === target.block && line.line !== undefined) runsPerLine.set(line.line, [...(runsPerLine.get(line.line) ?? []), line]);
  if ((runsPerLine.get(target.line)?.length ?? 0) !== 1) return null;
  const single = [...runsPerLine.entries()]
    .filter(([, runs]) => runs.length === 1)
    .map(([index, runs]) => ({ index, line: runs[0]! }))
    .sort((a, b) => a.index - b.index);
  const position = single.findIndex((item) => item.line.id === target.id);
  if (position < 0) return null;
  const key = styleKey(target);
  const size = target.size;
  const tolerance = (size * 1.5) / info.width;
  // Justified lines end at almost exactly the same place.
  const tight = (size * 0.5) / info.width;
  const gapOf = (a: PositionedTextLine, b: PositionedTextLine) => ((b.baseline - a.baseline) * info.height) / size;
  const fits = (a: { index: number; line: PositionedTextLine }, b: { index: number; line: PositionedTextLine }, gap: number | null) => {
    if (b.index !== a.index + 1 || styleKey(a.line) !== key || styleKey(b.line) !== key) return false;
    const next = gapOf(a.line, b.line);
    if (next < 0.9 || next > 2.4) return false;
    if (gap !== null && Math.abs(next - gap) > gap * 0.2) return false;
    const left = Math.abs(a.line.x - b.line.x) < tolerance;
    const centre = Math.abs(a.line.x + a.line.width / 2 - (b.line.x + b.line.width / 2)) < tolerance;
    const right = Math.abs(a.line.x + a.line.width - (b.line.x + b.line.width)) < tolerance;
    return left || centre || right;
  };
  let first = position;
  let last = position;
  let gap: number | null = null;
  while (first > 0 && fits(single[first - 1]!, single[first]!, gap)) {
    gap ??= gapOf(single[first - 1]!.line, single[first]!.line);
    first -= 1;
  }
  while (last < single.length - 1 && fits(single[last]!, single[last + 1]!, gap)) {
    gap ??= gapOf(single[last]!.line, single[last + 1]!.line);
    last += 1;
  }
  if (last === first) return null;
  const group = single.slice(first, last + 1).map((item) => item.line);
  const lefts = group.map((line) => line.x);
  const rights = group.map((line) => line.x + line.width);
  const centres = group.map((line, index) => (lefts[index]! + rights[index]!) / 2);
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const x = Math.min(...lefts);
  const right = Math.max(...rights);
  const alignment =
    spread(lefts) < tolerance
      ? spread(rights.slice(0, -1)) < tight && group.length > 2
        ? "justify"
        : "left"
      : spread(centres) < tolerance
        ? "center"
        : spread(rights) < tolerance
          ? "right"
          : "left";
  const top = Math.min(...group.map((line) => line.y));
  const bottom = Math.max(...group.map((line) => line.y + line.height));
  const spacing = group.slice(1).reduce((sum, line, index) => sum + gapOf(group[index]!, line), 0) / (group.length - 1);
  return {
    lines: group,
    text: joinLines(group.map((line) => line.text)),
    x,
    y: top,
    width: right - x,
    height: bottom - top,
    lineHeight: Math.min(3, Math.max(0.8, spacing)),
    alignment,
  };
}

/**
 * Width to reflow a paragraph in. A little slack keeps unchanged lines from
 * wrapping early when the substitute font is slightly wider than the original.
 */
export const reflowWidth = (paragraph: Paragraph) => Math.min(0.98 - paragraph.x, paragraph.width * 1.03);
