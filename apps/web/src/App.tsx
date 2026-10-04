import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crop,
  Download,
  FileImage,
  FileKey2,
  FilePlus2,
  Highlighter,
  ImageDown,
  Info,
  Italic,
  Layers,
  LayoutTemplate,
  ListChecks,
  Merge,
  MessageSquareText,
  MousePointer2,
  Paperclip,
  PenLine,
  Redo2,
  RotateCw,
  Ruler,
  ScanText,
  Scissors,
  Search,
  Shapes,
  ShieldCheck,
  Signature,
  Stamp,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  createPdfEngine,
  type FormField,
  type PageImage,
  type PageInfo,
  type PdfMetadata,
  type PositionedTextLine,
  type SignatureStatus,
} from "@paperless/pdf-engine";
import {
  EditorDocumentSchema,
  Overlay as OverlaySchema,
  normalizeRect,
  type EditorDocument,
  type Overlay,
  type Tool,
} from "@paperless/editor-core";
import {
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
  type ProjectSummary,
} from "./persistence";
import { useEditor } from "./store";
import { configureNativeUi, registerBackHandler, savePdf } from "./platform";
import {
  createOcrRecognizer,
  ocrLanguages,
  type OcrLanguage,
  type ScanEnhancement,
} from "./ocr";
import { signPdfWithCertificate } from "./digital-signature";

const tools: { id: Tool; label: string; Icon: typeof MousePointer2 }[] = [
  { id: "select", label: "Select", Icon: MousePointer2 },
  { id: "text", label: "Add text", Icon: Type },
  { id: "ink", label: "Draw", Icon: PenLine },
  { id: "signature", label: "Sign", Icon: Signature },
  { id: "shape", label: "Shapes", Icon: Shapes },
  { id: "redact", label: "Redact", Icon: Highlighter },
  { id: "crop", label: "Crop", Icon: Crop },
  { id: "form", label: "Form field", Icon: FileKey2 },
  { id: "markup", label: "Markup", Icon: Highlighter },
  { id: "note", label: "Comment", Icon: MessageSquareText },
  { id: "stamp", label: "Stamp", Icon: Stamp },
  { id: "measure", label: "Measure", Icon: Ruler },
];

type OpenDoc = {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  pages: PageInfo[];
  urls: Map<string, string>;
  formFields: FormField[];
  signatures: SignatureStatus[];
  initialMetadata: PdfMetadata;
  initialFormValues: Record<string, string>;
};
type FindResult = {
  sourcePage: number;
  line: PositionedTextLine;
  overlayId?: string;
};
type ShapeKind = "rectangle" | "square" | "circle" | "triangle";
type MarkupKind = "highlight" | "underline" | "strikeout" | "squiggly";
type ReviewOverlay = Extract<
  Overlay,
  { kind: "markup" | "note" | "stamp" | "attachment" | "measurement" }
>;
const isReviewOverlay = (overlay: Overlay): overlay is ReviewOverlay =>
  ["markup", "note", "stamp", "attachment", "measurement"].includes(
    overlay.kind,
  );
const commonFonts = [
  "Arial",
  "Helvetica",
  "Calibri",
  "Cambria",
  "Times New Roman",
  "Georgia",
  "Garamond",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Courier New",
  "Noto Sans",
  "Noto Serif",
];
const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
const fontStack = (fontName: string | null | undefined, family: string) =>
  `"${(fontName || family).replaceAll('"', "")}","${family.replaceAll('"', "")}",Arial,sans-serif`;
const layoutTextBox = (
  style: {
    x: number;
    size: number;
    fontFamily: string;
    bold: boolean;
    width: number;
    height: number;
    lineHeight?: number;
    letterSpacing?: number;
    fitMode?: "auto" | "shrink" | "overflow";
  },
  text: string,
  info: PageInfo,
) => {
  const factor =
    style.fontFamily.toLowerCase().includes("mono") ||
    style.fontFamily.toLowerCase().includes("courier")
      ? 0.62
      : style.fontFamily.toLowerCase().includes("serif") ||
          style.fontFamily.toLowerCase().includes("times")
        ? 0.52
        : 0.56;
  const characterWidth =
    style.size * (factor + (style.bold ? 0.03 : 0)) +
    (style.letterSpacing ?? 0);
  const availablePoints = Math.max(24, (0.98 - style.x) * info.width);
  const paragraphs = text.split(/\r?\n/);
  let visualLines = 0;
  let longestPoints = 0;
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/(\s+)/);
    let linePoints = 0;
    let paragraphLines = 1;
    for (const word of words) {
      const wordPoints = word.length * characterWidth;
      if (
        style.fitMode !== "overflow" &&
        style.fitMode !== "shrink" &&
        linePoints > 0 &&
        linePoints + wordPoints > availablePoints
      ) {
        longestPoints = Math.max(longestPoints, linePoints);
        linePoints = wordPoints;
        paragraphLines += 1;
      } else linePoints += wordPoints;
    }
    longestPoints = Math.max(longestPoints, linePoints);
    visualLines += paragraphLines;
  }
  const width =
    style.fitMode === "shrink" || style.fitMode === "overflow"
      ? style.width
      : Math.min(
          0.98 - style.x,
          Math.max(
            style.width,
            Math.min(availablePoints, longestPoints + style.size) / info.width,
          ),
        );
  const height = Math.max(
    style.height,
    (visualLines * style.size * (style.lineHeight ?? 1.2)) / info.height,
  );
  return { width: Math.max(0.03, width), height: Math.max(0.02, height) };
};
const fittedFontSize = (
  style: {
    size: number;
    fontFamily: string;
    bold: boolean;
    width: number;
    letterSpacing?: number;
    fitMode?: string;
  },
  text: string,
  info: PageInfo,
) => {
  if (style.fitMode !== "shrink") return style.size;
  const factor = style.fontFamily.toLowerCase().includes("mono")
    ? 0.62
    : style.fontFamily.toLowerCase().includes("serif") ||
        style.fontFamily.toLowerCase().includes("times")
      ? 0.52
      : 0.56;
  const longest = Math.max(
    ...text.split(/\r?\n/).map((line) => line.length),
    1,
  );
  const natural =
    longest * style.size * (factor + (style.bold ? 0.03 : 0)) +
    Math.max(0, longest - 1) * (style.letterSpacing ?? 0);
  return natural > style.width * info.width
    ? Math.max(6, (style.size * style.width * info.width) / natural)
    : style.size;
};
const withTimeout = <T,>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
) =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      milliseconds,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

function FontSizeInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 10) / 10));
  useEffect(() => setDraft(String(Math.round(value * 10) / 10)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(300, Math.max(6, parsed));
    setDraft(String(next));
    onCommit(next);
  };
  return (
    <input
      className="numberInput"
      aria-label="Font size"
      inputMode="decimal"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function CompactNumberInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    onCommit(next);
  };
  return (
    <input
      className="numberInput"
      aria-label={label}
      inputMode="decimal"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function App() {
  const engine = useRef<ReturnType<typeof createPdfEngine> | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const reviewImportInput = useRef<HTMLInputElement>(null);
  const insertPdfInput = useRef<HTMLInputElement>(null);
  const replaceImageInput = useRef<HTMLInputElement>(null);
  const nativeReplaceInput = useRef<HTMLInputElement>(null);
  const certificateInput = useRef<HTMLInputElement>(null);
  const signatureImageInput = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pinch = useRef<{
    distance: number;
    zoom: number;
    contentX: number;
    contentY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const loadSequence = useRef(0);
  const [open, setOpen] = useState<OpenDoc | null>(null);
  const [showProperties, setShowProperties] = useState(false);
  const [showForms, setShowForms] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [showOcr, setShowOcr] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showPages, setShowPages] = useState(false);
  const [showLayout, setShowLayout] = useState(false);
  const [showCompression, setShowCompression] = useState(false);
  const [showImageCrop, setShowImageCrop] = useState(false);
  const [showPageImages, setShowPageImages] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [findResults, setFindResults] = useState<FindResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [ocrLanguage, setOcrLanguage] = useState<OcrLanguage>("eng");
  const [ocrScope, setOcrScope] = useState<"page" | "document">("page");
  const [scanEnhancement, setScanEnhancement] =
    useState<ScanEnhancement>("document");
  const [autoDeskew, setAutoDeskew] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [confidenceThreshold, setConfidenceThreshold] = useState(75);
  const [metadataDraft, setMetadataDraft] = useState<PdfMetadata>({
    title: "",
    author: "",
    subject: "",
    keywords: "",
  });
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rectangle");
  const [markupKind, setMarkupKind] = useState<MarkupKind>("highlight");
  const [noteType, setNoteType] = useState<"sticky" | "callout">("sticky");
  const [stampLabel, setStampLabel] = useState("Approved");
  const [measureKind, setMeasureKind] = useState<
    "distance" | "perimeter" | "area"
  >("distance");
  const [measureUnit, setMeasureUnit] = useState<"pt" | "in" | "cm" | "mm">(
    "cm",
  );
  const [measureScale, setMeasureScale] = useState(1);
  const [reviewAuthor, setReviewAuthor] = useState("Reviewer");
  const [commentFilter, setCommentFilter] = useState<
    "all" | "open" | "resolved"
  >("all");
  const [pendingAttachment, setPendingAttachment] = useState<{
    name: string;
    mimeType: string;
    dataUrl: string;
  } | null>(null);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [compressionProfile, setCompressionProfile] = useState<
    "original" | "balanced" | "small"
  >("balanced");
  const [compressionEstimate, setCompressionEstimate] = useState<number | null>(
    null,
  );
  const [estimatingCompression, setEstimatingCompression] = useState(false);
  const [layoutDraft, setLayoutDraft] = useState({
    header: "",
    footer: "",
    watermark: "",
    batesPrefix: "",
    batesStart: 1,
    batesDigits: 4,
    background: "#ffffff",
    useBackground: false,
  });
  const [imageCrop, setImageCrop] = useState({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });
  const [pageImages, setPageImages] = useState<PageImage[]>([]);
  const [nativeReplace, setNativeReplace] = useState<PageImage | null>(null);
  const [formType, setFormType] = useState<
    "text" | "choice" | "checkbox" | "radio" | "signature"
  >("text");
  const [formName, setFormName] = useState("Field1");
  const [formValidation, setFormValidation] = useState<
    "none" | "email" | "number" | "regex"
  >("none");
  const [formPattern, setFormPattern] = useState("");
  const [signatureMode, setSignatureMode] = useState<
    "draw" | "typed" | "image" | "digital"
  >("draw");
  const [signatureName, setSignatureName] = useState("");
  const [signatureImage, setSignatureImage] = useState<string | null>(null);
  const [certificate, setCertificate] = useState<{
    name: string;
    bytes: Uint8Array;
  } | null>(null);
  const [certificatePassphrase, setCertificatePassphrase] = useState("");
  const [signatureReason, setSignatureReason] = useState("Approved and signed");
  const [signatureLocation, setSignatureLocation] = useState("");
  const [signatureContact, setSignatureContact] = useState("");
  const [security, setSecurity] = useState({
    userPassword: "",
    ownerPassword: "",
    allowPrint: true,
    allowCopy: true,
    allowEdit: false,
    allowAnnotate: true,
    sanitizeMetadata: false,
    flattenForms: false,
  });
  const [lastAudit, setLastAudit] = useState<{
    generatedAt: string;
    document: string;
    pages: number[];
    areas: number;
    verified: boolean;
  } | null>(null);
  const [drawColor, setDrawColor] = useState("#d64b35");
  const [textLines, setTextLines] = useState<PositionedTextLine[]>([]);
  const [originalEdit, setOriginalEdit] = useState<{
    line: PositionedTextLine;
    draft: string;
  } | null>(null);
  const {
    tool,
    zoom,
    page,
    doc,
    undo,
    redo,
    setTool,
    setZoom,
    setPage,
    execute,
    undoOnce,
    redoOnce,
    reset,
    hydrate,
  } = useEditor();

  const refreshRecent = useCallback(
    () =>
      listProjects()
        .then(setRecent)
        .catch(() => setRecent([])),
    [],
  );

  useEffect(() => {
    engine.current = createPdfEngine();
    void configureNativeUi();
    void refreshRecent();
    return () => engine.current?.terminate();
  }, [refreshRecent]);

  const openBytes = useCallback(
    async (input: {
      id: string;
      name: string;
      bytes: ArrayBuffer;
      snapshot?: EditorDocument;
    }) => {
      const sequence = ++loadSequence.current;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const loadOnce = async () => {
          const activeEngine = engine.current!;
          await withTimeout(
            activeEngine.ready,
            20_000,
            "The PDF engine took too long to start.",
          );
          return withTimeout(
            activeEngine.api.loadDocument(input.bytes.slice(0)),
            35_000,
            "This document took too long to load.",
          );
        };
        let meta;
        try {
          meta = await loadOnce();
        } catch {
          engine.current?.terminate();
          engine.current = createPdfEngine();
          meta = await loadOnce();
        }
        if (sequence !== loadSequence.current) return;
        if (input.snapshot) {
          const snapshot = EditorDocumentSchema.parse(input.snapshot);
          const validOrder =
            snapshot.pageOrder.length > 0 &&
            snapshot.pageOrder.every((item) => item < meta.pageCount) &&
            new Set(snapshot.pageOrder).size === snapshot.pageOrder.length;
          if (!validOrder)
            throw new Error(
              "The recovered page order is invalid for this PDF.",
            );
          hydrate(snapshot);
        } else {
          const formValues = Object.fromEntries(
            meta.formFields.map((field) => [field.name, field.value]),
          );
          reset(meta.pageCount, { metadata: meta.metadata, formValues });
        }
        const initialFormValues = Object.fromEntries(
          meta.formFields.map((field) => [field.name, field.value]),
        );
        setMetadataDraft(input.snapshot?.metadata ?? meta.metadata);
        setOpen({
          id: input.id,
          name: input.name,
          bytes: input.bytes,
          pages: meta.pages,
          urls: new Map(),
          formFields: meta.formFields,
          signatures: meta.signatures,
          initialMetadata: meta.metadata,
          initialFormValues,
        });
        if (meta.signatures.length)
          setNotice(
            `${meta.signatures.length} digital signature${meta.signatures.length === 1 ? "" : "s"} detected. Editing this document may invalidate existing signatures.`,
          );
        setImage(null);
        setTextLines([]);
        setSelectedId(null);
        setOriginalEdit(null);
      } catch (cause) {
        if (sequence === loadSequence.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "This PDF could not be opened.",
          );
      } finally {
        if (sequence === loadSequence.current) setBusy(false);
      }
    },
    [hydrate, reset],
  );

  const load = useCallback(
    async (file: File) => {
      if (
        file.type !== "application/pdf" &&
        !file.name.toLowerCase().endsWith(".pdf")
      ) {
        setError("Choose a PDF file.");
        return;
      }
      await openBytes({
        id: crypto.randomUUID(),
        name: file.name,
        bytes: await file.arrayBuffer(),
      });
    },
    [openBytes],
  );

  const recover = useCallback(
    async (id: string) => {
      setBusy(true);
      setError("");
      try {
        const project = await loadProject(id);
        await openBytes(project);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The project could not be recovered.",
        );
        setBusy(false);
      }
    },
    [openBytes],
  );

  const openId = open?.id;
  const openName = open?.name;
  const openBytesRef = open?.bytes;
  const sourcePage = doc.pageOrder[page] ?? 0;
  useEffect(() => {
    if (!openBytesRef || doc.pageOrder.length === 0) return;
    let active = true;
    setBusy(true);
    setTextLines([]);
    setOriginalEdit(null);
    const render = async () => {
      try {
        await withTimeout(
          engine.current!.ready,
          20_000,
          "The PDF renderer did not start.",
        );
        return await withTimeout(
          engine.current!.api.renderPage(
            sourcePage,
            Math.min(2, Math.max(1, window.devicePixelRatio)),
          ),
          30_000,
          "This page took too long to render.",
        );
      } catch {
        engine.current?.terminate();
        engine.current = createPdfEngine();
        await withTimeout(
          engine.current.ready,
          20_000,
          "The PDF renderer did not restart.",
        );
        await withTimeout(
          engine.current.api.loadDocument(openBytesRef.slice(0)),
          35_000,
          "The document could not be recovered.",
        );
        return withTimeout(
          engine.current.api.renderPage(
            sourcePage,
            Math.min(2, Math.max(1, window.devicePixelRatio)),
          ),
          30_000,
          "This page could not be rendered.",
        );
      }
    };
    void render()
      .then((png) => {
        if (!active) return;
        const key = `${sourcePage}`;
        const copy = new Uint8Array(png.byteLength);
        copy.set(png);
        const url = URL.createObjectURL(
          new Blob([copy.buffer], { type: "image/png" }),
        );
        setOpen((current) => {
          if (!current) return current;
          const old = current.urls.get(key);
          if (old) URL.revokeObjectURL(old);
          return { ...current, urls: new Map(current.urls).set(key, url) };
        });
        setImage(url);
        return withTimeout(
          engine.current!.api.extractTextLines(sourcePage),
          20_000,
          "Text selection took too long.",
        ).then((lines) => {
          if (active) setTextLines(lines);
        });
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Page render failed"),
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [openBytesRef, sourcePage, doc.pageOrder.length]);

  useEffect(() => {
    if (!openId || !openName || !openBytesRef || doc.pageOrder.length === 0)
      return;
    setSaving(true);
    const timer = window.setTimeout(() => {
      void saveProject({
        id: openId,
        name: openName,
        bytes: openBytesRef,
        snapshot: doc,
      })
        .then(refreshRecent)
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : "Autosave failed."),
        )
        .finally(() => setSaving(false));
    }, 500);
    return () => {
      window.clearTimeout(timer);
      setSaving(false);
    };
  }, [openId, openName, openBytesRef, doc, refreshRecent]);

  useEffect(() => {
    if (page >= doc.pageOrder.length && doc.pageOrder.length > 0)
      setPage(doc.pageOrder.length - 1);
  }, [doc.pageOrder.length, page, setPage]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoOnce();
        else undoOnce();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoOnce();
      }
      if (event.key === "PageDown" && open)
        setPage(Math.min(doc.pageOrder.length - 1, page + 1));
      if (event.key === "PageUp") setPage(Math.max(0, page - 1));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [doc.pageOrder.length, open, page, redoOnce, setPage, undoOnce]);

  const movePage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= doc.pageOrder.length) return;
    const after = [...doc.pageOrder];
    [after[index], after[target]] = [after[target]!, after[index]!];
    execute({ type: "setPageOrder", before: doc.pageOrder, after });
    setPage(target);
  };

  const removePage = (index: number) => {
    if (doc.pageOrder.length <= 1) {
      setError("A PDF must contain at least one page.");
      return;
    }
    const after = doc.pageOrder.filter((_, itemIndex) => itemIndex !== index);
    execute({ type: "setPageOrder", before: doc.pageOrder, after });
    setPage(Math.min(index, after.length - 1));
  };

  const closeDocument = () => {
    open?.urls.forEach((url) => URL.revokeObjectURL(url));
    setOpen(null);
    setImage(null);
    setTextLines([]);
    setOriginalEdit(null);
    setNotice("");
    setError("");
    void refreshRecent();
  };

  useEffect(() => {
    let dispose = () => undefined;
    void registerBackHandler(() => {
      if (showProperties) {
        setShowProperties(false);
        return true;
      }
      if (showForms) {
        setShowForms(false);
        return true;
      }
      if (showOcr) {
        setShowOcr(false);
        return true;
      }
      if (showComments) {
        setShowComments(false);
        return true;
      }
      if (showImageCrop) {
        setShowImageCrop(false);
        return true;
      }
      if (showPageImages) {
        setShowPageImages(false);
        return true;
      }
      if (showSecurity) {
        setShowSecurity(false);
        return true;
      }
      if (showCompression) {
        setShowCompression(false);
        return true;
      }
      if (showLayout) {
        setShowLayout(false);
        return true;
      }
      if (showPages) {
        setShowPages(false);
        return true;
      }
      if (showFind) {
        setShowFind(false);
        return true;
      }
      if (open) {
        open.urls.forEach((url) => URL.revokeObjectURL(url));
        setOpen(null);
        setImage(null);
        void refreshRecent();
        return true;
      }
      return false;
    }).then((cleanup) => {
      dispose = cleanup;
    });
    return () => dispose();
  }, [
    open,
    refreshRecent,
    showComments,
    showCompression,
    showFind,
    showForms,
    showImageCrop,
    showLayout,
    showOcr,
    showPageImages,
    showPages,
    showProperties,
    showSecurity,
  ]);

  const download = async () => {
    if (!open) return;
    setError("");
    setNotice("");
    setExporting(true);
    try {
      const edited =
        doc.overlays.length > 0 ||
        Object.keys(doc.rotations).length > 0 ||
        Object.keys(doc.crops).length > 0 ||
        JSON.stringify(doc.metadata) !== JSON.stringify(open.initialMetadata) ||
        JSON.stringify(doc.formValues) !==
          JSON.stringify(open.initialFormValues) ||
        doc.pageOrder.some((item, index) => item !== index) ||
        doc.pageOrder.length !== open.pages.length ||
        security.userPassword !== "" ||
        security.ownerPassword !== "" ||
        security.sanitizeMetadata ||
        security.flattenForms ||
        certificate !== null;
      let bytes: Uint8Array | ArrayBuffer = open.bytes;
      let filename = open.name;
      if (edited) {
        if (certificate && (security.userPassword || security.ownerPassword))
          throw new Error(
            "Certificate signing and password encryption must be exported separately so the signature remains valid.",
          );
        setNotice("Preparing and validating your PDF…");
        await withTimeout(
          engine.current!.ready,
          20_000,
          "The PDF exporter did not start.",
        );
        const result = await withTimeout(
          engine.current!.api.exportDocument({
            overlays: doc.overlays,
            rotations: doc.rotations,
            pageOrder: doc.pageOrder,
            crops: doc.crops,
            metadata: doc.metadata,
            formValues: doc.formValues,
            compression: compressionProfile,
            sanitizeMetadata: security.sanitizeMetadata,
            flattenForms: security.flattenForms,
            encryption:
              security.userPassword || security.ownerPassword
                ? {
                    userPassword: security.userPassword,
                    ownerPassword: security.ownerPassword,
                    allowPrint: security.allowPrint,
                    allowCopy: security.allowCopy,
                    allowEdit: security.allowEdit,
                    allowAnnotate: security.allowAnnotate,
                  }
                : undefined,
          }),
          90_000,
          "Export timed out. Your edits are still saved locally; please try again.",
        );
        let copy = new Uint8Array(result.bytes.byteLength);
        copy.set(result.bytes);
        if (certificate) {
          setNotice(
            "Applying the certificate-backed digital signature locally…",
          );
          copy = await signPdfWithCertificate(
            copy,
            certificate.bytes,
            certificatePassphrase,
            {
              reason: signatureReason,
              name: signatureName || reviewAuthor || "Signer",
              location: signatureLocation,
              contactInfo: signatureContact,
            },
          );
        }
        bytes = copy.buffer;
        filename = `${open.name.replace(/\.pdf$/i, "")}-edited.pdf`;
        const audit = {
          generatedAt: new Date().toISOString(),
          document: open.name,
          pages: result.redactionPages.map((item) => item + 1),
          areas: result.redactionCount,
          verified: true,
        };
        setLastAudit(audit);
        setNotice(
          `Export verified: ${result.pageCount} pages, ${result.annotationCount} edits, ${result.redactionCount} redactions${certificate ? ", digitally signed" : ""}.`,
        );
      }
      const message = await withTimeout(
        savePdf(
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          filename,
        ),
        45_000,
        "The Android save dialog did not open. Please try again.",
      );
      setNotice((current) => (current ? `${current} ${message}.` : message));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "PDF export failed validation.",
      );
    } finally {
      setExporting(false);
    }
  };

  const exportRequest = {
    overlays: doc.overlays,
    rotations: doc.rotations,
    pageOrder: doc.pageOrder,
    crops: doc.crops,
    metadata: doc.metadata,
    formValues: doc.formValues,
    compression: compressionProfile,
    sanitizeMetadata: security.sanitizeMetadata,
    flattenForms: security.flattenForms,
    encryption:
      security.userPassword || security.ownerPassword
        ? {
            userPassword: security.userPassword,
            ownerPassword: security.ownerPassword,
            allowPrint: security.allowPrint,
            allowCopy: security.allowCopy,
            allowEdit: security.allowEdit,
            allowAnnotate: security.allowAnnotate,
          }
        : undefined,
  };
  const downloadBytes = (bytes: Uint8Array, filename: string) =>
    savePdf(bytes, filename);

  const addImage = async (file: File) => {
    if (!open || !file.type.startsWith("image/")) {
      setError("Choose a PNG or JPEG image.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const dimensions = await new Promise<{ width: number; height: number }>(
      (resolve, reject) => {
        const image = new Image();
        image.onload = () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = reject;
        image.src = dataUrl;
      },
    );
    const info = open.pages[sourcePage]!;
    const width = 0.3;
    const height = Math.min(
      0.5,
      width *
        (dimensions.height / dimensions.width) *
        (info.width / info.height),
    );
    const overlay: Overlay = {
      id: crypto.randomUUID(),
      page: sourcePage,
      kind: "image",
      x: 0.12,
      y: 0.12,
      width,
      height,
      dataUrl,
      name: file.name,
      opacity: 1,
      rotation: 0,
    };
    execute({ type: "add", overlay });
    setSelectedId(overlay.id);
    setTool("select");
  };

  const chooseAttachment = async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      setError("Review attachments are limited to 15 MB.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setPendingAttachment({
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      dataUrl,
    });
    setTool("attachment");
    setNotice("Tap the page to place the attachment.");
  };

  const exportReviews = () => {
    const payload = JSON.stringify(
      {
        format: "paperless-review-v1",
        document: open?.name ?? "",
        exportedAt: new Date().toISOString(),
        annotations: doc.overlays.filter(isReviewOverlay),
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([payload], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(open?.name ?? "document").replace(/\.pdf$/i, "")}-review.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importReviews = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        annotations?: unknown[];
      };
      const imported: ReviewOverlay[] = [];
      for (const item of parsed.annotations ?? []) {
        const result = OverlaySchema.safeParse(item);
        if (
          result.success &&
          isReviewOverlay(result.data) &&
          result.data.page < doc.pageOrder.length
        )
          imported.push({ ...result.data, id: crypto.randomUUID() });
      }
      if (!imported.length)
        throw new Error(
          "No compatible Paperless review annotations were found.",
        );
      execute({ type: "addMany", overlays: imported });
      setNotice(`Imported ${imported.length} review annotations.`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Review import failed.",
      );
    }
  };

  const replaceSelectedImage = async (file: File) => {
    const selected = doc.overlays.find((overlay) => overlay.id === selectedId);
    if (selected?.kind !== "image" || !file.type.startsWith("image/")) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    execute({
      type: "updateOverlay",
      before: selected,
      after: { ...selected, dataUrl, name: file.name },
    });
  };

  const extractSelectedImage = () => {
    const selected = doc.overlays.find((overlay) => overlay.id === selectedId);
    if (selected?.kind !== "image") return;
    const anchor = document.createElement("a");
    anchor.href = selected.dataUrl;
    anchor.download = selected.name || "extracted-image.png";
    anchor.click();
  };

  const openNativeImages = async () => {
    setBusy(true);
    setError("");
    try {
      const images = await engine.current!.api.extractPageImages(sourcePage);
      setPageImages(images);
      setShowPageImages(true);
      if (!images.length)
        setNotice("No embedded raster images were found on this page.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Page images could not be extracted.",
      );
    } finally {
      setBusy(false);
    }
  };

  const replaceNativeImage = async (file: File) => {
    if (!nativeReplace || !file.type.startsWith("image/")) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const target = nativeReplace;
    const erase: Overlay = {
      id: crypto.randomUUID(),
      page: sourcePage,
      kind: "redact",
      x: target.x,
      y: target.y,
      width: target.width,
      height: target.height,
      color: "#ffffff",
    };
    const replacement: Overlay = {
      id: crypto.randomUUID(),
      page: sourcePage,
      kind: "image",
      x: target.x,
      y: target.y,
      width: target.width,
      height: target.height,
      dataUrl,
      name: file.name,
      opacity: 1,
      rotation: 0,
    };
    execute({ type: "addMany", overlays: [erase, replacement] });
    setNativeReplace(null);
    setShowPageImages(false);
    setSelectedId(replacement.id);
    setTool("select");
    setNotice("The embedded image will be replaced in the exported PDF.");
  };

  const cropSelectedImage = async () => {
    const selected = doc.overlays.find((overlay) => overlay.id === selectedId);
    if (selected?.kind !== "image") return;
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const item = new Image();
      item.onload = () => resolve(item);
      item.onerror = reject;
      item.src = selected.dataUrl;
    });
    const left = imageCrop.left / 100;
    const top = imageCrop.top / 100;
    const right = imageCrop.right / 100;
    const bottom = imageCrop.bottom / 100;
    const sourceWidth = Math.max(
      1,
      Math.round(image.naturalWidth * (1 - left - right)),
    );
    const sourceHeight = Math.max(
      1,
      Math.round(image.naturalHeight * (1 - top - bottom)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Image cropping is unavailable on this device.");
    context.drawImage(
      image,
      image.naturalWidth * left,
      image.naturalHeight * top,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight,
    );
    const info = open!.pages[selected.page]!;
    const nextHeight = Math.min(
      1 - selected.y,
      selected.width *
        (sourceHeight / sourceWidth) *
        (info.width / info.height),
    );
    execute({
      type: "updateOverlay",
      before: selected,
      after: {
        ...selected,
        dataUrl: canvas.toDataURL("image/png"),
        height: Math.max(0.02, nextHeight),
        name:
          selected.name?.replace(/\.[^.]+$/, "-cropped.png") ??
          "cropped-image.png",
      },
    });
    setShowImageCrop(false);
    setImageCrop({ left: 0, top: 0, right: 0, bottom: 0 });
  };

  const arrangeSelected = (where: "front" | "back") => {
    const index = doc.overlays.findIndex(
      (overlay) => overlay.id === selectedId,
    );
    if (index < 0) return;
    const after = [...doc.overlays];
    const [item] = after.splice(index, 1);
    if (!item) return;
    if (where === "front") after.push(item);
    else after.unshift(item);
    execute({ type: "setOverlayOrder", before: doc.overlays, after });
  };

  const alignSelected = (
    alignment: "left" | "center" | "right" | "top" | "middle" | "bottom",
  ) => {
    const selected = doc.overlays.find((overlay) => overlay.id === selectedId);
    if (!selected || !("x" in selected) || !("width" in selected)) return;
    const x =
      alignment === "left"
        ? 0
        : alignment === "center"
          ? (1 - selected.width) / 2
          : alignment === "right"
            ? 1 - selected.width
            : selected.x;
    const y =
      alignment === "top"
        ? 0
        : alignment === "middle"
          ? (1 - selected.height) / 2
          : alignment === "bottom"
            ? 1 - selected.height
            : selected.y;
    execute({
      type: "updateOverlay",
      before: selected,
      after: { ...selected, x, y } as Overlay,
    });
  };

  const applyPageOperation = async (
    operation: Parameters<
      ReturnType<typeof createPdfEngine>["api"]["composeDocument"]
    >[1],
    message: string,
  ) => {
    if (!open) return;
    setBusy(true);
    setError("");
    try {
      const result = await engine.current!.api.composeDocument(
        exportRequest,
        operation,
      );
      const copy = new Uint8Array(result.bytes.byteLength);
      copy.set(result.bytes);
      await openBytes({ id: open.id, name: open.name, bytes: copy.buffer });
      setNotice(`${message} The document now has ${result.pageCount} pages.`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Page operation failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const batchMovePages = (where: "start" | "end" | "reverse") => {
    if (where === "reverse") {
      execute({
        type: "setPageOrder",
        before: doc.pageOrder,
        after: [...doc.pageOrder].reverse(),
      });
      return;
    }
    if (!selectedPages.length) return;
    const selectedSet = new Set(selectedPages);
    const picked = doc.pageOrder.filter((_, index) => selectedSet.has(index));
    const rest = doc.pageOrder.filter((_, index) => !selectedSet.has(index));
    const after =
      where === "start" ? [...picked, ...rest] : [...rest, ...picked];
    execute({ type: "setPageOrder", before: doc.pageOrder, after });
    setSelectedPages([]);
  };

  const extractSelectedPages = async () => {
    if (!open || !selectedPages.length) return;
    setExporting(true);
    try {
      const order = [...selectedPages]
        .sort((a, b) => a - b)
        .map((index) => doc.pageOrder[index]!)
        .filter((item) => item !== undefined);
      const result = await engine.current!.api.exportDocument({
        ...exportRequest,
        pageOrder: order,
      });
      await downloadBytes(
        result.bytes,
        `${open.name.replace(/\.pdf$/i, "")}-extracted.pdf`,
      );
      setNotice(`Extracted ${order.length} pages.`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Page extraction failed.",
      );
    } finally {
      setExporting(false);
    }
  };

  const applyLayout = () => {
    if (!open) return;
    const existing = doc.overlays.filter(
      (overlay) =>
        !(
          overlay.kind === "background" ||
          (overlay.kind === "text" && overlay.layoutRole)
        ),
    );
    const additions: Overlay[] = [];
    doc.pageOrder.forEach((source, index) => {
      if (layoutDraft.useBackground)
        additions.push({
          id: crypto.randomUUID(),
          page: source,
          kind: "background",
          color: layoutDraft.background,
          opacity: 1,
        });
      const textBase = {
        page: source,
        kind: "text" as const,
        size: 10,
        color: "#444444",
        fontFamily: "Arial",
        fontName: "Arial",
        bold: false,
        italic: false,
        underline: false,
        alignment: "center" as const,
        lineHeight: 1,
        letterSpacing: 0,
        fitMode: "shrink" as const,
      };
      if (layoutDraft.header)
        additions.push({
          id: crypto.randomUUID(),
          ...textBase,
          x: 0.06,
          y: 0.018,
          width: 0.88,
          height: 0.035,
          text: layoutDraft.header
            .replaceAll("{page}", String(index + 1))
            .replaceAll("{pages}", String(doc.pageOrder.length)),
          layoutRole: "header",
        });
      if (layoutDraft.footer)
        additions.push({
          id: crypto.randomUUID(),
          ...textBase,
          x: 0.06,
          y: 0.95,
          width: 0.88,
          height: 0.035,
          text: layoutDraft.footer
            .replaceAll("{page}", String(index + 1))
            .replaceAll("{pages}", String(doc.pageOrder.length)),
          layoutRole: "footer",
        });
      if (layoutDraft.watermark)
        additions.push({
          id: crypto.randomUUID(),
          ...textBase,
          x: 0.15,
          y: 0.45,
          width: 0.7,
          height: 0.1,
          text: layoutDraft.watermark,
          size: 42,
          color: "#777777",
          opacity: 0.2,
          rotation: -35,
          layoutRole: "watermark",
        });
      if (layoutDraft.batesPrefix)
        additions.push({
          id: crypto.randomUUID(),
          ...textBase,
          x: 0.72,
          y: 0.95,
          width: 0.22,
          height: 0.035,
          text: `${layoutDraft.batesPrefix}${String(layoutDraft.batesStart + index).padStart(layoutDraft.batesDigits, "0")}`,
          alignment: "right",
          layoutRole: "bates",
        });
    });
    execute({
      type: "setOverlayOrder",
      before: doc.overlays,
      after: [...existing, ...additions],
    });
    setShowLayout(false);
    setNotice(`Applied document layout to ${doc.pageOrder.length} pages.`);
  };

  const estimateCompression = async () => {
    setEstimatingCompression(true);
    setError("");
    try {
      const result = await engine.current!.api.exportDocument({
        ...exportRequest,
        compression: compressionProfile,
      });
      setCompressionEstimate(result.bytes.byteLength);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Compression estimate failed.",
      );
    } finally {
      setEstimatingCompression(false);
    }
  };

  const buildReplacementOverlays = (
    line: PositionedTextLine,
    draft: string,
    source: number,
  ) => {
    if (!open) return [] as Overlay[];
    const padding = 0.002;
    const erase: Overlay = {
      id: crypto.randomUUID(),
      page: source,
      kind: "redact",
      x: line.x,
      y: Math.max(0, line.y - padding),
      width: line.width,
      height: Math.min(
        1 - Math.max(0, line.y - padding),
        line.height + padding * 2,
      ),
      color: "#ffffff",
    };
    const replacements: Overlay[] = [erase];
    if (draft.length > 0) {
      const box = layoutTextBox(line, draft, open.pages[source]!);
      replacements.push({
        id: crypto.randomUUID(),
        page: source,
        kind: "text",
        x: line.x,
        y: line.y,
        width: box.width,
        height: box.height,
        text: draft,
        size: line.size,
        color: line.color,
        fontFamily: line.fontFamily,
        fontName: line.fontName || null,
        bold: line.bold,
        italic: line.italic,
        underline: false,
        alignment: line.alignment,
        lineHeight: line.lineHeight,
        letterSpacing: line.letterSpacing,
        fitMode: line.fitMode,
      });
    }
    return replacements;
  };
  const buildMixedLineOverlays = (line: PositionedTextLine, draft: string) => {
    if (!open) return null;
    const runs = textLines
      .filter((candidate) => Math.abs(candidate.y - line.y) < 0.003)
      .sort((a, b) => a.x - b.x);
    if (runs.length < 2) return null;
    const startX = Math.min(...runs.map((run) => run.x));
    const startY = Math.min(...runs.map((run) => run.y));
    const right = Math.max(...runs.map((run) => run.x + run.width));
    const bottom = Math.max(...runs.map((run) => run.y + run.height));
    const overlays: Overlay[] = [
      {
        id: crypto.randomUUID(),
        page: sourcePage,
        kind: "redact",
        x: startX,
        y: Math.max(0, startY - 0.002),
        width: right - startX,
        height: bottom - startY + 0.004,
        color: "#ffffff",
      },
    ];
    let cursorX = startX;
    let cursorY = startY;
    let selectedOverlayId: string | null = null;
    for (const run of runs) {
      const text = run.id === line.id ? draft : run.text;
      if (!text) continue;
      const base = {
        ...run,
        x: cursorX,
        width: run.id === line.id ? 0.03 : run.width,
        fitMode: "auto" as const,
      };
      let box = layoutTextBox(base, text, open.pages[sourcePage]!);
      if (cursorX > startX && cursorX + box.width > 0.98) {
        cursorX = startX;
        cursorY += Math.max(...runs.map((item) => item.height)) * 1.15;
        box = layoutTextBox(
          { ...base, x: cursorX },
          text,
          open.pages[sourcePage]!,
        );
      }
      const id = crypto.randomUUID();
      overlays.push({
        id,
        page: sourcePage,
        kind: "text",
        x: cursorX,
        y: cursorY,
        width: box.width,
        height: box.height,
        text,
        size: run.size,
        color: run.color,
        fontFamily: run.fontFamily,
        fontName: run.fontName || null,
        bold: run.bold,
        italic: run.italic,
        underline: false,
        alignment: "left",
        lineHeight: run.lineHeight,
        letterSpacing: run.letterSpacing,
        fitMode: "auto",
      });
      if (run.id === line.id) selectedOverlayId = id;
      if (box.height > run.height * 1.5) {
        cursorX = startX;
        cursorY += box.height;
      } else cursorX += box.width;
    }
    return { overlays, selectedOverlayId };
  };
  const commitOriginalTextEdit = (
    edit: { line: PositionedTextLine; draft: string },
    selectReplacement: boolean,
  ) => {
    const mixed = buildMixedLineOverlays(edit.line, edit.draft);
    const replacements =
      mixed?.overlays ??
      buildReplacementOverlays(edit.line, edit.draft, sourcePage);
    if (!replacements.length) return;
    execute({ type: "addMany", overlays: replacements });
    setOriginalEdit(null);
    const replacementId =
      mixed?.selectedOverlayId ??
      (replacements.at(-1)?.kind === "text" ? replacements.at(-1)!.id : null);
    setSelectedId(selectReplacement ? replacementId : null);
  };
  const applyOriginalTextEdit = () => {
    if (originalEdit) commitOriginalTextEdit(originalEdit, true);
  };
  const runFind = async () => {
    if (!findQuery.trim() || !open) {
      setFindResults([]);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const needle = matchCase ? findQuery : findQuery.toLocaleLowerCase();
      const results: FindResult[] = [];
      for (const source of doc.pageOrder) {
        const lines = await withTimeout(
          engine.current!.api.extractTextLines(source),
          20_000,
          `Text search timed out on page ${source + 1}.`,
        );
        for (const line of lines) {
          const haystack = matchCase
            ? line.text
            : line.text.toLocaleLowerCase();
          if (haystack.includes(needle))
            results.push({ sourcePage: source, line });
        }
      }
      for (const overlay of doc.overlays) {
        if (overlay.kind !== "text" || !overlay.ocrSource) continue;
        const haystack = matchCase
          ? overlay.text
          : overlay.text.toLocaleLowerCase();
        if (!haystack.includes(needle)) continue;
        results.push({
          sourcePage: overlay.page,
          overlayId: overlay.id,
          line: {
            id: overlay.id,
            text: overlay.text,
            x: overlay.x,
            y: overlay.y,
            width: overlay.width,
            height: overlay.height,
            size: overlay.size,
            color: overlay.color,
            fontFamily: overlay.fontFamily,
            fontName: overlay.fontName ?? overlay.fontFamily,
            bold: overlay.bold,
            italic: overlay.italic,
            alignment: overlay.alignment,
            lineHeight: overlay.lineHeight,
            letterSpacing: overlay.letterSpacing,
            fitMode: overlay.fitMode,
          },
        });
      }
      setFindResults(results);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Document search failed.",
      );
    } finally {
      setSearching(false);
    }
  };
  const replaceAllMatches = () => {
    if (!findResults.length || !findQuery) return;
    const escaped = findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(escaped, matchCase ? "g" : "gi");
    const overlays: Overlay[] = [];
    for (const result of findResults) {
      const replacement = result.line.text.replace(expression, replaceQuery);
      if (replacement === result.line.text) continue;
      if (result.overlayId) {
        const original = doc.overlays.find(
          (overlay) => overlay.id === result.overlayId,
        );
        if (original?.kind === "text")
          execute({
            type: "updateOverlay",
            before: original,
            after: { ...original, text: replacement },
          });
      } else
        overlays.push(
          ...buildReplacementOverlays(
            result.line,
            replacement,
            result.sourcePage,
          ),
        );
    }
    if (overlays.length) execute({ type: "addMany", overlays });
    setNotice(
      `Replaced ${findResults.length} text ${findResults.length === 1 ? "run" : "runs"} across the document.`,
    );
    setFindResults([]);
    setShowFind(false);
  };

  const runOcr = async () => {
    if (!open || ocrRunning) return;
    const pages = ocrScope === "document" ? [...doc.pageOrder] : [sourcePage];
    setOcrRunning(true);
    setError("");
    setOcrProgress("Loading the on-device OCR engine…");
    let recognizer: Awaited<ReturnType<typeof createOcrRecognizer>> | null =
      null;
    try {
      recognizer = await createOcrRecognizer(
        { language: ocrLanguage, enhancement: scanEnhancement, autoDeskew },
        (message) =>
          setOcrProgress(
            `${message.status} · ${Math.round(message.progress * 100)}%`,
          ),
      );
      const created: Extract<Overlay, { kind: "text" }>[] = [];
      for (let index = 0; index < pages.length; index += 1) {
        const source = pages[index]!;
        setOcrProgress(`Recognising page ${index + 1} of ${pages.length}…`);
        const png = await withTimeout(
          engine.current!.api.renderPage(source, 2.5),
          45_000,
          `Page ${source + 1} could not be prepared for OCR.`,
        );
        const bytes = new Uint8Array(png.byteLength);
        bytes.set(png);
        const url = URL.createObjectURL(
          new Blob([bytes.buffer], { type: "image/png" }),
        );
        try {
          const lines = await recognizer.recognize(url);
          const pageHeight = open.pages[source]!.height;
          for (const line of lines) {
            created.push({
              id: crypto.randomUUID(),
              page: source,
              kind: "text",
              x: line.x,
              y: line.y,
              width: line.width,
              height: line.height,
              text: line.text,
              size: Math.max(6, line.height * pageHeight * 0.78),
              color: "#000000",
              fontFamily: "Arial",
              fontName: "Arial",
              bold: false,
              italic: false,
              underline: false,
              alignment: "left",
              lineHeight: 1,
              letterSpacing: 0,
              fitMode: "shrink",
              invisible: true,
              ocrConfidence: line.confidence,
              ocrSource: true,
            });
          }
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const old = doc.overlays.filter(
        (overlay) =>
          overlay.kind === "text" &&
          overlay.ocrSource &&
          pages.includes(overlay.page),
      );
      if (old.length) execute({ type: "removeMany", overlays: old });
      if (created.length) execute({ type: "addMany", overlays: created });
      const low = created.filter(
        (overlay) => (overlay.ocrConfidence ?? 100) < confidenceThreshold,
      ).length;
      setNotice(
        `OCR added ${created.length} searchable text lines across ${pages.length} ${pages.length === 1 ? "page" : "pages"}. ${low} need confidence review.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "OCR failed on this document.",
      );
    } finally {
      await recognizer?.terminate().catch(() => undefined);
      setOcrRunning(false);
      setOcrProgress("");
    }
  };

  const mergePdf = async (file: File) => {
    if (!open) return;
    setBusy(true);
    setError("");
    try {
      const result = await engine.current!.api.mergeDocument(
        await file.arrayBuffer(),
        exportRequest,
      );
      const copy = new Uint8Array(result.bytes.byteLength);
      copy.set(result.bytes);
      await openBytes({
        id: crypto.randomUUID(),
        name: `${open.name.replace(/\.pdf$/i, "")}-merged.pdf`,
        bytes: copy.buffer,
      });
      setNotice(`Merged document created with ${result.pageCount} pages.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PDF merge failed.");
    } finally {
      setBusy(false);
    }
  };

  const splitCurrentPage = async () => {
    if (!open) return;
    setExporting(true);
    setError("");
    try {
      const result = await engine.current!.api.exportDocument({
        ...exportRequest,
        pageOrder: [sourcePage],
      });
      const message = await downloadBytes(
        result.bytes,
        `${open.name.replace(/\.pdf$/i, "")}-page-${page + 1}.pdf`,
      );
      setNotice(`Current page exported and verified. ${message}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Page split failed.");
    } finally {
      setExporting(false);
    }
  };

  const saveMetadata = () => {
    execute({
      type: "setMetadata",
      before: doc.metadata,
      after: metadataDraft,
    });
    setShowProperties(false);
  };
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void load(file);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void load(file);
  };
  const touchDistance = (event: ReactTouchEvent) =>
    Math.hypot(
      event.touches[0]!.clientX - event.touches[1]!.clientX,
      event.touches[0]!.clientY - event.touches[1]!.clientY,
    );
  const beginPinch = (event: ReactTouchEvent) => {
    if (event.touches.length !== 2 || !stageRef.current) return;
    event.preventDefault();
    const stage = stageRef.current;
    const rect = stage.getBoundingClientRect();
    const centerX = (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2;
    const centerY = (event.touches[0]!.clientY + event.touches[1]!.clientY) / 2;
    const offsetX = centerX - rect.left;
    const offsetY = centerY - rect.top;
    pinch.current = {
      distance: touchDistance(event),
      zoom,
      contentX: stage.scrollLeft + offsetX,
      contentY: stage.scrollTop + offsetY,
      offsetX,
      offsetY,
    };
  };
  const movePinch = (event: ReactTouchEvent) => {
    if (event.touches.length !== 2 || !pinch.current || !stageRef.current)
      return;
    event.preventDefault();
    const state = pinch.current;
    const next = Math.min(
      3,
      Math.max(0.35, (state.zoom * touchDistance(event)) / state.distance),
    );
    const ratio = next / state.zoom;
    setZoom(next);
    requestAnimationFrame(() => {
      if (!stageRef.current) return;
      stageRef.current.scrollLeft = state.contentX * ratio - state.offsetX;
      stageRef.current.scrollTop = state.contentY * ratio - state.offsetY;
    });
  };
  const endPinch = (event: ReactTouchEvent) => {
    if (event.touches.length < 2) pinch.current = null;
  };

  if (!open)
    return (
      <main
        className="home"
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
      >
        <header className="brand">
          <span className="mark">P</span>
          <b>Paperless</b>
          <span className="local">Local only</span>
        </header>
        <section className="hero">
          <p className="eyebrow">PRIVATE BY DEFAULT</p>
          <h1>
            Edit the PDF.
            <br />
            <em>Keep the document.</em>
          </h1>
          <p>
            Open, review, and mark up PDFs without an account, an upload, or a
            paywall.
          </p>
          <label className="openButton">
            <FilePlus2 />
            Open a PDF
            <input
              aria-label="Open PDF"
              type="file"
              accept="application/pdf,.pdf"
              onChange={pick}
            />
          </label>
          <p className="dropcopy">or drop a PDF anywhere</p>
          {recent.length > 0 && (
            <div className="recents">
              <h2>Recent local projects</h2>
              {recent.map((project) => (
                <div className="recent" key={project.id}>
                  <button onClick={() => void recover(project.id)}>
                    <b>{project.name}</b>
                    <span>
                      {project.pageCount} pages ·{" "}
                      {new Date(project.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  <button
                    aria-label={`Remove ${project.name}`}
                    onClick={() =>
                      void deleteProject(project.id).then(refreshRecent)
                    }
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          )}
          {busy && <p role="status">Opening securely on this device…</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
        <footer>AGPL-3.0 · No uploads · No analytics</footer>
      </main>
    );

  const current = doc.overlays.filter((item) => item.page === sourcePage);
  const createdFormFields = doc.overlays.filter(
    (item): item is Extract<Overlay, { kind: "formField" }> =>
      item.kind === "formField",
  );
  const ocrText = doc.overlays.filter(
    (overlay): overlay is Extract<Overlay, { kind: "text" }> =>
      overlay.kind === "text" && Boolean(overlay.ocrSource),
  );
  const lowConfidenceOcr = ocrText.filter(
    (overlay) => (overlay.ocrConfidence ?? 100) < confidenceThreshold,
  );
  const reviewOverlays = doc.overlays.filter(isReviewOverlay);
  const filteredReviews = reviewOverlays.filter(
    (overlay) =>
      commentFilter === "all" ||
      (commentFilter === "resolved" ? overlay.resolved : !overlay.resolved),
  );
  const selected = current.find((item) => item.id === selectedId) ?? null;
  const fontOptions = Array.from(
    new Set(
      [
        ...textLines.map((line) => line.fontName),
        ...current
          .filter(
            (item): item is Extract<Overlay, { kind: "text" }> =>
              item.kind === "text",
          )
          .map((item) => item.fontName || item.fontFamily),
        ...commonFonts,
      ].filter(Boolean),
    ),
  );
  const pageInfo = open.pages[sourcePage]!;
  const edited =
    doc.overlays.length > 0 ||
    Object.keys(doc.rotations).length > 0 ||
    Object.keys(doc.crops).length > 0 ||
    JSON.stringify(doc.metadata) !== JSON.stringify(open.initialMetadata) ||
    JSON.stringify(doc.formValues) !== JSON.stringify(open.initialFormValues) ||
    doc.pageOrder.some((item, index) => item !== index) ||
    doc.pageOrder.length !== open.pages.length ||
    security.userPassword !== "" ||
    security.ownerPassword !== "" ||
    security.sanitizeMetadata ||
    security.flattenForms ||
    certificate !== null;

  return (
    <div className="app">
      <header className="top">
        <div className="file">
          <span className="mark">P</span>
          <div>
            <b>{open.name}</b>
            <small>
              {doc.pageOrder.length} pages ·{" "}
              {saving ? "saving…" : "saved locally"}
            </small>
          </div>
          <button aria-label="Close document" onClick={closeDocument}>
            <X />
          </button>
        </div>
        <div className="history">
          <button aria-label="Undo" disabled={!undo.length} onClick={undoOnce}>
            <Undo2 />
          </button>
          <button aria-label="Redo" disabled={!redo.length} onClick={redoOnce}>
            <Redo2 />
          </button>
        </div>
        <button
          className="export"
          disabled={exporting}
          title={
            edited ? "Export a validated edited PDF" : "Download original PDF"
          }
          onClick={() => void download()}
        >
          <Download />{" "}
          {exporting ? "Exporting…" : edited ? "Export PDF" : "Download"}
        </button>
      </header>
      <div className={`work ${showComments ? "withComments" : ""}`}>
        <aside className="rail">
          <div className="railTitle">
            <b>Pages</b>
            <span>{doc.pageOrder.length}</span>
          </div>
          {doc.pageOrder.map((source, index) => (
            <div
              key={source}
              role="button"
              tabIndex={0}
              className={index === page ? "thumb active" : "thumb"}
              onClick={() => setPage(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setPage(index);
              }}
            >
              <span>{index + 1}</span>
              <div className="thumbPreview">Page {source + 1}</div>
              <span className="pageActions">
                <button
                  aria-label={`Move page ${index + 1} up`}
                  disabled={index === 0}
                  onClick={(event) => {
                    event.stopPropagation();
                    movePage(index, -1);
                  }}
                >
                  <ArrowUp />
                </button>
                <button
                  aria-label={`Move page ${index + 1} down`}
                  disabled={index === doc.pageOrder.length - 1}
                  onClick={(event) => {
                    event.stopPropagation();
                    movePage(index, 1);
                  }}
                >
                  <ArrowDown />
                </button>
                <button
                  aria-label={`Delete page ${index + 1}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removePage(index);
                  }}
                >
                  <Trash2 />
                </button>
              </span>
            </div>
          ))}
        </aside>
        <main className="canvasArea">
          <div className="toolRegion">
            <nav className="tools" aria-label="Editing tools">
              {tools.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  className={tool === id ? "chosen" : ""}
                  aria-pressed={tool === id}
                  onClick={() => {
                    setTool(id);
                    if (id !== "select") {
                      setSelectedId(null);
                      setOriginalEdit(null);
                    } else
                      setNotice(
                        textLines.length
                          ? "Tap existing PDF text to edit it, or tap an added object to move or resize it."
                          : ocrText.some((item) => item.page === sourcePage)
                            ? "This scanned page has a searchable OCR layer. Open OCR to review recognised text."
                            : "No selectable text was found. Run OCR to make this scanned page searchable.",
                      );
                  }}
                >
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
              <span className="divide" />
              <button onClick={() => imageInput.current?.click()}>
                <FilePlus2 />
                <span>Add image</span>
              </button>
              <input
                ref={imageInput}
                hidden
                type="file"
                accept="image/png,image/jpeg"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void addImage(file);
                  event.target.value = "";
                }}
              />
              <button onClick={() => void openNativeImages()}>
                <FileImage />
                <span>Page images</span>
              </button>
              <button
                onClick={() =>
                  execute({
                    type: "rotate",
                    page: sourcePage,
                    before: doc.rotations[sourcePage] ?? 0,
                    after: (doc.rotations[sourcePage] ?? 0) + 90,
                  })
                }
              >
                <RotateCw />
                <span>Rotate</span>
              </button>
              <button
                onClick={() => {
                  setShowOcr(true);
                  setOcrProgress("");
                }}
              >
                <ScanText />
                <span>OCR</span>
              </button>
              <button
                onClick={() => {
                  setSelectedPages([]);
                  setShowPages(true);
                }}
              >
                <Layers />
                <span>Pages</span>
              </button>
              <button onClick={() => setShowLayout(true)}>
                <LayoutTemplate />
                <span>Layout</span>
              </button>
              <button
                onClick={() => {
                  setCompressionEstimate(null);
                  setShowCompression(true);
                }}
              >
                <ImageDown />
                <span>Compress</span>
              </button>
              <button onClick={() => attachmentInput.current?.click()}>
                <Paperclip />
                <span>Attach</span>
              </button>
              <input
                ref={attachmentInput}
                hidden
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void chooseAttachment(file);
                  event.target.value = "";
                }}
              />
              <button
                className={showComments ? "chosen" : ""}
                onClick={() => setShowComments((value) => !value)}
              >
                <MessageSquareText />
                <span>Reviews</span>
              </button>
              <button onClick={() => mergeInput.current?.click()}>
                <Merge />
                <span>Merge</span>
              </button>
              <input
                ref={mergeInput}
                hidden
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void mergePdf(file);
                  event.target.value = "";
                }}
              />
              <button onClick={() => void splitCurrentPage()}>
                <Scissors />
                <span>Split</span>
              </button>
              <button
                onClick={() => {
                  setMetadataDraft(doc.metadata);
                  setShowProperties(true);
                }}
              >
                <Info />
                <span>Properties</span>
              </button>
              <button
                title="Create and edit interactive PDF fields"
                onClick={() => setShowForms(true)}
              >
                <ListChecks />
                <span>Forms</span>
              </button>
              <button onClick={() => setShowSecurity(true)}>
                <ShieldCheck />
                <span>Security</span>
              </button>
              <button
                onClick={() => {
                  setFindResults([]);
                  setShowFind(true);
                }}
              >
                <Search />
                <span>Find</span>
              </button>
            </nav>
            {([
              "shape",
              "ink",
              "signature",
              "markup",
              "note",
              "stamp",
              "measure",
              "attachment",
              "form",
            ].includes(tool) ||
              selected ||
              originalEdit) && (
              <div className="contextBar">
                {tool === "shape" && (
                  <label>
                    Shape
                    <select
                      value={shapeKind}
                      onChange={(event) =>
                        setShapeKind(event.target.value as ShapeKind)
                      }
                    >
                      <option value="rectangle">Rectangle</option>
                      <option value="square">Square</option>
                      <option value="circle">Circle</option>
                      <option value="triangle">Triangle</option>
                    </select>
                  </label>
                )}
                {tool === "markup" && (
                  <label>
                    Markup
                    <select
                      value={markupKind}
                      onChange={(event) =>
                        setMarkupKind(event.target.value as MarkupKind)
                      }
                    >
                      <option value="highlight">Highlight</option>
                      <option value="underline">Underline</option>
                      <option value="strikeout">Strikeout</option>
                      <option value="squiggly">Squiggly</option>
                    </select>
                  </label>
                )}
                {tool === "note" && (
                  <label>
                    Comment
                    <select
                      value={noteType}
                      onChange={(event) =>
                        setNoteType(event.target.value as "sticky" | "callout")
                      }
                    >
                      <option value="sticky">Sticky note</option>
                      <option value="callout">Callout</option>
                    </select>
                  </label>
                )}
                {tool === "stamp" && (
                  <label>
                    Stamp
                    <select
                      value={stampLabel}
                      onChange={(event) => setStampLabel(event.target.value)}
                    >
                      <option>Approved</option>
                      <option>Draft</option>
                      <option>Final</option>
                      <option>Rejected</option>
                      <option>Confidential</option>
                    </select>
                  </label>
                )}
                {tool === "measure" && (
                  <>
                    <label>
                      Measure
                      <select
                        value={measureKind}
                        onChange={(event) =>
                          setMeasureKind(
                            event.target.value as typeof measureKind,
                          )
                        }
                      >
                        <option value="distance">Distance</option>
                        <option value="perimeter">Perimeter</option>
                        <option value="area">Area</option>
                      </select>
                    </label>
                    <label>
                      Unit
                      <select
                        value={measureUnit}
                        onChange={(event) =>
                          setMeasureUnit(
                            event.target.value as typeof measureUnit,
                          )
                        }
                      >
                        <option value="pt">pt</option>
                        <option value="in">in</option>
                        <option value="cm">cm</option>
                        <option value="mm">mm</option>
                      </select>
                    </label>
                    <label>
                      Preset
                      <select
                        value={
                          [1, 10, 20, 50, 100].includes(measureScale)
                            ? String(measureScale)
                            : "custom"
                        }
                        onChange={(event) => {
                          if (event.target.value !== "custom")
                            setMeasureScale(Number(event.target.value));
                        }}
                      >
                        <option value="1">1:1</option>
                        <option value="10">1:10</option>
                        <option value="20">1:20</option>
                        <option value="50">1:50</option>
                        <option value="100">1:100</option>
                        <option value="custom">Custom</option>
                      </select>
                    </label>
                    <label>
                      Scale
                      <CompactNumberInput
                        label="Measurement scale"
                        value={measureScale}
                        min={0.01}
                        max={1000}
                        onCommit={setMeasureScale}
                      />
                    </label>
                  </>
                )}
                {tool === "signature" && (
                  <>
                    <label>
                      Signature
                      <select
                        value={signatureMode}
                        onChange={(event) =>
                          setSignatureMode(
                            event.target.value as typeof signatureMode,
                          )
                        }
                      >
                        <option value="draw">Draw</option>
                        <option value="typed">Typed</option>
                        <option value="image">Image</option>
                        <option value="digital">Certificate-backed</option>
                      </select>
                    </label>
                    {signatureMode !== "draw" && (
                      <label>
                        Signer
                        <input
                          value={signatureName}
                          onChange={(event) =>
                            setSignatureName(event.target.value)
                          }
                          placeholder="Full name"
                        />
                      </label>
                    )}
                    {signatureMode === "image" && (
                      <>
                        <button
                          onClick={() => signatureImageInput.current?.click()}
                        >
                          Choose signature image
                        </button>
                        <input
                          ref={signatureImageInput}
                          hidden
                          type="file"
                          accept="image/png,image/jpeg"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = () =>
                                setSignatureImage(String(reader.result));
                              reader.readAsDataURL(file);
                            }
                            event.target.value = "";
                          }}
                        />
                      </>
                    )}
                    {signatureMode === "digital" && (
                      <button onClick={() => setShowSecurity(true)}>
                        {certificate ? certificate.name : "Choose certificate"}
                      </button>
                    )}
                  </>
                )}
                {tool === "form" && (
                  <>
                    <label>
                      Field
                      <select
                        value={formType}
                        onChange={(event) =>
                          setFormType(event.target.value as typeof formType)
                        }
                      >
                        <option value="text">Text</option>
                        <option value="choice">Choice</option>
                        <option value="checkbox">Checkbox</option>
                        <option value="radio">Radio</option>
                        <option value="signature">Signature</option>
                      </select>
                    </label>
                    <label>
                      Name
                      <input
                        value={formName}
                        onChange={(event) => setFormName(event.target.value)}
                      />
                    </label>
                    <label>
                      Validate
                      <select
                        value={formValidation}
                        onChange={(event) =>
                          setFormValidation(
                            event.target.value as typeof formValidation,
                          )
                        }
                      >
                        <option value="none">None</option>
                        <option value="email">Email</option>
                        <option value="number">Number</option>
                        <option value="regex">Pattern</option>
                      </select>
                    </label>
                    {formValidation === "regex" && (
                      <label>
                        Pattern
                        <input
                          value={formPattern}
                          onChange={(event) =>
                            setFormPattern(event.target.value)
                          }
                        />
                      </label>
                    )}
                  </>
                )}
                {tool === "attachment" && (
                  <span className="editingLabel">
                    {pendingAttachment
                      ? `Tap to place ${pendingAttachment.name}`
                      : "Choose Attach first"}
                  </span>
                )}
                {[
                  "shape",
                  "ink",
                  "signature",
                  "markup",
                  "note",
                  "stamp",
                  "measure",
                ].includes(tool) && (
                  <label>
                    Colour
                    <input
                      aria-label="Drawing colour"
                      type="color"
                      value={drawColor}
                      onChange={(event) => setDrawColor(event.target.value)}
                    />
                  </label>
                )}
                {originalEdit && (
                  <>
                    <span className="editingLabel">Original text</span>
                    <label>
                      Font
                      <select
                        value={
                          originalEdit.line.fontName ||
                          originalEdit.line.fontFamily
                        }
                        onChange={(event) =>
                          setOriginalEdit({
                            ...originalEdit,
                            line: {
                              ...originalEdit.line,
                              fontName: event.target.value,
                              fontFamily: event.target.value,
                            },
                          })
                        }
                      >
                        {fontOptions.map((font) => (
                          <option key={font}>{font}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Size
                      <FontSizeInput
                        value={originalEdit.line.size}
                        onCommit={(size) =>
                          setOriginalEdit({
                            ...originalEdit,
                            line: { ...originalEdit.line, size },
                          })
                        }
                      />
                    </label>
                    <button
                      aria-label="Bold"
                      className={originalEdit.line.bold ? "active" : ""}
                      onClick={() =>
                        setOriginalEdit({
                          ...originalEdit,
                          line: {
                            ...originalEdit.line,
                            bold: !originalEdit.line.bold,
                            fontName: "",
                          },
                        })
                      }
                    >
                      <Bold />
                    </button>
                    <button
                      aria-label="Italic"
                      className={originalEdit.line.italic ? "active" : ""}
                      onClick={() =>
                        setOriginalEdit({
                          ...originalEdit,
                          line: {
                            ...originalEdit.line,
                            italic: !originalEdit.line.italic,
                            fontName: "",
                          },
                        })
                      }
                    >
                      <Italic />
                    </button>
                    <label>
                      Align
                      <select
                        value={originalEdit.line.alignment}
                        onChange={(event) =>
                          setOriginalEdit({
                            ...originalEdit,
                            line: {
                              ...originalEdit.line,
                              alignment: event.target
                                .value as PositionedTextLine["alignment"],
                            },
                          })
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                        <option value="justify">Justify</option>
                      </select>
                    </label>
                    <label>
                      Line
                      <CompactNumberInput
                        label="Line spacing"
                        value={originalEdit.line.lineHeight}
                        min={0.8}
                        max={3}
                        onCommit={(lineHeight) =>
                          setOriginalEdit({
                            ...originalEdit,
                            line: { ...originalEdit.line, lineHeight },
                          })
                        }
                      />
                    </label>
                    <label>
                      Letter
                      <CompactNumberInput
                        label="Character spacing"
                        value={originalEdit.line.letterSpacing}
                        min={-5}
                        max={20}
                        onCommit={(letterSpacing) =>
                          setOriginalEdit({
                            ...originalEdit,
                            line: { ...originalEdit.line, letterSpacing },
                          })
                        }
                      />
                    </label>
                    <label>
                      Fit
                      <select
                        value={originalEdit.line.fitMode}
                        onChange={(event) =>
                          setOriginalEdit({
                            ...originalEdit,
                            line: {
                              ...originalEdit.line,
                              fitMode: event.target
                                .value as PositionedTextLine["fitMode"],
                            },
                          })
                        }
                      >
                        <option value="auto">Reflow</option>
                        <option value="shrink">Shrink</option>
                        <option value="overflow">Overflow</option>
                      </select>
                    </label>
                    <label>
                      Colour
                      <input
                        type="color"
                        value={originalEdit.line.color}
                        onChange={(event) =>
                          setOriginalEdit({
                            ...originalEdit,
                            line: {
                              ...originalEdit.line,
                              color: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <button
                      className="primaryAction"
                      onClick={applyOriginalTextEdit}
                    >
                      Apply
                    </button>
                    <button
                      onClick={() =>
                        setOriginalEdit({ ...originalEdit, draft: "" })
                      }
                    >
                      Delete text
                    </button>
                    <button onClick={() => setOriginalEdit(null)}>
                      Cancel
                    </button>
                  </>
                )}
                {selected?.kind === "text" && (
                  <>
                    <label>
                      Text
                      <input
                        className="textInput"
                        value={selected.text}
                        onChange={(event) => {
                          const box = layoutTextBox(
                            selected,
                            event.target.value,
                            pageInfo,
                          );
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              text: event.target.value,
                              ...box,
                            },
                          });
                        }}
                      />
                    </label>
                    <label>
                      Font
                      <select
                        value={selected.fontName || selected.fontFamily}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              fontName: event.target.value,
                              fontFamily: event.target.value,
                            },
                          })
                        }
                      >
                        {fontOptions.map((font) => (
                          <option key={font}>{font}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Size
                      <FontSizeInput
                        value={selected.size}
                        onCommit={(size) => {
                          const next = { ...selected, size };
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...next,
                              ...layoutTextBox(next, next.text, pageInfo),
                            },
                          });
                        }}
                      />
                    </label>
                    <button
                      aria-label="Bold"
                      className={selected.bold ? "active" : ""}
                      onClick={() => {
                        const next = {
                          ...selected,
                          bold: !selected.bold,
                          fontName: null,
                        };
                        execute({
                          type: "updateOverlay",
                          before: selected,
                          after: {
                            ...next,
                            ...layoutTextBox(next, next.text, pageInfo),
                          },
                        });
                      }}
                    >
                      <Bold />
                    </button>
                    <button
                      aria-label="Italic"
                      className={selected.italic ? "active" : ""}
                      onClick={() =>
                        execute({
                          type: "updateOverlay",
                          before: selected,
                          after: {
                            ...selected,
                            italic: !selected.italic,
                            fontName: null,
                          },
                        })
                      }
                    >
                      <Italic />
                    </button>
                    <button
                      aria-label="Underline"
                      className={selected.underline ? "active" : ""}
                      onClick={() =>
                        execute({
                          type: "updateOverlay",
                          before: selected,
                          after: {
                            ...selected,
                            underline: !selected.underline,
                          },
                        })
                      }
                    >
                      <Underline />
                    </button>
                    <label>
                      Align
                      <select
                        value={selected.alignment}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              alignment: event.target
                                .value as typeof selected.alignment,
                            },
                          })
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                        <option value="justify">Justify</option>
                      </select>
                    </label>
                    <label>
                      Line
                      <CompactNumberInput
                        label="Line spacing"
                        value={selected.lineHeight}
                        min={0.8}
                        max={3}
                        onCommit={(lineHeight) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: { ...selected, lineHeight },
                          })
                        }
                      />
                    </label>
                    <label>
                      Letter
                      <CompactNumberInput
                        label="Character spacing"
                        value={selected.letterSpacing}
                        min={-5}
                        max={20}
                        onCommit={(letterSpacing) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: { ...selected, letterSpacing },
                          })
                        }
                      />
                    </label>
                    <label>
                      Fit
                      <select
                        value={selected.fitMode}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              fitMode: event.target
                                .value as typeof selected.fitMode,
                            },
                          })
                        }
                      >
                        <option value="auto">Reflow</option>
                        <option value="shrink">Shrink</option>
                        <option value="overflow">Overflow</option>
                      </select>
                    </label>
                    <label>
                      Colour
                      <input
                        type="color"
                        value={selected.color}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: { ...selected, color: event.target.value },
                          })
                        }
                      />
                    </label>
                  </>
                )}
                {selected?.kind === "image" && (
                  <>
                    <label>
                      Opacity
                      <CompactNumberInput
                        label="Image opacity"
                        value={selected.opacity}
                        min={0.05}
                        max={1}
                        onCommit={(opacity) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: { ...selected, opacity },
                          })
                        }
                      />
                    </label>
                    <label>
                      Rotate
                      <CompactNumberInput
                        label="Image rotation"
                        value={selected.rotation}
                        min={-360}
                        max={360}
                        onCommit={(rotation) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: { ...selected, rotation },
                          })
                        }
                      />
                    </label>
                    <button onClick={() => replaceImageInput.current?.click()}>
                      Replace
                    </button>
                    <input
                      ref={replaceImageInput}
                      hidden
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void replaceSelectedImage(file);
                        event.target.value = "";
                      }}
                    />
                    <button onClick={extractSelectedImage}>
                      <ImageDown /> Extract
                    </button>
                    <button
                      onClick={() => {
                        setImageCrop({ left: 0, top: 0, right: 0, bottom: 0 });
                        setShowImageCrop(true);
                      }}
                    >
                      <Crop /> Crop
                    </button>
                  </>
                )}
                {selected && "x" in selected && "width" in selected && (
                  <>
                    <button onClick={() => arrangeSelected("back")}>
                      Send back
                    </button>
                    <button onClick={() => arrangeSelected("front")}>
                      Bring front
                    </button>
                    <label>
                      Align
                      <select
                        defaultValue=""
                        onChange={(event) => {
                          if (event.target.value)
                            alignSelected(
                              event.target.value as
                                | "left"
                                | "center"
                                | "right"
                                | "top"
                                | "middle"
                                | "bottom",
                            );
                          event.currentTarget.value = "";
                        }}
                      >
                        <option value="" disabled>
                          Choose
                        </option>
                        <option value="left">Left</option>
                        <option value="center">Centre</option>
                        <option value="right">Right</option>
                        <option value="top">Top</option>
                        <option value="middle">Middle</option>
                        <option value="bottom">Bottom</option>
                      </select>
                    </label>
                  </>
                )}
                {selected?.kind === "formField" && (
                  <>
                    <label>
                      Value
                      <input
                        value={selected.value}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: { ...selected, value: event.target.value },
                          })
                        }
                      />
                    </label>
                    {selected.fieldType === "choice" && (
                      <label>
                        Options
                        <input
                          value={selected.options.join(", ")}
                          onChange={(event) =>
                            execute({
                              type: "updateOverlay",
                              before: selected,
                              after: {
                                ...selected,
                                options: event.target.value
                                  .split(",")
                                  .map((item) => item.trim())
                                  .filter(Boolean),
                              },
                            })
                          }
                        />
                      </label>
                    )}
                    <label>
                      Calculation
                      <input
                        value={selected.calculation}
                        placeholder="sum:Field1,Field2"
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              calculation: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <button
                      className={selected.required ? "active" : ""}
                      onClick={() =>
                        execute({
                          type: "updateOverlay",
                          before: selected,
                          after: { ...selected, required: !selected.required },
                        })
                      }
                    >
                      Required
                    </button>
                    <button
                      className={selected.readOnly ? "active" : ""}
                      onClick={() =>
                        execute({
                          type: "updateOverlay",
                          before: selected,
                          after: { ...selected, readOnly: !selected.readOnly },
                        })
                      }
                    >
                      Read only
                    </button>
                    <button
                      className={selected.flatten ? "active" : ""}
                      onClick={() =>
                        execute({
                          type: "updateOverlay",
                          before: selected,
                          after: { ...selected, flatten: !selected.flatten },
                        })
                      }
                    >
                      {selected.flatten
                        ? "Flatten on export"
                        : "Keep interactive"}
                    </button>
                  </>
                )}
                {selected &&
                  selected.kind !== "text" &&
                  "color" in selected && (
                    <label>
                      Colour
                      <input
                        type="color"
                        value={selected.color}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              color: event.target.value,
                            } as Overlay,
                          })
                        }
                      />
                    </label>
                  )}
                {selected && isReviewOverlay(selected) && (
                  <>
                    <label>
                      Author
                      <input
                        value={selected.author}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              author: event.target.value,
                            } as Overlay,
                          })
                        }
                      />
                    </label>
                    <label>
                      Comment
                      <input
                        value={selected.comment}
                        onChange={(event) =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              comment: event.target.value,
                            } as Overlay,
                          })
                        }
                      />
                    </label>
                    <button
                      className={selected.resolved ? "active" : ""}
                      onClick={() =>
                        execute({
                          type: "updateOverlay",
                          before: selected,
                          after: {
                            ...selected,
                            resolved: !selected.resolved,
                          } as Overlay,
                        })
                      }
                    >
                      {selected.resolved ? "Resolved" : "Resolve"}
                    </button>
                    {selected.kind !== "attachment" && (
                      <button
                        className={selected.flatten ? "active" : ""}
                        onClick={() =>
                          execute({
                            type: "updateOverlay",
                            before: selected,
                            after: {
                              ...selected,
                              flatten: !selected.flatten,
                            } as Overlay,
                          })
                        }
                      >
                        {selected.flatten
                          ? "Flatten on export"
                          : "Keep editable"}
                      </button>
                    )}
                  </>
                )}
                {selected && (
                  <button
                    className="danger"
                    onClick={() => {
                      execute({ type: "remove", overlay: selected });
                      setSelectedId(null);
                    }}
                  >
                    <Trash2 /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
          <div
            ref={stageRef}
            className="stage"
            onTouchStart={beginPinch}
            onTouchMove={movePinch}
            onTouchEnd={endPinch}
            onTouchCancel={endPinch}
          >
            {busy && <div className="loading">Rendering page…</div>}
            <div className="pageViewport">
              <PageCanvas
                image={image}
                info={pageInfo}
                zoom={zoom}
                rotation={doc.rotations[sourcePage] ?? 0}
                overlays={current}
                textLines={textLines}
                originalEdit={originalEdit}
                crop={doc.crops[sourcePage]}
                tool={tool}
                shapeKind={shapeKind}
                drawColor={drawColor}
                reviewSettings={{
                  markupKind,
                  noteType,
                  stampLabel,
                  measureKind,
                  measureUnit,
                  measureScale,
                  reviewAuthor,
                  pendingAttachment,
                  formType,
                  formName,
                  formValidation,
                  formPattern,
                  signatureMode,
                  signatureName,
                  signatureImage,
                  hasCertificate: Boolean(certificate),
                }}
                selectedId={selectedId}
                onSelect={(id) => {
                  if (originalEdit) commitOriginalTextEdit(originalEdit, false);
                  setSelectedId(id);
                  if (id || !originalEdit) setOriginalEdit(null);
                }}
                onOriginalSelect={(line) => {
                  if (originalEdit) commitOriginalTextEdit(originalEdit, false);
                  setSelectedId(null);
                  setOriginalEdit({ line, draft: line.text });
                }}
                onOriginalChange={(draft) =>
                  setOriginalEdit((currentEdit) =>
                    currentEdit ? { ...currentEdit, draft } : null,
                  )
                }
                onAdd={(overlay) => {
                  execute({ type: "add", overlay });
                  setSelectedId(overlay.id);
                  if (
                    overlay.kind === "text" ||
                    overlay.kind === "attachment" ||
                    overlay.kind === "note" ||
                    overlay.kind === "stamp" ||
                    overlay.kind === "formField" ||
                    overlay.kind === "visualSignature"
                  )
                    setTool("select");
                  if (overlay.kind === "attachment") setPendingAttachment(null);
                }}
                onUpdate={(before, after) =>
                  execute({ type: "updateOverlay", before, after })
                }
                onCrop={(crop) =>
                  execute({
                    type: "setCrop",
                    page: sourcePage,
                    before: doc.crops[sourcePage] ?? null,
                    after: crop,
                  })
                }
                page={sourcePage}
              />
            </div>
          </div>
          <div className="status">
            <div>
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
              >
                <ChevronLeft />
              </button>
              <span>
                {page + 1} / {doc.pageOrder.length}
              </span>
              <button
                onClick={() =>
                  setPage(Math.min(doc.pageOrder.length - 1, page + 1))
                }
                disabled={page === doc.pageOrder.length - 1}
              >
                <ChevronRight />
              </button>
            </div>
            <div>
              <button
                aria-label="Zoom out"
                onClick={() => setZoom(zoom - 0.15)}
              >
                <ZoomOut />
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button aria-label="Zoom in" onClick={() => setZoom(zoom + 0.15)}>
                <ZoomIn />
              </button>
            </div>
          </div>
        </main>
        {showComments && (
          <aside className="commentSidebar">
            <header>
              <div>
                <b>Review</b>
                <span>
                  {reviewOverlays.filter((item) => !item.resolved).length} open
                </span>
              </div>
              <button
                aria-label="Close reviews"
                onClick={() => setShowComments(false)}
              >
                <X />
              </button>
            </header>
            <label>
              Reviewer
              <input
                value={reviewAuthor}
                onChange={(event) => setReviewAuthor(event.target.value)}
              />
            </label>
            <div className="reviewFilters">
              {(["all", "open", "resolved"] as const).map((filter) => (
                <button
                  key={filter}
                  className={commentFilter === filter ? "active" : ""}
                  onClick={() => setCommentFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
            <div className="reviewList">
              {filteredReviews.length ? (
                filteredReviews.map((overlay) => (
                  <article
                    key={overlay.id}
                    className={overlay.resolved ? "resolved" : ""}
                  >
                    <button
                      className="reviewJump"
                      onClick={() => {
                        const index = doc.pageOrder.indexOf(overlay.page);
                        if (index >= 0) setPage(index);
                        setTool("select");
                        setSelectedId(overlay.id);
                      }}
                    >
                      <span>
                        Page {doc.pageOrder.indexOf(overlay.page) + 1} ·{" "}
                        {overlay.kind === "measurement"
                          ? overlay.measurement
                          : overlay.kind}
                      </span>
                      <b>
                        {overlay.kind === "note"
                          ? overlay.text
                          : overlay.kind === "stamp"
                            ? overlay.label
                            : overlay.kind === "attachment"
                              ? overlay.name
                              : overlay.kind === "measurement"
                                ? overlay.label
                                : overlay.markup}
                      </b>
                      <p>{overlay.comment || "No comment"}</p>
                      <small>
                        {overlay.author || "Anonymous"} ·{" "}
                        {overlay.createdAt
                          ? new Date(overlay.createdAt).toLocaleString()
                          : "No date"}
                      </small>
                    </button>
                    <button
                      className="resolveButton"
                      onClick={() =>
                        execute({
                          type: "updateOverlay",
                          before: overlay,
                          after: {
                            ...overlay,
                            resolved: !overlay.resolved,
                          } as Overlay,
                        })
                      }
                    >
                      {overlay.resolved ? "Reopen" : "Resolve"}
                    </button>
                  </article>
                ))
              ) : (
                <p className="emptyReview">
                  No review annotations match this filter.
                </p>
              )}
            </div>
            <footer>
              <button onClick={() => reviewImportInput.current?.click()}>
                Import
              </button>
              <input
                ref={reviewImportInput}
                hidden
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importReviews(file);
                  event.target.value = "";
                }}
              />
              <button onClick={exportReviews} disabled={!reviewOverlays.length}>
                Export
              </button>
            </footer>
          </aside>
        )}
      </div>
      {showProperties && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Document properties"
          >
            <header>
              <h2>Document properties</h2>
              <button
                aria-label="Close properties"
                onClick={() => setShowProperties(false)}
              >
                <X />
              </button>
            </header>
            {(["title", "author", "subject", "keywords"] as const).map(
              (key) => (
                <label key={key}>
                  {key.charAt(0).toUpperCase() + key.slice(1)}
                  <input
                    value={metadataDraft[key]}
                    onChange={(event) =>
                      setMetadataDraft({
                        ...metadataDraft,
                        [key]: event.target.value,
                      })
                    }
                  />
                </label>
              ),
            )}
            <footer>
              <button onClick={() => setShowProperties(false)}>Cancel</button>
              <button className="primary" onClick={saveMetadata}>
                Save properties
              </button>
            </footer>
          </section>
        </div>
      )}
      {showForms && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal wideModal"
            role="dialog"
            aria-modal="true"
            aria-label="PDF form fields"
          >
            <header>
              <div>
                <h2>Form designer</h2>
                <p>
                  Create accessible fields, validation, calculations, and a
                  predictable tab order.
                </p>
              </div>
              <button
                aria-label="Close forms"
                onClick={() => setShowForms(false)}
              >
                <X />
              </button>
            </header>
            <div className="formDesignerActions">
              <button
                className="primary"
                onClick={() => {
                  setTool("form");
                  setShowForms(false);
                  setNotice("Drag on the page to place the new form field.");
                }}
              >
                <FileKey2 /> Draw a field
              </button>
              <label className="checkRow">
                <input
                  type="checkbox"
                  checked={security.flattenForms}
                  onChange={(event) =>
                    setSecurity({
                      ...security,
                      flattenForms: event.target.checked,
                    })
                  }
                />
                Flatten every form field on export
              </label>
            </div>
            {open.formFields.length > 0 && (
              <>
                <h3>Existing fields</h3>
                <div className="fieldGrid">
                  {open.formFields.map((field) => (
                    <label key={`${field.page}-${field.name}`}>
                      <span>
                        {field.label || field.name} · page {field.page + 1}
                      </span>
                      {field.type === "choice" ? (
                        <select
                          disabled={field.readOnly}
                          value={doc.formValues[field.name] ?? field.value}
                          onChange={(event) =>
                            execute({
                              type: "setFormValue",
                              name: field.name,
                              before: doc.formValues[field.name] ?? field.value,
                              after: event.target.value,
                            })
                          }
                        >
                          {field.options.map((option) => (
                            <option key={option}>{option}</option>
                          ))}
                        </select>
                      ) : field.type === "checkbox" ||
                        field.type === "radio" ? (
                        <input
                          disabled={field.readOnly}
                          type="checkbox"
                          checked={
                            (doc.formValues[field.name] ?? field.value) !==
                            "Off"
                          }
                          onChange={(event) =>
                            execute({
                              type: "setFormValue",
                              name: field.name,
                              before: doc.formValues[field.name] ?? field.value,
                              after: event.target.checked ? "Yes" : "Off",
                            })
                          }
                        />
                      ) : (
                        <input
                          disabled={field.readOnly}
                          defaultValue={
                            doc.formValues[field.name] ?? field.value
                          }
                          onBlur={(event) =>
                            execute({
                              type: "setFormValue",
                              name: field.name,
                              before: doc.formValues[field.name] ?? field.value,
                              after: event.target.value,
                            })
                          }
                        />
                      )}
                    </label>
                  ))}
                </div>
              </>
            )}
            <h3>Created fields</h3>
            {createdFormFields.length ? (
              <div className="createdFields">
                {[...createdFormFields]
                  .sort((a, b) => a.tabOrder - b.tabOrder)
                  .map((field) => (
                    <article key={field.id} className="createdField">
                      <div className="fieldGrid">
                        <label>
                          Name
                          <input
                            value={field.name}
                            onChange={(event) =>
                              execute({
                                type: "updateOverlay",
                                before: field,
                                after: { ...field, name: event.target.value },
                              })
                            }
                          />
                        </label>
                        <label>
                          Value
                          <input
                            value={field.value}
                            onChange={(event) =>
                              execute({
                                type: "updateOverlay",
                                before: field,
                                after: { ...field, value: event.target.value },
                              })
                            }
                          />
                        </label>
                        <label>
                          Tab order
                          <input
                            type="number"
                            min="0"
                            value={field.tabOrder}
                            onChange={(event) =>
                              execute({
                                type: "updateOverlay",
                                before: field,
                                after: {
                                  ...field,
                                  tabOrder: Number(event.target.value) || 0,
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          Calculation
                          <input
                            value={field.calculation}
                            placeholder="sum:Subtotal,Tax"
                            onChange={(event) =>
                              execute({
                                type: "updateOverlay",
                                before: field,
                                after: {
                                  ...field,
                                  calculation: event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="fieldFlags">
                        {(
                          [
                            "required",
                            "readOnly",
                            "multiline",
                            "flatten",
                          ] as const
                        ).map((key) => (
                          <label className="checkRow" key={key}>
                            <input
                              type="checkbox"
                              checked={field[key]}
                              onChange={(event) =>
                                execute({
                                  type: "updateOverlay",
                                  before: field,
                                  after: {
                                    ...field,
                                    [key]: event.target.checked,
                                  },
                                })
                              }
                            />
                            {key === "readOnly"
                              ? "Read only"
                              : key === "flatten"
                                ? "Flatten"
                                : key.charAt(0).toUpperCase() + key.slice(1)}
                          </label>
                        ))}
                        <button
                          onClick={() => {
                            setPage(doc.pageOrder.indexOf(field.page));
                            setSelectedId(field.id);
                            setTool("select");
                            setShowForms(false);
                          }}
                        >
                          Locate
                        </button>
                        <button
                          className="danger"
                          onClick={() =>
                            execute({ type: "remove", overlay: field })
                          }
                        >
                          <Trash2 /> Delete
                        </button>
                      </div>
                    </article>
                  ))}
              </div>
            ) : (
              <p className="emptyReview">
                No new fields yet. Choose “Draw a field” to start.
              </p>
            )}
            <footer>
              <button className="primary" onClick={() => setShowForms(false)}>
                Done
              </button>
            </footer>
          </section>
        </div>
      )}
      {showSecurity && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal wideModal"
            role="dialog"
            aria-modal="true"
            aria-label="Security and digital signatures"
          >
            <header>
              <div>
                <h2>Security & digital signatures</h2>
                <p>
                  Encrypt the export, remove metadata, and apply a
                  certificate-backed signature locally.
                </p>
              </div>
              <button
                aria-label="Close security"
                onClick={() => setShowSecurity(false)}
              >
                <X />
              </button>
            </header>
            {open.signatures.length > 0 && (
              <div className={edited ? "securityWarning" : "securityStatus"}>
                <b>
                  {open.signatures.length} existing digital signature
                  {open.signatures.length === 1 ? "" : "s"}
                </b>
                <span>
                  {edited
                    ? "This document has changed. Exporting will invalidate the existing signature coverage."
                    : "No edits have been made since opening this document."}
                </span>
                {open.signatures.map((signature, index) => (
                  <small key={`${signature.name}-${index}`}>
                    {signature.name || `Signature ${index + 1}`} ·{" "}
                    {signature.reason || "No reason"} ·{" "}
                    {signature.modifiedAfterSigning
                      ? "modified after signing"
                      : "covers current file"}
                  </small>
                ))}
              </div>
            )}
            <h3>Password encryption</h3>
            <div className="fieldGrid">
              <label>
                Password to open
                <input
                  type="password"
                  autoComplete="new-password"
                  value={security.userPassword}
                  onChange={(event) =>
                    setSecurity({
                      ...security,
                      userPassword: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Owner password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={security.ownerPassword}
                  onChange={(event) =>
                    setSecurity({
                      ...security,
                      ownerPassword: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="fieldFlags">
              {(
                [
                  ["allowPrint", "Allow printing"],
                  ["allowCopy", "Allow copying"],
                  ["allowEdit", "Allow editing"],
                  ["allowAnnotate", "Allow annotations"],
                  ["sanitizeMetadata", "Remove document metadata"],
                  ["flattenForms", "Flatten form fields"],
                ] as const
              ).map(([key, label]) => (
                <label className="checkRow" key={key}>
                  <input
                    type="checkbox"
                    checked={security[key]}
                    onChange={(event) =>
                      setSecurity({ ...security, [key]: event.target.checked })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <h3>Certificate-backed signature</h3>
            <p className="helperText">
              Choose a PKCS#12 certificate (.p12 or .pfx). The certificate and
              passphrase stay in this tab and are never saved.
            </p>
            <div className="fieldGrid">
              <label>
                Certificate
                <button onClick={() => certificateInput.current?.click()}>
                  {certificate ? certificate.name : "Choose .p12 or .pfx"}
                </button>
                <input
                  ref={certificateInput}
                  hidden
                  type="file"
                  accept=".p12,.pfx,application/x-pkcs12"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file)
                      void file
                        .arrayBuffer()
                        .then((bytes) =>
                          setCertificate({
                            name: file.name,
                            bytes: new Uint8Array(bytes),
                          }),
                        );
                    event.target.value = "";
                  }}
                />
              </label>
              <label>
                Certificate passphrase
                <input
                  type="password"
                  value={certificatePassphrase}
                  onChange={(event) =>
                    setCertificatePassphrase(event.target.value)
                  }
                />
              </label>
              <label>
                Signer name
                <input
                  value={signatureName}
                  onChange={(event) => setSignatureName(event.target.value)}
                />
              </label>
              <label>
                Reason
                <input
                  value={signatureReason}
                  onChange={(event) => setSignatureReason(event.target.value)}
                />
              </label>
              <label>
                Location
                <input
                  value={signatureLocation}
                  onChange={(event) => setSignatureLocation(event.target.value)}
                />
              </label>
              <label>
                Contact
                <input
                  value={signatureContact}
                  onChange={(event) => setSignatureContact(event.target.value)}
                />
              </label>
            </div>
            {lastAudit && (
              <div className="auditCard">
                <div>
                  <b>Secure redaction audit ready</b>
                  <span>
                    {lastAudit.areas} area{lastAudit.areas === 1 ? "" : "s"}{" "}
                    across {lastAudit.pages.length} page
                    {lastAudit.pages.length === 1 ? "" : "s"} · export verified
                  </span>
                </div>
                <button
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(lastAudit, null, 2)], {
                        type: "application/json",
                      }),
                    );
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = `${open.name.replace(/\.pdf$/i, "")}-redaction-audit.json`;
                    anchor.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download audit
                </button>
              </div>
            )}
            <footer>
              {certificate && (
                <button
                  className="danger"
                  onClick={() => {
                    setCertificate(null);
                    setCertificatePassphrase("");
                  }}
                >
                  Remove certificate
                </button>
              )}
              <button
                className="primary"
                onClick={() => setShowSecurity(false)}
              >
                Done
              </button>
            </footer>
          </section>
        </div>
      )}
      {showPageImages && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal pageImagesModal"
            role="dialog"
            aria-modal="true"
            aria-label="Embedded page images"
          >
            <header>
              <div>
                <h2>Page images</h2>
                <p>
                  Extract or visually replace raster images embedded on page{" "}
                  {page + 1}.
                </p>
              </div>
              <button
                aria-label="Close page images"
                onClick={() => setShowPageImages(false)}
              >
                <X />
              </button>
            </header>
            {pageImages.length ? (
              <div className="pageImageGrid">
                {pageImages.map((item, index) => (
                  <article key={item.id}>
                    <img
                      src={item.dataUrl}
                      alt={`Embedded image ${index + 1}`}
                    />
                    <span>
                      {item.pixelWidth} × {item.pixelHeight}
                    </span>
                    <div>
                      <button
                        onClick={() => {
                          const anchor = document.createElement("a");
                          anchor.href = item.dataUrl;
                          anchor.download = `page-${page + 1}-image-${index + 1}.png`;
                          anchor.click();
                        }}
                      >
                        Extract
                      </button>
                      <button
                        onClick={() => {
                          setNativeReplace(item);
                          nativeReplaceInput.current?.click();
                        }}
                      >
                        Replace
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="emptyReview">
                No embedded raster images were detected.
              </p>
            )}
            <input
              ref={nativeReplaceInput}
              hidden
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void replaceNativeImage(file);
                event.target.value = "";
              }}
            />
            <footer>
              <button
                className="primary"
                onClick={() => setShowPageImages(false)}
              >
                Done
              </button>
            </footer>
          </section>
        </div>
      )}
      {showPages && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal pagesModal"
            role="dialog"
            aria-modal="true"
            aria-label="Organize pages"
          >
            <header>
              <div>
                <h2>Organize pages</h2>
                <p>Select pages for batch movement or extraction.</p>
              </div>
              <button
                aria-label="Close page organizer"
                onClick={() => setShowPages(false)}
              >
                <X />
              </button>
            </header>
            <div className="pageBatchActions">
              <button
                onClick={() =>
                  void applyPageOperation(
                    {
                      type: "blank",
                      at: page + 1,
                      width: pageInfo.width,
                      height: pageInfo.height,
                    },
                    "Blank page inserted.",
                  )
                }
              >
                <FilePlus2 /> Blank
              </button>
              <button
                onClick={() =>
                  void applyPageOperation(
                    { type: "duplicate", at: page + 1, source: page },
                    "Page duplicated.",
                  )
                }
              >
                <Copy /> Duplicate current
              </button>
              <button onClick={() => insertPdfInput.current?.click()}>
                <Merge /> Insert PDF
              </button>
              <input
                ref={insertPdfInput}
                hidden
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file)
                    void file
                      .arrayBuffer()
                      .then((bytes) =>
                        applyPageOperation(
                          { type: "insert", at: page + 1, bytes },
                          `${file.name} inserted.`,
                        ),
                      );
                  event.target.value = "";
                }}
              />
            </div>
            <div className="organizerGrid">
              {doc.pageOrder.map((source, index) => (
                <label
                  key={`${source}-${index}`}
                  className={selectedPages.includes(index) ? "selected" : ""}
                >
                  <input
                    type="checkbox"
                    checked={selectedPages.includes(index)}
                    onChange={(event) =>
                      setSelectedPages((currentPages) =>
                        event.target.checked
                          ? [...currentPages, index]
                          : currentPages.filter((item) => item !== index),
                      )
                    }
                  />
                  <span>Page {index + 1}</span>
                  <small>Source {source + 1}</small>
                </label>
              ))}
            </div>
            <div className="pageBatchActions">
              <button
                onClick={() => batchMovePages("start")}
                disabled={!selectedPages.length}
              >
                Move selected first
              </button>
              <button
                onClick={() => batchMovePages("end")}
                disabled={!selectedPages.length}
              >
                Move selected last
              </button>
              <button onClick={() => batchMovePages("reverse")}>
                Reverse all
              </button>
              <button
                onClick={() => void extractSelectedPages()}
                disabled={!selectedPages.length}
              >
                Extract selected
              </button>
            </div>
            <footer>
              <button className="primary" onClick={() => setShowPages(false)}>
                Done
              </button>
            </footer>
          </section>
        </div>
      )}
      {showLayout && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal layoutModal"
            role="dialog"
            aria-modal="true"
            aria-label="Headers, footers and watermarks"
          >
            <header>
              <div>
                <h2>Document layout</h2>
                <p>
                  Use {"{page}"} and {"{pages}"} for automatic numbering.
                </p>
              </div>
              <button
                aria-label="Close layout"
                onClick={() => setShowLayout(false)}
              >
                <X />
              </button>
            </header>
            <label>
              Header
              <input
                value={layoutDraft.header}
                onChange={(event) =>
                  setLayoutDraft({ ...layoutDraft, header: event.target.value })
                }
                placeholder="Document title · {page}/{pages}"
              />
            </label>
            <label>
              Footer
              <input
                value={layoutDraft.footer}
                onChange={(event) =>
                  setLayoutDraft({ ...layoutDraft, footer: event.target.value })
                }
                placeholder="Confidential"
              />
            </label>
            <label>
              Watermark
              <input
                value={layoutDraft.watermark}
                onChange={(event) =>
                  setLayoutDraft({
                    ...layoutDraft,
                    watermark: event.target.value,
                  })
                }
                placeholder="DRAFT"
              />
            </label>
            <div className="layoutGrid">
              <label>
                Bates prefix
                <input
                  value={layoutDraft.batesPrefix}
                  onChange={(event) =>
                    setLayoutDraft({
                      ...layoutDraft,
                      batesPrefix: event.target.value,
                    })
                  }
                  placeholder="DOC-"
                />
              </label>
              <label>
                Bates start
                <CompactNumberInput
                  label="Bates start"
                  value={layoutDraft.batesStart}
                  min={0}
                  max={99999999}
                  onCommit={(batesStart) =>
                    setLayoutDraft({ ...layoutDraft, batesStart })
                  }
                />
              </label>
              <label>
                Digits
                <CompactNumberInput
                  label="Bates digits"
                  value={layoutDraft.batesDigits}
                  min={1}
                  max={10}
                  onCommit={(batesDigits) =>
                    setLayoutDraft({ ...layoutDraft, batesDigits })
                  }
                />
              </label>
            </div>
            <label className="checkLabel">
              <input
                type="checkbox"
                checked={layoutDraft.useBackground}
                onChange={(event) =>
                  setLayoutDraft({
                    ...layoutDraft,
                    useBackground: event.target.checked,
                  })
                }
              />
              Page background
            </label>
            {layoutDraft.useBackground && (
              <label>
                Background colour
                <input
                  type="color"
                  value={layoutDraft.background}
                  onChange={(event) =>
                    setLayoutDraft({
                      ...layoutDraft,
                      background: event.target.value,
                    })
                  }
                />
              </label>
            )}
            <footer>
              <button
                onClick={() => {
                  const remaining = doc.overlays.filter(
                    (overlay) =>
                      !(
                        overlay.kind === "background" ||
                        (overlay.kind === "text" && overlay.layoutRole)
                      ),
                  );
                  execute({
                    type: "setOverlayOrder",
                    before: doc.overlays,
                    after: remaining,
                  });
                  setShowLayout(false);
                }}
              >
                Clear layout
              </button>
              <button className="primary" onClick={applyLayout}>
                Apply to all pages
              </button>
            </footer>
          </section>
        </div>
      )}
      {showCompression && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal compressionModal"
            role="dialog"
            aria-modal="true"
            aria-label="Compression profiles"
          >
            <header>
              <div>
                <h2>Compress PDF</h2>
                <p>
                  Choose a local, lossless optimization profile before export.
                </p>
              </div>
              <button
                aria-label="Close compression"
                onClick={() => setShowCompression(false)}
              >
                <X />
              </button>
            </header>
            <div className="compressionProfiles">
              {(
                [
                  {
                    id: "original",
                    title: "Original quality",
                    detail: "Minimal cleanup; preserves source streams.",
                  },
                  {
                    id: "balanced",
                    title: "Balanced",
                    detail: "Compresses and cleans redundant PDF objects.",
                  },
                  {
                    id: "small",
                    title: "Smallest lossless",
                    detail: "Also compresses image and font streams.",
                  },
                ] as const
              ).map((profile) => (
                <button
                  key={profile.id}
                  className={
                    compressionProfile === profile.id ? "selected" : ""
                  }
                  onClick={() => {
                    setCompressionProfile(profile.id);
                    setCompressionEstimate(null);
                  }}
                >
                  <b>{profile.title}</b>
                  <span>{profile.detail}</span>
                </button>
              ))}
            </div>
            <div className="sizeEstimate">
              <span>Current file</span>
              <b>{formatBytes(open.bytes.byteLength)}</b>
              <span>Estimated export</span>
              <b>
                {compressionEstimate === null
                  ? "Run estimate"
                  : formatBytes(compressionEstimate)}
              </b>
            </div>
            <footer>
              <button
                onClick={() => void estimateCompression()}
                disabled={estimatingCompression}
              >
                {estimatingCompression ? "Estimating…" : "Estimate size"}
              </button>
              <button
                className="primary"
                onClick={() => setShowCompression(false)}
              >
                Use this profile
              </button>
            </footer>
          </section>
        </div>
      )}
      {showImageCrop && selected?.kind === "image" && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal imageCropModal"
            role="dialog"
            aria-modal="true"
            aria-label="Crop image"
          >
            <header>
              <h2>Crop image</h2>
              <button
                aria-label="Close image crop"
                onClick={() => setShowImageCrop(false)}
              >
                <X />
              </button>
            </header>
            <img
              src={selected.dataUrl}
              alt="Crop preview"
              style={{
                clipPath: `inset(${imageCrop.top}% ${imageCrop.right}% ${imageCrop.bottom}% ${imageCrop.left}%)`,
              }}
            />{" "}
            <div className="layoutGrid">
              {(["left", "top", "right", "bottom"] as const).map((edge) => (
                <label key={edge}>
                  {edge}
                  <CompactNumberInput
                    label={`${edge} crop percent`}
                    value={imageCrop[edge]}
                    min={0}
                    max={45}
                    onCommit={(value) =>
                      setImageCrop({ ...imageCrop, [edge]: value })
                    }
                  />
                </label>
              ))}
            </div>
            <footer>
              <button onClick={() => setShowImageCrop(false)}>Cancel</button>
              <button
                className="primary"
                onClick={() => void cropSelectedImage()}
              >
                Apply crop
              </button>
            </footer>
          </section>
        </div>
      )}
      {showOcr && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal ocrModal"
            role="dialog"
            aria-modal="true"
            aria-label="Scan and OCR"
          >
            <header>
              <div>
                <h2>Scan and OCR</h2>
                <p>
                  Recognition runs on this device. The exported PDF receives an
                  invisible, searchable text layer.
                </p>
              </div>
              <button
                aria-label="Close OCR"
                disabled={ocrRunning}
                onClick={() => setShowOcr(false)}
              >
                <X />
              </button>
            </header>
            <div className="ocrSettings">
              <label>
                Language
                <select
                  value={ocrLanguage}
                  disabled={ocrRunning}
                  onChange={(event) =>
                    setOcrLanguage(event.target.value as OcrLanguage)
                  }
                >
                  {ocrLanguages.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Pages
                <select
                  value={ocrScope}
                  disabled={ocrRunning}
                  onChange={(event) =>
                    setOcrScope(event.target.value as "page" | "document")
                  }
                >
                  <option value="page">Current page</option>
                  <option value="document">Entire document</option>
                </select>
              </label>
              <label>
                Scan cleanup
                <select
                  value={scanEnhancement}
                  disabled={ocrRunning}
                  onChange={(event) =>
                    setScanEnhancement(event.target.value as ScanEnhancement)
                  }
                >
                  <option value="none">Original</option>
                  <option value="grayscale">Grayscale</option>
                  <option value="document">Auto contrast + grayscale</option>
                </select>
              </label>
              <label>
                Review below
                <CompactNumberInput
                  label="Low confidence threshold"
                  value={confidenceThreshold}
                  min={1}
                  max={99}
                  onCommit={setConfidenceThreshold}
                />
              </label>
            </div>
            <label className="checkLabel">
              <input
                type="checkbox"
                checked={autoDeskew}
                disabled={ocrRunning}
                onChange={(event) => setAutoDeskew(event.target.checked)}
              />
              Auto-deskew recognition
            </label>
            <p className="ocrHint">
              Use the existing Rotate tool for sideways pages. Cleanup affects
              recognition without flattening or degrading the original scan.
            </p>
            {ocrProgress && (
              <div className="ocrProgress" role="status">
                <span className="spinner" />
                {ocrProgress}
              </div>
            )}
            <div className="ocrReviewHeader">
              <div>
                <b>Confidence review</b>
                <span>
                  {ocrText.length} recognised lines · {lowConfidenceOcr.length}{" "}
                  below {confidenceThreshold}%
                </span>
              </div>
              {ocrText.length > 0 && (
                <button
                  className="danger"
                  disabled={ocrRunning}
                  onClick={() => {
                    const targets = doc.overlays.filter(
                      (overlay) =>
                        overlay.kind === "text" &&
                        overlay.ocrSource &&
                        (ocrScope === "document" ||
                          overlay.page === sourcePage),
                    );
                    if (targets.length)
                      execute({ type: "removeMany", overlays: targets });
                  }}
                >
                  Remove OCR layer
                </button>
              )}
            </div>
            {lowConfidenceOcr.length > 0 ? (
              <div className="ocrReview">
                {lowConfidenceOcr.slice(0, 200).map((overlay) => (
                  <label key={overlay.id}>
                    <span>
                      <b>Page {doc.pageOrder.indexOf(overlay.page) + 1}</b>
                      <em>{Math.round(overlay.ocrConfidence ?? 0)}%</em>
                    </span>
                    <input
                      defaultValue={overlay.text}
                      onBlur={(event) => {
                        if (event.target.value !== overlay.text)
                          execute({
                            type: "updateOverlay",
                            before: overlay,
                            after: { ...overlay, text: event.target.value },
                          });
                      }}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <div className="emptyReview">
                {ocrText.length
                  ? "No recognised lines are below the review threshold."
                  : "Run OCR to create a searchable text layer and review uncertain lines."}
              </div>
            )}
            <footer>
              <button disabled={ocrRunning} onClick={() => setShowOcr(false)}>
                Done
              </button>
              <button
                className="primary"
                disabled={ocrRunning}
                onClick={() => void runOcr()}
              >
                {ocrRunning
                  ? "Recognising…"
                  : ocrScope === "document"
                    ? "OCR entire document"
                    : "OCR current page"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {showFind && (
        <div className="modalBackdrop" role="presentation">
          <section
            className="modal findModal"
            role="dialog"
            aria-modal="true"
            aria-label="Find and replace"
          >
            <header>
              <h2>Find and replace</h2>
              <button
                aria-label="Close find and replace"
                onClick={() => setShowFind(false)}
              >
                <X />
              </button>
            </header>
            <label>
              Find
              <input
                autoFocus
                value={findQuery}
                onChange={(event) => setFindQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runFind();
                }}
              />
            </label>
            <label>
              Replace with
              <input
                value={replaceQuery}
                onChange={(event) => setReplaceQuery(event.target.value)}
              />
            </label>
            <label className="checkLabel">
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(event) => setMatchCase(event.target.checked)}
              />
              Match case
            </label>
            <div className="findSummary">
              {searching
                ? "Searching locally…"
                : `${findResults.length} matching text ${findResults.length === 1 ? "run" : "runs"}`}
            </div>
            {findResults.length > 0 && (
              <div className="findResults">
                {findResults.slice(0, 100).map((result) => (
                  <button
                    key={`${result.sourcePage}-${result.line.id}`}
                    onClick={() => {
                      const displayPage = doc.pageOrder.indexOf(
                        result.sourcePage,
                      );
                      if (displayPage >= 0) setPage(displayPage);
                      setShowFind(false);
                    }}
                  >
                    <b>Page {doc.pageOrder.indexOf(result.sourcePage) + 1}</b>
                    <span>{result.line.text.trim()}</span>
                  </button>
                ))}
              </div>
            )}
            <footer>
              <button onClick={() => setShowFind(false)}>Cancel</button>
              <button
                onClick={() => void runFind()}
                disabled={searching || !findQuery.trim()}
              >
                Find all
              </button>
              <button
                className="primary"
                onClick={replaceAllMatches}
                disabled={!findResults.length}
              >
                Replace all
              </button>
            </footer>
          </section>
        </div>
      )}
      {error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="toast success" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function PageCanvas({
  image,
  info,
  zoom,
  rotation,
  overlays,
  textLines,
  originalEdit,
  crop,
  tool,
  shapeKind,
  drawColor,
  reviewSettings,
  selectedId,
  onSelect,
  onOriginalSelect,
  onOriginalChange,
  onAdd,
  onUpdate,
  onCrop,
  page,
}: {
  image: string | null;
  info: PageInfo;
  zoom: number;
  rotation: number;
  overlays: Overlay[];
  textLines: PositionedTextLine[];
  originalEdit: { line: PositionedTextLine; draft: string } | null;
  crop?: { x: number; y: number; width: number; height: number };
  tool: Tool;
  shapeKind: ShapeKind;
  drawColor: string;
  reviewSettings: {
    markupKind: MarkupKind;
    noteType: "sticky" | "callout";
    stampLabel: string;
    measureKind: "distance" | "perimeter" | "area";
    measureUnit: "pt" | "in" | "cm" | "mm";
    measureScale: number;
    reviewAuthor: string;
    pendingAttachment: {
      name: string;
      mimeType: string;
      dataUrl: string;
    } | null;
    formType: "text" | "choice" | "checkbox" | "radio" | "signature";
    formName: string;
    formValidation: "none" | "email" | "number" | "regex";
    formPattern: string;
    signatureMode: "draw" | "typed" | "image" | "digital";
    signatureName: string;
    signatureImage: string | null;
    hasCertificate: boolean;
  };
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOriginalSelect: (line: PositionedTextLine) => void;
  onOriginalChange: (draft: string) => void;
  onAdd: (overlay: Overlay) => void;
  onUpdate: (before: Overlay, after: Overlay) => void;
  onCrop: (crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  page: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const points = useRef<{ x: number; y: number }[]>([]);
  const drag = useRef<{
    before: Overlay;
    start: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    mode: "move" | "resize";
  } | null>(null);
  const [livePoints, setLivePoints] = useState<{ x: number; y: number }[]>([]);
  const [liveRect, setLiveRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [preview, setPreview] = useState<Overlay | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const position = (event: ReactPointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };
  const boundsOf = (overlay: Overlay) => {
    if (overlay.kind === "background")
      return { x: 0, y: 0, width: 1, height: 1 };
    if (
      overlay.kind === "ink" ||
      overlay.kind === "signature" ||
      overlay.kind === "measurement"
    ) {
      const xs = overlay.points.map((point) => point.x);
      const ys = overlay.points.map((point) => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return {
        x,
        y,
        width: Math.max(0.02, Math.max(...xs) - x),
        height: Math.max(0.02, Math.max(...ys) - y),
      };
    }
    return {
      x: overlay.x,
      y: overlay.y,
      width: overlay.width,
      height: overlay.height,
    };
  };
  const sizedRect = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => {
    if (tool !== "shape" || shapeKind !== "square") return normalizeRect(a, b);
    const side = Math.min(
      Math.abs(b.x - a.x) * info.width,
      Math.abs(b.y - a.y) * info.height,
    );
    const width = side / info.width;
    const height = side / info.height;
    return {
      x: b.x < a.x ? a.x - width : a.x,
      y: b.y < a.y ? a.y - height : a.y,
      width,
      height,
    };
  };
  const down = (event: ReactPointerEvent) => {
    if (tool === "select") {
      onSelect(null);
      return;
    }
    ref.current?.setPointerCapture(event.pointerId);
    start.current = position(event);
    points.current = [start.current];
    setLivePoints(points.current);
    setLiveRect(null);
    if (tool === "text") {
      const text = prompt("Text to add");
      if (text) {
        const base = {
          x: start.current.x,
          size: 18,
          fontFamily: "Helvetica",
          bold: false,
          width: 0.18,
          height: 0.035,
        };
        const box = layoutTextBox(base, text, info);
        onAdd({
          id: crypto.randomUUID(),
          page,
          kind: "text",
          x: start.current!.x,
          y: start.current!.y,
          width: box.width,
          height: box.height,
          text,
          size: 18,
          color: drawColor,
          fontFamily: "Helvetica",
          fontName: "Helvetica",
          bold: false,
          italic: false,
          underline: false,
          alignment: "left",
          lineHeight: 1.2,
          letterSpacing: 0,
          fitMode: "auto",
        });
      }
      start.current = null;
      setLivePoints([]);
    }
    const reviewBase = {
      author: reviewSettings.reviewAuthor,
      createdAt: new Date().toISOString(),
      comment: "",
      resolved: false,
      flatten: false,
    };
    if (tool === "note") {
      const text = prompt(
        reviewSettings.noteType === "sticky" ? "Comment" : "Callout text",
      );
      if (text)
        onAdd({
          id: crypto.randomUUID(),
          page,
          kind: "note",
          noteType: reviewSettings.noteType,
          x: start.current!.x,
          y: start.current!.y,
          width: reviewSettings.noteType === "sticky" ? 0.055 : 0.3,
          height: reviewSettings.noteType === "sticky" ? 0.045 : 0.1,
          color: drawColor,
          text,
          ...reviewBase,
        });
      start.current = null;
      setLivePoints([]);
    }
    if (tool === "stamp") {
      onAdd({
        id: crypto.randomUUID(),
        page,
        kind: "stamp",
        x: start.current!.x,
        y: start.current!.y,
        width: 0.2,
        height: 0.065,
        label: reviewSettings.stampLabel,
        color: drawColor,
        ...reviewBase,
      });
      start.current = null;
      setLivePoints([]);
    }
    if (tool === "attachment" && reviewSettings.pendingAttachment) {
      onAdd({
        id: crypto.randomUUID(),
        page,
        kind: "attachment",
        x: start.current!.x,
        y: start.current!.y,
        width: 0.045,
        height: 0.045,
        ...reviewSettings.pendingAttachment,
        ...reviewBase,
      });
      start.current = null;
      setLivePoints([]);
    }
    if (tool === "signature" && reviewSettings.signatureMode !== "draw") {
      if (
        reviewSettings.signatureMode === "image" &&
        !reviewSettings.signatureImage
      ) {
        alert("Choose a signature image first.");
        start.current = null;
        return;
      }
      if (
        reviewSettings.signatureMode === "digital" &&
        !reviewSettings.hasCertificate
      ) {
        alert("Choose a PKCS#12 certificate in Security first.");
        start.current = null;
        return;
      }
      const signer = reviewSettings.signatureName || "Signer";
      onAdd({
        id: crypto.randomUUID(),
        page,
        kind: "visualSignature",
        mode:
          reviewSettings.signatureMode === "digital"
            ? "digital"
            : reviewSettings.signatureMode,
        x: start.current!.x,
        y: start.current!.y,
        width: 0.3,
        height: 0.08,
        text:
          reviewSettings.signatureMode === "digital"
            ? `Digitally signed by ${signer}`
            : signer,
        dataUrl:
          reviewSettings.signatureMode === "image"
            ? (reviewSettings.signatureImage ?? undefined)
            : undefined,
        color: "#171714",
        signer,
        signedAt: new Date().toISOString(),
      });
      start.current = null;
      setLivePoints([]);
    }
  };
  const move = (event: ReactPointerEvent) => {
    const current = position(event);
    if (drag.current) {
      const { before, start: origin, bounds, mode } = drag.current;
      const dx = current.x - origin.x;
      const dy = current.y - origin.y;
      if (before.kind === "background") return;
      if (
        before.kind === "ink" ||
        before.kind === "signature" ||
        before.kind === "measurement"
      ) {
        if (mode === "move")
          setPreview({
            ...before,
            points: before.points.map((point) => ({
              x: Math.min(1, Math.max(0, point.x + dx)),
              y: Math.min(1, Math.max(0, point.y + dy)),
            })),
          });
        else {
          const width = Math.max(0.02, current.x - bounds.x);
          const height = Math.max(0.02, current.y - bounds.y);
          setPreview({
            ...before,
            points: before.points.map((point) => ({
              x: bounds.x + ((point.x - bounds.x) / bounds.width) * width,
              y: bounds.y + ((point.y - bounds.y) / bounds.height) * height,
            })),
          });
        }
      } else if (mode === "move") {
        let x = Math.min(1 - bounds.width, Math.max(0, bounds.x + dx));
        let y = Math.min(1 - bounds.height, Math.max(0, bounds.y + dy));
        const nextGuides: { x?: number; y?: number } = {};
        const xTargets = [0, 0.5 - bounds.width / 2, 1 - bounds.width];
        const yTargets = [0, 0.5 - bounds.height / 2, 1 - bounds.height];
        for (const target of xTargets)
          if (Math.abs(x - target) < 0.012) {
            x = target;
            nextGuides.x =
              target === 0 ? 0 : target === 1 - bounds.width ? 1 : 0.5;
            break;
          }
        for (const target of yTargets)
          if (Math.abs(y - target) < 0.012) {
            y = target;
            nextGuides.y =
              target === 0 ? 0 : target === 1 - bounds.height ? 1 : 0.5;
            break;
          }
        setGuides(nextGuides);
        setPreview({ ...before, x, y });
      } else {
        setPreview({
          ...before,
          width: Math.max(0.02, current.x - bounds.x),
          height: Math.max(0.02, current.y - bounds.y),
        });
      }
      return;
    }
    if (
      (tool === "ink" ||
        (tool === "signature" && reviewSettings.signatureMode === "draw")) &&
      start.current
    ) {
      points.current = [...points.current, current];
      setLivePoints(points.current);
    }
    if (
      (tool === "shape" ||
        tool === "redact" ||
        tool === "crop" ||
        tool === "markup" ||
        tool === "measure" ||
        tool === "form") &&
      start.current
    )
      setLiveRect(sizedRect(start.current, current));
  };
  const up = (event: ReactPointerEvent) => {
    if (drag.current) {
      const before = drag.current.before;
      if (preview && JSON.stringify(preview) !== JSON.stringify(before))
        onUpdate(before, preview);
      drag.current = null;
      setPreview(null);
      setGuides({});
      return;
    }
    if (!start.current) return;
    const end = position(event);
    if (
      (tool === "ink" ||
        (tool === "signature" && reviewSettings.signatureMode === "draw")) &&
      points.current.length > 1
    )
      onAdd({
        id: crypto.randomUUID(),
        page,
        kind: tool,
        points: points.current,
        color: tool === "signature" ? "#171714" : drawColor,
        width: tool === "signature" ? 2 : 3,
      });
    if (tool === "shape") {
      const rect = sizedRect(start.current, end);
      if (rect.width > 0.01 && rect.height > 0.01)
        onAdd({
          id: crypto.randomUUID(),
          page,
          kind: "shape",
          shape: shapeKind,
          ...rect,
          color: drawColor,
          fillColor: null,
          strokeWidth: 2,
        });
    }
    if (tool === "redact") {
      const rect = normalizeRect(start.current, end);
      if (rect.width > 0.01 && rect.height > 0.01)
        onAdd({
          id: crypto.randomUUID(),
          page,
          kind: "redact",
          ...rect,
          color: "#111111",
        });
    }
    if (tool === "crop") {
      const rect = normalizeRect(start.current, end);
      if (rect.width > 0.05 && rect.height > 0.05) onCrop(rect);
    }
    if (tool === "markup") {
      const rect = normalizeRect(start.current, end);
      if (rect.width > 0.005 && rect.height > 0.005)
        onAdd({
          id: crypto.randomUUID(),
          page,
          kind: "markup",
          markup: reviewSettings.markupKind,
          ...rect,
          color: drawColor,
          opacity: reviewSettings.markupKind === "highlight" ? 0.35 : 1,
          author: reviewSettings.reviewAuthor,
          createdAt: new Date().toISOString(),
          comment: "",
          resolved: false,
          flatten: false,
        });
    }
    if (tool === "measure") {
      const rect = normalizeRect(start.current, end);
      if (rect.width > 0.005 || rect.height > 0.005) {
        const points =
          reviewSettings.measureKind === "distance"
            ? [start.current, end]
            : [
                { x: rect.x, y: rect.y },
                { x: rect.x + rect.width, y: rect.y },
                { x: rect.x + rect.width, y: rect.y + rect.height },
                { x: rect.x, y: rect.y + rect.height },
              ];
        const widthPoints = rect.width * info.width;
        const heightPoints = rect.height * info.height;
        const unitFactor =
          reviewSettings.measureUnit === "in"
            ? 1 / 72
            : reviewSettings.measureUnit === "cm"
              ? 2.54 / 72
              : reviewSettings.measureUnit === "mm"
                ? 25.4 / 72
                : 1;
        const raw =
          reviewSettings.measureKind === "distance"
            ? Math.hypot(
                (end.x - start.current.x) * info.width,
                (end.y - start.current.y) * info.height,
              )
            : reviewSettings.measureKind === "perimeter"
              ? 2 * (widthPoints + heightPoints)
              : widthPoints * heightPoints;
        const power = reviewSettings.measureKind === "area" ? 2 : 1;
        const value =
          raw * Math.pow(unitFactor * reviewSettings.measureScale, power);
        const suffix = `${reviewSettings.measureUnit}${power === 2 ? "²" : ""}`;
        const label = `${value.toFixed(value >= 100 ? 0 : 2)} ${suffix}`;
        onAdd({
          id: crypto.randomUUID(),
          page,
          kind: "measurement",
          measurement: reviewSettings.measureKind,
          points,
          color: drawColor,
          unit: reviewSettings.measureUnit,
          scale: reviewSettings.measureScale,
          label,
          author: reviewSettings.reviewAuthor,
          createdAt: new Date().toISOString(),
          comment: "",
          resolved: false,
          flatten: false,
        });
      }
    }
    if (tool === "form") {
      const rect = normalizeRect(start.current, end);
      if (rect.width > 0.03 && rect.height > 0.018)
        onAdd({
          id: crypto.randomUUID(),
          page,
          kind: "formField",
          fieldType: reviewSettings.formType,
          ...rect,
          name: reviewSettings.formName || `Field${Date.now()}`,
          label: reviewSettings.formName,
          value: "",
          options:
            reviewSettings.formType === "choice"
              ? ["Option 1", "Option 2"]
              : [],
          required: false,
          readOnly: false,
          multiline: false,
          maxLength: 0,
          validation: reviewSettings.formValidation,
          validationPattern: reviewSettings.formPattern,
          calculation: "",
          tabOrder: overlays.filter((item) => item.kind === "formField").length,
          flatten: false,
        });
    }
    start.current = null;
    points.current = [];
    setLivePoints([]);
    setLiveRect(null);
  };
  const shown = overlays.map((overlay) =>
    preview?.id === overlay.id ? preview : overlay,
  );
  const editorBox = originalEdit
    ? layoutTextBox(originalEdit.line, originalEdit.draft, info)
    : null;
  const objectDown = (
    event: ReactPointerEvent,
    overlay: Overlay,
    mode: "move" | "resize",
  ) => {
    if (tool !== "select") return;
    event.stopPropagation();
    ref.current?.setPointerCapture(event.pointerId);
    onSelect(overlay.id);
    drag.current = {
      before: overlay,
      start: position(event),
      bounds: boundsOf(overlay),
      mode,
    };
    setPreview(overlay);
  };
  const lineWasReplaced = (line: PositionedTextLine) =>
    shown.some(
      (overlay) =>
        overlay.kind === "redact" &&
        overlay.color.toLowerCase() === "#ffffff" &&
        line.x + line.width / 2 >= overlay.x &&
        line.x + line.width / 2 <= overlay.x + overlay.width &&
        line.y + line.height / 2 >= overlay.y &&
        line.y + line.height / 2 <= overlay.y + overlay.height,
    );
  return (
    <div
      className="pageWrap"
      style={{
        width: info.width * zoom,
        height: info.height * zoom,
        transform: `rotate(${rotation}deg)`,
      }}
    >
      <div
        ref={ref}
        className={`page tool-${tool}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {image && (
          <img
            src={image}
            alt={`Rendered PDF page ${page + 1}`}
            draggable={false}
          />
        )}
        {shown
          .filter(
            (overlay): overlay is Extract<Overlay, { kind: "background" }> =>
              overlay.kind === "background",
          )
          .map((overlay) => (
            <span
              key={overlay.id}
              className="backgroundOverlay"
              style={{ background: overlay.color, opacity: overlay.opacity }}
            />
          ))}
        {shown
          .filter(
            (overlay): overlay is Extract<Overlay, { kind: "image" }> =>
              overlay.kind === "image",
          )
          .map((overlay) => (
            <img
              key={overlay.id}
              className="imageOverlay"
              src={overlay.dataUrl}
              alt="Placed PDF content"
              style={{
                left: `${overlay.x * 100}%`,
                top: `${overlay.y * 100}%`,
                width: `${overlay.width * 100}%`,
                height: `${overlay.height * 100}%`,
                opacity: overlay.opacity,
                transform: `rotate(${overlay.rotation}deg)`,
              }}
            />
          ))}
        {shown
          .filter(
            (
              overlay,
            ): overlay is Extract<Overlay, { kind: "visualSignature" }> =>
              overlay.kind === "visualSignature",
          )
          .map((overlay) =>
            overlay.mode === "image" && overlay.dataUrl ? (
              <img
                key={overlay.id}
                className="visualSignatureOverlay"
                src={overlay.dataUrl}
                alt={`Signature of ${overlay.signer}`}
                style={{
                  left: `${overlay.x * 100}%`,
                  top: `${overlay.y * 100}%`,
                  width: `${overlay.width * 100}%`,
                  height: `${overlay.height * 100}%`,
                }}
              />
            ) : (
              <span
                key={overlay.id}
                className={`visualSignatureOverlay ${overlay.mode === "digital" ? "digital" : ""}`}
                style={{
                  left: `${overlay.x * 100}%`,
                  top: `${overlay.y * 100}%`,
                  width: `${overlay.width * 100}%`,
                  height: `${overlay.height * 100}%`,
                  color: overlay.color,
                }}
              >
                {overlay.text}
                {overlay.mode === "digital" && (
                  <small>{new Date(overlay.signedAt).toLocaleString()}</small>
                )}
              </span>
            ),
          )}
        {shown
          .filter(
            (overlay): overlay is Extract<Overlay, { kind: "formField" }> =>
              overlay.kind === "formField",
          )
          .map((overlay) => (
            <span
              key={overlay.id}
              className={`formFieldOverlay form-${overlay.fieldType}`}
              style={{
                left: `${overlay.x * 100}%`,
                top: `${overlay.y * 100}%`,
                width: `${overlay.width * 100}%`,
                height: `${overlay.height * 100}%`,
              }}
            >
              {overlay.fieldType === "checkbox" || overlay.fieldType === "radio"
                ? overlay.value !== "" && overlay.value !== "Off"
                  ? "✓"
                  : ""
                : overlay.fieldType === "signature"
                  ? "Sign here"
                  : overlay.value || overlay.label || overlay.name}
              {overlay.required && <b aria-label="Required">*</b>}
            </span>
          ))}
        <svg className="overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
          {shown.map((overlay) =>
            overlay.kind === "ink" || overlay.kind === "signature" ? (
              <polyline
                key={overlay.id}
                points={overlay.points
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                fill="none"
                stroke={overlay.color}
                strokeWidth={overlay.width}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : overlay.kind === "rect" || overlay.kind === "redact" ? (
              <rect
                key={overlay.id}
                x={overlay.x}
                y={overlay.y}
                width={overlay.width}
                height={overlay.height}
                fill={overlay.kind === "redact" ? overlay.color : "transparent"}
                stroke={overlay.color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ) : overlay.kind === "shape" ? (
              overlay.shape === "circle" ? (
                <ellipse
                  key={overlay.id}
                  cx={overlay.x + overlay.width / 2}
                  cy={overlay.y + overlay.height / 2}
                  rx={overlay.width / 2}
                  ry={overlay.height / 2}
                  fill={overlay.fillColor ?? "transparent"}
                  stroke={overlay.color}
                  strokeWidth={overlay.strokeWidth}
                  vectorEffect="non-scaling-stroke"
                />
              ) : overlay.shape === "triangle" ? (
                <polygon
                  key={overlay.id}
                  points={`${overlay.x + overlay.width / 2},${overlay.y} ${overlay.x + overlay.width},${overlay.y + overlay.height} ${overlay.x},${overlay.y + overlay.height}`}
                  fill={overlay.fillColor ?? "transparent"}
                  stroke={overlay.color}
                  strokeWidth={overlay.strokeWidth}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <rect
                  key={overlay.id}
                  x={overlay.x}
                  y={overlay.y}
                  width={overlay.width}
                  height={overlay.height}
                  fill={overlay.fillColor ?? "transparent"}
                  stroke={overlay.color}
                  strokeWidth={overlay.strokeWidth}
                  vectorEffect="non-scaling-stroke"
                />
              )
            ) : null,
          )}
          {shown
            .filter(
              (overlay): overlay is Extract<Overlay, { kind: "markup" }> =>
                overlay.kind === "markup",
            )
            .map((overlay) =>
              overlay.markup === "highlight" ? (
                <rect
                  key={overlay.id}
                  x={overlay.x}
                  y={overlay.y}
                  width={overlay.width}
                  height={overlay.height}
                  fill={overlay.color}
                  opacity={overlay.opacity}
                />
              ) : overlay.markup === "strikeout" ? (
                <line
                  key={overlay.id}
                  x1={overlay.x}
                  y1={overlay.y + overlay.height / 2}
                  x2={overlay.x + overlay.width}
                  y2={overlay.y + overlay.height / 2}
                  stroke={overlay.color}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              ) : overlay.markup === "squiggly" ? (
                <path
                  key={overlay.id}
                  d={`M ${overlay.x} ${overlay.y + overlay.height} q ${overlay.width / 8} ${-overlay.height / 4} ${overlay.width / 4} 0 t ${overlay.width / 4} 0 t ${overlay.width / 4} 0 t ${overlay.width / 4} 0`}
                  fill="none"
                  stroke={overlay.color}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <line
                  key={overlay.id}
                  x1={overlay.x}
                  y1={overlay.y + overlay.height}
                  x2={overlay.x + overlay.width}
                  y2={overlay.y + overlay.height}
                  stroke={overlay.color}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              ),
            )}
          {shown
            .filter(
              (
                overlay,
              ): overlay is Extract<Overlay, { kind: "note" | "stamp" }> =>
                overlay.kind === "note" || overlay.kind === "stamp",
            )
            .map((overlay) => (
              <g key={overlay.id}>
                <rect
                  x={overlay.x}
                  y={overlay.y}
                  width={overlay.width}
                  height={overlay.height}
                  rx="0.008"
                  fill={overlay.kind === "note" ? "#fff4a8" : "#fff"}
                  stroke={overlay.color}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={overlay.x + overlay.width / 2}
                  y={overlay.y + overlay.height / 2}
                  dominantBaseline="middle"
                  textAnchor="middle"
                  fill={overlay.color}
                  fontSize={Math.min(overlay.height * 0.38, 0.018)}
                  fontWeight={overlay.kind === "stamp" ? "bold" : "normal"}
                >
                  {overlay.kind === "note"
                    ? overlay.noteType === "sticky"
                      ? "✎"
                      : overlay.text.slice(0, 24)
                    : overlay.label}
                </text>
              </g>
            ))}
          {shown
            .filter(
              (overlay): overlay is Extract<Overlay, { kind: "attachment" }> =>
                overlay.kind === "attachment",
            )
            .map((overlay) => (
              <g key={overlay.id}>
                <circle
                  cx={overlay.x + overlay.width / 2}
                  cy={overlay.y + overlay.height / 2}
                  r={Math.min(overlay.width, overlay.height) / 2}
                  fill="#fff"
                  stroke="#d64b35"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={overlay.x + overlay.width / 2}
                  y={overlay.y + overlay.height / 2}
                  dominantBaseline="middle"
                  textAnchor="middle"
                  fontSize={Math.min(overlay.height * 0.55, 0.02)}
                >
                  ↗
                </text>
              </g>
            ))}
          {shown
            .filter(
              (overlay): overlay is Extract<Overlay, { kind: "measurement" }> =>
                overlay.kind === "measurement",
            )
            .map((overlay) => (
              <g key={overlay.id}>
                <polyline
                  points={overlay.points
                    .map((point) => `${point.x},${point.y}`)
                    .join(" ")}
                  fill={
                    overlay.measurement === "area"
                      ? `${overlay.color}22`
                      : "none"
                  }
                  stroke={overlay.color}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={overlay.points[0]?.x ?? 0}
                  y={(overlay.points[0]?.y ?? 0) - 0.008}
                  fill={overlay.color}
                  fontSize="0.015"
                >
                  {overlay.label}
                </text>
              </g>
            ))}
          {livePoints.length > 1 && (
            <polyline
              points={livePoints
                .map((point) => `${point.x},${point.y}`)
                .join(" ")}
              fill="none"
              stroke={tool === "signature" ? "#171714" : drawColor}
              strokeWidth={tool === "signature" ? 2 : 3}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {liveRect &&
            tool === "shape" &&
            (shapeKind === "circle" ? (
              <ellipse
                cx={liveRect.x + liveRect.width / 2}
                cy={liveRect.y + liveRect.height / 2}
                rx={liveRect.width / 2}
                ry={liveRect.height / 2}
                fill="transparent"
                stroke={drawColor}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ) : shapeKind === "triangle" ? (
              <polygon
                points={`${liveRect.x + liveRect.width / 2},${liveRect.y} ${liveRect.x + liveRect.width},${liveRect.y + liveRect.height} ${liveRect.x},${liveRect.y + liveRect.height}`}
                fill="transparent"
                stroke={drawColor}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <rect
                x={liveRect.x}
                y={liveRect.y}
                width={liveRect.width}
                height={liveRect.height}
                fill="transparent"
                stroke={drawColor}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          {liveRect && tool === "redact" && (
            <rect
              x={liveRect.x}
              y={liveRect.y}
              width={liveRect.width}
              height={liveRect.height}
              fill="#d64b3544"
              stroke="#d64b35"
              strokeWidth="2"
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {liveRect && tool === "crop" && (
            <rect
              className="cropRect"
              x={liveRect.x}
              y={liveRect.y}
              width={liveRect.width}
              height={liveRect.height}
            />
          )}
          {liveRect && tool === "markup" && (
            <rect
              x={liveRect.x}
              y={liveRect.y}
              width={liveRect.width}
              height={liveRect.height}
              fill={
                reviewSettings.markupKind === "highlight"
                  ? `${drawColor}55`
                  : "transparent"
              }
              stroke={drawColor}
              strokeWidth="1.5"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {liveRect && tool === "measure" && (
            <rect
              x={liveRect.x}
              y={liveRect.y}
              width={liveRect.width}
              height={liveRect.height}
              fill="transparent"
              stroke={drawColor}
              strokeWidth="1.5"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {liveRect && tool === "form" && (
            <rect
              x={liveRect.x}
              y={liveRect.y}
              width={liveRect.width}
              height={liveRect.height}
              fill="#2f6fed14"
              stroke="#2f6fed"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {crop && (
            <rect
              className="cropRect"
              x={crop.x}
              y={crop.y}
              width={crop.width}
              height={crop.height}
            />
          )}
          {guides.x !== undefined && (
            <line
              x1={guides.x}
              y1="0"
              x2={guides.x}
              y2="1"
              stroke="#2f6fed"
              strokeWidth="1"
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {guides.y !== undefined && (
            <line
              x1="0"
              y1={guides.y}
              x2="1"
              y2={guides.y}
              stroke="#2f6fed"
              strokeWidth="1"
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {shown
          .filter(
            (overlay): overlay is Extract<Overlay, { kind: "text" }> =>
              overlay.kind === "text" && !overlay.invisible,
          )
          .map((overlay) => (
            <span
              key={overlay.id}
              className="textOverlay"
              style={{
                left: `${overlay.x * 100}%`,
                top: `${overlay.y * 100}%`,
                width: `${overlay.width * 100}%`,
                height: `${overlay.height * 100}%`,
                fontSize: fittedFontSize(overlay, overlay.text, info) * zoom,
                color: overlay.color,
                fontFamily: fontStack(overlay.fontName, overlay.fontFamily),
                fontWeight: overlay.bold ? 700 : 400,
                fontStyle: overlay.italic ? "italic" : "normal",
                textDecoration: overlay.underline ? "underline" : "none",
                textAlign: overlay.alignment,
                lineHeight: overlay.lineHeight,
                letterSpacing: overlay.letterSpacing * zoom,
                opacity: overlay.opacity ?? 1,
                transform: `rotate(${overlay.rotation ?? 0}deg)`,
                transformOrigin: "left top",
              }}
            >
              {overlay.text}
            </span>
          ))}
        {tool === "select" &&
          textLines
            .filter((line) => !lineWasReplaced(line))
            .map((line) => (
              <button
                key={line.id}
                className={`originalTextHit ${originalEdit?.line.id === line.id ? "selected" : ""}`}
                aria-label={`Edit PDF text: ${line.text.trim().slice(0, 80)}`}
                style={{
                  left: `${line.x * 100}%`,
                  top: `${line.y * 100}%`,
                  width: `${line.width * 100}%`,
                  height: `${line.height * 100}%`,
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onOriginalSelect(line);
                }}
              />
            ))}
        {originalEdit && editorBox && (
          <textarea
            autoFocus
            className="originalTextEditor"
            aria-label="Edit original PDF text"
            value={originalEdit.draft}
            style={{
              left: `${originalEdit.line.x * 100}%`,
              top: `${originalEdit.line.y * 100}%`,
              width: `${editorBox.width * 100}%`,
              height: `${editorBox.height * 100}%`,
              fontSize:
                fittedFontSize(originalEdit.line, originalEdit.draft, info) *
                zoom,
              color: originalEdit.line.color,
              fontFamily: fontStack(
                originalEdit.line.fontName,
                originalEdit.line.fontFamily,
              ),
              fontWeight: originalEdit.line.bold ? 700 : 400,
              fontStyle: originalEdit.line.italic ? "italic" : "normal",
              textAlign: originalEdit.line.alignment,
              lineHeight: originalEdit.line.lineHeight,
              letterSpacing: originalEdit.line.letterSpacing * zoom,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onOriginalChange(event.target.value)}
          />
        )}
        {tool === "select" &&
          shown
            .filter(
              (overlay) =>
                overlay.kind !== "background" &&
                (overlay.kind !== "text" || !overlay.invisible),
            )
            .map((overlay) => {
              const bounds = boundsOf(overlay);
              const selected = selectedId === overlay.id;
              return (
                <div
                  key={`hit-${overlay.id}`}
                  className={`objectBox ${selected ? "selected" : ""}`}
                  style={{
                    left: `${bounds.x * 100}%`,
                    top: `${bounds.y * 100}%`,
                    width: `${bounds.width * 100}%`,
                    height: `${bounds.height * 100}%`,
                  }}
                  onPointerDown={(event) => objectDown(event, overlay, "move")}
                >
                  {selected && (
                    <button
                      className="resizeHandle"
                      aria-label="Resize selected object"
                      onPointerDown={(event) =>
                        objectDown(event, overlay, "resize")
                      }
                    />
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}
