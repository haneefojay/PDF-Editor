import { describe, expect, it } from "vitest";
import { applyFilter } from "./filters";
import { correctedSize, detectDocument, homography, orderCorners, project, warpPerspective, type Point, type Quad, type Raster } from "./geometry";

const inside = (polygon: Point[], x: number, y: number) => {
  let hit = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
};

/** A photo-like scene: a page with text lines on a noisy desk, lit from one side. */
function scene(width: number, height: number, corners: Point[], desk = 70): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 24;
  const inverse = corners.length === 4 ? homography(corners, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) : [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const light = 0.75 + 0.25 * (x / width);
      let value = desk + noise();
      let tint = [1, 0.85, 0.7];
      if (corners.length === 4 && inside(corners, x + 0.5, y + 0.5)) {
        const local = project(inverse, { x: x + 0.5, y: y + 0.5 });
        const ink = local.x > 0.1 && local.x < 0.9 && local.y > 0.1 && local.y < 0.9 && Math.floor(local.y * 40) % 3 === 0;
        value = (ink ? 40 : 235) * light + noise() / 3;
        tint = [1, 1, 0.97];
      }
      const pixel = (y * width + x) * 4;
      data[pixel] = value * tint[0]!;
      data[pixel + 1] = value * tint[1]!;
      data[pixel + 2] = value * tint[2]!;
      data[pixel + 3] = 255;
    }
  return { data, width, height };
}

const near = (quad: Quad, expected: Point[], width: number, height: number, tolerance = 0.02) =>
  quad.forEach((point, index) => {
    expect(Math.abs(point.x - expected[index]!.x / width)).toBeLessThan(tolerance);
    expect(Math.abs(point.y - expected[index]!.y / height)).toBeLessThan(tolerance);
  });

describe("document detection", () => {
  it("finds a tilted page on a desk", () => {
    const corners = [{ x: 70, y: 40 }, { x: 250, y: 60 }, { x: 235, y: 330 }, { x: 45, y: 310 }];
    const quad = detectDocument(scene(300, 380, corners))!;
    expect(quad).not.toBeNull();
    near(quad, corners, 300, 380);
  });

  it("finds a page in perspective, photographed at an angle", () => {
    const corners = [{ x: 110, y: 50 }, { x: 290, y: 50 }, { x: 350, y: 290 }, { x: 40, y: 290 }];
    near(detectDocument(scene(400, 320, corners))!, corners, 400, 320);
  });

  it("gives up on a plain image", () => {
    expect(detectDocument(scene(200, 200, [], 120))).toBeNull();
  });

  it("orders corners clockwise from the top left", () => {
    const quad = orderCorners([{ x: 9, y: 9 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 1 }]);
    expect(quad).toEqual([{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 9, y: 9 }, { x: 0, y: 10 }]);
  });
});

describe("perspective correction", () => {
  it("maps corners exactly", () => {
    const from = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const to = [{ x: 10, y: 5 }, { x: 90, y: 20 }, { x: 80, y: 70 }, { x: 5, y: 60 }];
    const matrix = homography(from, to);
    from.forEach((point, index) => {
      const mapped = project(matrix, point);
      expect(mapped.x).toBeCloseTo(to[index]!.x, 6);
      expect(mapped.y).toBeCloseTo(to[index]!.y, 6);
    });
  });

  it("straightens a tilted page into a clean rectangle", () => {
    const corners: Quad = [{ x: 70, y: 40 }, { x: 250, y: 60 }, { x: 235, y: 330 }, { x: 45, y: 310 }];
    const size = correctedSize(corners);
    expect(size.width).toBeGreaterThan(185);
    expect(size.height).toBeGreaterThan(265);
    const flat = warpPerspective(scene(300, 380, corners), corners, size.width, size.height);
    const at = (x: number, y: number) => flat.data[(Math.floor(y * flat.height) * flat.width + Math.floor(x * flat.width)) * 4]!;
    // Margins are paper, the text lines come out level.
    expect(at(0.05, 0.05)).toBeGreaterThan(150);
    expect(at(0.95, 0.95)).toBeGreaterThan(150);
    const row = Math.floor(0.3 * 40) / 40 + 0.4 / 40;
    expect(at(0.2, row)).toBeLessThan(90);
    expect(at(0.8, row)).toBeLessThan(90);
  });

  it("caps the long edge", () => {
    expect(correctedSize([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }], 2000)).toEqual({ width: 2000, height: 1500 });
  });
});

