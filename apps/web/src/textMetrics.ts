import { useEffect, useState } from "react";
import {
  baselineOffset,
  fontCategory,
  layoutText,
  type FitMode,
  type FontCategory,
  type TextLayout,
} from "@paperless/editor-core/text-layout";
import type { PageInfo } from "@paperless/pdf-engine";

// The editor previews text with the same font files the exporter embeds, so
// what you see on the page is what ends up in the PDF.
export const previewFamily: Record<FontCategory, string> = {
  sans: '"Paperless Sans", Arial, Helvetica, sans-serif',
  serif: '"Paperless Serif", "Times New Roman", Times, serif',
  mono: '"Paperless Mono", "Courier New", Courier, monospace',
};
export const exportFontName: Record<FontCategory, string> = {
  sans: "Liberation Sans",
  serif: "Liberation Serif",
  mono: "Liberation Mono",
};

let loading: Promise<void> | null = null;
export function loadPreviewFonts() {
  loading ??= import("@paperless/pdf-engine/fonts")
    .then(async ({ bundledFontBase64 }) => {
      await Promise.all(
        Object.entries(bundledFontBase64).map(async ([key, base64]) => {
          const [category = "Sans", style = "Regular"] = key.split("_");
          const raw = atob(base64);
          const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
          const face = new FontFace(`Paperless ${category}`, bytes, {
            weight: style.includes("Bold") ? "700" : "400",
            style: style.includes("Italic") ? "italic" : "normal",
          });
          document.fonts.add(await face.load());
        }),
      );
      measureCache.clear();
    })
    .catch(() => undefined);
  return loading;
}

/** Re-renders once the preview fonts are available. */
export function usePreviewFonts() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void loadPreviewFonts().then(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, []);
  return ready;
}

let context: CanvasRenderingContext2D | null = null;
const measureCache = new Map<string, number>();
const fontString = (category: FontCategory, bold: boolean, italic: boolean, size: number) =>
  `${italic ? "italic " : ""}${bold ? 700 : 400} ${size}px ${previewFamily[category]}`;

export function measureFor(category: FontCategory, bold: boolean, italic: boolean) {
  return (text: string, size: number) => {
    const key = `${category}${bold}${italic}\u0000${text}`;
    const cached = measureCache.get(key);
    if (cached !== undefined) return cached * size;
    context ??= document.createElement("canvas").getContext("2d");
    if (!context) return text.length * size * 0.55;
    context.font = fontString(category, bold, italic, 100);
    if ("fontKerning" in context) context.fontKerning = "none";
    const perPoint = context.measureText(text).width / 100;
    if (measureCache.size > 5000) measureCache.clear();
    measureCache.set(key, perPoint);
    return perPoint * size;
  };
}

export type TextStyle = {
  x: number;
  width: number;
  size: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  lineHeight: number;
  letterSpacing: number;
  fitMode: FitMode;
};

export function layoutStyled(style: TextStyle, text: string, info: PageInfo, width = style.width): TextLayout {
  const category = fontCategory(style.fontFamily);
  return layoutText(text, {
    size: style.size,
    maxWidth: width * info.width,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    fitMode: style.fitMode,
    measure: measureFor(category, style.bold, style.italic),
  });
}

/**
 * Box size for text being typed: a box that still fits on one line grows to
 * the right (up to the page margin); a box that already wraps keeps its width.
 */
export function fitTextBox(
  style: TextStyle & { height: number },
  text: string,
  info: PageInfo,
  previousText?: string,
) {
  const available = Math.max(24 / info.width, 0.98 - style.x);
  let width = style.width;
  if (style.fitMode === "auto") {
    const previous = layoutStyled(style, previousText ?? "", info);
    const paragraphs = (previousText ?? "").split(/\r?\n/).length;
    const wrapping = previousText !== undefined && previous.lines.length > paragraphs;
    if (!wrapping) {
      const natural = layoutStyled({ ...style, fitMode: "overflow" }, text, info);
      width = Math.min(available, Math.max(style.width, (natural.width + style.size * 0.3) / info.width));
    }
  }
  const layout = layoutStyled(style, text, info, width);
  return {
    width: Math.max(0.02, width),
    height: Math.max(0.015, style.fitMode === "overflow" ? style.height : layout.height / info.height),
  };
}

export function previewTextStyle(style: TextStyle & { color: string; underline?: boolean }, size: number, zoom: number) {
  const category = fontCategory(style.fontFamily);
  return {
    fontFamily: previewFamily[category],
    fontSize: size * zoom,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing * zoom,
    color: style.color,
    textDecoration: style.underline ? "underline" : "none",
    fontKerning: "none" as const,
  };
}

/** Top of a text box whose first baseline sits on `baseline` (normalized). */
export function topForBaseline(style: { fontFamily: string; size: number; lineHeight: number }, baseline: number, info: PageInfo) {
  return Math.max(0, baseline - baselineOffset(fontCategory(style.fontFamily), style.size, style.lineHeight) / info.height);
}

export { fontCategory };
