import { describe, expect, it } from "vitest";
import { blankRanges, findXObjectDraws } from "./contentStream";

const encode = (text: string) => new TextEncoder().encode(text);

describe("content stream scanning", () => {
  it("tracks the transform through q/Q and cm", () => {
    const draws = findXObjectDraws([encode("q 2 0 0 2 10 20 cm q 100 0 0 50 0 0 cm /Im1 Do Q /Im2 Do Q /Im3 Do")]);
    expect(draws.map((draw) => [draw.name, draw.matrix])).toEqual([
      ["Im1", [200, 0, 0, 100, 10, 20]],
      ["Im2", [2, 0, 0, 2, 10, 20]],
      ["Im3", [1, 0, 0, 1, 0, 0]],
    ]);
  });

  it("is not confused by strings, comments, dictionaries or inline images", () => {
    const stream = "% a comment with /Fake Do\nBT (text with (nested) and \\) and /Name Do) Tj ET /P <</MCID 0>> BDC BI /W 1 /H 1 ID \u0000Do\u0001 EI EMC q 5 0 0 5 1 1 cm /Real Do Q";
    const draws = findXObjectDraws([encode(stream)]);
    expect(draws.map((draw) => draw.name)).toEqual(["Real"]);
    expect(draws[0]!.matrix).toEqual([5, 0, 0, 5, 1, 1]);
  });

  it("keeps state across content streams and blanks exact ranges", () => {
    const streams = [encode("q 3 0 0 3 0 0 cm"), encode("/X Do Q")];
    const [draw] = findXObjectDraws(streams);
    expect(draw!.stream).toBe(1);
    expect(draw!.matrix).toEqual([3, 0, 0, 3, 0, 0]);
    const blanked = new TextDecoder().decode(blankRanges(streams[1]!, [draw!]));
    expect(blanked).toBe("      Q");
  });

  it("decodes escaped names", () => {
    expect(findXObjectDraws([encode("/Im#20One Do")])[0]!.name).toBe("Im One");
  });
});
