import { createWorker, OEM, type LoggerMessage } from "tesseract.js";
import engUrl from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
import fraUrl from "@tesseract.js-data/fra/4.0.0_best_int/fra.traineddata.gz?url";
import spaUrl from "@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz?url";
import deuUrl from "@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz?url";
import porUrl from "@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz?url";
import araUrl from "@tesseract.js-data/ara/4.0.0_best_int/ara.traineddata.gz?url";
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import coreUrl from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";

export const ocrLanguages = [
  { code: "eng", label: "English", url: engUrl },
  { code: "fra", label: "French", url: fraUrl },
  { code: "spa", label: "Spanish", url: spaUrl },
  { code: "deu", label: "German", url: deuUrl },
  { code: "por", label: "Portuguese", url: porUrl },
  { code: "ara", label: "Arabic", url: araUrl },
] as const;

export type OcrLanguage = (typeof ocrLanguages)[number]["code"];
export type ScanEnhancement = "none" | "grayscale" | "document";
export type OcrLine = {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export function linesFromTsv(tsv: string | null, imageWidth: number, imageHeight: number): OcrLine[] {
  if (!tsv) return [];
  const groups = new Map<string, { words: string[]; confidence: number[]; left: number; top: number; right: number; bottom: number }>();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const columns = row.split("\t");
    if (columns.length < 12 || columns[0] !== "5") continue;
    const text = columns.slice(11).join("\t").trim();
    if (!text) continue;
    const left = Number(columns[6]); const top = Number(columns[7]); const width = Number(columns[8]); const height = Number(columns[9]); const confidence = Number(columns[10]);
    if (![left, top, width, height].every(Number.isFinite)) continue;
    const key = `${columns[2]}-${columns[3]}-${columns[4]}`;
    const group = groups.get(key) ?? { words: [], confidence: [], left, top, right: left + width, bottom: top + height };
    group.words.push(text);
    if (Number.isFinite(confidence) && confidence >= 0) group.confidence.push(confidence);
    group.left = Math.min(group.left, left); group.top = Math.min(group.top, top);
    group.right = Math.max(group.right, left + width); group.bottom = Math.max(group.bottom, top + height);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    text: group.words.join(" "),
    confidence: group.confidence.length ? group.confidence.reduce((sum, value) => sum + value, 0) / group.confidence.length : 0,
    x: group.left / imageWidth, y: group.top / imageHeight,
    width: Math.max(0.002, (group.right - group.left) / imageWidth),
    height: Math.max(0.002, (group.bottom - group.top) / imageHeight),
  }));
}

const loadImage = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("The rendered page could not be prepared for OCR."));
  image.src = source;
});

const enhance = async (source: string, mode: ScanEnhancement) => {
  const image = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This device cannot create an OCR canvas.");
  context.drawImage(image, 0, 0);
  if (mode === "none") return canvas;

  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = frame.data;
  const luminance = new Uint8Array(canvas.width * canvas.height);
  const histogram = new Uint32Array(256);
  for (let pixel = 0, index = 0; pixel < pixels.length; pixel += 4, index += 1) {
    const gray = Math.round(pixels[pixel]! * 0.299 + pixels[pixel + 1]! * 0.587 + pixels[pixel + 2]! * 0.114);
    luminance[index] = gray;
    histogram[gray] = (histogram[gray] ?? 0) + 1;
  }

  let dark = 0;
  let light = 255;
  if (mode === "document") {
    const total = luminance.length;
    let cumulative = 0;
    for (let value = 0; value < 256; value += 1) {
      cumulative += histogram[value]!;
      if (cumulative >= total * 0.001) { dark = value; break; }
    }
    cumulative = 0;
    for (let value = 255; value >= 0; value -= 1) {
      cumulative += histogram[value]!;
      if (cumulative >= total * 0.001) { light = value; break; }
    }
    if (light - dark < 32) { dark = 0; light = 255; }
  }

  const range = Math.max(1, light - dark);
  for (let pixel = 0, index = 0; pixel < pixels.length; pixel += 4, index += 1) {
    let gray = luminance[index]!;
    if (mode === "document") gray = Math.max(0, Math.min(255, Math.round((gray - dark) * 255 / range)));
    pixels[pixel] = gray;
    pixels[pixel + 1] = gray;
    pixels[pixel + 2] = gray;
  }
  context.putImageData(frame, 0, 0);
  return canvas;
};

const languagePath = (code: OcrLanguage) => {
  const entry = ocrLanguages.find((language) => language.code === code);
  if (!entry) throw new Error(`OCR language ${code} is unavailable.`);
  const url = new URL(entry.url, window.location.href);
  return url.href.slice(0, url.href.lastIndexOf("/"));
};

export async function createOcrRecognizer(
  options: { language: OcrLanguage; enhancement: ScanEnhancement; autoDeskew: boolean },
  onProgress: (message: LoggerMessage) => void,
) {
  const worker = await createWorker(
    options.language,
    OEM.LSTM_ONLY,
    { workerPath: workerUrl, corePath: coreUrl, langPath: languagePath(options.language), gzip: true, logger: onProgress },
  );
  return {
    async recognize(source: string): Promise<OcrLine[]> {
      const canvas = await enhance(source, options.enhancement);
    const result = await worker.recognize(canvas, { rotateAuto: options.autoDeskew }, { blocks: true, text: true, tsv: true });
    const lines = result.data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
    const structured = lines
      .filter((line) => line.text.trim())
      .map((line) => ({
        text: line.text.replace(/\s+$/u, ""),
        confidence: Math.max(0, Math.min(100, line.confidence)),
        x: line.bbox.x0 / canvas.width,
        y: line.bbox.y0 / canvas.height,
        width: Math.max(0.002, (line.bbox.x1 - line.bbox.x0) / canvas.width),
        height: Math.max(0.002, (line.bbox.y1 - line.bbox.y0) / canvas.height),
      }));
      return structured.length ? structured : linesFromTsv(result.data.tsv, canvas.width, canvas.height);
    },
    terminate: () => worker.terminate(),
  };
}