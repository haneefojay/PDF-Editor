import { describe, expect, it } from "vitest";
import type { PositionedTextLine } from "@paperless/pdf-engine";
import { sentencesOf } from "./readAloud";

let id = 0;
const run = (text: string, block: number, line: number, x: number, y: number, width: number): PositionedTextLine => ({
  id: String(id++), text, x, y, width, height: 0.02, baseline: y + 0.016, size: 12, color: "#000000", fontFamily: "Helvetica", fontName: "Helvetica",
  bold: false, italic: false, alignment: "left", lineHeight: 1.2, letterSpacing: 0, fitMode: "auto", block, line,
});

describe("read aloud sentences", () => {
  it("splits page text into sentences across lines and runs, with their boxes", () => {
    const lines = [
      run("Revenue grew this quarter. Costs", 0, 0, 0.1, 0.1, 0.6),
      run("stayed flat, so margins im-", 0, 1, 0.1, 0.13, 0.5),
      run("proved.", 0, 2, 0.1, 0.16, 0.1),
      run("Total:", 1, 3, 0.1, 0.3, 0.1),
      run("$2,180,000", 1, 3, 0.5, 0.3, 0.15),
    ];
    const sentences = sentencesOf(lines);
    expect(sentences.map((sentence) => sentence.text)).toEqual(["Revenue grew this quarter.", "Costs stayed flat, so margins improved.", "Total: $2,180,000"]);
    // The first sentence covers the start of the first line only.
    expect(sentences[0]!.boxes).toHaveLength(1);
    expect(sentences[0]!.boxes[0]!.width).toBeLessThan(0.6);
    expect(sentences[1]!.boxes).toHaveLength(3);
    expect(sentences[1]!.top).toBeCloseTo(0.1);
  });

  it("breaks very long sentences into speakable pieces", () => {
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(", ");
    const sentences = sentencesOf([run(`${long}.`, 0, 0, 0, 0, 1)]);
    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.every((sentence) => sentence.text.length <= 220)).toBe(true);
    expect(sentences.map((sentence) => sentence.text).join(" ")).toBe(`${long}.`);
  });

  it("skips runs with nothing to say", () => {
    expect(sentencesOf([run("   ", 0, 0, 0, 0, 1), run("•", 0, 1, 0, 0.1, 0.01)])).toEqual([]);
  });
});
