import type { Overlay, PageLayout } from "@paperless/editor-core";
import type { PageInfo } from "@paperless/pdf-engine";

/** Generated overlays use this id prefix; they are not selectable or stored. */
export const LAYOUT_ID = "layout:";

const fill = (template: string, index: number, total: number) =>
  template.replaceAll("{page}", String(index + 1)).replaceAll("{pages}", String(total));

/** Builds header/footer/watermark/Bates overlays for the current page order. */
export function layoutOverlays(layout: PageLayout | null, pageOrder: number[], pages: PageInfo[]): Overlay[] {
  if (!layout) return [];
  const overlays: Overlay[] = [];
  pageOrder.forEach((source, index) => {
    const info = pages[source];
    if (!info) return;
    const id = (role: string) => `${LAYOUT_ID}${role}:${source}`;
    const text = {
      page: source,
      kind: "text" as const,
      size: 10,
      color: "#444444",
      fontFamily: "Helvetica",
      fontName: null,
      bold: false,
      italic: false,
      underline: false,
      alignment: "center" as const,
      lineHeight: 1.2,
      letterSpacing: 0,
      fitMode: "shrink" as const,
    };
    if (layout.background) overlays.push({ id: id("background"), page: source, kind: "background", color: layout.background, opacity: 1 });
    if (layout.header) overlays.push({ ...text, id: id("header"), x: 0.06, y: 0.02, width: 0.88, height: 0.03, text: fill(layout.header, index, pageOrder.length), layoutRole: "header" });
    if (layout.footer) overlays.push({ ...text, id: id("footer"), x: 0.06, y: 0.955, width: 0.88, height: 0.03, text: fill(layout.footer, index, pageOrder.length), layoutRole: "footer" });
    if (layout.watermark) {
      // A diagonal watermark centred on the page, corner to corner.
      const angle = (-Math.atan2(info.height, info.width) * 180) / Math.PI;
      const radians = (angle * Math.PI) / 180;
      const span = Math.hypot(info.width, info.height) * 0.7;
      const size = Math.min(96, span / Math.max(4, layout.watermark.length) / 0.65);
      const boxHeight = size * 1.2;
      const x = info.width / 2 - (Math.cos(radians) * span) / 2 + (Math.sin(radians) * boxHeight) / 2;
      const y = info.height / 2 - (Math.sin(radians) * span) / 2 - (Math.cos(radians) * boxHeight) / 2;
      overlays.push({
        ...text,
        id: id("watermark"),
        x: x / info.width,
        y: y / info.height,
        width: span / info.width,
        height: boxHeight / info.height,
        text: layout.watermark,
        size,
        bold: true,
        color: "#888888",
        opacity: 0.25,
        rotation: angle,
        layoutRole: "watermark",
      });
    }
    if (layout.batesPrefix)
      overlays.push({
        ...text,
        id: id("bates"),
        x: 0.62,
        y: 0.955,
        width: 0.32,
        height: 0.03,
        text: `${layout.batesPrefix}${String(layout.batesStart + index).padStart(layout.batesDigits, "0")}`,
        alignment: "right",
        layoutRole: "bates",
      });
  });
  return overlays;
}
