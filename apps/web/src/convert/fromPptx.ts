// PowerPoint → PDF: each visible slide becomes one page of the slide's size.
// Shapes, pictures, tables and text keep their places, theme colours and
// fonts, including what the slide inherits from its layout and master; the
// engine draws them and lays out the text of each box with MuPDF.
import type { SlideColor, SlideFill, SlideItem, SlideMatrix, SlidePart, SlidePath } from "@paperless/pdf-engine";
import { fontStack } from "./fromDocx";
import { readZip } from "./unzip";
import { child, elements, find, parseXml, textOf, type XmlNode } from "./xml";

const EMU = 12_700;
const pt = (value: string | undefined, fallback = 0) => (value === undefined || value === "" || Number.isNaN(Number(value)) ? fallback : Number(value) / EMU);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Transforms, applied left to right: concat(a, b) is "a, then b".
const IDENTITY: SlideMatrix = [1, 0, 0, 1, 0, 0];
const concat = (a: SlideMatrix, b: SlideMatrix): SlideMatrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const translate = (x: number, y: number): SlideMatrix => [1, 0, 0, 1, x, y];
const rotate = (degrees: number): SlideMatrix => {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0];
};
/** Places a w × h frame at (x, y), turned and mirrored about its centre like PowerPoint. */
const place = (box: Box, degrees: number, flipH = false, flipV = false): SlideMatrix =>
  [translate(-box.width / 2, -box.height / 2), [flipH ? -1 : 1, 0, 0, flipV ? -1 : 1, 0, 0] as SlideMatrix, rotate(degrees), translate(box.x + box.width / 2, box.y + box.height / 2)].reduce(concat);

type Box = { x: number; y: number; width: number; height: number };
type Color = { rgb: SlideColor; alpha: number };
type Theme = { colors: Record<string, string>; major: string; minor: string; lineWidths: number[]; fills: XmlNode[]; backgrounds: XmlNode[] };
/** A fill as read from the file; `gradient` lacks the frame size until it is drawn. */
type Fill = Color & { gradient?: Omit<NonNullable<SlideFill["gradient"]>, "width" | "height"> };

// ---- Colours ----

