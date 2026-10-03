export type PageInfo = { width: number; height: number };

export type ExportOverlay =
  | { id: string; page: number; kind: "text"; x: number; y: number; text: string; size: number; color: string }
  | { id: string; page: number; kind: "ink"; points: { x: number; y: number }[]; color: string; width: number }
  | { id: string; page: number; kind: "rect" | "redact"; x: number; y: number; width: number; height: number; color: string };

export type ExportRequest = { overlays: ExportOverlay[]; rotations: Record<number, number>; pageOrder: number[] };
export type ExportResult = { bytes: Uint8Array; pageCount: number; annotationCount: number; redactionCount: number };

export interface PdfWorkerApi {
  loadDocument(bytes: ArrayBuffer): Promise<{ pageCount: number; pages: PageInfo[] }>;
  renderPage(index: number, scale: number): Promise<Uint8Array>;
  extractText(index: number): Promise<string>;
  exportDocument(request: ExportRequest): Promise<ExportResult>;
  destroy(): Promise<void>;
}
