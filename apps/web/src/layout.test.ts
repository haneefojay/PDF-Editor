import { describe, expect, it } from "vitest";
import { layoutOverlays } from "./layout";

const layout = { header: "", footer: "Page {page} of {pages}", watermark: "", batesPrefix: "DOC-", batesStart: 7, batesDigits: 3, background: null };
const pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }, { width: 600, height: 800 }];

describe("page layout", () => {
  it("numbers pages in their current order", () => {
    const overlays = layoutOverlays(layout, [2, 0], pages);
    const texts = overlays.map((overlay) => [overlay.page, overlay.kind === "text" ? overlay.text : ""]);
    expect(texts).toEqual([
      [2, "Page 1 of 2"],
      [2, "DOC-007"],
      [0, "Page 2 of 2"],
      [0, "DOC-008"],
    ]);
  });

  it("produces nothing without a layout", () => {
    expect(layoutOverlays(null, [0, 1], pages)).toEqual([]);
  });

  it("keeps watermarks inside the page", () => {
    const [mark] = layoutOverlays({ ...layout, footer: "", batesPrefix: "", watermark: "CONFIDENTIAL" }, [0], pages);
    expect(mark?.kind).toBe("text");
    if (mark?.kind !== "text") return;
    expect(mark.rotation).toBeLessThan(0);
    // The box rotates about its top-left corner; every corner must stay on the page.
    const radians = ((mark.rotation ?? 0) * Math.PI) / 180;
    const [w, h] = [mark.width * 600, mark.height * 800];
    for (const [dx, dy] of [[0, 0], [w, 0], [0, h], [w, h]] as const) {
      const x = mark.x * 600 + dx * Math.cos(radians) - dy * Math.sin(radians);
      const y = mark.y * 800 + dx * Math.sin(radians) + dy * Math.cos(radians);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(600);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(800);
    }
  });
});
