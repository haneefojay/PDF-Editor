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

export type ExportOverlay =
  | {
      id: string;
      page: number;
      kind: "text";
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      size: number;
      color: string;
      fontFamily: string;
      fontName: string | null;
      bold: boolean;
      italic: boolean;
      underline: boolean;
      alignment: "left" | "center" | "right" | "justify";
      lineHeight: number;
      letterSpacing: number;
      fitMode: "auto" | "shrink" | "overflow";
      invisible?: boolean;
      ocrConfidence?: number;
      ocrSource?: boolean;
      opacity?: number;
      rotation?: number;
      layoutRole?: "header" | "footer" | "watermark" | "bates";
    }
  | {
      id: string;
      page: number;
      kind: "ink" | "signature";
      points: { x: number; y: number }[];
      color: string;
      width: number;
    }
  | {
      id: string;
      page: number;
      kind: "shape";
      shape: "rectangle" | "square" | "circle" | "triangle";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      fillColor: string | null;
      strokeWidth: number;
    }
  | {
      id: string;
      page: number;
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
    }
  | {
      id: string;
      page: number;
      kind: "redact";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
    }
  | {
      id: string;
      page: number;
      kind: "image";
      x: number;
      y: number;
      width: number;
      height: number;
      dataUrl: string;
      name?: string;
      opacity: number;
      rotation: number;
    }
  | {
      id: string;
      page: number;
      kind: "background";
      color: string;
      opacity: number;
    }
  | {
      id: string;
      page: number;
      kind: "markup";
      markup: "highlight" | "underline" | "strikeout" | "squiggly";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      opacity: number;
      author: string;
      createdAt: string;
      comment: string;
      resolved: boolean;
      flatten: boolean;
    }
  | {
      id: string;
      page: number;
      kind: "note";
      noteType: "sticky" | "callout";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      text: string;
      author: string;
      createdAt: string;
      comment: string;
      resolved: boolean;
      flatten: boolean;
    }
  | {
      id: string;
      page: number;
      kind: "stamp";
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
      color: string;
      author: string;
      createdAt: string;
      comment: string;
      resolved: boolean;
      flatten: boolean;
    }
  | {
      id: string;
      page: number;
      kind: "attachment";
      x: number;
      y: number;
      width: number;
      height: number;
      name: string;
      mimeType: string;
      dataUrl: string;
      author: string;
      createdAt: string;
      comment: string;
      resolved: boolean;
      flatten: boolean;
    }
  | {
      id: string;
      page: number;
      kind: "measurement";
      measurement: "distance" | "perimeter" | "area";
      points: { x: number; y: number }[];
      color: string;
      unit: "pt" | "in" | "cm" | "mm";
      scale: number;
      label: string;
      author: string;
      createdAt: string;
      comment: string;
      resolved: boolean;
      flatten: boolean;
    }
  | {
      id: string;
      page: number;
      kind: "formField";
      fieldType: "text" | "choice" | "checkbox" | "radio" | "signature";
      x: number;
      y: number;
      width: number;
      height: number;
      name: string;
      label: string;
      value: string;
      options: string[];
      required: boolean;
      readOnly: boolean;
      multiline: boolean;
      maxLength: number;
      validation: "none" | "email" | "number" | "regex";
      validationPattern: string;
      calculation: string;
      tabOrder: number;
      flatten: boolean;
    }
  | {
      id: string;
      page: number;
      kind: "visualSignature";
      mode: "typed" | "image" | "digital";
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      dataUrl?: string;
      color: string;
      signer: string;
      signedAt: string;
    };

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
};

export interface PdfWorkerApi {
  loadDocument(
    bytes: ArrayBuffer,
  ): Promise<{
    pageCount: number;
    pages: PageInfo[];
    metadata: PdfMetadata;
    formFields: FormField[];
    encrypted: boolean;
    signatures: SignatureStatus[];
  }>;
  renderPage(index: number, scale: number): Promise<Uint8Array>;
  extractText(index: number): Promise<string>;
  extractTextLines(index: number): Promise<PositionedTextLine[]>;
  extractPageImages(index: number): Promise<PageImage[]>;
  exportDocument(request: ExportRequest): Promise<ExportResult>;
  mergeDocument(
    bytes: ArrayBuffer,
    request: ExportRequest,
  ): Promise<{ bytes: Uint8Array; pageCount: number }>;
  composeDocument(
    request: ExportRequest,
    operation:
      | { type: "blank"; at: number; width: number; height: number }
      | { type: "duplicate"; at: number; source: number }
      | { type: "insert"; at: number; bytes: ArrayBuffer },
  ): Promise<{ bytes: Uint8Array; pageCount: number }>;
  destroy(): Promise<void>;
}
