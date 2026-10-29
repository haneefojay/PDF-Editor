import type { Overlay } from "@paperless/editor-core";

export type PageInfo = { width: number; height: number };
export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type PdfMetadata = {
  title: string;
  author: string;
  subject: string;
  keywords: string;
};
export type FormField = {
  page: number;
  name: string;
  label: string;
  type: "text" | "choice" | "checkbox" | "radio" | "signature";
  value: string;
  options: string[];
  readOnly: boolean;
};
export type SignatureStatus = {
  name: string;
  reason: string;
  validCoverage: boolean;
  modifiedAfterSigning: boolean;
};
export type PageImage = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  dataUrl: string;
};
export type PositionedTextLine = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Normalized y of the text baseline. */
  baseline: number;
  /** Text block and line within the page, used to group lines into paragraphs. */
  block?: number;
  line?: number;
  size: number;
  color: string;
  fontFamily: string;
  fontName: string;
  bold: boolean;
  italic: boolean;
  alignment: "left" | "center" | "right" | "justify";
  lineHeight: number;
  letterSpacing: number;
  fitMode: "auto" | "shrink" | "overflow";
};

/**
 * Page content for conversion to other formats, in points from the top-left
 * of the displayed page.
 */
export type LayoutSpan = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  size: number;
  color: string;
  fontName: string;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  monospace: boolean;
  /** Text block and line within the page, in reading order. */
  block: number;
  line: number;
};
export type LayoutImage = { x: number; y: number; width: number; height: number; mimeType: "image/png" | "image/jpeg"; data: Uint8Array };
/** Filled or stroked rectangles: table rules, cell shading, underlines. */
export type LayoutRect = { x: number; y: number; width: number; height: number; color: string; stroked: boolean };
/** A table grid: column and row boundaries in points. */
export type LayoutTable = { columns: number[]; rows: number[]; ruled: boolean };
export type PageLayout = { width: number; height: number; spans: LayoutSpan[]; images: LayoutImage[]; rects: LayoutRect[]; tables: LayoutTable[] };

export type OutlineEntry = {
  title: string;
  /** Target page index, or null when the entry has no destination in this file. */
  page: number | null;
  depth: number;
  uri?: string;
};
/** A clickable area on a page, in normalized coordinates. */
export type PageLink = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Internal target page and normalized vertical position on it. */
  page?: number;
  top?: number;
  /** External target (web or mail address). */
  uri?: string;
};

/** Overlays are exported exactly as the editor stores them. */
export type ExportOverlay = Overlay;

export type ExportRequest = {
  overlays: ExportOverlay[];
  rotations: Record<number, number>;
  pageOrder: number[];
  crops: Record<number, NormalizedRect>;
  metadata: PdfMetadata;
  formValues: Record<string, string>;
  compression?: "original" | "balanced" | "small";
  sanitizeMetadata?: boolean;
  flattenForms?: boolean;
  encryption?: {
    userPassword: string;
    ownerPassword: string;
    allowPrint: boolean;
    allowCopy: boolean;
    allowEdit: boolean;
    allowAnnotate: boolean;
  };
};
export type ExportResult = {
  bytes: Uint8Array;
  pageCount: number;
  annotationCount: number;
  redactionCount: number;
  redactionPages: number[];
  /** Characters no bundled font can draw; they are exported as blanks. */
  missingGlyphs: string[];
};

export type DocumentInfo = {
  pageCount: number;
  pages: PageInfo[];
  metadata: PdfMetadata;
  formFields: FormField[];
  encrypted: boolean;
  signatures: SignatureStatus[];
};

/**
 * Page size for image pages: a sheet the image is fitted into (keeping the
 * image's orientation), or "fit" for a page shaped like the image whose long
 * edge matches A4.
 */
export type ImagePageSize = "a4" | "letter" | "fit";

export type AppendOperation =
  | { type: "blank"; width: number; height: number }
  | { type: "images"; images: ArrayBuffer[]; pageSize?: ImagePageSize }
  | { type: "copy"; source: number }
  /** Copies of pages fitted (scaled and centred) to a new display size in points. */
  | { type: "resize"; sources: number[]; width: number; height: number }
  | { type: "pdf"; bytes: ArrayBuffer; password?: string };

/** How normalized positions on a source page map onto its resized copy. */
export type PageMapping = {
  source: number;
  target: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
};

export type AppendResult = DocumentInfo & {
  /** The new source document; the appended pages follow the old ones. */
  bytes: Uint8Array;
  firstIndex: number;
  count: number;
  mappings?: PageMapping[];
};

/** Error messages start with one of these codes so the UI can react. */
export const PASSWORD_REQUIRED = "PASSWORD_REQUIRED";
export const PASSWORD_INCORRECT = "PASSWORD_INCORRECT";

export interface PdfWorkerApi {
  loadDocument(bytes: ArrayBuffer, password?: string): Promise<DocumentInfo>;
  renderPage(index: number, scale: number): Promise<Uint8Array>;
  extractText(index: number): Promise<string>;
  extractTextLines(index: number): Promise<PositionedTextLine[]>;
  extractPageImages(index: number): Promise<PageImage[]>;
  /** Image positions on a page, without decoding the pixels. */
  listPageImages(index: number): Promise<Omit<PageImage, "dataUrl">[]>;
  /** The document outline (bookmarks), flattened in reading order. */
  getOutline(): Promise<OutlineEntry[]>;
  getLinks(index: number): Promise<PageLink[]>;
  exportDocument(request: ExportRequest): Promise<ExportResult>;
  /**
   * Adds pages to the end of the source document without touching edits, so
   * page insertion stays undoable through the page order.
   */
  appendPages(operation: AppendOperation): Promise<AppendResult>;
  /** Builds a new PDF with one page per image (PNG or JPEG), fitted to A4. */
  createFromImages(images: ArrayBuffer[], pageSize?: ImagePageSize): Promise<Uint8Array>;
  /** Text, images, shapes and tables of the given pages of a PDF, for conversion. */
  analyzeBytes(bytes: ArrayBuffer, pages?: number[]): Promise<PageLayout[]>;
  /**
   * Lays out HTML documents into PDF pages, one part after another; each part
   * starts on a new page of its own size (in points).
   */
  htmlToPdf(parts: { html: string; width: number; height: number }[]): Promise<Uint8Array>;
  /** A page rendered as PNG with its text removed, for slide backgrounds. */
  renderBytesWithoutText(bytes: ArrayBuffer, index: number, scale: number): Promise<Uint8Array>;
  /** Renders a page of another PDF (such as an export) without opening it. */
  renderBytes(bytes: Uint8Array, index: number, scale: number): Promise<Uint8Array>;
  /** Plain text of every page of another PDF, one string per page. */
  textOfBytes(bytes: Uint8Array): Promise<string[]>;
  destroy(): Promise<void>;
}
