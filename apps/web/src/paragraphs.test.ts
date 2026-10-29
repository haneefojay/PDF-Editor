import { describe, expect, it } from "vitest";
import type { PositionedTextLine } from "@paperless/pdf-engine";
import { findParagraph, joinLines } from "./paragraphs";

const info = { width: 600, height: 800 };
let id = 0;
const line = (text: string, lineIndex: number, extra: Partial<PositionedTextLine> = {}): PositionedTextLine => ({
  id: String(id++),
  text,
  x: 0.1,
  y: 0.1 + lineIndex * 0.018 - 0.012,
  width: 0.7,
  height: 0.016,
  baseline: 0.1 + lineIndex * 0.018,
  size: 12,
  color: "#000000",
  fontFamily: "Helvetica",
  fontName: "Helvetica",
  bold: false,
  italic: false,
  alignment: "left",
  lineHeight: 1.2,
  letterSpacing: 0,
  fitMode: "auto",
  block: 0,
  line: lineIndex,
  ...extra,
});

describe("paragraph detection", () => {
  it("groups evenly spaced lines of one style", () => {
    const lines = [line("The quick brown fox jumps over", 0), line("the lazy dog and keeps on", 1, { width: 0.68 }), line("running.", 2, { width: 0.2 })];
    const paragraph = findParagraph(lines, lines[1]!, info)!;
    expect(paragraph.lines).toHaveLength(3);
    expect(paragraph.text).toBe("The quick brown fox jumps over the lazy dog and keeps on running.");
    expect(paragraph.lineHeight).toBeCloseTo((0.018 * 800) / 12, 2);
    expect(paragraph.alignment).toBe("left");
  });

  it("detects justified text from aligned right edges", () => {
    const lines = [line("a", 0), line("b", 1), line("c", 2), line("end", 3, { width: 0.3 })];
    expect(findParagraph(lines, lines[0]!, info)!.alignment).toBe("justify");
  });

  it("detects centred text", () => {
    const lines = [line("Centred title line", 0, { x: 0.3, width: 0.4 }), line("short", 1, { x: 0.45, width: 0.1 })];
    expect(findParagraph(lines, lines[0]!, info)!.alignment).toBe("center");
  });

  it("stops at style changes and big gaps", () => {
    const lines = [line("Heading", 0, { size: 18, bold: true }), line("Body one", 1), line("Body two", 2), line("Far away", 6)];
    const paragraph = findParagraph(lines, lines[1]!, info)!;
    expect(paragraph.lines.map((item) => item.text)).toEqual(["Body one", "Body two"]);
  });

  it("leaves mixed-style lines to line editing", () => {
    const lines = [line("Plain ", 0, { width: 0.2 }), line("bold", 0, { x: 0.3, width: 0.1, bold: true }), line("next", 1)];
    expect(findParagraph(lines, lines[0]!, info)).toBeNull();
    expect(findParagraph([line("alone", 0)], line("alone", 0), info)).toBeNull();
  });

  it("re-joins hyphenated words", () => {
    expect(joinLines(["an exam-", "ple of hyphen-", "Ation"])).toBe("an example of hyphen- Ation");
  });
});
