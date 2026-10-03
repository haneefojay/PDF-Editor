export type PageInfo = { width: number; height: number };
export type NormalizedRect = { x: number; y: number; width: number; height: number };
export type PdfMetadata = { title: string; author: string; subject: string; keywords: string };
export type FormField = { page: number; name: string; label: string; type: "text" | "choice" | "checkbox" | "radio"; value: string; options: string[]; readOnly: boolean };
export type PositionedTextLine = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
  color: string;
  fontFamily: string;
  fontName: string;
  bold: boolean;
  italic: boolean;
};

export type ExportOverlay =
  | { id: string; page: number; kind: "text"; x: number; y: number; width: number; height: number; text: string; size: number; color: string; fontFamily: string; fontName: string | null; bold: boolean; italic: boolean; underline: boolean }
  | { id: string; page: number; kind: "ink" | "signature"; points: { x: number; y: number }[]; color: string; width: number }
  | { id: string; page: number; kind: "shape"; shape: "rectangle" | "square" | "circle" | "triangle"; x: number; y: number; width: number; height: number; color: string; fillColor: string | null; strokeWidth: number }
  | { id: string; page: number; kind: "rect"; x: number; y: number; width: number; height: number; color: string }
  | { id: string; page: number; kind: "redact"; x: number; y: number; width: number; height: number; color: string }
  | { id: string; page: number; kind: "image"; x: number; y: number; width: number; height: number; dataUrl: string };

export type ExportRequest = {
  overlays: ExportOverlay[];
  rotations: Record<number, number>;
  pageOrder: number[];
  crops: Record<number, NormalizedRect>;
  metadata: PdfMetadata;
  formValues: Record<string, string>;
};
export type ExportResult = { bytes: Uint8Array; pageCount: number; annotationCount: number; redactionCount: number };

export interface PdfWorkerApi {
  loadDocument(bytes: ArrayBuffer): Promise<{ pageCount: number; pages: PageInfo[]; metadata: PdfMetadata; formFields: FormField[]; encrypted: boolean }>;
  renderPage(index: number, scale: number): Promise<Uint8Array>;
  extractText(index: number): Promise<string>;
  extractTextLines(index: number): Promise<PositionedTextLine[]>;
  exportDocument(request: ExportRequest): Promise<ExportResult>;
  mergeDocument(bytes: ArrayBuffer, request: ExportRequest): Promise<{ bytes: Uint8Array; pageCount: number }>;
  destroy(): Promise<void>;
}
