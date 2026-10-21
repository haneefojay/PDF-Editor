// Dependency-free text layout shared by the editor preview and the PDF
// exporter. Both sides measure with the same bundled fonts, so wrapping and
// shrink-to-fit decisions made on screen are the ones baked into the PDF.

export type FontCategory = "sans" | "serif" | "mono";
export type FontVariant = "regular" | "bold" | "italic" | "boldItalic";
export type FitMode = "auto" | "shrink" | "overflow";

/** Returns the advance width of `text` in points at `size`, without letter spacing. */
export type MeasureText = (text: string, size: number) => number;

const serifHints = [
  "times",
  "serif",
  "georgia",
  "garamond",
  "cambria",
  "minion",
  "palatino",
  "baskerville",
  "book antiqua",
  "century",
  "roman",
];
const monoHints = ["courier", "mono", "consolas", "menlo", "code"];

export function fontCategory(fontFamily: string): FontCategory {
  const lower = fontFamily.toLowerCase();
  if (monoHints.some((hint) => lower.includes(hint))) return "mono";
  // "sans-serif" families contain "serif"; check for "sans" first.
  if (lower.includes("sans")) return "sans";
  if (serifHints.some((hint) => lower.includes(hint))) return "serif";
  return "sans";
}

export function fontVariant(bold: boolean, italic: boolean): FontVariant {
  if (bold && italic) return "boldItalic";
  if (bold) return "bold";
  if (italic) return "italic";
  return "regular";
}

/** Ascent/descent (fractions of the em) of the bundled Liberation fonts. */
export const fontMetrics: Record<
  FontCategory,
  { ascent: number; descent: number }
> = {
  sans: { ascent: 0.905, descent: 0.212 },
  serif: { ascent: 0.891, descent: 0.216 },
  mono: { ascent: 0.833, descent: 0.3 },
};

/**
 * Distance from the top of a CSS-style line box to the baseline, matching how
 * browsers centre glyphs inside `line-height`.
 */
export function baselineOffset(
  category: FontCategory,
  size: number,
  lineHeight: number,
) {
  const { ascent, descent } = fontMetrics[category];
  return size * ((lineHeight - (ascent + descent)) / 2 + ascent);
}

export const MIN_FIT_SIZE = 6;

const characterCount = (text: string) => Array.from(text).length;

export function textWidth(
  text: string,
  size: number,
  letterSpacing: number,
  measure: MeasureText,
) {
  const count = characterCount(text);
  return measure(text, size) + Math.max(0, count - 1) * letterSpacing;
}

function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  width: (text: string) => number,
) {
  if (width(paragraph) <= maxWidth) return [paragraph];
  const output: string[] = [];
  let current = "";
  for (const token of paragraph.split(/(\s+)/)) {
    if (!token) continue;
    const candidate = current + token;
    if (current.trim() && width(candidate.trimEnd()) > maxWidth) {
      output.push(current.trimEnd());
      current = token.trimStart();
    } else current = candidate;
    // Break words that are wider than the box on their own.
    while (current.length > 1 && width(current) > maxWidth) {
      const characters = Array.from(current);
      let fit = 1;
      while (
        fit < characters.length &&
        width(characters.slice(0, fit + 1).join("")) <= maxWidth
      )
        fit += 1;
      output.push(characters.slice(0, fit).join(""));
      current = characters.slice(fit).join("");
    }
  }
  output.push(current);
  return output;
}

export type TextLayout = {
  /** Font size actually used (smaller than requested when shrinking). */
  size: number;
  lines: string[];
  /** Width of each line in points, including letter spacing. */
  widths: number[];
  /** Width of the widest line in points. */
  width: number;
  /** Total height in points. */
  height: number;
};

export function layoutText(
  text: string,
  options: {
    size: number;
    maxWidth: number;
    lineHeight: number;
    letterSpacing: number;
    fitMode: FitMode;
    measure: MeasureText;
  },
): TextLayout {
  const { maxWidth, lineHeight, letterSpacing, fitMode, measure } = options;
  const paragraphs = text.replace(/\t/g, "    ").split(/\r?\n/);
  let size = options.size;
  const widthAt = (value: string, at: number) =>
    textWidth(value, at, letterSpacing, measure);
  if (fitMode === "shrink" && maxWidth > 0) {
    const natural = Math.max(0, ...paragraphs.map((line) => widthAt(line, size)));
    if (natural > maxWidth)
      size = Math.max(MIN_FIT_SIZE, (size * maxWidth) / natural);
  }
  const lines =
    fitMode === "auto" && maxWidth > 0
      ? paragraphs.flatMap((paragraph) =>
          wrapParagraph(paragraph, maxWidth, (value) => widthAt(value, size)),
        )
      : paragraphs;
  const widths = lines.map((line) => widthAt(line, size));
  return {
    size,
    lines,
    widths,
    width: Math.max(0, ...widths),
    height: lines.length * size * lineHeight,
  };
}
