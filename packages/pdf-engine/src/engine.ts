import type * as Mupdf from "mupdf";
import {
  baselineOffset,
  fontCategory,
  fontVariant,
  layoutText,
  type FontCategory,
  type FontVariant,
} from "@paperless/editor-core/text-layout";
import { redactMode, type RedactMode } from "@paperless/editor-core";
import type {
  AppendOperation,
  DocumentInfo,
  ExportOverlay,
  ExportRequest,
  FormField,
  PageImage,
  PdfMetadata,
  PdfWorkerApi,
  PositionedTextLine,
  SignatureStatus,
} from "./protocol";
import { PASSWORD_INCORRECT, PASSWORD_REQUIRED } from "./protocol";
import { bundledFontBase64 } from "./fontData";

type MupdfModule = typeof Mupdf;
type Matrix = [number, number, number, number, number, number];
type TextOverlay = Extract<ExportOverlay, { kind: "text" }>;
type TextSpec = Omit<TextOverlay, "id" | "page" | "kind">;

const bundledKeys: Record<FontCategory, Record<FontVariant, string>> = {
  sans: {
    regular: "Sans_Regular",
    bold: "Sans_Bold",
    italic: "Sans_Italic",
    boldItalic: "Sans_BoldItalic",
  },
  serif: {
    regular: "Serif_Regular",
    bold: "Serif_Bold",
    italic: "Serif_Italic",
    boldItalic: "Serif_BoldItalic",
  },
  mono: {
    regular: "Mono_Regular",
    bold: "Mono_Bold",
    italic: "Mono_Italic",
    boldItalic: "Mono_BoldItalic",
  },
};
// MuPDF's built-in base-14 fonts cover Latin Extended, Greek and Cyrillic,
// which the Latin-1 subsets of the bundled fonts do not.
const builtinNames: Record<FontCategory, Record<FontVariant, string>> = {
  sans: {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
    boldItalic: "Helvetica-BoldOblique",
  },
  serif: {
    regular: "Times-Roman",
    bold: "Times-Bold",
    italic: "Times-Italic",
    boldItalic: "Times-BoldItalic",
  },
  mono: {
    regular: "Courier",
    bold: "Courier-Bold",
    italic: "Courier-Oblique",
    boldItalic: "Courier-BoldOblique",
  },
};

const parseColor = (hex: string): [number, number, number] => {
  const short = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex);
  const long = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  const parts = long
    ? [long[1]!, long[2]!, long[3]!]
    : short
      ? [short[1]!.repeat(2), short[2]!.repeat(2), short[3]!.repeat(2)]
      : ["00", "00", "00"];
  return parts.map((part) => Number.parseInt(part, 16) / 255) as [
    number,
    number,
    number,
  ];
};
const num = (value: number) =>
  Number.isFinite(value) ? String(Math.round(value * 10000) / 10000) : "0";
const rgb = (hex: string) => parseColor(hex).map(num).join(" ");
const matrixString = (m: Matrix) => m.map(num).join(" ");
/** Applies `a` first, then `b`. */
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const invert = (m: Matrix): Matrix => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return [1, 0, 0, 1, 0, 0];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
};
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
/** Clockwise rotation in the editor's y-down display space. */
const rotation = (degrees: number): Matrix => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
};
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

