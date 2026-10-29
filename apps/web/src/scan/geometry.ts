// Document detection and perspective correction for scanned photos. Pure
// functions over RGBA pixels so they run in tests, workers or the page.

export type Point = { x: number; y: number };
/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];
export type Raster = { data: Uint8ClampedArray; width: number; height: number };

export const FULL_FRAME: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

export function luminance({ data, width, height }: Raster) {
  const gray = new Float32Array(width * height);
  for (let index = 0, pixel = 0; index < gray.length; index += 1, pixel += 4)
    gray[index] = 0.299 * data[pixel]! + 0.587 * data[pixel + 1]! + 0.114 * data[pixel + 2]!;
  return gray;
}

/** Separable box blur with clamped edges. */
export function boxBlur(values: Float32Array, width: number, height: number, radius: number) {
  if (radius < 1) return values.slice();
  const pass = (input: Float32Array, length: number, lines: number, stride: number, step: number) => {
    const output = new Float32Array(input.length);
    const size = radius * 2 + 1;
    for (let line = 0; line < lines; line += 1) {
      const base = line * stride;
      const at = (index: number) => input[base + Math.min(length - 1, Math.max(0, index)) * step]!;
      let sum = 0;
      for (let index = -radius; index <= radius; index += 1) sum += at(index);
      for (let index = 0; index < length; index += 1) {
        output[base + index * step] = sum / size;
        sum += at(index + radius + 1) - at(index - radius);
      }
    }
    return output;
  };
  return pass(pass(values, width, height, width, 1), height, width, 1, width);
}

