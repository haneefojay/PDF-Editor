import { describe, expect, it } from "vitest";
import { linesFromTsv } from "./ocr";

describe("OCR TSV parsing", () => {
  it("groups words into positioned confidence-aware lines", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t100\t200\t80\t30\t92\tPaperless",
      "5\t1\t1\t1\t1\t2\t190\t200\t40\t30\t88\tOCR",
      "5\t1\t1\t1\t2\t1\t100\t250\t70\t25\t40\tReview",
    ].join("\n");

    expect(linesFromTsv(tsv, 1000, 2000)).toEqual([
      { text: "Paperless OCR", confidence: 90, x: 0.1, y: 0.1, width: 0.13, height: 0.015 },
      { text: "Review", confidence: 40, x: 0.1, y: 0.125, width: 0.07, height: 0.0125 },
    ]);
  });
});