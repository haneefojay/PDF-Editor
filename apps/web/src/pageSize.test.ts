import { describe, expect, it } from "vitest";
import type { Overlay } from "@paperless/editor-core";
import { PAGE_SIZES, mapOverlay, presetOf, targetSize } from "./pageSize";

const mapping = { source: 0, target: 1, scale: 0.5, scaleX: 0.8, scaleY: 0.5, offsetX: 0.1, offsetY: 0 };

describe("page sizes", () => {
  it("recognises presets in either orientation", () => {
    expect(presetOf(595.28, 841.89)).toBe("A4");
    expect(presetOf(792, 612)).toBe("Letter");
    expect(presetOf(500, 500)).toBe("custom");
  });

  it("keeps or forces orientation", () => {
    expect(targetSize(PAGE_SIZES.Letter, "keep", { width: 800, height: 600 })).toEqual({ width: 792, height: 612 });
    expect(targetSize(PAGE_SIZES.Letter, "keep", { width: 600, height: 800 })).toEqual({ width: 612, height: 792 });
    expect(targetSize(PAGE_SIZES.Letter, "portrait", { width: 800, height: 600 })).toEqual({ width: 612, height: 792 });
    expect(targetSize({ width: 792, height: 612 }, "landscape", { width: 600, height: 800 })).toEqual({ width: 792, height: 612 });
  });

  it("moves edits onto the resized page", () => {
    const text = { id: "t", page: 0, kind: "text", x: 0.5, y: 0.2, width: 0.25, height: 0.1, size: 20 } as Overlay;
    const moved = mapOverlay(text, mapping, 7) as Extract<Overlay, { kind: "text" }>;
    expect(moved).toMatchObject({ page: 7, x: 0.5, y: 0.1, width: 0.2, height: 0.05, size: 10 });
    expect(moved.id).not.toBe("t");
    const ink = { id: "i", page: 0, kind: "ink", points: [{ x: 0, y: 1 }, { x: 1, y: 0 }], color: "#000", width: 4 } as Overlay;
    expect(mapOverlay(ink, mapping, 7)).toMatchObject({ points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0 }], width: 2 });
  });
});