/** Otsu's threshold for values in 0–255. */
export function otsu(values: Float32Array) {
  const histogram = new Float64Array(256);
  for (const value of values) histogram[Math.max(0, Math.min(255, Math.round(value)))]! += 1;
  let total = 0;
  for (let level = 0; level < 256; level += 1) total += level * histogram[level]!;
  let below = 0;
  let belowSum = 0;
  let best = 0;
  let threshold = 128;
  for (let level = 0; level < 256; level += 1) {
    below += histogram[level]!;
    if (!below) continue;
    const above = values.length - below;
    if (!above) break;
    belowSum += level * histogram[level]!;
    const meanBelow = belowSum / below;
    const meanAbove = (total - belowSum) / above;
    const between = below * above * (meanBelow - meanAbove) ** 2;
    if (between > best) {
      best = between;
      threshold = level;
    }
  }
  return threshold;
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull, counter-clockwise in image coordinates (monotone chain). */
export function convexHull(points: Point[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export const polygonArea = (points: Point[]) =>
  Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;

/** Orders four corners as top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(points: Point[]): Quad {
  const centre = { x: points.reduce((sum, point) => sum + point.x, 0) / 4, y: points.reduce((sum, point) => sum + point.y, 0) / 4 };
  const around = [...points].sort((a, b) => Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x));
  // Starting from the corner closest to the top-left keeps the order stable.
  const start = around.reduce((best, point, index) => (point.x + point.y < around[best]!.x + around[best]!.y ? index : best), 0);
  return [0, 1, 2, 3].map((offset) => around[(start + offset) % 4]!) as Quad;
}

/** The largest-area quadrilateral with corners on the hull. */
export function largestQuad(hull: Point[]): Point[] | null {
  if (hull.length < 4) return null;
  // Drop the points that matter least (smallest triangle with their
  // neighbours) so the corners survive while the search stays small.
  const points = [...hull];
  while (points.length > 24) {
    let weakest = 0;
    let smallest = Infinity;
    points.forEach((point, index) => {
      const area = Math.abs(cross(points[(index + points.length - 1) % points.length]!, point, points[(index + 1) % points.length]!));
      if (area < smallest) {
        smallest = area;
        weakest = index;
      }
    });
    points.splice(weakest, 1);
  }
  const count = points.length;
  let best: Point[] | null = null;
  let bestArea = 0;
  for (let a = 0; a < count; a += 1)
    for (let b = a + 1; b < count; b += 1)
      for (let c = b + 1; c < count; c += 1)
        for (let d = c + 1; d < count; d += 1) {
          const quad = [points[a]!, points[b]!, points[c]!, points[d]!];
          const area = polygonArea(quad);
          if (area > bestArea) {
            bestArea = area;
            best = quad;
          }
        }
  return best;
}

type Region = { area: number; sum: number; rows: Map<number, [number, number]>; touches: number };

/** Connected regions (4-neighbour) of a mask, with each row's extent. */
function regions(mask: Uint8Array, values: Float32Array, width: number, height: number, minimum: number) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const found: Region[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const region: Region = { area: 0, sum: 0, rows: new Map(), touches: 0 };
    let edges = 0;
    while (top) {
      const index = stack[--top]!;
      const x = index % width;
      const y = (index - x) / width;
      region.area += 1;
      region.sum += values[index]!;
      const row = region.rows.get(y);
      if (!row) region.rows.set(y, [x, x]);
      else {
        if (x < row[0]) row[0] = x;
        if (x > row[1]) row[1] = x;
      }
      if (x === 0) edges |= 1;
      if (y === 0) edges |= 2;
      if (x === width - 1) edges |= 4;
      if (y === height - 1) edges |= 8;
      const visit = (next: number) => {
        if (mask[next] && !seen[next]) {
          seen[next] = 1;
          stack[top++] = next;
        }
      };
      if (x > 0) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y < height - 1) visit(index + width);
    }
    region.touches = [1, 2, 4, 8].filter((bit) => edges & bit).length;
    if (region.area >= minimum) found.push(region);
  }
  return found;
}

/**
 * Finds the page in a photo: the large, nearly quadrilateral region that
 * stands out from its surroundings. Returns normalized corners, or null when
 * nothing convincing is found. Pass a downscaled image (about 300–500 px).
 */
export function detectDocument(raster: Raster): Quad | null {
  const { width, height } = raster;
  const imageArea = width * height;
  const gray = boxBlur(luminance(raster), width, height, Math.max(1, Math.round(Math.min(width, height) / 150)));
  const threshold = otsu(gray);
  const total = gray.reduce((sum, value) => sum + value, 0);
  let best: { quad: Point[]; score: number } | null = null;
  for (const bright of [true, false]) {
    const mask = new Uint8Array(gray.length);
    for (let index = 0; index < gray.length; index += 1) mask[index] = (bright ? gray[index]! > threshold : gray[index]! <= threshold) ? 1 : 0;
    for (const region of regions(mask, gray, width, height, imageArea * 0.08)) {
      // A region touching every edge is the background, not the page.
      if (region.touches === 4) continue;
      // The page must stand out clearly from what is around it.
      const contrast = Math.abs(region.sum / region.area - (total - region.sum) / (imageArea - region.area));
      if (contrast < 40) continue;
      const outline: Point[] = [];
      region.rows.forEach(([left, right], y) => outline.push({ x: left, y }, { x: right + 1, y }, { x: left, y: y + 1 }, { x: right + 1, y: y + 1 }));
      const quad = largestQuad(convexHull(outline));
      if (!quad) continue;
      const quadArea = polygonArea(quad);
      // Row spans fill in the text and pictures on the page.
      let spans = 0;
      region.rows.forEach(([left, right]) => (spans += right - left + 1));
      const fill = spans / quadArea;
      const coverage = quadArea / imageArea;
      if (fill < 0.82 || coverage < 0.1 || coverage > 0.995) continue;
      const score = Math.min(1, fill) * Math.sqrt(coverage) * (bright ? 1 : 0.9);
      if (!best || score > best.score) best = { quad, score };
    }
  }
  if (!best) return null;
  return orderCorners(best.quad.map((point) => ({ x: Math.min(1, Math.max(0, point.x / width)), y: Math.min(1, Math.max(0, point.y / height)) })));
}

/** 3×3 homography (row-major) mapping each `from` corner onto `to`. */
export function homography(from: Point[], to: Point[]) {
  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = from[index]!;
    const { x: u, y: v } = to[index]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const lead = rows[column]![column]!;
    if (Math.abs(lead) < 1e-12) throw new Error("The corners do not form a usable shape.");
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = rows[row]![column]! / lead;
      for (let index = column; index < 9; index += 1) rows[row]![index]! -= factor * rows[column]![index]!;
    }
  }
  return [...rows.map((row, index) => row[8]! / row[index]!), 1];
}