const dataUrlBytes = (dataUrl: string) => {
  const encoded = dataUrl.split(",")[1];
  if (!encoded) throw new Error("Embedded file data is invalid.");
  const raw = atob(encoded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const copyBytes = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
};

const extractedColor = (color: Mupdf.Color) => {
  const values =
    color.length === 1
      ? [color[0]!, color[0]!, color[0]!]
      : color.length === 3
        ? color
        : color.length === 4
          ? [
              (1 - color[0]!) * (1 - color[3]!),
              (1 - color[1]!) * (1 - color[3]!),
              (1 - color[2]!) * (1 - color[3]!),
            ]
          : [0, 0, 0];
  return `#${values
    .slice(0, 3)
    .map((value) =>
      Math.round(Math.min(1, Math.max(0, value)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};
const extractedFont = (name: string) => {
  const clean = name.replace(/^[A-Z]{6}\+/, "");
  const lower = clean.toLowerCase();
  const family =
    clean
      .replace(
        /(?:-|,)?(?:bolditalic|boldoblique|semibolditalic|semibold|bold|italic|oblique|regular|roman|medium|book|mt)$/i,
        "",
      )
      .replace(/MT$/i, "") || clean;
  return {
    fontName: clean,
    fontFamily: family,
    bold:
      lower.includes("bold") ||
      lower.includes("black") ||
      lower.includes("heavy"),
    italic: lower.includes("italic") || lower.includes("oblique"),
  };
};

const redactionOptions = (
  mupdf: MupdfModule,
  mode: RedactMode,
): [number, number, number] => {
  const page = mupdf.PDFPage;
  if (mode === "eraseText")
    return [
      page.REDACT_IMAGE_NONE,
      page.REDACT_LINE_ART_NONE,
      page.REDACT_TEXT_REMOVE,
    ];
  if (mode === "eraseImage")
    return [
      page.REDACT_IMAGE_PIXELS,
      page.REDACT_LINE_ART_NONE,
      page.REDACT_TEXT_NONE,
    ];
  return [
    page.REDACT_IMAGE_PIXELS,
    page.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
    page.REDACT_TEXT_REMOVE,
  ];
};

/**
 * The editor stores geometry normalized to the page as MuPDF displays it.
 * A frame captures that display box and the matrix from display points
 * (origin top-left, y down) to PDF user space, so drawing is correct on
 * rotated pages, cropped pages, and pages whose MediaBox is not at the origin.
 */
type PageFrame = {
  bounds: Mupdf.Rect;
  width: number;
  height: number;
  toUser: Matrix;
};

type FontEntry = { key: string; font: Mupdf.Font };

class PageDrawing {
  readonly before: string[] = [];
  readonly after: string[] = [];
  readonly fonts = new Map<string, Mupdf.PDFObject>();
  readonly states = new Map<string, { fill: number; stroke: number; multiply: boolean }>();
  readonly images = new Map<string, Mupdf.PDFObject>();
  constructor(
    readonly pageIndex: number,
    readonly frame: PageFrame,
  ) {}
  /** Graphics state names for opacity and blend mode. */
  state(fill: number, stroke = fill, multiplyBlend = false) {
    const name = `PplGS${Math.round(fill * 100)}_${Math.round(stroke * 100)}${multiplyBlend ? "m" : ""}`;
    this.states.set(name, { fill, stroke, multiply: multiplyBlend });
    return name;
  }
}

export function createEngine(mupdf: MupdfModule): PdfWorkerApi {
  const fontCache = new Map<string, Mupdf.Font>();
  const loadFont = (key: string) => {
    let font = fontCache.get(key);
    if (font) return font;
    if (key in bundledFontBase64) {
      const raw = atob(bundledFontBase64[key as keyof typeof bundledFontBase64]);
      font = new mupdf.Font(
        `Liberation ${key}`,
        Uint8Array.from(raw, (character) => character.charCodeAt(0)),
      );
    } else font = new mupdf.Font(key);
    fontCache.set(key, font);
    return font;
  };
  const fontChain = (category: FontCategory, variant: FontVariant): FontEntry[] =>
    [bundledKeys[category][variant], builtinNames[category][variant]].map(
      (key) => ({ key, font: loadFont(key) }),
    );

  /** Picks the first font in the chain with a glyph for each character. */
  const shape = (text: string, chain: FontEntry[]) =>
    Array.from(text, (character) => {
      for (let index = 0; index < chain.length; index += 1) {
        const gid = chain[index]!.font.encodeCharacter(character);
        if (gid > 0) return { character, fontIndex: index, gid };
      }
      return { character, fontIndex: -1, gid: 0 };
    });
  const spaceAdvance = (chain: FontEntry[]) =>
    chain[0]!.font.advanceGlyph(chain[0]!.font.encodeCharacter(" "));
  const measureWith =
    (chain: FontEntry[]) =>
    (text: string, size: number) =>
      shape(text, chain).reduce(
        (total, glyph) =>
          total +
          size *
            (glyph.fontIndex < 0
              ? spaceAdvance(chain)
              : chain[glyph.fontIndex]!.font.advanceGlyph(glyph.gid)),
        0,
      );

  let doc: Mupdf.PDFDocument | null = null;
  let sourceBytes: Uint8Array | null = null;
  let password: string | undefined;

  const open = (bytes: Uint8Array, secret?: string) => {
    let opened: Mupdf.Document;
    try {
      opened = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch {
      throw new Error("The selected file is not a readable PDF document.");
    }
    if (!opened.isPDF()) {
      opened.destroy();
      throw new Error("The selected file is not a PDF document.");
    }
    if (opened.needsPassword()) {
      if (!secret) {
        opened.destroy();
        throw new Error(`${PASSWORD_REQUIRED}: This PDF is password protected.`);
      }
      if (!opened.authenticatePassword(secret)) {
        opened.destroy();
        throw new Error(`${PASSWORD_INCORRECT}: The password is incorrect.`);
      }
    }
    return opened as Mupdf.PDFDocument;
  };
  const requireDoc = () => {
    if (!doc || !sourceBytes) throw new Error("No PDF is open");
    return doc;
  };

  const frameOf = (page: Mupdf.PDFPage): PageFrame => {
    const bounds = page.getBounds();
    const ctm = page.getTransform() as Matrix;
    return {
      bounds,
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
      toUser: multiply(translate(bounds[0], bounds[1]), invert(ctm)),
    };
  };
  const fitzRect = (
    rect: { x: number; y: number; width: number; height: number },
    frame: PageFrame,
  ): Mupdf.Rect => [
    frame.bounds[0] + rect.x * frame.width,
    frame.bounds[1] + rect.y * frame.height,
    frame.bounds[0] + (rect.x + rect.width) * frame.width,
    frame.bounds[1] + (rect.y + rect.height) * frame.height,
  ];
  const fitzPoint = (
    point: { x: number; y: number },
    frame: PageFrame,
  ): Mupdf.Point => [
    frame.bounds[0] + point.x * frame.width,
    frame.bounds[1] + point.y * frame.height,
  ];

  const metadataOf = (target: Mupdf.Document): PdfMetadata => ({
    title: target.getMetaData(mupdf.Document.META_INFO_TITLE) ?? "",
    author: target.getMetaData(mupdf.Document.META_INFO_AUTHOR) ?? "",
    subject: target.getMetaData(mupdf.Document.META_INFO_SUBJECT) ?? "",
    keywords: target.getMetaData(mupdf.Document.META_INFO_KEYWORDS) ?? "",
  });

  const describe = (target: Mupdf.PDFDocument, bytes: Uint8Array, encrypted: boolean): DocumentInfo => {
    const pageCount = target.countPages();
    const pages = [];
    const formFields: FormField[] = [];
    const signatures: SignatureStatus[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      const page = target.loadPage(index);
      const [x0, y0, x1, y1] = page.getBounds();
      pages.push({ width: x1 - x0, height: y1 - y0 });
      for (const widget of page.getWidgets()) {
        const isSignature = widget
          .getFieldType()
          .toLowerCase()
          .includes("signature");
        formFields.push({
          page: index,
          name: widget.getName(),
          label: widget.getLabel(),
          type: isSignature
            ? "signature"
            : widget.isText()
              ? "text"
              : widget.isChoice()
                ? "choice"
                : widget.isRadioButton()
                  ? "radio"
                  : "checkbox",
          value: widget.getValue(),
          options: widget.isChoice() ? widget.getOptions() : [],
          readOnly: widget.isReadOnly(),
        });
        if (isSignature) {
          const value = widget.getObject().get("V").resolve();
          const byteRange = value.get("ByteRange").resolve();
          const parts: number[] = [];
          if (byteRange.isArray())
            for (let item = 0; item < byteRange.length; item += 1)
              parts.push(byteRange.get(item).asNumber());
          const coveredEnd =
            parts.length === 4 ? (parts[2] ?? 0) + (parts[3] ?? 0) : 0;
          if (parts.length === 4)
            signatures.push({
              name: value.get("Name").isString()
                ? value.get("Name").asString()
                : widget.getName(),
              reason: value.get("Reason").isString()
                ? value.get("Reason").asString()
                : "",
              validCoverage: parts[0] === 0 && coveredEnd <= bytes.length,
              modifiedAfterSigning: coveredEnd > 0 && coveredEnd < bytes.length,
            });
        }
        widget.destroy();
      }
      page.destroy();
    }
    return {
      pageCount,
      pages,
      metadata: metadataOf(target),
      formFields,
      encrypted,
      signatures,
    };
  };

  const loadInto = (bytes: Uint8Array, secret?: string) => {
    const opened = open(bytes, secret);
    doc?.destroy();
    doc = opened;
    sourceBytes = bytes;
    password = secret;
    return describe(opened, bytes, Boolean(secret));
  };

  // --- content drawing --------------------------------------------------

  const drawText = (
    drawing: PageDrawing,
    target: Mupdf.PDFDocument,
    spec: TextSpec & { x: number; y: number; width: number; height: number },
    missing: Set<string>,
    layer: "before" | "after" = "after",
  ) => {
    const { frame } = drawing;
    const category = fontCategory(spec.fontFamily);
    const chain = fontChain(category, fontVariant(spec.bold, spec.italic));
    const boxX = spec.x * frame.width;
    const boxY = spec.y * frame.height;
    const boxWidth = spec.width * frame.width;
    const layout = layoutText(spec.text, {
      size: spec.size,
      maxWidth: boxWidth,
      lineHeight: spec.lineHeight,
      letterSpacing: spec.letterSpacing,
      fitMode: spec.fitMode,
      measure: measureWith(chain),
    });
    const size = layout.size;
    const resourceNames = chain.map((entry) => {
      const name = `Ppl${entry.key.replace(/[^A-Za-z0-9]/g, "")}`;
      if (!drawing.fonts.has(name))
        drawing.fonts.set(name, fontReference(target, entry));
      return name;
    });
    const rotate = rotation(spec.rotation ?? 0);
    const place = (x: number, y: number) => {
      const [dx, dy] = apply(rotate, x, y);
      return [boxX + dx, boxY + dy] as const;
    };
    const cos = rotate[0];
    const sin = rotate[1];
    const opacity = spec.opacity ?? 1;
    const commands: string[] = ["q"];
    if (opacity < 1) commands.push(`/${drawing.state(opacity)} gs`);
    commands.push(`${rgb(spec.color)} rg`, `${rgb(spec.color)} RG`);
    const space = spaceAdvance(chain);
    layout.lines.forEach((line, index) => {
      const lineWidth = layout.widths[index] ?? 0;
      const glyphs = shape(line, chain);
      glyphs
        .filter((glyph) => glyph.fontIndex < 0 && glyph.character.trim())
        .forEach((glyph) => missing.add(glyph.character));
      const spaces = glyphs.filter((glyph) => glyph.character === " ").length;
      const justify =
        spec.alignment === "justify" &&
        index < layout.lines.length - 1 &&
        spaces > 0
          ? Math.max(0, (boxWidth - lineWidth) / spaces)
          : 0;
      let x =
        spec.alignment === "center"
          ? Math.max(0, (boxWidth - lineWidth) / 2)
          : spec.alignment === "right"
            ? Math.max(0, boxWidth - lineWidth)
            : 0;
      const baseline =
        baselineOffset(category, size, spec.lineHeight) +
        index * size * spec.lineHeight;
      const startX = x;
      commands.push("BT", spec.invisible ? "3 Tr" : "0 Tr");
      commands.push(`${num(spec.letterSpacing)} Tc`);
      let cursor = 0;
      while (cursor < glyphs.length) {
        const fontIndex = glyphs[cursor]!.fontIndex;
        let end = cursor;
        while (end < glyphs.length && glyphs[end]!.fontIndex === fontIndex)
          end += 1;
        const run = glyphs.slice(cursor, end);
        cursor = end;
        if (fontIndex < 0) {
          x += run.length * (space * size + spec.letterSpacing);
          continue;
        }
        const font = chain[fontIndex]!.font;
        const parts: string[] = [];
        let hex = "";
        let width = 0;
        for (const glyph of run) {
          hex += glyph.gid.toString(16).padStart(4, "0");
          width += font.advanceGlyph(glyph.gid) * size + spec.letterSpacing;
          if (glyph.character === " " && justify) {
            parts.push(`<${hex}>`, num((-justify / size) * 1000));
            hex = "";
            width += justify;
          }
        }
        if (hex) parts.push(`<${hex}>`);
        const [px, py] = place(x, baseline);
        commands.push(
          `/${resourceNames[fontIndex]} ${num(size)} Tf`,
          `${num(cos)} ${num(sin)} ${num(sin)} ${num(-cos)} ${num(px)} ${num(py)} Tm`,
          `[${parts.join(" ")}] TJ`,
        );
        x += width;
      }
      commands.push("ET");
      if (spec.underline && !spec.invisible && x > startX) {
        const [ux0, uy0] = place(startX, baseline + size * 0.12);
        const [ux1, uy1] = place(x, baseline + size * 0.12);
        commands.push(
          `${num(Math.max(0.6, size / 16))} w`,
          `${num(ux0)} ${num(uy0)} m ${num(ux1)} ${num(uy1)} l S`,
        );
      }
    });
    commands.push("Q");
    drawing[layer].push(commands.join("\n"));
  };

  const fontRefs = new WeakMap<Mupdf.PDFDocument, Map<string, Mupdf.PDFObject>>();
  const fontReference = (target: Mupdf.PDFDocument, entry: FontEntry) => {
    let refs = fontRefs.get(target);
    if (!refs) {
      refs = new Map();
      fontRefs.set(target, refs);
    }
    let ref = refs.get(entry.key);
    if (!ref) {
      ref = target.addFont(entry.font);
      refs.set(entry.key, ref);
    }
    return ref;
  };

  const drawImage = (
    drawing: PageDrawing,
    target: Mupdf.PDFDocument,
    overlay: { x: number; y: number; width: number; height: number; dataUrl: string; opacity?: number; rotation?: number },
  ) => {
    const { frame } = drawing;
    const image = new mupdf.Image(dataUrlBytes(overlay.dataUrl));
    const name = `PplIm${drawing.images.size + 1}`;
    drawing.images.set(name, target.addImage(image));
    image.destroy();
    const x = overlay.x * frame.width;
    const y = overlay.y * frame.height;
    const w = overlay.width * frame.width;
    const h = overlay.height * frame.height;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const placement = multiply(
      multiply([w, 0, 0, -h, x, y + h], translate(-cx, -cy)),
      multiply(rotation(overlay.rotation ?? 0), translate(cx, cy)),
    );
    const opacity = overlay.opacity ?? 1;
    drawing.after.push(
      [
        "q",
        opacity < 1 ? `/${drawing.state(opacity)} gs` : "",
        `${matrixString(placement)} cm`,
        `/${name} Do`,
        "Q",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  };

  const box = (
    frame: PageFrame,
    rect: { x: number; y: number; width: number; height: number },
  ) =>
    [
      rect.x * frame.width,
      rect.y * frame.height,
      rect.width * frame.width,
      rect.height * frame.height,
    ] as const;

  const label = (
    text: string,
    rect: { x: number; y: number; width: number; height: number },
    options: Partial<TextSpec> = {},
  ) => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    text,
    size: 11,
    color: "#111111",
    fontFamily: "Helvetica",
    fontName: null,
    bold: false,
    italic: false,
    underline: false,
    alignment: "left" as const,
    lineHeight: 1.15,
    letterSpacing: 0,
    fitMode: "shrink" as const,
    ...options,
  });

  const drawFlattenedReview = (
    drawing: PageDrawing,
    target: Mupdf.PDFDocument,
    overlay: Extract<ExportOverlay, { kind: "markup" | "note" | "stamp" | "measurement" }>,
    missing: Set<string>,
  ) => {
    const { frame } = drawing;
    const color = rgb(overlay.color);
    if (overlay.kind === "markup") {
      const [x, y, w, h] = box(frame, overlay);
      if (overlay.markup === "highlight") {
        drawing.after.push(
          `q /${drawing.state(overlay.opacity, overlay.opacity, true)} gs ${color} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f Q`,
        );
        return;
      }
      const stroke = num(Math.max(0.8, h / 14));
      if (overlay.markup === "squiggly") {
        const step = Math.max(2, h / 5);
        const base = y + h - step;
        const points = [`${num(x)} ${num(base)} m`];
        for (let px = x, up = true; px < x + w; up = !up) {
          px = Math.min(x + w, px + step);
          points.push(`${num(px)} ${num(base + (up ? step : 0))} l`);
        }
        drawing.after.push(`q ${color} RG ${stroke} w ${points.join(" ")} S Q`);
        return;
      }
      const lineY = overlay.markup === "strikeout" ? y + h / 2 : y + h * 0.94;
      drawing.after.push(
        `q ${color} RG ${stroke} w ${num(x)} ${num(lineY)} m ${num(x + w)} ${num(lineY)} l S Q`,
      );
      return;
    }
    if (overlay.kind === "measurement") {
      const [first, ...rest] = overlay.points;
      if (!first) return;
      const path = [
        `${num(first.x * frame.width)} ${num(first.y * frame.height)} m`,
        ...rest.map(
          (point) =>
            `${num(point.x * frame.width)} ${num(point.y * frame.height)} l`,
        ),
      ];
      if (overlay.measurement !== "distance") path.push("h");
      drawing.after.push(`q ${color} RG 1.5 w ${path.join(" ")} S Q`);
      drawText(
        drawing,
        target,
        label(
          overlay.label,
          { x: first.x, y: Math.max(0, first.y - 0.025), width: 0.25, height: 0.025 },
          { size: 10, bold: true, color: overlay.color },
        ),
        missing,
      );
      return;
    }
    const [x, y, w, h] = box(frame, overlay);
    drawing.after.push(
      `q ${color} RG ${overlay.kind === "note" ? "1 0.957 0.659" : "1 1 1"} rg 1.5 w ${num(x)} ${num(y)} ${num(w)} ${num(h)} re B Q`,
    );
    drawText(
      drawing,
      target,
      label(
        overlay.kind === "note" ? overlay.text : overlay.label,
        {
          x: overlay.x + 0.006,
          y: overlay.y + 0.004,
          width: Math.max(0.01, overlay.width - 0.012),
          height: Math.max(0.01, overlay.height - 0.008),
        },
        {
          size: overlay.kind === "note" ? 10 : 14,
          bold: overlay.kind === "stamp",
          color: overlay.color,
          alignment: overlay.kind === "stamp" ? "center" : "left",
          fitMode: overlay.kind === "note" ? "auto" : "shrink",
        },
      ),
      missing,
    );
  };

  const reviewMetadata = (
    annotation: Mupdf.PDFAnnotation,
    overlay: { id: string; author: string; createdAt: string; comment: string; resolved: boolean },
  ) => {
    annotation.setName(overlay.id);
    annotation.setAuthor(overlay.author || "Paperless");
    annotation.setContents(overlay.comment);
    annotation.setSubject(overlay.resolved ? "Resolved review" : "Review");
    const created = new Date(overlay.createdAt);
    if (!Number.isNaN(created.valueOf())) {
      annotation.setCreationDate(created);
      annotation.setModificationDate(created);
    }
    annotation.getObject().put("PaperlessResolved", overlay.resolved);
    annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
  };

  const acroFormFields = (target: Mupdf.PDFDocument) => {
    const root = target.getTrailer().get("Root").resolve();
    let acroForm = root.get("AcroForm");
    if (acroForm.isNull()) {
      acroForm = target.newDictionary();
      root.put("AcroForm", acroForm);
    }
    acroForm = acroForm.resolve();
    let fields = acroForm.get("Fields");
    if (fields.isNull()) {
      fields = target.newArray();
      acroForm.put("Fields", fields);
    }
    acroForm.put("NeedAppearances", true);
    return fields.resolve();
  };

  const validateFormValue = (
    overlay: Extract<ExportOverlay, { kind: "formField" }>,
    value: string,
  ) => {
    const name = overlay.label || overlay.name;
    if (overlay.required && !value.trim())
      throw new Error(`Required field "${name}" is empty.`);
    if (!value || overlay.validation === "none") return;
    if (
      overlay.validation === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
      throw new Error(`Field "${name}" requires an email address.`);
    if (overlay.validation === "number" && !Number.isFinite(Number(value)))
      throw new Error(`Field "${name}" requires a number.`);
    if (overlay.validation === "regex") {
      let pattern: RegExp;
      try {
        pattern = new RegExp(overlay.validationPattern);
      } catch {
        throw new Error(`Field "${name}" has an invalid validation pattern.`);
      }
      if (!pattern.test(value))
        throw new Error(`Field "${name}" does not match its validation pattern.`);
    }
  };

  /** Writes queued drawing into the page, isolating the original content. */
  const commitDrawing = (target: Mupdf.PDFDocument, drawing: PageDrawing) => {
    if (!drawing.before.length && !drawing.after.length) return;
    const page = target.loadPage(drawing.pageIndex);
    const pageObject = page.getObject();
    let resources = pageObject.get("Resources");
    if (resources.isNull()) {
      const inherited = pageObject.getInheritable("Resources");
      resources = target.newDictionary();
      if (!inherited.isNull())
        inherited.resolve().forEach((value, key) => resources.put(key, value));
      pageObject.put("Resources", resources);
    }
    resources = resources.resolve();
    const dictionary = (key: string) => {
      let value = resources.get(key);
      if (value.isNull()) {
        value = target.newDictionary();
        resources.put(key, value);
      }
      return value.resolve();
    };
    if (drawing.fonts.size) {
      const fonts = dictionary("Font");
      drawing.fonts.forEach((ref, name) => fonts.put(name, ref));
    }
    if (drawing.images.size) {
      const xobjects = dictionary("XObject");
      drawing.images.forEach((ref, name) => xobjects.put(name, ref));
    }
    if (drawing.states.size) {
      const states = dictionary("ExtGState");
      drawing.states.forEach((state, name) => {
        const gs = target.newDictionary();
        gs.put("Type", target.newName("ExtGState"));
        gs.put("ca", state.fill);
        gs.put("CA", state.stroke);
        if (state.multiply) gs.put("BM", target.newName("Multiply"));
        states.put(name, target.addObject(gs));
      });
    }
    const stream = (body: string) =>
      target.addStream(new TextEncoder().encode(body), target.newDictionary());
    const wrap = (parts: string[]) =>
      stream(
        [`q ${matrixString(drawing.frame.toUser)} cm`, ...parts, "Q"].join("\n"),
      );
    const original: Mupdf.PDFObject[] = [];
    const contents = pageObject.get("Contents");
    if (!contents.isNull()) {
      const resolved = contents.resolve();
      if (resolved.isArray())
        for (let index = 0; index < resolved.length; index += 1)
          original.push(resolved.get(index));
      else original.push(contents);
    }
    const array = target.newArray();
    if (drawing.before.length) array.push(wrap(drawing.before));
    // Unbalanced q/cm operators in source content must not leak into ours.
    array.push(stream("q"));
    original.forEach((item) => array.push(item));
    array.push(stream("Q"));
    if (drawing.after.length) array.push(wrap(drawing.after));
    pageObject.put("Contents", array);
    page.destroy();
  };

  const exportDocument = async (request: ExportRequest) => {
    requireDoc();
    const target = open(sourceBytes!, password);
    const pageCount = target.countPages();
    const missing = new Set<string>();
    let annotationCount = 0;
    let redactionCount = 0;
    const redactionPages = new Set<number>();
    try {
      target.setMetaData(mupdf.Document.META_INFO_TITLE, request.metadata.title);
      target.setMetaData(mupdf.Document.META_INFO_AUTHOR, request.metadata.author);
      target.setMetaData(mupdf.Document.META_INFO_SUBJECT, request.metadata.subject);
      target.setMetaData(mupdf.Document.META_INFO_KEYWORDS, request.metadata.keywords);
      if (request.sanitizeMetadata) {
        for (const key of [
          mupdf.Document.META_INFO_TITLE,
          mupdf.Document.META_INFO_AUTHOR,
          mupdf.Document.META_INFO_SUBJECT,
          mupdf.Document.META_INFO_KEYWORDS,
          "info:Creator",
          "info:Producer",
        ])
          target.setMetaData(key, "");
        target.getTrailer().get("Root").resolve().delete("Metadata");
      }

      // Capture every page frame before anything changes rotation or crop.
      const frames: PageFrame[] = [];
      for (let index = 0; index < pageCount; index += 1) {
        const page = target.loadPage(index);
        frames.push(frameOf(page));
        page.destroy();
      }
      const valid = (index: number) =>
        Number.isInteger(index) && index >= 0 && index < pageCount;

      for (let index = 0; index < pageCount; index += 1) {
        const page = target.loadPage(index);
        for (const widget of page.getWidgets()) {
          const value = request.formValues[widget.getName()];
          if (value !== undefined && !widget.isReadOnly() && value !== widget.getValue()) {
            if (widget.isText()) widget.setTextValue(value);
            else if (widget.isChoice()) widget.setChoiceValue(value);
            else if (widget.isCheckbox() || widget.isRadioButton()) widget.toggle();
            widget.update();
          }
          widget.destroy();
        }
        page.update();
        page.destroy();
      }

      // Redactions apply to the original content only, before anything is
      // added, so new edits are never swallowed by an erase box.
      const redactions = new Map<number, Map<RedactMode, Extract<ExportOverlay, { kind: "redact" }>[]>>();
      for (const overlay of request.overlays) {
        if (overlay.kind !== "redact" || !valid(overlay.page)) continue;
        const mode = redactMode(overlay);
        const byMode = redactions.get(overlay.page) ?? new Map();
        byMode.set(mode, [...(byMode.get(mode) ?? []), overlay]);
        redactions.set(overlay.page, byMode);
      }
      for (const [pageIndex, byMode] of redactions) {
        for (const [mode, items] of byMode) {
          const page = target.loadPage(pageIndex);
          for (const item of items) {
            const annotation = page.createAnnotation("Redact");
            annotation.setRect(fitzRect(item, frames[pageIndex]!));
            annotation.update();
            annotation.destroy();
          }
          const [image, lineArt, text] = redactionOptions(mupdf, mode);
          page.applyRedactions(false, image, lineArt, text);
          page.update();
          page.destroy();
          if (mode === "redact") {
            redactionCount += items.length;
            redactionPages.add(pageIndex);
          }
        }
      }

      const drawings = new Map<number, PageDrawing>();
      const drawingFor = (pageIndex: number) => {
        let drawing = drawings.get(pageIndex);
        if (!drawing) {
          drawing = new PageDrawing(pageIndex, frames[pageIndex]!);
          drawings.set(pageIndex, drawing);
        }
        return drawing;
      };

      const formValues = new Map(Object.entries(request.formValues));
      for (const overlay of request.overlays)
        if (overlay.kind === "formField" && !formValues.has(overlay.name))
          formValues.set(overlay.name, overlay.value);
      for (const overlay of request.overlays)
        if (overlay.kind === "formField" && overlay.calculation.startsWith("sum:")) {
          const total = overlay.calculation
            .slice(4)
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
            .reduce((sum, name) => sum + (Number(formValues.get(name)) || 0), 0);
          formValues.set(overlay.name, String(total));
        }

      for (const overlay of request.overlays) {
        if (!valid(overlay.page) || overlay.kind === "redact") {
          if (overlay.kind === "redact" && valid(overlay.page) && redactMode(overlay) === "redact" && overlay.color.toLowerCase() !== "#ffffff") {
            const drawing = drawingFor(overlay.page);
            const [x, y, w, h] = box(drawing.frame, overlay);
            drawing.after.push(`q ${rgb(overlay.color)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f Q`);
          }
          continue;
        }
        const frame = frames[overlay.page]!;
        if (overlay.kind === "background") {
          const drawing = drawingFor(overlay.page);
          drawing.before.push(
            `q ${overlay.opacity < 1 ? `/${drawing.state(overlay.opacity)} gs ` : ""}${rgb(overlay.color)} rg 0 0 ${num(frame.width)} ${num(frame.height)} re f Q`,
          );
          annotationCount += 1;
          continue;
        }
        if (overlay.kind === "text") {
          drawText(drawingFor(overlay.page), target, overlay, missing);
          annotationCount += 1;
          continue;
        }
        if (overlay.kind === "image") {
          drawImage(drawingFor(overlay.page), target, overlay);
          annotationCount += 1;
          continue;
        }
        if (
          (overlay.kind === "markup" ||
            overlay.kind === "note" ||
            overlay.kind === "stamp" ||
            overlay.kind === "measurement") &&
          overlay.flatten
        ) {
          drawFlattenedReview(drawingFor(overlay.page), target, overlay, missing);
          annotationCount += 1;
          continue;
        }
        if (overlay.kind === "visualSignature") {
          const drawing = drawingFor(overlay.page);
          if (overlay.dataUrl)
            drawImage(drawing, target, { ...overlay, dataUrl: overlay.dataUrl });
          else {
            const [x, y, w, h] = box(frame, overlay);
            drawing.after.push(`q 0.15 0.15 0.15 RG 0.8 w ${num(x)} ${num(y + h)} m ${num(x + w)} ${num(y + h)} l S Q`);
            drawText(
              drawing,
              target,
              label(overlay.text, overlay, {
                size: Math.max(10, Math.min(28, overlay.height * frame.height * 0.6)),
                color: overlay.color,
                fontFamily: "Serif",
                italic: true,
                alignment: "center",
              }),
              missing,
            );
          }
          annotationCount += 1;
          continue;
        }
        if (overlay.kind === "formField" && (overlay.flatten || request.flattenForms)) {
          const value = formValues.get(overlay.name) ?? overlay.value;
          validateFormValue(overlay, value);
          const drawing = drawingFor(overlay.page);
          const [x, y, w, h] = box(frame, overlay);
          drawing.after.push(`q 0.25 0.25 0.25 RG 0.8 w ${num(x)} ${num(y)} ${num(w)} ${num(h)} re S Q`);
          const display =
            overlay.fieldType === "checkbox" || overlay.fieldType === "radio"
              ? value && value !== "Off"
                ? "X"
                : ""
              : value;
          if (display)
            drawText(
              drawing,
              target,
              label(
                display,
                {
                  x: overlay.x + 0.004,
                  y: overlay.y,
                  width: Math.max(0.01, overlay.width - 0.008),
                  height: overlay.height,
                },
                {
                  size: Math.max(6, Math.min(12, h * 0.65)),
                  alignment: overlay.fieldType === "checkbox" || overlay.fieldType === "radio" ? "center" : "left",
                  lineHeight: Math.max(1, (h / Math.max(6, Math.min(12, h * 0.65))) * 0.98),
                },
              ),
              missing,
            );
          annotationCount += 1;
          continue;
        }

        const page = target.loadPage(overlay.page);
        if (overlay.kind === "ink" || overlay.kind === "signature") {
          const annotation = page.createAnnotation("Ink");
          annotation.setInkList([overlay.points.map((point) => fitzPoint(point, frame))]);
          annotation.setColor(parseColor(overlay.color));
          annotation.setBorderWidth(overlay.width);
          annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "line") {
          const annotation = page.createAnnotation("Line");
          annotation.setLine(fitzPoint(overlay.points[0]!, frame), fitzPoint(overlay.points[1]!, frame));
          annotation.setLineEndingStyles(
            overlay.arrow === "both" ? "OpenArrow" : "None",
            overlay.arrow === "none" ? "None" : "OpenArrow",
          );
          annotation.setColor(parseColor(overlay.color));
          annotation.setBorderWidth(overlay.width);
          annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "rect" || overlay.kind === "shape") {
          const shapeKind = overlay.kind === "rect" ? "rectangle" : overlay.shape;
          const annotation = page.createAnnotation(
            shapeKind === "circle" ? "Circle" : shapeKind === "triangle" ? "Polygon" : "Square",
          );
          const rect = fitzRect(overlay, frame);
          if (shapeKind === "triangle")
            annotation.setVertices([
              [(rect[0] + rect[2]) / 2, rect[1]],
              [rect[2], rect[3]],
              [rect[0], rect[3]],
            ]);
          else annotation.setRect(rect);
          annotation.setColor(parseColor(overlay.color));
          if (overlay.kind === "shape" && overlay.fillColor)
            annotation.setInteriorColor(parseColor(overlay.fillColor));
          annotation.setBorderWidth(overlay.kind === "shape" ? overlay.strokeWidth : 2);
          annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "formField") {
          const value = formValues.get(overlay.name) ?? overlay.value;
          validateFormValue(overlay, value);
          const annotation = page.createAnnotation("Widget");
          annotation.setRect(fitzRect(overlay, frame));
          annotation.setBorderWidth(1);
          annotation.setColor(parseColor("#777777"));
          annotation.setDefaultAppearance("Helv", 11, parseColor("#111111"));
          annotation.setFlags(mupdf.PDFAnnotation.IS_PRINT);
          const object = annotation.getObject();
          object.put(
            "FT",
            target.newName(
              overlay.fieldType === "text"
                ? "Tx"
                : overlay.fieldType === "choice"
                  ? "Ch"
                  : overlay.fieldType === "signature"
                    ? "Sig"
                    : "Btn",
            ),
          );
          object.put("T", target.newString(overlay.name));
          object.put("TU", target.newString(overlay.label));
          let flags = overlay.readOnly ? mupdf.PDFWidget.FIELD_IS_READ_ONLY : 0;
          if (overlay.required) flags |= mupdf.PDFWidget.FIELD_IS_REQUIRED;
          if (overlay.multiline && overlay.fieldType === "text")
            flags |= mupdf.PDFWidget.TX_FIELD_IS_MULTILINE;
          if (overlay.fieldType === "radio") flags |= mupdf.PDFWidget.BTN_FIELD_IS_RADIO;
          object.put("Ff", flags);
          if (overlay.maxLength > 0 && overlay.fieldType === "text")
            object.put("MaxLen", overlay.maxLength);
          if (overlay.fieldType === "choice") {
            const options = target.newArray();
            overlay.options.forEach((option) => options.push(target.newString(option)));
            object.put("Opt", options);
          }
          if (overlay.fieldType !== "signature")
            object.put(
              "V",
              overlay.fieldType === "checkbox" || overlay.fieldType === "radio"
                ? target.newName(value && value !== "Off" ? "Yes" : "Off")
                : target.newString(value),
            );
          object.put(
            "PaperlessValidation",
            target.newString(
              JSON.stringify({
                type: overlay.validation,
                pattern: overlay.validationPattern,
                calculation: overlay.calculation,
                tabOrder: overlay.tabOrder,
              }),
            ),
          );
          acroFormFields(target).push(object);
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "markup") {
          const annotation = page.createAnnotation(
            overlay.markup === "highlight"
              ? "Highlight"
              : overlay.markup === "underline"
                ? "Underline"
                : overlay.markup === "strikeout"
                  ? "StrikeOut"
                  : "Squiggly",
          );
          const [x0, y0, x1, y1] = fitzRect(overlay, frame);
          annotation.setQuadPoints([[x0, y0, x1, y0, x0, y1, x1, y1]]);
          annotation.setColor(parseColor(overlay.color));
          annotation.setOpacity(overlay.opacity);
          reviewMetadata(annotation, overlay);
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "note") {
          const annotation = page.createAnnotation(overlay.noteType === "sticky" ? "Text" : "FreeText");
          annotation.setRect(fitzRect(overlay, frame));
          reviewMetadata(annotation, { ...overlay, comment: overlay.comment || overlay.text });
          if (overlay.noteType === "sticky") annotation.setIcon("Comment");
          else {
            annotation.setDefaultAppearance("Helv", 11, parseColor(overlay.color));
            annotation.setContents(overlay.text);
          }
          annotation.setColor(parseColor(overlay.color));
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "stamp") {
          const annotation = page.createAnnotation("Stamp");
          annotation.setRect(fitzRect(overlay, frame));
          annotation.setIcon(overlay.label.replaceAll(" ", ""));
          annotation.setColor(parseColor(overlay.color));
          reviewMetadata(annotation, overlay);
          annotation.setContents(overlay.comment || overlay.label);
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "attachment") {
          const annotation = page.createAnnotation("FileAttachment");
          annotation.setRect(fitzRect(overlay, frame));
          annotation.setIcon("Paperclip");
          const created = new Date(overlay.createdAt);
          const when = Number.isNaN(created.valueOf()) ? new Date() : created;
          annotation.setFileSpec(
            target.addEmbeddedFile(
              overlay.name,
              overlay.mimeType || "application/octet-stream",
              dataUrlBytes(overlay.dataUrl),
              when,
              when,
              true,
            ),
          );
          annotation.setColor(parseColor("#d64b35"));
          reviewMetadata(annotation, overlay);
          annotation.update();
          annotation.destroy();
        } else if (overlay.kind === "measurement") {
          const points = overlay.points.map((point) => fitzPoint(point, frame));
          const annotation = page.createAnnotation(overlay.measurement === "distance" ? "Line" : "Polygon");
          if (overlay.measurement === "distance") {
            annotation.setLine(points[0]!, points.at(-1)!);
            annotation.setLineEndingStyles("OpenArrow", "OpenArrow");
            annotation.setLineCaption(true);
          } else annotation.setVertices(points);
          annotation.setColor(parseColor(overlay.color));
          annotation.setBorderWidth(1.5);
          reviewMetadata(annotation, { ...overlay, comment: overlay.comment || overlay.label });
          annotation.setContents(overlay.label);
          annotation.update();
          annotation.destroy();
        }
        page.update();
        page.destroy();
        annotationCount += 1;
      }

      for (const drawing of drawings.values()) commitDrawing(target, drawing);

      // Rotation and crop last: they change the display transform that all
      // geometry above was mapped through.
      for (let index = 0; index < pageCount; index += 1) {
        const extra = request.rotations[index] ?? 0;
        const crop = request.crops[index];
        if (!extra && !crop) continue;
        const page = target.loadPage(index);
        const pageObject = page.getObject();
        if (crop) {
          const frame = frames[index]!;
          const corners = [
            apply(frame.toUser, crop.x * frame.width, crop.y * frame.height),
            apply(frame.toUser, (crop.x + crop.width) * frame.width, (crop.y + crop.height) * frame.height),
          ];
          const box = target.newArray();
          [
            Math.min(corners[0]![0], corners[1]![0]),
            Math.min(corners[0]![1], corners[1]![1]),
            Math.max(corners[0]![0], corners[1]![0]),
            Math.max(corners[0]![1], corners[1]![1]),
          ].forEach((value) => box.push(value));
          pageObject.put("CropBox", box);
        }
        if (extra) {
          const inherited = pageObject.getInheritable("Rotate");
          const original = inherited.isNumber() ? inherited.asNumber() : 0;
          pageObject.put("Rotate", (((original + extra) % 360) + 360) % 360);
        }
        page.destroy();
      }

      if (request.flattenForms) target.bake(false, true);
      const order = request.pageOrder;
      if (!order.length || new Set(order).size !== order.length || order.some((item) => !valid(item)))
        throw new Error("Export validation failed: page order is invalid.");
      target.rearrangePages(order);

      let options =
        request.compression === "original"
          ? "garbage=1"
          : request.compression === "small"
            ? "garbage=4,compress=yes,compress-images=yes,compress-fonts=yes,clean=yes"
            : "garbage=3,compress=yes";
      const encryption = request.encryption;
      // Without new passwords the export is written unencrypted, even when
      // the source was protected and opened with its password.
      if (!encryption?.userPassword && !encryption?.ownerPassword)
        options += ",encrypt=none";
      else {
        const clean = (value: string) => value.replaceAll(",", "").replaceAll("=", "");
        let permissions = 0xfffff0c0 | 3;
        if (encryption.allowPrint) permissions |= 4 | 2048;
        if (encryption.allowEdit) permissions |= 8 | 256 | 1024;
        if (encryption.allowCopy) permissions |= 16 | 512;
        if (encryption.allowAnnotate) permissions |= 32;
        options += `,encrypt=aes-256,user-password=${clean(encryption.userPassword)},owner-password=${clean(encryption.ownerPassword || encryption.userPassword)},permissions=${permissions | 0}`;
      }
      const bytes = copyBytes(target.saveToBuffer(options).asUint8Array());

      const verified = mupdf.Document.openDocument(bytes, "application/pdf");
      try {
        if (verified.needsPassword() && encryption)
          verified.authenticatePassword(encryption.ownerPassword || encryption.userPassword);
        if (!verified.isPDF() || verified.countPages() !== order.length)
          throw new Error("Export validation failed: page structure changed unexpectedly.");
        for (let index = 0; index < verified.countPages(); index += 1) {
          const page = verified.loadPage(index);
          if (index === 0)
            page.toPixmap([0.2, 0, 0, 0.2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true).destroy();
          page.destroy();
        }
      } finally {
        verified.destroy();
      }
      return {
        bytes,
        pageCount: order.length,
        annotationCount,
        redactionCount,
        redactionPages: [...redactionPages].sort((a, b) => a - b),
        missingGlyphs: [...missing],
      };
    } finally {
      target.destroy();
    }
  };

  return {
    async loadDocument(bytes, secret) {
      const copy = copyBytes(new Uint8Array(bytes));
      return loadInto(copy, secret || undefined);
    },

    async renderPage(index, scale) {
      const page = requireDoc().loadPage(index);
      const pixmap = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
      const png = copyBytes(pixmap.asPNG());
      pixmap.destroy();
      page.destroy();
      return png;
    },

    async extractText(index) {
      const page = requireDoc().loadPage(index);
      const structured = page.toStructuredText("");
      const text = structured.asText();
      structured.destroy();
      page.destroy();
      return text;
    },

    async extractTextLines(index) {
      const page = requireDoc().loadPage(index);
      const bounds = page.getBounds();
      const pageWidth = bounds[2] - bounds[0];
      const pageHeight = bounds[3] - bounds[1];
      const structured = page.toStructuredText("preserve-whitespace");
      const lines: PositionedTextLine[] = [];
      let lineIndex = -1;
      let runIndex = 0;
      type Run = {
        key: string;
        text: string;
        bbox: Mupdf.Rect;
        baseline: number;
        size: number;
        color: string;
        fontName: string;
        pendingSpace: { text: string; bbox: Mupdf.Rect } | null;
      };
      let run: Run | null = null;
      const union = (a: Mupdf.Rect, b: Mupdf.Rect): Mupdf.Rect => [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
      ];
      const flush = () => {
        const current = run as Run | null;
        run = null;
        if (!current || !current.text.trim()) return;
        const [x0, y0, x1, y1] = current.bbox;
        lines.push({
          id: `${index}-${lineIndex}-${runIndex++}`,
          text: current.text,
          x: (x0 - bounds[0]) / pageWidth,
          y: (y0 - bounds[1]) / pageHeight,
          width: Math.max(0.005, (x1 - x0) / pageWidth),
          height: Math.max(0.005, (y1 - y0) / pageHeight),
          baseline: (current.baseline - bounds[1]) / pageHeight,
          size: current.size,
          color: current.color,
          alignment: "left",
          lineHeight: 1.2,
          letterSpacing: 0,
          fitMode: "auto",
          ...extractedFont(current.fontName),
        });
      };
      structured.walk({
        beginLine: () => {
          flush();
          lineIndex += 1;
          runIndex = 0;
        },
        onChar: (char, origin, font, size, quad, color) => {
          const current = run as Run | null;
          const fontName = font.getName();
          const hex = extractedColor(color);
          const key = `${fontName}\u0000${Math.round(size * 100) / 100}\u0000${hex}`;
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const charBox: Mupdf.Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          if (!char.trim() && current) {
            current.pendingSpace = current.pendingSpace
              ? { text: current.pendingSpace.text + char, bbox: union(current.pendingSpace.bbox, charBox) }
              : { text: char, bbox: charBox };
            return;
          }
          if (current && current.key === key) {
            if (current.pendingSpace) {
              current.text += current.pendingSpace.text;
              current.bbox = union(current.bbox, current.pendingSpace.bbox);
              current.pendingSpace = null;
            }
            current.text += char;
            current.bbox = union(current.bbox, charBox);
            return;
          }
          flush();
          run = { key, text: char, bbox: charBox, baseline: origin[1], size, color: hex, fontName, pendingSpace: null };
        },
        endLine: flush,
      });
      flush();
      structured.destroy();
      page.destroy();
      return lines;
    },

    async extractPageImages(index) {
      const page = requireDoc().loadPage(index);
      const bounds = page.getBounds();
      const width = bounds[2] - bounds[0];
      const height = bounds[3] - bounds[1];
      const structured = page.toStructuredText("preserve-images");
      const images: PageImage[] = [];
      let imageIndex = 0;
      structured.walk({
        onImageBlock: (bbox, _transform, image) => {
          const pixmap = image.toPixmap();
          images.push({
            id: `${index}-${imageIndex++}`,
            x: (bbox[0] - bounds[0]) / width,
            y: (bbox[1] - bounds[1]) / height,
            width: (bbox[2] - bbox[0]) / width,
            height: (bbox[3] - bbox[1]) / height,
            pixelWidth: image.getWidth(),
            pixelHeight: image.getHeight(),
            dataUrl: `data:image/png;base64,${toBase64(pixmap.asPNG())}`,
          });
          pixmap.destroy();
        },
      });
      structured.destroy();
      page.destroy();
      return images;
    },

    exportDocument,

    async appendPages(operation: AppendOperation) {
      requireDoc();
      const target = open(sourceBytes!, password);
      const firstIndex = target.countPages();
      try {
        if (operation.type === "blank") {
          target.insertPage(
            -1,
            target.addPage([0, 0, operation.width, operation.height], 0, target.newDictionary(), ""),
          );
        } else {
          const source =
            operation.type === "pdf"
              ? open(new Uint8Array(operation.bytes), operation.password)
              : open(sourceBytes!, password);
          try {
            if (operation.type === "copy") {
              if (operation.source < 0 || operation.source >= source.countPages())
                throw new Error("The page to duplicate is unavailable.");
              target.graftPage(-1, source, operation.source);
            } else
              for (let index = 0; index < source.countPages(); index += 1)
                target.graftPage(-1, source, index);
          } finally {
            source.destroy();
          }
        }
        const bytes = copyBytes(target.saveToBuffer("garbage=1").asUint8Array());
        const count = target.countPages() - firstIndex;
        const reopened = open(bytes, password);
        const needsSecret = reopened.needsPassword();
        reopened.destroy();
        const info = loadInto(bytes, needsSecret ? password : undefined);
        return { ...info, bytes: copyBytes(bytes), firstIndex, count };
      } finally {
        target.destroy();
      }
    },

    async destroy() {
      doc?.destroy();
      doc = null;
      sourceBytes = null;
      password = undefined;
    },
  };
}
