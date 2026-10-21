import type { Overlay } from "@paperless/editor-core";
import type { PositionedTextLine } from "@paperless/pdf-engine";

export type Rect = { x: number; y: number; width: number; height: number };

export const boundsOf = (overlay: Overlay): Rect => {
  if (overlay.kind === "background") return { x: 0, y: 0, width: 1, height: 1 };
  if ("points" in overlay) {
    const xs = overlay.points.map((point) => point.x);
    const ys = overlay.points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(0.01, Math.max(...xs) - x), height: Math.max(0.01, Math.max(...ys) - y) };
  }
  return { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height };
};

/** Lines of original text a dragged markup box should snap to. */
export function snapToText(rect: Rect, lines: PositionedTextLine[]): Rect[] {
  const tap = rect.width < 0.004 && rect.height < 0.004;
  return lines
    .filter((line) => {
      const overlapY = Math.min(rect.y + rect.height, line.y + line.height) - Math.max(rect.y, line.y);
      const overlapX = Math.min(rect.x + rect.width, line.x + line.width) - Math.max(rect.x, line.x);
      if (tap)
        return rect.x >= line.x && rect.x <= line.x + line.width && rect.y >= line.y && rect.y <= line.y + line.height;
      return overlapY > Math.min(line.height, rect.height) * 0.4 && overlapX > 0;
    })
    .map((line) => {
      if (tap) return { x: line.x, y: line.y, width: line.width, height: line.height };
      const x = Math.max(line.x, rect.x);
      return { x, y: line.y, width: Math.min(line.x + line.width, rect.x + rect.width) - x, height: line.height };
    })
    .filter((item) => item.width > 0.002);
}