const PRESET_COLORS: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080",
  darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500", purple: "800080", navy: "000080", silver: "C0C0C0", maroon: "800000", teal: "008080",
};
const hexRgb = (hex: string): SlideColor => [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255 || 0) as SlideColor;
const cssColor = (color: Color) => `#${color.rgb.map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;

function toHsl([r, g, b]: SlideColor): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  if (max === min) return [0, 0, light];
  const delta = max - min;
  const saturation = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue / 6, saturation, light];
}
function fromHsl(hue: number, saturation: number, light: number): SlideColor {
  if (!saturation) return [light, light, light];
  const q = light < 0.5 ? light * (1 + saturation) : light + saturation - light * saturation;
  const p = 2 * light - q;
  const channel = (t: number) => {
    const at = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return at < 1 / 6 ? p + (q - p) * 6 * at : at < 1 / 2 ? q : at < 2 / 3 ? p + (q - p) * (2 / 3 - at) * 6 : p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const toLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const toSrgb = (value: number) => clamp(value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);

// ---- Preset shapes ----

type Pen = { path: SlidePath; x: number; y: number };
/** Appends an elliptical arc like DrawingML's arcTo: angles in degrees, clockwise from the x axis. */
function arc(pen: Pen, rx: number, ry: number, start: number, sweep: number) {
  const startRad = (start * Math.PI) / 180;
  const cx = pen.x - rx * Math.cos(startRad);
  const cy = pen.y - ry * Math.sin(startRad);
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / 90));
  const step = ((sweep / segments) * Math.PI) / 180;
  const k = (4 / 3) * Math.tan(step / 4);
  let angle = startRad;
  for (let index = 0; index < segments; index += 1) {
    const next = angle + step;
    const [x1, y1] = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
    const [x2, y2] = [cx + rx * Math.cos(next), cy + ry * Math.sin(next)];
    pen.path.push(["C", x1 - k * rx * Math.sin(angle), y1 + k * ry * Math.cos(angle), x2 + k * rx * Math.sin(next), y2 - k * ry * Math.cos(next), x2, y2]);
    angle = next;
  }
  pen.x = cx + rx * Math.cos(angle);
  pen.y = cy + ry * Math.sin(angle);
}
const polygon = (points: [number, number][]): SlidePath => [["M", ...points[0]!], ...points.slice(1).map((point) => ["L", ...point] as ["L", number, number]), ["Z"]];
const ellipse = (width: number, height: number): SlidePath => {
  const pen: Pen = { path: [["M", width, height / 2]], x: width, y: height / 2 };
  arc(pen, width / 2, height / 2, 0, 360);
  pen.path.push(["Z"]);
  return pen.path;
};

/** Outline of a preset shape in a w × h frame; `adjust` holds the shape's adjustment values (out of 100,000). */
export function presetPath(name: string, w: number, h: number, adjust: Record<string, number> = {}): SlidePath {
  const ss = Math.min(w, h);
  const a = (key: string, fallback: number) => (adjust[key] ?? fallback) / 100_000;
  switch (name) {
    case "ellipse":
    case "flowChartConnector":
      return ellipse(w, h);
    case "roundRect": {
      const r = ss * Math.min(0.5, a("adj", 16_667));
      const pen: Pen = { path: [["M", r, 0], ["L", w - r, 0]], x: w - r, y: 0 };
      arc(pen, r, r, 270, 90);
      pen.path.push(["L", w, h - r]);
      [pen.x, pen.y] = [w, h - r];
      arc(pen, r, r, 0, 90);
      pen.path.push(["L", r, h]);
      [pen.x, pen.y] = [r, h];
      arc(pen, r, r, 90, 90);
      pen.path.push(["L", 0, r]);
      [pen.x, pen.y] = [0, r];
      arc(pen, r, r, 180, 90);
      pen.path.push(["Z"]);
      return pen.path;
    }
    case "triangle":
      return polygon([[w * a("adj", 50_000), 0], [w, h], [0, h]]);
    case "rtTriangle":
      return polygon([[0, 0], [w, h], [0, h]]);
    case "diamond":
    case "flowChartDecision":
      return polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case "parallelogram": {
      const x = ss * a("adj", 25_000);
      return polygon([[x, 0], [w, 0], [w - x, h], [0, h]]);
    }
    case "trapezoid": {
      const x = ss * a("adj", 25_000);
      return polygon([[0, h], [x, 0], [w - x, 0], [w, h]]);
    }
    case "pentagon":
      return polygon([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]]);
    case "hexagon": {
      const x = ss * a("adj", 25_000);
      return polygon([[x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h], [0, h / 2]]);
    }
    case "octagon": {
      const x = ss * a("adj", 29_289);
      return polygon([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]);
    }
    case "homePlate": {
      const x = w - ss * a("adj", 50_000);
      return polygon([[0, 0], [x, 0], [w, h / 2], [x, h], [0, h]]);
    }
    case "chevron": {
      const x = ss * a("adj", 50_000);
      return polygon([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]]);
    }
    case "rightArrow":
    case "leftArrow": {
      const shaft = (h * a("adj1", 50_000)) / 2;
      const head = w - ss * a("adj2", 50_000);
      const points: [number, number][] = [[0, h / 2 - shaft], [head, h / 2 - shaft], [head, 0], [w, h / 2], [head, h], [head, h / 2 + shaft], [0, h / 2 + shaft]];
      return polygon(name === "leftArrow" ? points.map(([x, y]) => [w - x, y]) : points);
    }
    case "upArrow":
    case "downArrow": {
      const shaft = (w * a("adj1", 50_000)) / 2;
      const head = h - ss * a("adj2", 50_000);
      const points: [number, number][] = [[w / 2 - shaft, 0], [w / 2 - shaft, head], [0, head], [w / 2, h], [w, head], [w / 2 + shaft, head], [w / 2 + shaft, 0]];
      return polygon(name === "upArrow" ? points.map(([x, y]) => [x, h - y]) : points);
    }
    case "plus": {
      const x = ss * a("adj", 25_000);
      return polygon([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]]);
    }
    case "star5": {
      const points: [number, number][] = [];
      for (let index = 0; index < 10; index += 1) {
        const angle = -Math.PI / 2 + (index * Math.PI) / 5;
        const radius = index % 2 ? 0.382 : 1;
        points.push([w / 2 + (w / 2) * radius * Math.cos(angle), h / 2 + (h / 2) * radius * Math.sin(angle) * 1.05 + h * 0.025]);
      }
      return polygon(points);
    }
    case "line":
    case "straightConnector1":
    case "bentConnector1":
      return [["M", 0, 0], ["L", w, h]];
    default:
      return polygon([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}

/** A custom geometry's paths, scaled into a w × h frame. Returns null for guide formulas this reader does not evaluate. */
function customPath(geometry: XmlNode, w: number, h: number): { path: SlidePath; filled: boolean } | null {
  const path: SlidePath = [];
  let filled = false;
  for (const item of elements(find(geometry, "a:pathLst"), "a:path")) {
    const sx = item.attrs.w ? w / Number(item.attrs.w) : 1 / EMU;
    const sy = item.attrs.h ? h / Number(item.attrs.h) : 1 / EMU;
    if (item.attrs.fill !== "none") filled = true;
    const pen: Pen = { path, x: 0, y: 0 };
    const point = (node: XmlNode | undefined): [number, number] | null => {
      const [x, y] = [Number(node?.attrs.x), Number(node?.attrs.y)];
      return Number.isFinite(x) && Number.isFinite(y) ? [x * sx, y * sy] : null;
    };
    for (const command of elements(item)) {
      const points = elements(command, "a:pt").map(point);
      if (points.some((value) => !value)) return null;
      const [p1, p2, p3] = points as [number, number][];
      if (command.name === "a:moveTo" && p1) path.push(["M", ...p1]);
      else if (command.name === "a:lnTo" && p1) path.push(["L", ...p1]);
      else if (command.name === "a:cubicBezTo" && p1 && p2 && p3) path.push(["C", ...p1, ...p2, ...p3]);
      else if (command.name === "a:quadBezTo" && p1 && p2) path.push(["C", pen.x + ((p1[0] - pen.x) * 2) / 3, pen.y + ((p1[1] - pen.y) * 2) / 3, p2[0] + ((p1[0] - p2[0]) * 2) / 3, p2[1] + ((p1[1] - p2[1]) * 2) / 3, ...p2]);
      else if (command.name === "a:arcTo") {
        const values = ["wR", "hR", "stAng", "swAng"].map((key) => Number(command.attrs[key]));
        if (values.some((value) => !Number.isFinite(value))) return null;
        arc(pen, values[0]! * sx, values[1]! * sy, values[2]! / 60_000, values[3]! / 60_000);
        continue;
      } else if (command.name === "a:close") path.push(["Z"]);
      const last = path.at(-1);
      if (last && last[0] !== "Z") [pen.x, pen.y] = last.slice(-2) as [number, number];
    }
  }
  return path.length ? { path, filled } : null;
}

// ---- Text ----

type ParagraphStyle = { align?: string; marginLeft?: number; indent?: number; lineSpacing?: { percent?: number; points?: number }; before?: { percent?: number; points?: number }; after?: { percent?: number; points?: number }; bullet?: { char?: string; autoNumber?: string; start?: number; none?: boolean; color?: Color; font?: string; sizePercent?: number } };
type RunStyle = { size?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; caps?: boolean; color?: Color; font?: string; baseline?: number };
type Level = { paragraph: ParagraphStyle; run: RunStyle };
type BodyProps = { left: number; top: number; right: number; bottom: number; anchor: "top" | "middle" | "bottom"; wrap: boolean; fontScale: number; spacingReduction: number; vertical: boolean };

const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
const flag = (value: string | undefined) => (value === undefined ? undefined : value === "1" || value === "true");
const spacing = (node: XmlNode | undefined) => {
  if (!node) return undefined;
  const percent = child(node, "a:spcPct")?.attrs.val;
  const points = child(node, "a:spcPts")?.attrs.val;
  return percent !== undefined ? { percent: Number(percent) / 100_000 } : points !== undefined ? { points: Number(points) / 100 } : undefined;
};

/** Symbol-font bullets with no Unicode meaning are shown as round bullets. */
const bulletChar = (char: string, font: string | undefined) => {
  if (!font || !/wingdings|symbol|webdings/i.test(font)) return char;
  return { "§": "\u25aa", n: "\u25aa", q: "\u25aa", l: "\u2022", "·": "\u2022", "–": "\u2013", "-": "\u2013" }[char] ?? "\u2022";
};

function autoNumber(scheme: string, number: number) {
  const roman = (value: number) => {
    let out = "";
    for (const [amount, digits] of [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]] as const)
      while (value >= amount) {
        out += digits;
        value -= amount;
      }
    return out;
  };
  const alpha = (value: number) => {
    let out = "";
    for (let left = value; left > 0; left = Math.floor((left - 1) / 26)) out = String.fromCharCode(97 + ((left - 1) % 26)) + out;
    return out;
  };
  const body = scheme.startsWith("roman") ? roman(number) : scheme.startsWith("alpha") ? alpha(number) : String(number);
  const cased = /Uc/.test(scheme) ? body.toUpperCase() : body;
  if (scheme.endsWith("ParenBoth")) return `(${cased})`;
  if (scheme.endsWith("ParenR")) return `${cased})`;
  if (scheme.endsWith("Plain")) return cased;
  return `${cased}.`;
}

// PowerPoint's default table style, Medium Style 2 – Accent 1. Files often
// name it without saving its definition.
const line = (side: string, width: number) => `<a:${side}><a:ln w="${width}"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:${side}>`;
const accent = (tint?: number) => `<a:fill><a:solidFill><a:schemeClr val="accent1">${tint ? `<a:tint val="${tint}"/>` : ""}</a:schemeClr></a:solidFill></a:fill>`;
const strong = '<a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle>';
const DEFAULT_TABLE_STYLE = `<a:tblStyleLst><a:tblStyle styleId="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}">
<a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${["left", "right", "top", "bottom", "insideH", "insideV"].map((side) => line(side, 12_700)).join("")}</a:tcBdr>${accent(20_000)}</a:tcStyle></a:wholeTbl>
<a:band1H><a:tcStyle>${accent(40_000)}</a:tcStyle></a:band1H><a:band1V><a:tcStyle>${accent(40_000)}</a:tcStyle></a:band1V>
<a:lastCol>${strong}<a:tcStyle>${accent()}</a:tcStyle></a:lastCol><a:firstCol>${strong}<a:tcStyle>${accent()}</a:tcStyle></a:firstCol>
<a:lastRow>${strong}<a:tcStyle><a:tcBdr>${line("top", 38_100)}</a:tcBdr>${accent()}</a:tcStyle></a:lastRow>
<a:firstRow>${strong}<a:tcStyle><a:tcBdr>${line("bottom", 38_100)}</a:tcBdr>${accent()}</a:tcStyle></a:firstRow>
</a:tblStyle></a:tblStyleLst>`;

// ---- The reader ----

export async function pptxToSlides(bytes: Uint8Array): Promise<SlidePart[]> {
  const files = await readZip(bytes);
  const xmlCache = new Map<string, XmlNode | undefined>();
  const read = (name: string) => {
    if (!xmlCache.has(name)) {
      const data = files.get(name);
      xmlCache.set(name, data ? parseXml(new TextDecoder().decode(data)) : undefined);
    }
    return xmlCache.get(name);
  };
  const resolve = (base: string, target: string) => {
    if (target.startsWith("/")) return target.slice(1);
    const parts = base.split("/").slice(0, -1);
    for (const piece of target.split("/")) {
      if (piece === "..") parts.pop();
      else if (piece !== ".") parts.push(piece);
    }
    return parts.join("/");
  };
  /** A part's relationships: id → { type, target path }. */
  const relationships = (part: string) => {
    const slash = part.lastIndexOf("/");
    const rels = read(`${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`);
    const map = new Map<string, { type: string; target: string }>();
    for (const rel of elements(find(rels, "Relationships"), "Relationship"))
      if (rel.attrs.TargetMode !== "External") map.set(rel.attrs.Id ?? "", { type: (rel.attrs.Type ?? "").split("/").pop() ?? "", target: resolve(part, rel.attrs.Target ?? "") });
    return map;
  };
  const relatedOf = (part: string, type: string) => [...relationships(part).values()].find((rel) => rel.type === type)?.target;

  const presentation = find(read("ppt/presentation.xml"), "p:presentation");
  if (!presentation) throw new Error("This file is not a PowerPoint presentation.");
  const size = child(presentation, "p:sldSz");
  const slideWidth = pt(size?.attrs.cx, 720);
  const slideHeight = pt(size?.attrs.cy, 540);
  const presentationRels = relationships("ppt/presentation.xml");
  const defaultTextStyle = child(presentation, "p:defaultTextStyle");

  // Table styles saved with the file, by id.
  const tableStyles = new Map<string, XmlNode>();
  for (const style of elements(find(parseXml(DEFAULT_TABLE_STYLE), "a:tblStyleLst"), "a:tblStyle")) tableStyles.set(style.attrs.styleId ?? "", style);
  const savedStyles = find(read("ppt/tableStyles.xml"), "a:tblStyleLst");
  for (const style of elements(savedStyles, "a:tblStyle")) tableStyles.set(style.attrs.styleId ?? "", style);
  const defaultTableStyle = savedStyles?.attrs.def ?? "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";

  const themes = new Map<string, Theme>();
  const themeOf = (masterPath: string): Theme => {
    const path = relatedOf(masterPath, "theme") ?? "";
    if (!themes.has(path)) {
      const xml = read(path);
      const colors: Record<string, string> = {};
      for (const node of elements(find(xml, "a:clrScheme"))) {
        const value = child(node, "a:srgbClr")?.attrs.val ?? child(node, "a:sysClr")?.attrs.lastClr;
        if (value) colors[node.name.replace(/^a:/, "")] = value;
      }
      const latin = (name: string) => child(find(xml, name), "a:latin")?.attrs.typeface ?? "Calibri";
      themes.set(path, {
        colors,
        major: latin("a:majorFont"),
        minor: latin("a:minorFont"),
        lineWidths: elements(find(xml, "a:lnStyleLst"), "a:ln").map((line) => pt(line.attrs.w, 0.75)),
        fills: elements(find(xml, "a:fillStyleLst")),
        backgrounds: elements(find(xml, "a:bgFillStyleLst")),
      });
    }
    return themes.get(path)!;
  };

  const parts: SlidePart[] = [];
  const slideIds = elements(child(presentation, "p:sldIdLst"), "p:sldId");
  for (const slideId of slideIds) {
    const slidePath = presentationRels.get(slideId.attrs["r:id"] ?? "")?.target;
    const slide = slidePath ? find(read(slidePath), "p:sld") : undefined;
    if (!slidePath || !slide || slide.attrs.show === "0") continue;
    const slideNumber = slideIds.indexOf(slideId) + 1;
    const layoutPath = relatedOf(slidePath, "slideLayout") ?? "";
    const layout = find(read(layoutPath), "p:sldLayout");
    const masterPath = relatedOf(layoutPath, "slideMaster") ?? "";
    const master = find(read(masterPath), "p:sldMaster");
    const theme = themeOf(masterPath);

    // Scheme colour names (bg1, tx1…) map to theme colours through the master's map, which a layout or slide may override.
    const colorMap: Record<string, string> = { ...child(master, "p:clrMap")?.attrs };
    for (const level of [layout, slide]) Object.assign(colorMap, child(child(level, "p:clrMapOvr"), "a:overrideClrMapping")?.attrs ?? {});

    /** Reads the colour inside a fill or colour element; `placeholder` stands for phClr in theme styles. */
    const colorOf = (node: XmlNode | undefined, placeholder?: Color): Color | undefined => {
      const value = node && elements(node).find((item) => /^a:(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/.test(item.name));
      if (!value) return undefined;
      let rgb: SlideColor;
      let alpha = 1;
      if (value.name === "a:srgbClr") rgb = hexRgb(value.attrs.val ?? "000000");
      else if (value.name === "a:sysClr") rgb = hexRgb(value.attrs.lastClr ?? (value.attrs.val === "window" ? "FFFFFF" : "000000"));
      else if (value.name === "a:prstClr") rgb = hexRgb(PRESET_COLORS[value.attrs.val ?? ""] ?? "000000");
      else if (value.name === "a:scrgbClr") rgb = ["r", "g", "b"].map((key) => Number(value.attrs[key] ?? 0) / 100_000) as SlideColor;
      else if (value.name === "a:hslClr") rgb = fromHsl(Number(value.attrs.hue ?? 0) / 21_600_000, Number(value.attrs.sat ?? 0) / 100_000, Number(value.attrs.lum ?? 0) / 100_000);
      else {
        const name = value.attrs.val ?? "tx1";
        if (name === "phClr") {
          if (!placeholder) return undefined;
          ({ rgb, alpha } = placeholder);
        } else rgb = hexRgb(theme.colors[colorMap[name] ?? name] ?? "000000");
      }
      for (const modifier of elements(value)) {
        const amount = Number(modifier.attrs.val ?? 0) / 100_000;
        const [hue, saturation, light] = toHsl(rgb);
        if (modifier.name === "a:lumMod") rgb = fromHsl(hue, saturation, clamp(light * amount));
        else if (modifier.name === "a:lumOff") rgb = fromHsl(hue, saturation, clamp(light + amount));
        else if (modifier.name === "a:satMod") rgb = fromHsl(hue, clamp(saturation * amount), light);
        // Tints and shades mix in linear light, as PowerPoint does.
        else if (modifier.name === "a:tint") rgb = rgb.map((channel) => toSrgb(1 - (1 - toLinear(channel)) * amount)) as SlideColor;
        else if (modifier.name === "a:shade") rgb = rgb.map((channel) => toSrgb(toLinear(channel) * amount)) as SlideColor;
        else if (modifier.name === "a:alpha") alpha = amount;
      }
      return { rgb, alpha };
    };
    /** A fill: a colour, null for "no fill", or undefined when the element sets none. */
    const fillOf = (node: XmlNode | undefined, placeholder?: Color): Fill | null | undefined => {
      for (const item of elements(node)) {
        if (item.name === "a:noFill") return null;
        if (item.name === "a:solidFill") return colorOf(item, placeholder) ?? null;
        if (item.name === "a:gradFill") {
          const stops = elements(child(item, "a:gsLst"), "a:gs")
            .map((stop) => ({ at: Number(stop.attrs.pos ?? 0) / 100_000, color: colorOf(stop, placeholder) }))
            .filter((stop): stop is { at: number; color: Color } => Boolean(stop.color))
            .sort((a, b) => a.at - b.at);
          if (!stops.length) return null;
          const [first, last] = [stops[0]!.color, stops.at(-1)!.color];
          // The colour halfway along stands in wherever a gradient cannot be drawn, such as text.
          return {
            rgb: first.rgb.map((value, index) => (value + last.rgb[index]!) / 2) as SlideColor,
            alpha: (first.alpha + last.alpha) / 2,
            gradient: {
              kind: child(item, "a:path") ? "radial" : "linear",
              angle: Number(child(item, "a:lin")?.attrs.ang ?? 0) / 60_000,
              stops: stops.map((stop) => ({ at: stop.at, color: stop.color.rgb, alpha: stop.color.alpha })),
            },
          };
        }
        if (item.name === "a:pattFill") return colorOf(child(item, "a:fgClr"), placeholder) ?? null;
        if (item.name === "a:grpFill") return undefined;
      }
      return undefined;
    };
    /** A theme fill style named by a shape's or background's reference, in the reference's colour. */
    const themeFill = (reference: XmlNode | undefined): Fill | undefined => {
      const index = Number(reference?.attrs.idx ?? 0);
      if (!reference || !index) return undefined;
      const color = colorOf(reference);
      const style = index > 1000 ? theme.backgrounds[index - 1001] : theme.fills[index - 1];
      return (style ? fillOf({ name: "a:fill", attrs: {}, children: [style] }, color) : undefined) ?? color;
    };
    const slideFill = (fill: Fill, box: { width: number; height: number }): SlideFill => ({
      color: fill.rgb,
      alpha: fill.alpha,
      gradient: fill.gradient && { ...fill.gradient, width: box.width, height: box.height },
    });
    const fontName = (typeface: string | undefined) => (typeface === "+mj-lt" ? theme.major : typeface === "+mn-lt" ? theme.minor : typeface);

    const readParagraph = (pPr: XmlNode | undefined): ParagraphStyle => {
      if (!pPr) return {};
      const bullet: ParagraphStyle["bullet"] = {};
      if (child(pPr, "a:buNone")) bullet.none = true;
      const char = child(pPr, "a:buChar")?.attrs.char;
      if (char !== undefined) Object.assign(bullet, { char, none: false, autoNumber: undefined });
      const auto = child(pPr, "a:buAutoNum");
      if (auto) Object.assign(bullet, { autoNumber: auto.attrs.type ?? "arabicPeriod", start: Number(auto.attrs.startAt ?? 1), none: false, char: undefined });
      const font = child(pPr, "a:buFont")?.attrs.typeface;
      if (font) bullet.font = fontName(font);
      const color = colorOf(child(pPr, "a:buClr"));
      if (color) bullet.color = color;
      const sizePercent = child(pPr, "a:buSzPct")?.attrs.val;
      if (sizePercent) bullet.sizePercent = Number(sizePercent) / 100_000;
      return defined({
        align: pPr.attrs.algn,
        marginLeft: pPr.attrs.marL !== undefined ? pt(pPr.attrs.marL) : undefined,
        indent: pPr.attrs.indent !== undefined ? pt(pPr.attrs.indent) : undefined,
        lineSpacing: spacing(child(pPr, "a:lnSpc")),
        before: spacing(child(pPr, "a:spcBef")),
        after: spacing(child(pPr, "a:spcAft")),
        bullet: Object.keys(bullet).length ? bullet : undefined,
      });
    };
    const readRun = (rPr: XmlNode | undefined): RunStyle => {
      if (!rPr) return {};
      const fill = fillOf(rPr);
      return defined({
        size: rPr.attrs.sz ? Number(rPr.attrs.sz) / 100 : undefined,
        bold: flag(rPr.attrs.b),
        italic: flag(rPr.attrs.i),
        underline: rPr.attrs.u === undefined ? undefined : rPr.attrs.u !== "none",
        strike: rPr.attrs.strike === undefined ? undefined : rPr.attrs.strike !== "noStrike",
        caps: rPr.attrs.cap === undefined ? undefined : rPr.attrs.cap === "all",
        baseline: rPr.attrs.baseline ? Number(rPr.attrs.baseline) / 1000 : undefined,
        color: fill ?? undefined,
        font: fontName(child(rPr, "a:latin")?.attrs.typeface),
      });
    };
    const mergeLevel = (base: Level, pPr: XmlNode | undefined): Level => {
      const paragraph = readParagraph(pPr);
      return {
        paragraph: { ...base.paragraph, ...paragraph, bullet: paragraph.bullet ? { ...base.paragraph.bullet, ...paragraph.bullet } : base.paragraph.bullet },
        run: { ...base.run, ...readRun(child(pPr, "a:defRPr")) },
      };
    };
    /** Applies a list style (lvl1pPr…lvl9pPr) on top of nine inherited levels. */
    const applyList = (levels: Level[], list: XmlNode | undefined) =>
      list ? levels.map((level, index) => mergeLevel(level, child(list, `a:lvl${index + 1}pPr`))) : levels;
    const baseLevels = (): Level[] => Array.from({ length: 9 }, () => ({ paragraph: {}, run: { size: 18 } }));

    // ---- Placeholders and inheritance ----

    type Placeholder = { type: string; index?: string };
    const placeholderOf = (shape: XmlNode): Placeholder | undefined => {
      const ph = find(elements(shape).find((item) => /^p:nv/.test(item.name)), "p:ph");
      return ph ? { type: ph.attrs.type ?? "obj", index: ph.attrs.idx } : undefined;
    };
    const shapesOf = (tree: XmlNode | undefined): XmlNode[] => elements(tree).flatMap((item) => (item.name === "mc:AlternateContent" ? elements(child(item, "mc:Fallback") ?? child(item, "mc:Choice")) : [item]));
    const treeOf = (root: XmlNode | undefined) => child(child(root, "p:cSld"), "p:spTree");
    const isTitle = (type: string) => type === "title" || type === "ctrTitle";
    const matchPlaceholder = (root: XmlNode | undefined, wanted: Placeholder, byType: boolean) => {
      const candidates = shapesOf(treeOf(root)).filter((shape) => shape.name === "p:sp" && placeholderOf(shape));
      const sameType = (found: Placeholder) => found.type === wanted.type || (isTitle(found.type) && isTitle(wanted.type)) || (wanted.type === "subTitle" && found.type === "body") || (wanted.type === "obj" && found.type === "body");
      if (!byType && wanted.index !== undefined) {
        const byIndex = candidates.find((shape) => placeholderOf(shape)!.index === wanted.index);
        if (byIndex) return byIndex;
      }
      return candidates.find((shape) => sameType(placeholderOf(shape)!));
    };
    /** The layout and master shapes a slide placeholder inherits from, nearest first. */
    const inheritance = (shape: XmlNode, own: "slide" | "layout" | "master") => {
      const placeholder = placeholderOf(shape);
      if (!placeholder) return [];
      const chain: XmlNode[] = [];
      if (own === "slide") {
        const fromLayout = matchPlaceholder(layout, placeholder, false);
        if (fromLayout) chain.push(fromLayout);
      }
      if (own !== "master") {
        const fromMaster = matchPlaceholder(master, placeholderOf(chain[0] ?? shape) ?? placeholder, true);
        if (fromMaster) chain.push(fromMaster);
      }
      return chain;
    };
    const textStyles = child(master, "p:txStyles");
    const masterStyleFor = (placeholder: Placeholder | undefined) => {
      if (!placeholder) return child(textStyles, "p:otherStyle");
      if (isTitle(placeholder.type)) return child(textStyles, "p:titleStyle");
      if (["dt", "ftr", "sldNum", "hdr"].includes(placeholder.type)) return child(textStyles, "p:otherStyle");
      return child(textStyles, "p:bodyStyle");
    };

    // ---- Shapes ----

    const items: SlideItem[] = [];
    const strokeOf = (spPr: XmlNode | undefined, style: XmlNode | undefined, inherited: XmlNode[]) => {
      const line = [spPr, ...inherited.map((node) => child(node, "p:spPr"))].map((node) => child(node, "a:ln")).find(Boolean);
      const reference = child(style, "a:lnRef");
      const referenceColor = colorOf(reference);
      let color: Color | null | undefined = fillOf(line, referenceColor);
      if (color === undefined) color = reference && reference.attrs.idx !== "0" ? referenceColor : undefined;
      if (!color) return undefined;
      const width = line?.attrs.w !== undefined ? pt(line.attrs.w) : (theme.lineWidths[Number(reference?.attrs.idx ?? 1) - 1] ?? 0.75);
      const dash = child(line, "a:prstDash")?.attrs.val;
      const unit = Math.max(width, 0.75);
      const dashes = !dash || dash === "solid" ? undefined : { dot: [1, 3], sysDot: [1, 1], sysDash: [3, 1], dash: [4, 3], dashDot: [4, 3, 1, 3], lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], sysDashDot: [3, 1, 1, 1] }[dash]?.map((value) => value * unit);
      return { color: color.rgb, alpha: color.alpha, width: Math.max(0.25, width), dashes };
    };
    const geometryOf = (spPr: XmlNode | undefined, box: Box) => {
      const preset = child(spPr, "a:prstGeom");
      if (preset) {
        const adjust: Record<string, number> = {};
        for (const guide of elements(child(preset, "a:avLst"), "a:gd")) {
          const value = /^val\s+(-?\d+)/.exec(guide.attrs.fmla ?? "");
          if (value) adjust[guide.attrs.name ?? ""] = Number(value[1]);
        }
        const name = preset.attrs.prst ?? "rect";
        return { path: presetPath(name, box.width, box.height, adjust), filled: !["line", "straightConnector1", "bentConnector1"].includes(name) };
      }
      const custom = child(spPr, "a:custGeom");
      return (custom && customPath(custom, box.width, box.height)) ?? { path: presetPath("rect", box.width, box.height), filled: true };
    };

    /** The paragraphs of a text body as HTML. */
    const textHtml = (body: XmlNode, levels: Level[], scale: { font: number; spacing: number }, fallbackColor: Color | undefined) => {
      const html: string[] = [];
      const counters = new Map<number, number>();
      for (const paragraph of elements(body, "a:p")) {
        const pPr = child(paragraph, "a:pPr");
        const level = Math.min(8, Number(pPr?.attrs.lvl ?? 0));
        const style = mergeLevel(levels[level]!, pPr);
        const runs = elements(paragraph).filter((item) => ["a:r", "a:br", "a:fld"].includes(item.name));
        // The shape's font colour beats inherited list styles; the run's own colour beats both.
        const runStyle = (node: XmlNode | undefined) => {
          const own = readRun(node);
          const props = { ...style.run, ...own };
          return { ...props, size: (props.size ?? 18) * scale.font, color: own.color ?? fallbackColor ?? style.run.color };
        };
        const spans: string[] = [];
        let largest = 0;
        for (const run of runs) {
          if (run.name === "a:br") {
            spans.push("<br/>");
            continue;
          }
          const props = runStyle(child(run, "a:rPr"));
          largest = Math.max(largest, props.size);
          let text = run.name === "a:fld" && run.attrs.type === "slidenum" ? String(slideNumber) : textOf(child(run, "a:t"));
          if (props.caps) text = text.toUpperCase();
          const css = [
            `font-family:${fontStack(props.font ?? theme.minor)}`,
            `font-size:${props.size.toFixed(2)}pt`,
            props.bold ? "font-weight:bold" : "",
            props.italic ? "font-style:italic" : "",
            props.underline || props.strike ? `text-decoration:${[props.underline ? "underline" : "", props.strike ? "line-through" : ""].filter(Boolean).join(" ")}` : "",
            props.color ? `color:${cssColor(props.color)}` : "",
            props.baseline ? `vertical-align:${props.baseline > 0 ? "super" : "sub"}` : "",
          ].filter(Boolean);
          spans.push(`<span style="${css.join(";")}">${escape(text).replace(/\t/g, " ").replace(/ {2}/g, " &#160;")}</span>`);
        }
        const hasText = runs.some((run) => run.name !== "a:br" && textOf(child(run, "a:t")));
        const endProps = runStyle(child(paragraph, "a:endParaRPr"));
        if (!largest) largest = endProps.size;
        const { paragraph: props } = style;
        const bullet = props.bullet;
        let marker = "";
        if (hasText && bullet && !bullet.none && (bullet.char || bullet.autoNumber)) {
          const first = runStyle(child(runs.find((run) => run.name !== "a:br"), "a:rPr"));
          const count = (counters.get(level) ?? (bullet.start ?? 1) - 1) + 1;
          counters.set(level, count);
          const symbol = bullet.autoNumber ? autoNumber(bullet.autoNumber, count) : bulletChar(bullet.char!, bullet.font);
          const color = bullet.color ?? first.color;
          marker = `<span style="font-family:${bullet.autoNumber ? fontStack(first.font ?? theme.minor) : "sans-serif"};font-size:${(first.size * (bullet.sizePercent ?? 1)).toFixed(2)}pt${color ? `;color:${cssColor(color)}` : ""}">${escape(symbol)}&#160; </span>`;
        }
        // Numbering restarts after a paragraph at a shallower level.
        for (const key of [...counters.keys()]) if (key > level) counters.delete(key);
        if (!marker) counters.delete(level);
        const amount = (value: { percent?: number; points?: number } | undefined) => (value ? (value.points ?? (value.percent ?? 0) * largest * 1.2) : 0);
        const line = props.lineSpacing;
        const lineHeight = line?.points ? line.points : largest * 1.2 * Math.max(0.5, (line?.percent ?? 1) - scale.spacing);
        const align = { ctr: "center", r: "right", just: "justify", dist: "justify" }[props.align ?? ""] ?? "left";
        const css = [
          "margin:0",
          `margin-left:${(props.marginLeft ?? 0).toFixed(2)}pt`,
          props.indent ? `text-indent:${props.indent.toFixed(2)}pt` : "",
          `margin-top:${amount(props.before).toFixed(2)}pt`,
          `margin-bottom:${amount(props.after).toFixed(2)}pt`,
          `line-height:${lineHeight.toFixed(2)}pt`,
          `font-size:${largest.toFixed(2)}pt`,
          `text-align:${align}`,
        ].filter(Boolean);
        html.push(`<p style="${css.join(";")}">${marker}${spans.join("") || "&#160;"}</p>`);
      }
      return html.join("");
    };
    const documentHtml = (body: string, wrap: boolean) =>
      `<html><head><style>@page{margin:0} body{margin:0}${wrap ? "" : " p{white-space:nowrap}"}</style></head><body>${body}</body></html>`;

    const bodyProps = (chain: (XmlNode | undefined)[]): BodyProps => {
      const attrs: Record<string, string> = {};
      let fontScale = 1;
      let spacingReduction = 0;
      for (const bodyPr of [...chain].reverse()) {
        if (!bodyPr) continue;
        Object.assign(attrs, bodyPr.attrs);
        const autofit = child(bodyPr, "a:normAutofit");
        if (autofit) {
          fontScale = Number(autofit.attrs.fontScale ?? 100_000) / 100_000;
          spacingReduction = Number(autofit.attrs.lnSpcReduction ?? 0) / 100_000;
        }
      }
      return {
        left: pt(attrs.lIns, 7.2),
        top: pt(attrs.tIns, 3.6),
        right: pt(attrs.rIns, 7.2),
        bottom: pt(attrs.bIns, 3.6),
        anchor: attrs.anchor === "ctr" ? "middle" : attrs.anchor === "b" ? "bottom" : "top",
        wrap: attrs.wrap !== "none",
        fontScale,
        spacingReduction,
        vertical: attrs.vert === "vert" || attrs.vert === "eaVert",
      };
    };

    type Frame = { map: (box: Box) => Box; outer: SlideMatrix };
    const xfrmBox = (xfrm: XmlNode | undefined): Box | undefined => {
      const off = child(xfrm, "a:off");
      const ext = child(xfrm, "a:ext");
      return off && ext ? { x: pt(off.attrs.x), y: pt(off.attrs.y), width: pt(ext.attrs.cx), height: pt(ext.attrs.cy) } : undefined;
    };
    const turn = (xfrm: XmlNode | undefined) => ({ degrees: Number(xfrm?.attrs.rot ?? 0) / 60_000, flipH: xfrm?.attrs.flipH === "1", flipV: xfrm?.attrs.flipV === "1" });

    const addText = (body: XmlNode | undefined, matrix: SlideMatrix, box: Box, levels: Level[], bodyChain: (XmlNode | undefined)[], color: Color | undefined) => {
      if (!body || !elements(body, "a:p").some((paragraph) => textOf(paragraph).trim() || find(paragraph, "a:fld"))) return;
      const props = bodyProps([child(body, "a:bodyPr"), ...bodyChain]);
      let inner: Box = { x: props.left, y: props.top, width: Math.max(1, box.width - props.left - props.right), height: Math.max(1, box.height - props.top - props.bottom) };
      let frame = matrix;
      if (props.vertical) {
        // Vertical text runs down the box, turned a quarter turn clockwise.
        frame = concat(concat(rotate(90), translate(box.width - props.right, props.top)), matrix);
        inner = { x: 0, y: 0, width: inner.height, height: inner.width };
      } else frame = concat(translate(inner.x, inner.y), matrix);
      const html = textHtml(body, levels, { font: props.fontScale, spacing: props.spacingReduction }, color);
      items.push({ kind: "text", matrix: frame, width: inner.width, height: inner.height, html: documentHtml(html, props.wrap), anchor: props.anchor });
    };

    const addShape = (shape: XmlNode, frame: Frame, own: "slide" | "layout" | "master") => {
      const placeholder = placeholderOf(shape);
      const chain = inheritance(shape, own);
      const spPr = child(shape, "p:spPr");
      const xfrm = child(spPr, "a:xfrm") ?? chain.map((node) => child(child(node, "p:spPr"), "a:xfrm")).find((node) => xfrmBox(node));
      const local = xfrmBox(xfrm);
      if (!local) return;
      const box = frame.map(local);
      const { degrees, flipH, flipV } = turn(xfrm);
      const matrix = concat(place(box, degrees, flipH, flipV), frame.outer);
      const style = child(shape, "p:style");

      const geometry = geometryOf(spPr ?? chain.map((node) => child(node, "p:spPr")).find((node) => child(node, "a:prstGeom")), box);
      let fill: Fill | null | undefined = fillOf(spPr);
      for (const node of chain) if (fill === undefined) fill = fillOf(child(node, "p:spPr"));
      if (fill === undefined) fill = themeFill(child(style, "a:fillRef"));
      const stroke = strokeOf(spPr, style, chain);
      if ((fill && geometry.filled) || stroke) items.push({ kind: "shape", matrix, path: geometry.path, fill: fill && geometry.filled ? slideFill(fill, box) : undefined, stroke });

      // Text keeps upright under a horizontal mirror and turns over under a vertical one.
      const textMatrix = concat(place(box, degrees + (flipV ? 180 : 0)), frame.outer);
      let levels = placeholder ? baseLevels() : applyList(baseLevels(), defaultTextStyle);
      levels = applyList(levels, masterStyleFor(placeholder));
      for (const node of [...chain].reverse()) levels = applyList(levels, child(child(node, "p:txBody"), "a:lstStyle"));
      const body = child(shape, "p:txBody");
      levels = applyList(levels, child(body, "a:lstStyle"));
      const fontColor = colorOf(child(style, "a:fontRef"));
      addText(body, textMatrix, box, levels, chain.map((node) => child(child(node, "p:txBody"), "a:bodyPr")), fontColor);
    };

    const addPicture = (picture: XmlNode, frame: Frame, partPath: string) => {
      const spPr = child(picture, "p:spPr");
      const xfrm = child(spPr, "a:xfrm");
      const local = xfrmBox(xfrm);
      const blipFill = child(picture, "p:blipFill");
      const blip = child(blipFill, "a:blip");
      const target = relationships(partPath).get(blip?.attrs["r:embed"] ?? "")?.target;
      const data = target ? files.get(target) : undefined;
      if (!local) return;
      const box = frame.map(local);
      const { degrees, flipH, flipV } = turn(xfrm);
      const matrix = concat(place(box, degrees, flipH, flipV), frame.outer);
      if (data) {
        const source = child(blipFill, "a:srcRect");
        const crop = source ? { left: Number(source.attrs.l ?? 0) / 100_000, top: Number(source.attrs.t ?? 0) / 100_000, right: Number(source.attrs.r ?? 0) / 100_000, bottom: Number(source.attrs.b ?? 0) / 100_000 } : undefined;
        const preset = child(spPr, "a:prstGeom")?.attrs.prst;
        const alpha = Number(child(blip, "a:alphaModFix")?.attrs.amt ?? 100_000) / 100_000;
        items.push({ kind: "image", matrix, width: box.width, height: box.height, data, alpha, crop, clip: preset && preset !== "rect" ? presetPath(preset, box.width, box.height) : undefined });
      }
      const stroke = strokeOf(spPr, child(picture, "p:style"), []);
      if (stroke) items.push({ kind: "shape", matrix, path: geometryOf(spPr, box).path, stroke });
    };

    const addTable = (graphicFrame: XmlNode, frame: Frame) => {
      const table = find(graphicFrame, "a:tbl");
      const local = xfrmBox(child(graphicFrame, "p:xfrm"));
      if (!table || !local) return;
      const box = frame.map(local);
      const properties = child(table, "a:tblPr");
      const columns = elements(child(table, "a:tblGrid"), "a:gridCol").map((column) => pt(column.attrs.w));
      const rows = elements(table, "a:tr");
      const styleNode = tableStyles.get(textOf(child(properties, "a:tableStyleId")).trim() || defaultTableStyle);
      const on = (name: string) => properties?.attrs[name] === "1";
      // Table style parts apply from the whole table up to the most specific.
      const partsFor = (row: number, column: number) => {
        const names = ["a:wholeTbl"];
        if (on("bandRow") && (row - (on("firstRow") ? 1 : 0)) % 2 === 0) names.push("a:band1H");
        if (on("bandCol") && (column - (on("firstCol") ? 1 : 0)) % 2 === 0) names.push("a:band1V");
        if (on("firstCol") && column === 0) names.push("a:firstCol");
        if (on("lastCol") && column === columns.length - 1) names.push("a:lastCol");
        if (on("lastRow") && row === rows.length - 1) names.push("a:lastRow");
        if (on("firstRow") && row === 0) names.push("a:firstRow");
        return names.map((name) => child(styleNode, name)).filter((node): node is XmlNode => Boolean(node));
      };
      const lineCss = (line: XmlNode | undefined) => {
        const color = fillOf(line);
        return color ? `${Math.max(0.25, pt(line?.attrs.w, 1)).toFixed(2)}pt solid ${cssColor(color)}` : undefined;
      };
      const styleBorder = (parts: XmlNode[], side: string) => {
        let css: string | undefined;
        for (const part of parts) {
          const line = child(child(child(part, "a:tcStyle"), "a:tcBdr"), side);
          if (line) css = lineCss(child(line, "a:ln")) ?? css;
        }
        return css;
      };
      const html: string[] = [];
      rows.forEach((row, rowIndex) => {
        const cells: string[] = [];
        let column = 0;
        for (const cell of elements(row, "a:tc")) {
          const span = Number(cell.attrs.gridSpan ?? 1);
          const rowSpan = Number(cell.attrs.rowSpan ?? 1);
          const at = column;
          column += 1;
          if (cell.attrs.hMerge === "1" || cell.attrs.vMerge === "1") continue;
          const parts = partsFor(rowIndex, at);
          const tcPr = child(cell, "a:tcPr");
          let fill: Color | null | undefined = fillOf(tcPr);
          if (fill === undefined) for (const part of parts) fill = fillOf(child(child(part, "a:tcStyle"), "a:fill")) ?? fill;
          let color: Color | undefined;
          let bold: boolean | undefined;
          for (const part of parts) {
            const text = child(part, "a:tcTxStyle");
            color = colorOf(text) ?? colorOf(child(text, "a:fontRef")) ?? color;
            if (text?.attrs.b) bold = text.attrs.b === "on";
          }
          const levels = applyList(applyList(baseLevels(), defaultTextStyle), child(textStyles, "p:otherStyle")).map((level) => ({ ...level, run: { ...level.run, ...(bold === undefined ? {} : { bold }) } }));
          const border = (side: string, inside: string, edge: boolean) =>
            lineCss(child(tcPr, side === "left" ? "a:lnL" : side === "right" ? "a:lnR" : side === "top" ? "a:lnT" : "a:lnB")) ?? styleBorder(parts, edge ? `a:${side}` : inside) ?? "none";
          const width = columns.slice(at, at + span).reduce((sum, value) => sum + value, 0);
          const margins = ["marL", "marT", "marR", "marB"].map((key, index) => pt(tcPr?.attrs[key], index % 2 ? 3.6 : 7.2));
          const css = [
            `width:${Math.max(1, width - margins[0]! - margins[2]!).toFixed(2)}pt`,
            `height:${Math.max(1, pt(row.attrs.h) - margins[1]! - margins[3]!).toFixed(2)}pt`,
            `padding:${margins[1]!.toFixed(2)}pt ${margins[2]!.toFixed(2)}pt ${margins[3]!.toFixed(2)}pt ${margins[0]!.toFixed(2)}pt`,
            `vertical-align:${tcPr?.attrs.anchor === "ctr" ? "middle" : tcPr?.attrs.anchor === "b" ? "bottom" : "top"}`,
            fill ? `background-color:${cssColor(fill)}` : "",
            `border-left:${border("left", "a:insideV", at === 0)}`,
            `border-right:${border("right", "a:insideV", at + span >= columns.length)}`,
            `border-top:${border("top", "a:insideH", rowIndex === 0)}`,
            `border-bottom:${border("bottom", "a:insideH", rowIndex + rowSpan >= rows.length)}`,
          ].filter(Boolean);
          const body = child(cell, "a:txBody");
          cells.push(`<td${span > 1 ? ` colspan="${span}"` : ""}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ""} style="${css.join(";")}">${body ? textHtml(body, levels, { font: 1, spacing: 0 }, color) : "&#160;"}</td>`);
        }
        html.push(`<tr>${cells.join("")}</tr>`);
      });
      items.push({ kind: "text", matrix: concat(translate(box.x, box.y), frame.outer), width: box.width, height: box.height, html: documentHtml(`<table style="border-collapse:collapse">${html.join("")}</table>`, true), anchor: "top" });
    };

    const addTree = (tree: XmlNode | undefined, frame: Frame, partPath: string, own: "slide" | "layout" | "master") => {
      for (const shape of shapesOf(tree)) {
        const nv = elements(shape).find((item) => /^p:nv/.test(item.name));
        if (child(nv, "p:cNvPr")?.attrs.hidden === "1") continue;
        // Placeholders on layouts and masters are prompts, not content.
        if (own !== "slide" && placeholderOf(shape)) continue;
        if (shape.name === "p:sp" || shape.name === "p:cxnSp") addShape(shape, frame, own);
        else if (shape.name === "p:pic") addPicture(shape, frame, partPath);
        else if (shape.name === "p:graphicFrame") addTable(shape, frame);
        else if (shape.name === "p:grpSp") {
          const xfrm = child(child(shape, "p:grpSpPr"), "a:xfrm");
          const outerBox = xfrmBox(xfrm);
          const chOff = child(xfrm, "a:chOff");
          const chExt = child(xfrm, "a:chExt");
          if (!outerBox) {
            addTree(shape, frame, partPath, own);
            continue;
          }
          const box = frame.map(outerBox);
          const childBox = { x: pt(chOff?.attrs.x), y: pt(chOff?.attrs.y), width: pt(chExt?.attrs.cx) || outerBox.width, height: pt(chExt?.attrs.cy) || outerBox.height };
          const sx = box.width / (childBox.width || 1);
          const sy = box.height / (childBox.height || 1);
          const { degrees, flipH, flipV } = turn(xfrm);
          addTree(
            shape,
            {
              map: (inner) => ({ x: box.x + (inner.x - childBox.x) * sx, y: box.y + (inner.y - childBox.y) * sy, width: inner.width * sx, height: inner.height * sy }),
              outer: degrees || flipH || flipV ? concat(concat(translate(-box.x, -box.y), place(box, degrees, flipH, flipV)), frame.outer) : frame.outer,
            },
            partPath,
            own,
          );
        }
      }
    };

    // Background: the slide's own, else its layout's, else the master's.
    let background: SlideColor | undefined = [1, 1, 1];
    for (const root of [slide, layout, master]) {
      const bg = child(child(root, "p:cSld"), "p:bg");
      if (!bg) continue;
      const bgPr = child(bg, "p:bgPr");
      const reference = child(bg, "p:bgRef");
      const picture = child(bgPr, "a:blipFill");
      const partPath = root === slide ? slidePath : root === layout ? layoutPath : masterPath;
      if (picture) {
        const target = relationships(partPath).get(child(picture, "a:blip")?.attrs["r:embed"] ?? "")?.target;
        const data = target ? files.get(target) : undefined;
        if (data) items.push({ kind: "image", matrix: IDENTITY, width: slideWidth, height: slideHeight, data, alpha: 1 });
        background = undefined;
      } else {
        const fill = bgPr ? fillOf(bgPr) : themeFill(reference);
        background = fill?.rgb ?? [1, 1, 1];
        if (fill?.gradient) {
          items.push({ kind: "shape", matrix: IDENTITY, path: presetPath("rect", slideWidth, slideHeight), fill: slideFill(fill, { width: slideWidth, height: slideHeight }) });
          background = undefined;
        }
      }
      break;
    }

    const whole: Frame = { map: (box) => box, outer: IDENTITY };
    const showMaster = (root: XmlNode | undefined) => root?.attrs.showMasterSp !== "0";
    if (showMaster(slide) && showMaster(layout)) addTree(treeOf(master), whole, masterPath, "master");
    if (showMaster(slide)) addTree(treeOf(layout), whole, layoutPath, "layout");
    addTree(treeOf(slide), whole, slidePath, "slide");
    parts.push({ width: slideWidth, height: slideHeight, background, items });
  }
  if (!parts.length) throw new Error("This presentation has no slides to show.");
  return parts;
}
