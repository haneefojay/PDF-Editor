import { describe, expect, it } from "vitest";
import { baselineOffset, fontCategory, layoutText } from "./text-layout";

// Every character is half an em wide.
const measure = (text: string, size: number) => Array.from(text).length * size * 0.5;
const base = { size: 10, lineHeight: 1.2, letterSpacing: 0, measure };

describe("text layout", () => {
  it("wraps words to the box width", () => {
    const layout = layoutText("aaaa bbbb cccc", { ...base, maxWidth: 40, fitMode: "auto" });
    expect(layout.lines).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(layout.height).toBeCloseTo(36);
  });

  it("breaks words that are wider than the box", () => {
    const layout = layoutText("abcdefghij", { ...base, maxWidth: 20, fitMode: "auto" });
    expect(layout.lines).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps explicit line breaks", () => {
    expect(layoutText("one\ntwo", { ...base, maxWidth: 500, fitMode: "auto" }).lines).toEqual(["one", "two"]);
  });

  it("shrinks to fit without wrapping", () => {
    const layout = layoutText("abcdefghij", { ...base, maxWidth: 25, fitMode: "shrink" });
    expect(layout.lines).toEqual(["abcdefghij"]);
    expect(layout.size).toBeCloseTo(6);
    expect(layoutText("abc", { ...base, maxWidth: 25, fitMode: "shrink" }).size).toBe(10);
  });

  it("counts letter spacing between characters", () => {
    const layout = layoutText("abc", { ...base, letterSpacing: 2, maxWidth: 500, fitMode: "overflow" });
    expect(layout.width).toBeCloseTo(19);
  });

  it("classifies font families", () => {
    expect(fontCategory("Times New Roman")).toBe("serif");
    expect(fontCategory("Noto Sans")).toBe("sans");
    expect(fontCategory("Microsoft Sans Serif")).toBe("sans");
    expect(fontCategory("Courier New")).toBe("mono");
    expect(fontCategory("Calibri")).toBe("sans");
  });

  it("centres glyphs in the line box like CSS", () => {
    expect(baselineOffset("sans", 10, 1.117)).toBeCloseTo(9.05);
  });
});
