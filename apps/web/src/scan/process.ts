// Browser glue for scanning: decoding photos, detecting the page and
// producing the corrected, filtered page image.
import { applyFilter, type ScanFilter } from "./filters";
import { correctedSize, detectDocument, FULL_FRAME, rotateRaster, warpPerspective, type Quad, type Raster } from "./geometry";

export type ScanSettings = { corners: Quad; filter: ScanFilter; rotation: number };

const canvas = (width: number, height: number) => {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
};

/** Pixels of an image or video frame, scaled so the long edge is at most `maxEdge`. */
export function rasterOf(source: CanvasImageSource, width: number, height: number, maxEdge = Infinity): Raster {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const target = canvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const context = target.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, target.width, target.height);
  const { data } = context.getImageData(0, 0, target.width, target.height);
  return { data, width: target.width, height: target.height };
}

/** Finds the page; live previews use a small frame, photos a sharper one. */
export const detectIn = (source: CanvasImageSource, width: number, height: number, maxEdge = 360) => detectDocument(rasterOf(source, width, height, maxEdge));

/** Decodes a photo, honouring its EXIF orientation. */
export const decode = (blob: Blob) => createImageBitmap(blob, { imageOrientation: "from-image" });

/** Straightens the page; filtering and rotation are applied separately so they can change cheaply. */
export function straighten(source: Raster, corners: Quad, maxEdge: number) {
  const pixels = corners.map((point) => ({ x: point.x * source.width, y: point.y * source.height })) as Quad;
  const size = correctedSize(pixels, maxEdge, source);
  return warpPerspective(source, pixels, size.width, size.height);
}

export const finish = (straight: Raster, settings: Pick<ScanSettings, "filter" | "rotation">) => rotateRaster(applyFilter(straight, settings.filter), settings.rotation);

export function drawRaster(target: HTMLCanvasElement, raster: Raster) {
  target.width = raster.width;
  target.height = raster.height;
  target.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
}

export function encodeJpeg(raster: Raster, quality = 0.86) {
  const target = canvas(raster.width, raster.height);
  drawRaster(target, raster);
  return new Promise<Blob>((resolve, reject) => target.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The page image could not be saved."))), "image/jpeg", quality));
}

export const toDataUrl = (raster: Raster) => {
  const target = canvas(raster.width, raster.height);
  drawRaster(target, raster);
  return target.toDataURL("image/jpeg", 0.8);
};

/** Full-quality page image for the PDF. */
export async function renderScan(source: Blob, settings: ScanSettings, maxEdge = 2600) {
  const bitmap = await decode(source);
  try {
    const raster = rasterOf(bitmap, bitmap.width, bitmap.height);
    return await encodeJpeg(finish(straighten(raster, settings.corners, maxEdge), settings));
  } finally {
    bitmap.close();
  }
}

/** Reads a photo and finds the page in it. */
export async function prepareScan(source: Blob) {
  const bitmap = await decode(source);
  try {
    const corners = detectIn(bitmap, bitmap.width, bitmap.height, 800);
    return { width: bitmap.width, height: bitmap.height, corners: corners ?? FULL_FRAME, detected: Boolean(corners) };
  } finally {
    bitmap.close();
  }
}

/** Gives the browser a frame to paint before heavy work. */
export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
