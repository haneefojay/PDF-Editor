import { boxBlur, luminance, type Raster } from "./geometry";

export type ScanFilter = "original" | "auto" | "document" | "grayscale" | "blackWhite";

export const scanFilters: { id: ScanFilter; label: string }[] = [
  { id: "document", label: "Document" },
  { id: "auto", label: "Auto colour" },
  { id: "original", label: "Original" },
  { id: "grayscale", label: "Grayscale" },
  { id: "blackWhite", label: "B&W" },
];

/**
 * Paper brightness across the page: the brightest values in coarse blocks,
 * smoothed and interpolated back to full size. Dividing by it removes shadows
 * and uneven lighting while keeping ink dark.
 */
export function paperLevel(gray: Float32Array, width: number, height: number) {
  const block = Math.max(8, Math.round(Math.min(width, height) / 24));
  const columns = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const smooth = boxBlur(gray, width, height, 1);
  const peaks = new Float32Array(columns * rows);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const cell = Math.floor(y / block) * columns + Math.floor(x / block);
      peaks[cell] = Math.max(peaks[cell]!, smooth[y * width + x]!);
    }
  // Spread bright paper into blocks covered by ink or pictures.
  const spread = new Float32Array(peaks.length);
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      let peak = 0;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = Math.min(rows - 1, Math.max(0, row + dy));
          const c = Math.min(columns - 1, Math.max(0, column + dx));
          peak = Math.max(peak, peaks[r * columns + c]!);
        }
      spread[row * columns + column] = peak;
    }
  const levels = boxBlur(spread, columns, rows, 1);
  const level = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(columns - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(columns - 1, x0 + 1);
      const fx = gx - x0;
      const top = levels[y0 * columns + x0]! + (levels[y0 * columns + x1]! - levels[y0 * columns + x0]!) * fx;
      const bottom = levels[y1 * columns + x0]! + (levels[y1 * columns + x1]! - levels[y1 * columns + x0]!) * fx;
      level[y * width + x] = Math.max(24, top + (bottom - top) * fy);
    }
  }
  return level;
}

const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);

/** Levels that push nearly-white paper to white and deepen ink. */
const curve = (value: number, black = 30, white = 225) => clamp(((value - black) * 255) / (white - black));

/** Applies a scan filter, returning a new raster. */
export function applyFilter(source: Raster, filter: ScanFilter): Raster {
  const { width, height } = source;
  const data = new Uint8ClampedArray(source.data);
  if (filter === "original") return { data, width, height };
  if (filter === "auto") {
    // Per-channel stretch between the 1st and 99th percentiles also balances white.
    for (let channel = 0; channel < 3; channel += 1) {
      const histogram = new Uint32Array(256);
      for (let pixel = channel; pixel < data.length; pixel += 4) histogram[data[pixel]!]! += 1;
      const total = width * height;
      let low = 0;
      let high = 255;
      for (let seen = 0; low < 255 && (seen += histogram[low]!) < total * 0.01; ) low += 1;
      for (let seen = 0; high > 0 && (seen += histogram[high]!) < total * 0.01; ) high -= 1;
      const range = Math.max(32, high - low);
      for (let pixel = channel; pixel < data.length; pixel += 4) data[pixel] = clamp(((data[pixel]! - low) * 255) / range);
    }
    return { data, width, height };
  }
  const gray = luminance(source);
  const paper = paperLevel(gray, width, height);
  for (let index = 0, pixel = 0; index < gray.length; index += 1, pixel += 4) {
    const gain = 255 / paper[index]!;
    if (filter === "document") {
      for (let channel = 0; channel < 3; channel += 1) data[pixel + channel] = curve(data[pixel + channel]! * gain);
    } else {
      const value = gray[index]! * gain;
      const out = filter === "grayscale" ? curve(value) : value < 175 ? 0 : 255;
      data[pixel] = data[pixel + 1] = data[pixel + 2] = out;
    }
  }
  return { data, width, height };
}