export const project = (matrix: number[], { x, y }: Point): Point => {
  const w = matrix[6]! * x + matrix[7]! * y + matrix[8]!;
  return { x: (matrix[0]! * x + matrix[1]! * y + matrix[2]!) / w, y: (matrix[3]! * x + matrix[4]! * y + matrix[5]!) / w };
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Width ÷ height of the real page from its photographed corners (in pixels),
 * assuming the lens centre is the middle of the image. Follows Zhang and He's
 * whiteboard-scanning method. Returns null when the shape is not consistent
 * with a camera photo.
 */
export function pageAspect(corners: Quad, image: { width: number; height: number }) {
  const lift = ({ x, y }: Point) => [x - image.width / 2, y - image.height / 2, 1] as const;
  const [m1, m2, m4, m3] = corners.map(lift) as [Vector, Vector, Vector, Vector];
  const k2 = dot(crossVector(m1, m4), m3) / dot(crossVector(m2, m4), m3);
  const k3 = dot(crossVector(m1, m4), m2) / dot(crossVector(m3, m4), m2);
  const n2 = m2.map((value, index) => k2 * value - m1[index]!) as unknown as Vector;
  const n3 = m3.map((value, index) => k3 * value - m1[index]!) as unknown as Vector;
  const scale = Math.hypot(image.width, image.height);
  // Seen square-on there is no perspective to undo: the edges are in proportion.
  if (Math.abs(n2[2]) * scale < Math.hypot(n2[0], n2[1]) * 0.02 && Math.abs(n3[2]) * scale < Math.hypot(n3[0], n3[1]) * 0.02)
    return Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
  const focal2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  if (!Number.isFinite(focal2) || focal2 < (scale * 0.2) ** 2 || focal2 > (scale * 6) ** 2) return null;
  const ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + focal2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + focal2 * n3[2] ** 2));
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}
type Vector = readonly [number, number, number];
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossVector = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Output size for a corrected page from its corners in pixels, capped on the
 * long edge. With the photo's size, the page keeps its real proportions even
 * when shot at an angle.
 */
export function correctedSize(corners: Quad, maxEdge = 2600, image?: { width: number; height: number }) {
  let width = Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]));
  let height = Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]));
  const aspect = image ? pageAspect(corners, image) : null;
  if (aspect && aspect / (width / height) > 0.5 && aspect / (width / height) < 2) {
    height = Math.max(height, width / aspect);
    width = height * aspect;
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Straightens the quadrilateral `corners` (in pixels) of `source` into a width × height image. */
export function warpPerspective(source: Raster, corners: Quad, width: number, height: number): Raster {
  const matrix = homography(
    [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    corners,
  );
  const output = new Uint8ClampedArray(width * height * 4);
  const { data, width: sourceWidth, height: sourceHeight } = source;
  const maxX = sourceWidth - 1;
  const maxY = sourceHeight - 1;
  for (let y = 0; y < height; y += 1) {
    const cy = y + 0.5;
    for (let x = 0; x < width; x += 1) {
      const cx = x + 0.5;
      const w = matrix[6]! * cx + matrix[7]! * cy + matrix[8]!;
      const sx = Math.min(maxX, Math.max(0, (matrix[0]! * cx + matrix[1]! * cy + matrix[2]!) / w - 0.5));
      const sy = Math.min(maxY, Math.max(0, (matrix[3]! * cx + matrix[4]! * cy + matrix[5]!) / w - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(maxX, x0 + 1);
      const y1 = Math.min(maxY, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const a = (y0 * sourceWidth + x0) * 4;
      const b = (y0 * sourceWidth + x1) * 4;
      const c = (y1 * sourceWidth + x0) * 4;
      const d = (y1 * sourceWidth + x1) * 4;
      const out = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = data[a + channel]! + (data[b + channel]! - data[a + channel]!) * fx;
        const bottom = data[c + channel]! + (data[d + channel]! - data[c + channel]!) * fx;
        output[out + channel] = top + (bottom - top) * fy;
      }
      output[out + 3] = 255;
    }
  }
  return { data: output, width, height };
}

/** Rotates a raster clockwise by a multiple of 90°. */
export function rotateRaster(source: Raster, degrees: number): Raster {
  const turns = (((Math.round(degrees / 90) % 4) + 4) % 4);
  if (!turns) return source;
  const { width, height, data } = source;
  const outWidth = turns % 2 ? height : width;
  const outHeight = turns % 2 ? width : height;
  const output = new Uint8ClampedArray(data.length);
  const view = new Uint32Array(data.buffer, data.byteOffset, width * height);
  const out = new Uint32Array(output.buffer);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const [nx, ny] = turns === 1 ? [height - 1 - y, x] : turns === 2 ? [width - 1 - x, height - 1 - y] : [y, width - 1 - x];
      out[ny * outWidth + nx] = view[y * width + x]!;
    }
  return { data: output, width: outWidth, height: outHeight };
}

/** True when the corners make a convex, non-degenerate shape. */
export function isUsableQuad(quad: Quad) {
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const turn = cross(quad[index]!, quad[(index + 1) % 4]!, quad[(index + 2) % 4]!);
    if (Math.abs(turn) < 1e-6) return false;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  return polygonArea(quad) > 0.01;
}