describe("scan filters", () => {
  const page = () => scene(200, 260, [{ x: -1, y: -1 }, { x: 201, y: -1 }, { x: 201, y: 261 }, { x: -1, y: 261 }]);
  const values = (raster: Raster, ink: boolean) => {
    const found: number[] = [];
    for (let y = 30; y < 230; y += 1) {
      const position = ((y + 1.5) / 262) * 40;
      // Skip rows on the boundary of a text line.
      if (position % 1 < 0.15 || position % 1 > 0.85) continue;
      if ((Math.floor(position) % 3 === 0) !== ink) continue;
      for (let x = 40; x < 160; x += 7) found.push(raster.data[(y * 200 + x) * 4 + 1]!);
    }
    return found;
  };

  it("whitens shaded paper and keeps ink dark", () => {
    const original = page();
    expect(Math.min(...values(original, false))).toBeLessThan(200);
    const cleaned = applyFilter(original, "document");
    expect(Math.min(...values(cleaned, false))).toBeGreaterThan(235);
    expect(Math.max(...values(cleaned, true))).toBeLessThan(90);
  });

  it("makes black and white pages", () => {
    const bw = applyFilter(page(), "blackWhite");
    expect(new Set([...values(bw, false), ...values(bw, true)])).toEqual(new Set([0, 255]));
    expect(values(bw, true).every((value) => value === 0)).toBe(true);
  });
});

describe("raster helpers", () => {
  it("rotates clockwise", async () => {
    const { rotateRaster } = await import("./geometry");
    // 2×1 image: red, blue → rotated becomes 1×2 with red on top.
    const source = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
    const turned = rotateRaster(source, 90);
    expect([turned.width, turned.height]).toEqual([1, 2]);
    expect([...turned.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    const back = rotateRaster(source, 270);
    expect([...back.data]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });

  it("rejects crossed corners", async () => {
    const { isUsableQuad } = await import("./geometry");
    expect(isUsableQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).toBe(true);
    expect(isUsableQuad([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBe(false);
  });
});

/** Corners of a w×h page photographed by a pinhole camera, tilted away at the top. */
function photographed(page: { width: number; height: number }, view: { tilt: number; turn: number; distance: number; focal: number; image: { width: number; height: number } }): Quad {
  const tilt = (view.tilt * Math.PI) / 180;
  const turn = (view.turn * Math.PI) / 180;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const x0 = (sx * page.width) / 2;
    const y0 = (sy * page.height) / 2;
    const [x1, y1] = [x0 * Math.cos(turn) - y0 * Math.sin(turn), x0 * Math.sin(turn) + y0 * Math.cos(turn)];
    const [y2, z2] = [y1 * Math.cos(tilt), y1 * Math.sin(tilt)];
    const z = view.distance - z2;
    return { x: (view.focal * x1) / z + view.image.width / 2, y: (view.focal * y2) / z + view.image.height / 2 };
  }) as Quad;
}

describe("page proportions", () => {
  const image = { width: 1280, height: 960 };
  it("recovers an A4 page shot at an angle", async () => {
    const { pageAspect } = await import("./geometry");
    for (const view of [
      { tilt: 35, turn: 8, distance: 520, focal: 1000 },
      { tilt: 20, turn: -15, distance: 600, focal: 1400 },
      { tilt: 0.01, turn: 30, distance: 500, focal: 900 },
    ]) {
      const corners = photographed({ width: 210, height: 297 }, { ...view, image });
      expect(pageAspect(corners, image)).toBeCloseTo(210 / 297, 2);
    }
  });

  it("sizes the corrected page in proportion", () => {
    const corners = photographed({ width: 300, height: 400 }, { tilt: 40, turn: 5, distance: 700, focal: 1000, image });
    const size = correctedSize(corners, 2600, image);
    expect(size.width / size.height).toBeCloseTo(0.75, 2);
  });
});
