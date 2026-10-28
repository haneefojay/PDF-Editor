import type { NormalizedRect, Overlay } from "@paperless/editor-core";
import type { PageMapping } from "@paperless/pdf-engine";

const MM = 72 / 25.4;

/** Portrait sizes in points. */
export const PAGE_SIZES = {
  A3: { label: "A3", width: 297 * MM, height: 420 * MM },
  A4: { label: "A4", width: 210 * MM, height: 297 * MM },
  A5: { label: "A5", width: 148 * MM, height: 210 * MM },
  Letter: { label: "Letter", width: 612, height: 792 },
  Legal: { label: "Legal", width: 612, height: 1008 },
} as const;
export type PageSizePreset = keyof typeof PAGE_SIZES | "custom";
export type Orientation = "keep" | "portrait" | "landscape";

export const pointsToMm = (points: number) => points / MM;
export const mmToPoints = (mm: number) => mm * MM;

/** Name of the preset a page already has, if any. */
export function presetOf(width: number, height: number): PageSizePreset {
  const [short, long] = [Math.min(width, height), Math.max(width, height)];
  const match = (Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).find(
    (key) => Math.abs(PAGE_SIZES[key].width - short) < 2 && Math.abs(PAGE_SIZES[key].height - long) < 2,
  );
  return match ?? "custom";
}

/**
 * The size a page gets, as it is displayed (after the user's rotation).
 * `width`/`height` describe a portrait sheet; "keep" follows the page.
 */
export function targetSize(size: { width: number; height: number }, orientation: Orientation, page: { width: number; height: number }) {
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  const landscape = orientation === "keep" ? page.width > page.height : orientation === "landscape";
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** Moves an edit made on the original page onto its resized copy. */
export function mapOverlay<T extends Overlay>(overlay: T, mapping: PageMapping, page: number): T {
  const point = ({ x, y }: { x: number; y: number }) => ({ x: x * mapping.scaleX + mapping.offsetX, y: y * mapping.scaleY + mapping.offsetY });
  const moved = { ...overlay, id: crypto.randomUUID(), page } as T & Record<string, unknown>;
  if ("x" in overlay && "width" in overlay && "height" in overlay) {
    Object.assign(moved, point(overlay), { width: overlay.width * mapping.scaleX, height: overlay.height * mapping.scaleY });
  }
  if ("points" in overlay) moved.points = overlay.points.map(point);
  if (overlay.kind === "text") moved.size = overlay.size * mapping.scale;
  if (overlay.kind === "ink" || overlay.kind === "signature" || overlay.kind === "line") moved.width = overlay.width * mapping.scale;
  if (overlay.kind === "shape") moved.strokeWidth = overlay.strokeWidth * mapping.scale;
  // Measurements keep reporting the same real-world distance.
  if (overlay.kind === "measurement") moved.scale = overlay.scale / mapping.scale;
  return moved;
}

export const mapCrop = (crop: NormalizedRect, mapping: PageMapping): NormalizedRect => ({
  x: crop.x * mapping.scaleX + mapping.offsetX,
  y: crop.y * mapping.scaleY + mapping.offsetY,
  width: crop.width * mapping.scaleX,
  height: crop.height * mapping.scaleY,
});
