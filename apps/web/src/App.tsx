import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bold,
  BookOpen,
  BringToFront,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crop,
  Download,
  Eraser,
  FileImage,
  FileKey2,
  FileOutput,
  FilePlus2,
  FileText,
  Highlighter,
  ImageDown,
  ImagePlus,
  Images,
  Info,
  Italic,
  Keyboard,
  Layers,
  LayoutTemplate,
  ListChecks,
  Lock,
  Maximize,
  Moon,
  Merge,
  MessageSquareText,
  MousePointer2,
  MoveHorizontal,
  PanelLeft,
  Paperclip,
  PenLine,
  Pencil,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Ruler,
  ScanText,
  Search,
  SendToBack,
  Shapes,
  ShieldCheck,
  Signature,
  Stamp,
  Trash2,
  Type,
  Underline,
  Undo2,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  createPdfEngine,
  PASSWORD_INCORRECT,
  PASSWORD_REQUIRED,
  type AppendOperation,
  type FormField,
  type OutlineEntry,
  type PageLink,
  type PageImage,
  type PageInfo,
  type PdfMetadata,
  type PositionedTextLine,
  type SignatureStatus,
} from "@paperless/pdf-engine";
import {
  EditorDocumentSchema,
  Overlay as OverlaySchema,
  type Command,
  type EditorDocument,
  type Overlay,
  type Tool,
} from "@paperless/editor-core";
import { deleteProject, listProjects, loadProject, saveProject, type ProjectSummary } from "./persistence";
import { MAX_ZOOM, MIN_ZOOM, useEditor } from "./store";
import { configureNativeUi, isNativePlatform, registerBackHandler, savePdf } from "./platform";
import { createOcrRecognizer, ocrLanguages, type OcrLanguage, type ScanEnhancement } from "./ocr";
import { signPdfWithCertificate } from "./digital-signature";
import { DocumentView, type DocumentViewHandle } from "./DocumentView";
import { PageCanvas, type CanvasSettings, type MarkupKind, type OriginalEdit, type ShapeKind } from "./PageCanvas";
import { exportFontName, fitTextBox, fontCategory, layoutStyled, topForBaseline, usePreviewFonts } from "./textMetrics";
import { Modal, NumberField, Toast } from "./ui";
import { useMediaQuery } from "./hooks";
import { dataUrlToBlob, downloadBlob, readAsDataUrl } from "./files";
import { boundsOf } from "./geometry";
import { layoutOverlays } from "./layout";
import { findParagraph, reflowWidth } from "./paragraphs";

type Engine = ReturnType<typeof createPdfEngine>;
type OpenDoc = {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  password?: string;
  pages: PageInfo[];
  formFields: FormField[];
  signatures: SignatureStatus[];
  initialMetadata: PdfMetadata;
  initialFormValues: Record<string, string>;
};
type FindResult = { sourcePage: number; line: PositionedTextLine; overlayId?: string };
type TabId = "edit" | "comment" | "sign" | "pages" | "tools";
type PageImageBox = Omit<PageImage, "dataUrl">;
type ReviewOverlay = Extract<Overlay, { kind: "markup" | "note" | "stamp" | "attachment" | "measurement" }>;
type TextOverlay = Extract<Overlay, { kind: "text" }>;
type PasswordRequest = { name: string; incorrect: boolean; resolve: (password: string | null) => void };

const isReviewOverlay = (overlay: Overlay): overlay is ReviewOverlay =>
  ["markup", "note", "stamp", "attachment", "measurement"].includes(overlay.kind);
const commonFonts = ["Helvetica", "Arial", "Calibri", "Times New Roman", "Georgia", "Garamond", "Verdana", "Courier New"];
const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
const baseName = (name: string) => name.replace(/\.pdf$/i, "");
const errorText = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message.replace(/^(PASSWORD_REQUIRED|PASSWORD_INCORRECT): /, "") : fallback;
const isPasswordError = (cause: unknown) =>
  cause instanceof Error && (cause.message.startsWith(PASSWORD_REQUIRED) || cause.message.startsWith(PASSWORD_INCORRECT));
const withTimeout = <T,>(promise: Promise<T>, milliseconds: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
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
const pngUrl = (png: Uint8Array) => {
  const copy = new Uint8Array(png.byteLength);
  copy.set(png);
  return URL.createObjectURL(new Blob([copy.buffer], { type: "image/png" }));
};
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const toolShortcuts: Partial<Record<string, Tool>> = { v: "select", t: "text", d: "ink", h: "markup", n: "note", r: "shape", l: "line", s: "signature" };
const shortcutFor = (tool: Tool) => Object.entries(toolShortcuts).find(([, value]) => value === tool)?.[0]?.toUpperCase();

function Thumbnail({ source, rotation, url, onVisible }: { source: number; rotation: number; url?: string; onVisible: (source: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (url || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible(source);
    }, { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [onVisible, source, url]);
  return (
    <div ref={ref} className="thumbPreview">
      {url ? <img src={url} alt="" draggable={false} style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined }} /> : <span className="thumbLoading" />}
    </div>
  );
}

export function App() {
  const engine = useRef<Engine | null>(null);
  const inputs = {
    image: useRef<HTMLInputElement>(null),
    merge: useRef<HTMLInputElement>(null),
    attachment: useRef<HTMLInputElement>(null),
    reviewImport: useRef<HTMLInputElement>(null),
    insertPdf: useRef<HTMLInputElement>(null),
    replaceImage: useRef<HTMLInputElement>(null),
    nativeReplace: useRef<HTMLInputElement>(null),
    certificate: useRef<HTMLInputElement>(null),
    signatureImage: useRef<HTMLInputElement>(null),
    imagePages: useRef<HTMLInputElement>(null),
  };
  const stageRef = useRef<HTMLDivElement>(null);
  const pinch = useRef<{ distance: number; zoom: number; contentX: number; contentY: number; offsetX: number; offsetY: number } | null>(null);
  const loadSequence = useRef(0);
  const clipboard = useRef<Overlay | null>(null);
  // Thumbnails render one at a time so they never starve the main page.
  const thumbQueue = useRef<{ pending: Set<number>; running: boolean; generation: number }>({ pending: new Set(), running: false, generation: 0 });
  const fontsReady = usePreviewFonts();

  const [open, setOpen] = useState<OpenDoc | null>(null);
  const [tab, setTab] = useState<TabId>("edit");
  const [dialog, setDialog] = useState<
    null | "properties" | "forms" | "find" | "ocr" | "pages" | "layout" | "compress" | "imageCrop" | "pageImages" | "security" | "shortcuts"
  >(null);
  const [showComments, setShowComments] = useState(false);
  const [showRail, setShowRail] = useState(() => window.innerWidth > 760);
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [findResults, setFindResults] = useState<FindResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchHighlight, setSearchHighlight] = useState<{ sourcePage: number; rect: { x: number; y: number; width: number; height: number } } | null>(null);
  const [ocrLanguage, setOcrLanguage] = useState<OcrLanguage>("eng");
  const [ocrScope, setOcrScope] = useState<"page" | "document">("page");
  const [scanEnhancement, setScanEnhancement] = useState<ScanEnhancement>("document");
  const [autoDeskew, setAutoDeskew] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [confidenceThreshold, setConfidenceThreshold] = useState(75);
  const [metadataDraft, setMetadataDraft] = useState<PdfMetadata>({ title: "", author: "", subject: "", keywords: "" });
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const [busy, setBusy] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fit, setFit] = useState<"width" | "page" | null>("width");
  const [settings, setSettings] = useState<CanvasSettings>({
    shapeKind: "rectangle",
    drawColor: "#d64b35",
    fillColor: null,
    strokeWidth: 2,
    lineArrow: "end",
    textColor: "#111111",
    textSize: 14,
    textFont: "Helvetica",
    markupKind: "highlight",
    noteType: "sticky",
    stampLabel: "Approved",
    measureKind: "distance",
    measureUnit: "cm",
    measureScale: 1,
    reviewAuthor: "Reviewer",
    pendingAttachment: null,
    formType: "text",
    formName: "Field1",
    formValidation: "none",
    formPattern: "",
    signatureMode: "draw",
    signatureName: "",
    signatureImage: null,
    hasCertificate: false,
  });
  const updateSettings = (patch: Partial<CanvasSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const [commentFilter, setCommentFilter] = useState<"all" | "open" | "resolved">("all");
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [compressionProfile, setCompressionProfile] = useState<"original" | "balanced" | "small">("balanced");
  const [compressionEstimate, setCompressionEstimate] = useState<number | null>(null);
  const [estimatingCompression, setEstimatingCompression] = useState(false);
  const [layoutDraft, setLayoutDraft] = useState({ header: "", footer: "", watermark: "", batesPrefix: "", batesStart: 1, batesDigits: 4, background: "#ffffff", useBackground: false });
  const [imageCrop, setImageCrop] = useState({ left: 0, top: 0, right: 0, bottom: 0 });
  const [pageImages, setPageImages] = useState<PageImage[]>([]);
  const [nativeReplace, setNativeReplace] = useState<PageImage | null>(null);
  const [certificate, setCertificate] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [certificatePassphrase, setCertificatePassphrase] = useState("");
  const [signatureReason, setSignatureReason] = useState("Approved and signed");
  const [signatureLocation, setSignatureLocation] = useState("");
  const [signatureContact, setSignatureContact] = useState("");
  const [security, setSecurity] = useState({ userPassword: "", ownerPassword: "", allowPrint: true, allowCopy: true, allowEdit: false, allowAnnotate: true, sanitizeMetadata: false, flattenForms: false });
  const [lastAudit, setLastAudit] = useState<{ generatedAt: string; document: string; pages: number[]; areas: number; verified: boolean } | null>(null);
  // Text runs and links per source page, fetched as pages come into view.
  const [pageData, setPageData] = useState<Map<number, { lines: PositionedTextLine[]; links: PageLink[]; images: PageImageBox[] }>>(new Map());
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [railTab, setRailTab] = useState<"pages" | "outline">("pages");
  const [readingTheme, setReadingTheme] = useState<"day" | "night" | "sepia">(() => {
    try {
      const saved = localStorage.getItem("paperless:reading-theme");
      return saved === "night" || saved === "sepia" ? saved : "day";
    } catch {
      return "day";
    }
  });
  const isPhone = useMediaQuery("(max-width: 760px)");
  const [trayOpen, setTrayOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  // The phone page indicator shows while scrolling, then fades away.
  const [pillShown, setPillShown] = useState(true);
  const viewRef = useRef<DocumentViewHandle>(null);
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const [originalEdit, setOriginalEdit] = useState<OriginalEdit | null>(null);
  const { tool, zoom, page, doc, undo, redo, setTool, setZoom, setPage, execute, undoOnce, redoOnce, reset, hydrate } = useEditor();

  useEffect(() => updateSettings({ hasCertificate: Boolean(certificate) }), [certificate]);
  const dismissError = useCallback(() => setError(""), []);
  const dismissNotice = useCallback(() => setNotice(""), []);
  const fail = useCallback((cause: unknown, fallback: string) => setError(errorText(cause, fallback)), []);

  const refreshRecent = useCallback(() => listProjects().then(setRecent).catch(() => setRecent([])), []);
  useEffect(() => {
    engine.current = createPdfEngine();
    void configureNativeUi();
    void refreshRecent();
    return () => engine.current?.terminate();
  }, [refreshRecent]);

  const askPassword = useCallback(
    (name: string, incorrect: boolean) =>
      new Promise<string | null>((resolve) => {
        setPasswordDraft("");
        setPasswordRequest({ name, incorrect, resolve });
      }),
    [],
  );
  const answerPassword = (value: string | null) => {
    passwordRequest?.resolve(value);
    setPasswordRequest(null);
  };

  /** Runs `attempt`, prompting for a password while the PDF asks for one. */
  const withPassword = useCallback(
    async <T,>(name: string, attempt: (password?: string) => Promise<T>, initial?: string) => {
      let password = initial;
      for (;;) {
        try {
          return { value: await attempt(password), password };
        } catch (cause) {
          if (!isPasswordError(cause)) throw cause;
          const next = await askPassword(name, Boolean(password));
          if (next === null) return null;
          password = next;
        }
      }
    },
    [askPassword],
  );

  const restartEngine = useCallback(async (bytes?: ArrayBuffer, password?: string) => {
    engine.current?.terminate();
    engine.current = createPdfEngine();
    await withTimeout(engine.current.ready, 20_000, "The PDF engine did not restart.");
    if (bytes) await withTimeout(engine.current.api.loadDocument(bytes.slice(0), password), 35_000, "The document could not be reloaded.");
  }, []);
  const api = () => engine.current!.api;

  const resetView = () => {
    thumbQueue.current.generation += 1;
    thumbQueue.current.pending.clear();
    setPageData(new Map());
    setOutline([]);
    setSelectedId(null);
    setEditingId(null);
    setOriginalEdit(null);
    setSearchHighlight(null);
    setFindResults(null);
    setThumbs((current) => {
      current.forEach((url) => URL.revokeObjectURL(url));
      return new Map();
    });
  };

  const openBytes = useCallback(
    async (input: { id: string; name: string; bytes: ArrayBuffer; snapshot?: EditorDocument }) => {
      const sequence = ++loadSequence.current;
      setBusy("Opening securely on this device…");
      setError("");
      setNotice("");
      try {
        await withTimeout(engine.current!.ready, 20_000, "The PDF engine took too long to start.");
        const load = (password?: string) => withTimeout(api().loadDocument(input.bytes.slice(0), password), 35_000, "This document took too long to load.");
        let loaded;
        try {
          loaded = await withPassword(input.name, load);
        } catch (cause) {
          if (isPasswordError(cause) || (cause instanceof Error && /not a (readable )?PDF/.test(cause.message))) throw cause;
          await restartEngine();
          loaded = await withPassword(input.name, load);
        }
        if (!loaded || sequence !== loadSequence.current) return;
        const meta = loaded.value;
        resetView();
        if (input.snapshot) {
          const snapshot = EditorDocumentSchema.parse(input.snapshot);
          const validOrder =
            snapshot.pageOrder.length > 0 &&
            snapshot.pageOrder.every((item) => item < meta.pageCount) &&
            new Set(snapshot.pageOrder).size === snapshot.pageOrder.length;
          if (!validOrder) throw new Error("The recovered page order is invalid for this PDF.");
          hydrate(snapshot);
        } else {
          const formValues = Object.fromEntries(meta.formFields.map((field) => [field.name, field.value]));
          reset(meta.pageCount, { metadata: meta.metadata, formValues });
        }
        setMetadataDraft(input.snapshot?.metadata ?? meta.metadata);
        setFit("width");
        setOpen({
          id: input.id,
          name: input.name,
          bytes: input.bytes,
          password: loaded.password,
          pages: meta.pages,
          formFields: meta.formFields,
          signatures: meta.signatures,
          initialMetadata: meta.metadata,
          initialFormValues: Object.fromEntries(meta.formFields.map((field) => [field.name, field.value])),
        });
        if (meta.signatures.length)
          setNotice(`${meta.signatures.length} digital signature${meta.signatures.length === 1 ? "" : "s"} detected. Editing this document will invalidate existing signatures.`);
      } catch (cause) {
        if (sequence === loadSequence.current) fail(cause, "This PDF could not be opened.");
      } finally {
        if (sequence === loadSequence.current) setBusy("");
      }
    },
     
    [hydrate, reset, withPassword, restartEngine, fail],
  );

  const load = useCallback(
    async (file: File) => {
      if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setError("Choose a PDF file.");
        return;
      }
      await openBytes({ id: crypto.randomUUID(), name: file.name, bytes: await file.arrayBuffer() });
    },
    [openBytes],
  );

  const createFromImages = useCallback(
    async (files: File[]) => {
      const images = files.filter((file) => /^image\/(png|jpe?g)$/.test(file.type));
      if (!images.length) {
        setError("Choose PNG or JPEG images.");
        return;
      }
      setBusy(`Creating a PDF from ${images.length} image${images.length === 1 ? "" : "s"}…`);
      setError("");
      try {
        await withTimeout(engine.current!.ready, 20_000, "The PDF engine took too long to start.");
        const created = await engine.current!.api.createFromImages(await Promise.all(images.map((file) => file.arrayBuffer())));
        const bytes = new Uint8Array(created.byteLength);
        bytes.set(created);
        await openBytes({ id: crypto.randomUUID(), name: `${images[0]!.name.replace(/\.[^.]+$/, "")}.pdf`, bytes: bytes.buffer });
      } catch (cause) {
        fail(cause, "The images could not be converted.");
        setBusy("");
      }
    },
    [openBytes, fail],
  );

  // Installed as an app, PDFs opened from the OS arrive through the launch queue.
  useEffect(() => {
    const launchQueue = (window as Window & { launchQueue?: { setConsumer: (consumer: (params: { files: FileSystemFileHandle[] }) => void) => void } }).launchQueue;
    launchQueue?.setConsumer((params) => {
      const handle = params.files[0];
      if (handle) void handle.getFile().then(load);
    });
  }, [load]);

  const recover = useCallback(
    async (id: string) => {
      setError("");
      try {
        await openBytes(await loadProject(id));
      } catch (cause) {
        fail(cause, "The project could not be recovered.");
      }
    },
    [openBytes, fail],
  );

  const sourcePage = doc.pageOrder[page] ?? 0;
  const pageInfo = open?.pages[sourcePage];
  const [renderScale, setRenderScale] = useState(1.5);

  // Keep the render resolution in step with zoom so pages stay sharp.
  useEffect(() => {
    const target = Math.min(4, Math.max(1, Math.ceil(zoom * Math.min(3, window.devicePixelRatio || 1) * 2) / 2));
    const timer = window.setTimeout(() => setRenderScale(target), 180);
    return () => window.clearTimeout(timer);
  }, [zoom]);

  const openBytesRef = open?.bytes;
  const openPassword = open?.password;
  const renderForView = useCallback(
    async (source: number, scale: number) => {
      try {
        await withTimeout(engine.current!.ready, 20_000, "The PDF renderer did not start.");
        return await withTimeout(api().renderPage(source, scale), 30_000, "This page took too long to render.");
      } catch {
        await restartEngine(openBytesRef, openPassword);
        return withTimeout(api().renderPage(source, scale), 30_000, "This page could not be rendered.");
      }
    },
     
    [openBytesRef, openPassword, restartEngine],
  );

  // A changed source document invalidates cached text and links.
  const pageDataLoading = useRef(new Set<number>());
  const currentBytes = useRef<ArrayBuffer | undefined>(undefined);
  currentBytes.current = openBytesRef;
  useEffect(() => {
    pageDataLoading.current.clear();
    setPageData(new Map());
    if (!openBytesRef) return;
    let active = true;
    void api()
      .getOutline()
      .then((entries) => active && setOutline(entries))
      .catch(() => active && setOutline([]));
    return () => {
      active = false;
    };
  }, [openBytesRef]);
  const loadPageData = useCallback(
    (sources: number[]) => {
      const bytes = openBytesRef;
      for (const source of sources) {
        if (pageDataLoading.current.has(source)) continue;
        pageDataLoading.current.add(source);
        void Promise.all([
          withTimeout(api().extractTextLines(source), 20_000, "Reading page text took too long."),
          api().getLinks(source).catch(() => [] as PageLink[]),
          api().listPageImages(source).catch(() => [] as PageImageBox[]),
        ])
          .then(([lines, links, images]) => {
            if (bytes !== currentBytes.current) return;
            setPageData((current) => new Map(current).set(source, { lines, links, images }));
          })
          .catch(() => pageDataLoading.current.delete(source));
      }
    },
    [openBytesRef],
  );
  useEffect(() => {
    if (openBytesRef && doc.pageOrder.length) loadPageData([sourcePage]);
  }, [openBytesRef, sourcePage, doc.pageOrder.length, loadPageData]);
  const textLines = pageData.get(sourcePage)?.lines ?? [];

  const requestThumb = useCallback(
    (source: number) => {
      const queue = thumbQueue.current;
      queue.pending.add(source);
      if (queue.running) return;
      queue.running = true;
      void (async () => {
        while (queue.pending.size) {
          const next = queue.pending.values().next().value as number;
          queue.pending.delete(next);
          const info = open?.pages[next];
          if (!info) continue;
          const generation = queue.generation;
          try {
            const png = await api().renderPage(next, Math.min(0.5, 220 / Math.max(info.width, info.height)));
            // A different document was opened while this page rendered.
            if (generation !== queue.generation) continue;
            setThumbs((current) => {
              if (current.has(next)) return current;
              return new Map(current).set(next, pngUrl(png));
            });
          } catch {
            break;
          }
        }
        queue.running = false;
      })();
    },
    [open?.pages],
  );

  useEffect(() => {
    if (!open || !doc.pageOrder.length) return;
    setSaving(true);
    const timer = window.setTimeout(() => {
      void saveProject({ id: open.id, name: open.name, bytes: open.bytes, snapshot: doc })
        .then(refreshRecent)
        .catch((cause) => fail(cause, "Autosave failed."))
        .finally(() => setSaving(false));
    }, 600);
    return () => {
      window.clearTimeout(timer);
      setSaving(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id, open?.name, open?.bytes, doc, refreshRecent]);

  useEffect(() => {
    if (page >= doc.pageOrder.length && doc.pageOrder.length > 0) setPage(doc.pageOrder.length - 1);
  }, [doc.pageOrder.length, page, setPage]);

  // Fit uses the document's most common page size, so scrolling past an odd
  // landscape page doesn't make the zoom jump.
  const typicalPage = useMemo(() => {
    const counts = new Map<string, { width: number; height: number; count: number }>();
    for (const source of doc.pageOrder) {
      const info = open?.pages[source];
      if (!info) continue;
      const sideways = (((doc.rotations[source] ?? 0) % 360) + 360) % 180 !== 0;
      const width = Math.round(sideways ? info.height : info.width);
      const height = Math.round(sideways ? info.width : info.height);
      const key = `${width}x${height}`;
      const entry = counts.get(key) ?? { width, height, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
  }, [doc.pageOrder, doc.rotations, open?.pages]);
  useLayoutEffect(() => {
    if (!fit || !typicalPage || !stageRef.current) return;
    const apply = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const { width, height } = typicalPage;
      const margin = window.innerWidth < 760 ? 16 : 48;
      const byWidth = (stage.clientWidth - margin) / width;
      const next = fit === "width" ? Math.min(byWidth, 1.5) : Math.min(byWidth, (stage.clientHeight - margin) / height);
      setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [fit, typicalPage, setZoom, showRail, showComments]);

  const zoomTo = useCallback(
    (next: number) => {
      setFit(null);
      setZoom(next);
    },
    [setZoom],
  );

  useEffect(() => {
    try {
      localStorage.setItem("paperless:reading-theme", readingTheme);
    } catch {
      // Private browsing: the theme just isn't remembered.
    }
  }, [readingTheme]);
  useEffect(() => {
    if (!isPhone || !stageElement) return;
    let timer = window.setTimeout(() => setPillShown(false), 1800);
    const show = () => {
      setPillShown(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPillShown(false), 1500);
    };
    stageElement.addEventListener("scroll", show, { passive: true });
    return () => {
      window.clearTimeout(timer);
      stageElement.removeEventListener("scroll", show);
    };
  }, [isPhone, stageElement]);
  // Tools need the chrome; reading full screen is only for browsing.
  useEffect(() => {
    if (tool !== "select" || trayOpen) setImmersive(false);
  }, [tool, trayOpen]);

  const closeDocument = useCallback(() => {
    resetView();
    setOpen(null);
    setNotice("");
    setError("");
    setDialog(null);
    void refreshRecent();
     
  }, [refreshRecent]);

  useEffect(() => {
    let dispose = () => undefined;
    void registerBackHandler(() => {
      if (passwordRequest) {
        answerPassword(null);
        return true;
      }
      if (dialog) {
        if (dialog !== "ocr" || !ocrRunning) setDialog(null);
        return true;
      }
      if (showComments) {
        setShowComments(false);
        return true;
      }
      if (originalEdit || editingId || selectedId) {
        setOriginalEdit(null);
        setEditingId(null);
        setSelectedId(null);
        return true;
      }
      if (open) {
        closeDocument();
        return true;
      }
      return false;
    }).then((cleanup) => {
      dispose = cleanup;
    });
    return () => dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dialog, showComments, originalEdit, editingId, selectedId, passwordRequest, ocrRunning, closeDocument]);

  const generated = useMemo(() => layoutOverlays(doc.layout, doc.pageOrder, open?.pages ?? []), [doc.layout, doc.pageOrder, open?.pages]);
  const current = useMemo(() => doc.overlays.filter((item) => item.page === sourcePage), [doc.overlays, sourcePage]);
  const overlaysByPage = useMemo(() => {
    const byPage = new Map<number, Overlay[]>();
    const push = (overlay: Overlay) => byPage.set(overlay.page, [...(byPage.get(overlay.page) ?? []), overlay]);
    generated.filter((item) => item.kind === "background").forEach(push);
    doc.overlays.forEach(push);
    generated.filter((item) => item.kind !== "background").forEach(push);
    return byPage;
  }, [generated, doc.overlays]);
  const selected = current.find((item) => item.id === selectedId) ?? null;

  const edited =
    !!open &&
    (doc.overlays.length > 0 ||
      doc.layout !== null ||
      Object.values(doc.rotations).some((value) => value % 360 !== 0) ||
      Object.keys(doc.crops).length > 0 ||
      JSON.stringify(doc.metadata) !== JSON.stringify(open.initialMetadata) ||
      JSON.stringify(doc.formValues) !== JSON.stringify(open.initialFormValues) ||
      doc.pageOrder.some((item, index) => item !== index) ||
      doc.pageOrder.length !== open.pages.length ||
      Boolean(open.password) ||
      security.userPassword !== "" ||
      security.ownerPassword !== "" ||
      security.sanitizeMetadata ||
      security.flattenForms ||
      certificate !== null);

  const exportRequest = (overrides: { pageOrder?: number[] } = {}) => ({
    overlays: [...doc.overlays, ...generated],
    rotations: doc.rotations,
    pageOrder: overrides.pageOrder ?? doc.pageOrder,
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
  });

  const missingGlyphWarning = (missing: string[]) =>
    missing.length
      ? ` ${missing.length} character${missing.length === 1 ? "" : "s"} (${missing.slice(0, 8).join(" ")}) could not be drawn with the bundled fonts and were left blank.`
      : "";

  const download = async () => {
    if (!open || exporting) return;
    setError("");
    setNotice("");
    setExporting(true);
    try {
      let bytes = new Uint8Array(open.bytes);
      let filename = open.name;
      let summary = "";
      if (edited) {
        if (certificate && (security.userPassword || security.ownerPassword))
          throw new Error("Certificate signing and password encryption must be exported separately so the signature remains valid.");
        setNotice("Preparing and validating your PDF…");
        await withTimeout(engine.current!.ready, 20_000, "The PDF exporter did not start.");
        const result = await withTimeout(api().exportDocument(exportRequest()), 120_000, "Export timed out. Your edits are still saved locally; please try again.");
        bytes = new Uint8Array(result.bytes.byteLength);
        bytes.set(result.bytes);
        if (certificate) {
          setNotice("Applying the certificate-backed digital signature locally…");
          bytes = await signPdfWithCertificate(bytes, certificate.bytes, certificatePassphrase, {
            reason: signatureReason,
            name: settings.signatureName || settings.reviewAuthor || "Signer",
            location: signatureLocation,
            contactInfo: signatureContact,
          });
        }
        filename = `${baseName(open.name)}-edited.pdf`;
        setLastAudit({ generatedAt: new Date().toISOString(), document: open.name, pages: result.redactionPages.map((item) => item + 1), areas: result.redactionCount, verified: true });
        summary = `Export verified: ${result.pageCount} page${result.pageCount === 1 ? "" : "s"}${result.redactionCount ? `, ${result.redactionCount} redaction${result.redactionCount === 1 ? "" : "s"}` : ""}${certificate ? ", digitally signed" : ""}.${missingGlyphWarning(result.missingGlyphs)}`;
      }
      const message = await withTimeout(savePdf(bytes, filename), 45_000, "The save dialog did not open. Please try again.");
      setNotice(summary ? `${summary} ${message}.` : `${message}.`);
    } catch (cause) {
      setNotice("");
      fail(cause, "PDF export failed validation.");
    } finally {
      setExporting(false);
    }
  };

  const exportPages = async (order: number[], filename: string, label: string) => {
    if (!open) return;
    setExporting(true);
    setError("");
    try {
      const result = await api().exportDocument(exportRequest({ pageOrder: order }));
      const message = await savePdf(result.bytes, filename);
      setNotice(`${label} ${message}.${missingGlyphWarning(result.missingGlyphs)}`);
    } catch (cause) {
      fail(cause, "Page export failed.");
    } finally {
      setExporting(false);
    }
  };

  /** The current document with all edits applied, never password protected. */
  const renderedExport = async (order = doc.pageOrder) => {
    const result = await withTimeout(api().exportDocument({ ...exportRequest({ pageOrder: order }), encryption: undefined }), 120_000, "Preparing the document took too long.");
    return result.bytes;
  };
  const printDocument = async () => {
    if (!open) return;
    setBusy("Preparing to print…");
    setError("");
    try {
      const bytes = await renderedExport();
      if (isNativePlatform) {
        await savePdf(bytes, `${baseName(open.name)}-print.pdf`);
        return;
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/pdf" }));
      const frame = document.createElement("iframe");
      frame.className = "printFrame";
      frame.src = url;
      frame.onload = () => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          window.open(url, "_blank");
        }
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 120_000);
      };
      document.body.append(frame);
    } catch (cause) {
      fail(cause, "The document could not be prepared for printing.");
    } finally {
      setBusy("");
    }
  };
  const savePageImage = async () => {
    if (!open) return;
    setBusy("Rendering image…");
    try {
      const png = await api().renderBytes(await renderedExport([sourcePage]), 0, 200 / 72);
      const message = await downloadBlob(new Blob([new Uint8Array(png)], { type: "image/png" }), `${baseName(open.name)}-page-${page + 1}.png`);
      setNotice(`Page ${page + 1} saved as a 200 dpi PNG. ${message}.`);
    } catch (cause) {
      fail(cause, "The page could not be saved as an image.");
    } finally {
      setBusy("");
    }
  };
  const exportText = async () => {
    if (!open) return;
    setBusy("Extracting text…");
    try {
      const pages = await api().textOfBytes(await renderedExport());
      const text = pages.map((content, index) => `--- Page ${index + 1} ---\n${content.trim()}`).join("\n\n");
      const message = await downloadBlob(new Blob([text], { type: "text/plain" }), `${baseName(open.name)}.txt`);
      setNotice(`Text of ${pages.length} page${pages.length === 1 ? "" : "s"} saved. ${message}.`);
    } catch (cause) {
      fail(cause, "Text export failed.");
    } finally {
      setBusy("");
    }
  };

  /** Adds pages to the source and splices them into the page order (undoable). */
  const appendPages = async (operation: AppendOperation, at: number, message: string, copyOverlaysFrom?: number) => {
    if (!open) return;
    setBusy("Updating pages…");
    setError("");
    try {
      const outcome = await withPassword(operation.type === "pdf" ? "the inserted PDF" : open.name, (password) =>
        api().appendPages(operation.type === "pdf" ? { ...operation, bytes: operation.bytes.slice(0), password } : operation),
      );
      if (!outcome) return;
      const result = outcome.value;
      const added = Array.from({ length: result.count }, (_, index) => result.firstIndex + index);
      const commands: Command[] = [{ type: "setPageOrder", before: doc.pageOrder, after: [...doc.pageOrder.slice(0, at), ...added, ...doc.pageOrder.slice(at)] }];
      if (copyOverlaysFrom !== undefined) {
        const copies = doc.overlays
          .filter((overlay) => overlay.page === copyOverlaysFrom)
          .map((overlay) => ({ ...overlay, id: crypto.randomUUID(), page: result.firstIndex }));
        if (copies.length) commands.push({ type: "addMany", overlays: copies });
        if (doc.rotations[copyOverlaysFrom]) commands.push({ type: "rotate", page: result.firstIndex, before: 0, after: doc.rotations[copyOverlaysFrom]! });
        const crop = doc.crops[copyOverlaysFrom];
        if (crop) commands.push({ type: "setCrop", page: result.firstIndex, before: null, after: crop });
      }
      const bytes = new Uint8Array(result.bytes.byteLength);
      bytes.set(result.bytes);
      setOpen((currentDoc) =>
        currentDoc && {
          ...currentDoc,
          bytes: bytes.buffer,
          pages: result.pages,
          formFields: result.formFields,
          initialFormValues: { ...Object.fromEntries(result.formFields.map((field) => [field.name, field.value])), ...currentDoc.initialFormValues },
        },
      );
      execute({ type: "batch", commands });
      setPage(at);
      setNotice(`${message} Undo removes ${result.count === 1 ? "it" : "them"} again.`);
    } catch (cause) {
      fail(cause, "The page operation failed.");
    } finally {
      setBusy("");
    }
  };

  const movePage = (index: number, target: number) => {
    if (target < 0 || target >= doc.pageOrder.length || target === index) return;
    const after = [...doc.pageOrder];
    const [moved] = after.splice(index, 1);
    after.splice(target, 0, moved!);
    execute({ type: "setPageOrder", before: doc.pageOrder, after });
    setPage(target);
  };
  const removePages = (indexes: number[]) => {
    const remove = new Set(indexes);
    if (remove.size >= doc.pageOrder.length) {
      setError("A PDF must keep at least one page.");
      return;
    }
    const after = doc.pageOrder.filter((_, index) => !remove.has(index));
    execute({ type: "setPageOrder", before: doc.pageOrder, after });
    setPage(Math.min(Math.min(...indexes), after.length - 1));
    setSelectedPages([]);
  };
  const rotatePages = (sources: number[], delta: number) => {
    const commands: Command[] = sources.map((source) => ({ type: "rotate", page: source, before: doc.rotations[source] ?? 0, after: (doc.rotations[source] ?? 0) + delta }));
    execute(commands.length === 1 ? commands[0]! : { type: "batch", commands });
  };

  const addOverlays = (overlays: Overlay[]) => {
    if (!overlays.length) return;
    execute(overlays.length === 1 ? { type: "add", overlay: overlays[0]! } : { type: "addMany", overlays });
    const last = overlays.at(-1)!;
    setSelectedId(last.id);
    if (["text", "attachment", "note", "stamp", "formField", "visualSignature"].includes(last.kind)) setTool("select");
    if (last.kind === "attachment") updateSettings({ pendingAttachment: null });
  };
  const update = (before: Overlay, after: Overlay, merge?: string) => execute({ type: "updateOverlay", before, after }, merge);
  const updateSelected = (patch: Partial<Overlay>, merge?: string) => {
    if (selected) update(selected, { ...selected, ...patch } as Overlay, merge);
  };
  const updateText = (overlay: TextOverlay, patch: Partial<TextOverlay>, merge?: string) => {
    const next = { ...overlay, ...patch };
    const refit = ["size", "fontFamily", "bold", "italic", "letterSpacing", "lineHeight", "fitMode"].some((key) => key in patch);
    update(overlay, refit && pageInfo ? { ...next, ...fitTextBox(next, next.text, pageInfo, next.text) } : next, merge);
  };
  const deleteSelected = () => {
    if (!selected) return;
    execute({ type: "remove", overlay: selected });
    setSelectedId(null);
    setEditingId(null);
  };
  const duplicateOverlay = (overlay: Overlay, offset = 0.02) => {
    const shifted: Overlay =
      "points" in overlay
        ? ({ ...overlay, points: overlay.points.map((point) => ({ x: Math.min(1, point.x + offset), y: Math.min(1, point.y + offset) })) } as Overlay)
        : "x" in overlay
          ? ({ ...overlay, x: Math.min(1 - overlay.width, overlay.x + offset), y: Math.min(1 - overlay.height, overlay.y + offset) } as Overlay)
          : overlay;
    const copy = { ...shifted, id: crypto.randomUUID(), page: sourcePage } as Overlay;
    execute({ type: "add", overlay: copy });
    setSelectedId(copy.id);
  };
  const nudge = (overlay: Overlay, dx: number, dy: number) => {
    const bounds = boundsOf(overlay);
    const sx = Math.min(1 - bounds.x - bounds.width, Math.max(-bounds.x, dx));
    const sy = Math.min(1 - bounds.y - bounds.height, Math.max(-bounds.y, dy));
    const moved =
      "points" in overlay
        ? ({ ...overlay, points: overlay.points.map((point) => ({ x: point.x + sx, y: point.y + sy })) } as Overlay)
        : ({ ...overlay, x: bounds.x + sx, y: bounds.y + sy } as Overlay);
    update(overlay, moved, `nudge:${overlay.id}`);
  };

  const addImage = async (file: File) => {
    if (!open || !pageInfo || !/^image\/(png|jpe?g)$/.test(file.type)) {
      setError("Choose a PNG or JPEG image.");
      return;
    }
    const dataUrl = await readAsDataUrl(file);
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
      element.onerror = reject;
      element.src = dataUrl;
    });
    let width = 0.35;
    let height = width * (dimensions.height / dimensions.width) * (pageInfo.width / pageInfo.height);
    if (height > 0.5) {
      width *= 0.5 / height;
      height = 0.5;
    }
    addOverlays([{ id: crypto.randomUUID(), page: sourcePage, kind: "image", x: (1 - width) / 2, y: (1 - height) / 2, width, height, dataUrl, name: file.name, opacity: 1, rotation: 0 }]);
    setTool("select");
  };

  const chooseAttachment = async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      setError("Attachments are limited to 15 MB.");
      return;
    }
    updateSettings({ pendingAttachment: { name: file.name, mimeType: file.type || "application/octet-stream", dataUrl: await readAsDataUrl(file) } });
    setTab("comment");
    setTool("attachment");
    setNotice(`Tap the page to place ${file.name}.`);
  };

  const exportReviews = () => {
    const payload = JSON.stringify({ format: "paperless-review-v1", document: open?.name ?? "", exportedAt: new Date().toISOString(), annotations: doc.overlays.filter(isReviewOverlay) }, null, 2);
    void downloadBlob(new Blob([payload], { type: "application/json" }), `${baseName(open?.name ?? "document")}-review.json`);
  };
  const importReviews = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { annotations?: unknown[] };
      const imported: ReviewOverlay[] = [];
      for (const item of parsed.annotations ?? []) {
        const result = OverlaySchema.safeParse(item);
        if (result.success && isReviewOverlay(result.data) && doc.pageOrder.includes(result.data.page)) imported.push({ ...result.data, id: crypto.randomUUID() });
      }
      if (!imported.length) throw new Error("No compatible Paperless review annotations were found.");
      execute({ type: "addMany", overlays: imported });
      setNotice(`Imported ${imported.length} review annotations.`);
    } catch (cause) {
      fail(cause, "Review import failed.");
    }
  };

  const replaceSelectedImage = async (file: File) => {
    if (selected?.kind !== "image" || !file.type.startsWith("image/")) return;
    update(selected, { ...selected, dataUrl: await readAsDataUrl(file), name: file.name });
  };
  const extractSelectedImage = () => {
    if (selected?.kind !== "image") return;
    void downloadBlob(dataUrlToBlob(selected.dataUrl), selected.name || "image.png");
  };
  const openNativeImages = async () => {
    setBusy("Finding images…");
    setError("");
    try {
      const images = await api().extractPageImages(sourcePage);
      setPageImages(images);
      setDialog("pageImages");
    } catch (cause) {
      fail(cause, "Page images could not be extracted.");
    } finally {
      setBusy("");
    }
  };
  /** Turns an image that is part of the page into an object that can be moved, resized, rotated or deleted. */
  const liftImage = async (source: number, box: PageImageBox) => {
    setBusy("Preparing image…");
    try {
      const image = (await api().extractPageImages(source)).find((item) => item.id === box.id);
      if (!image) throw new Error("That image could not be read.");
      const area = { x: box.x, y: box.y, width: box.width, height: box.height };
      const overlay: Overlay = { id: crypto.randomUUID(), page: source, kind: "image", ...area, dataUrl: image.dataUrl, name: `page-${doc.pageOrder.indexOf(source) + 1}-image.png`, opacity: 1, rotation: 0 };
      execute({ type: "addMany", overlays: [{ id: crypto.randomUUID(), page: source, kind: "redact", ...area, color: "#ffffff", mode: "eraseImage" }, overlay] });
      setSelectedId(overlay.id);
      setNotice("Drag to move, use the handles to resize or rotate, or press Delete to remove the image.");
    } catch (cause) {
      fail(cause, "The image could not be edited.");
    } finally {
      setBusy("");
    }
  };
  const replaceNativeImage = async (file: File) => {
    if (!nativeReplace || !file.type.startsWith("image/")) return;
    const target = nativeReplace;
    const area = { x: target.x, y: target.y, width: target.width, height: target.height };
    const replacement: Overlay = { id: crypto.randomUUID(), page: sourcePage, kind: "image", ...area, dataUrl: await readAsDataUrl(file), name: file.name, opacity: 1, rotation: 0 };
    execute({ type: "addMany", overlays: [{ id: crypto.randomUUID(), page: sourcePage, kind: "redact", ...area, color: "#ffffff", mode: "eraseImage" }, replacement] });
    setNativeReplace(null);
    setDialog(null);
    setSelectedId(replacement.id);
    setTool("select");
    setNotice("The embedded image will be replaced in the exported PDF.");
  };
  const cropSelectedImage = async () => {
    if (selected?.kind !== "image" || !open) return;
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const item = new Image();
      item.onload = () => resolve(item);
      item.onerror = reject;
      item.src = selected.dataUrl;
    });
    const [left, top, right, bottom] = [imageCrop.left, imageCrop.top, imageCrop.right, imageCrop.bottom].map((value) => value / 100) as [number, number, number, number];
    const sourceWidth = Math.max(1, Math.round(element.naturalWidth * (1 - left - right)));
    const sourceHeight = Math.max(1, Math.round(element.naturalHeight * (1 - top - bottom)));
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image cropping is unavailable on this device.");
    context.drawImage(element, element.naturalWidth * left, element.naturalHeight * top, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    update(selected, {
      ...selected,
      x: selected.x + selected.width * left,
      y: selected.y + selected.height * top,
      width: Math.max(0.01, selected.width * (1 - left - right)),
      height: Math.max(0.01, selected.height * (1 - top - bottom)),
      dataUrl: canvas.toDataURL("image/png"),
      name: selected.name?.replace(/\.[^.]+$/, "-cropped.png") ?? "cropped-image.png",
    });
    setDialog(null);
    setImageCrop({ left: 0, top: 0, right: 0, bottom: 0 });
  };

  const arrangeSelected = (where: "front" | "back") => {
    const index = doc.overlays.findIndex((overlay) => overlay.id === selectedId);
    if (index < 0) return;
    const after = [...doc.overlays];
    const [item] = after.splice(index, 1);
    if (where === "front") after.push(item!);
    else after.unshift(item!);
    execute({ type: "setOverlayOrder", before: doc.overlays, after });
  };
  const alignSelected = (alignment: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (!selected || !("x" in selected) || !("width" in selected)) return;
    const x = alignment === "left" ? 0.04 : alignment === "center" ? (1 - selected.width) / 2 : alignment === "right" ? 0.96 - selected.width : selected.x;
    const y = alignment === "top" ? 0.04 : alignment === "middle" ? (1 - selected.height) / 2 : alignment === "bottom" ? 0.96 - selected.height : selected.y;
    update(selected, { ...selected, x: Math.max(0, x), y: Math.max(0, y) } as Overlay);
  };

  const legacyLayout = doc.overlays.filter((overlay) => overlay.kind === "background" || (overlay.kind === "text" && overlay.layoutRole));
  const setLayout = (after: EditorDocument["layout"]) => {
    const commands: Command[] = [{ type: "setLayout", before: doc.layout, after }];
    // Projects from older versions stored layout as plain overlays.
    if (legacyLayout.length) commands.push({ type: "removeMany", overlays: legacyLayout });
    execute({ type: "batch", commands });
  };
  const applyLayout = () => {
    const { useBackground, background, ...text } = layoutDraft;
    const empty = !text.header && !text.footer && !text.watermark && !text.batesPrefix && !useBackground;
    setLayout(empty ? null : { ...text, background: useBackground ? background : null });
    setDialog(null);
    setNotice(empty ? "Header, footer and watermark removed." : `Layout applied to all ${doc.pageOrder.length} pages. It updates automatically as pages change.`);
  };
  const openLayout = () => {
    const saved = doc.layout;
    if (saved) setLayoutDraft({ ...saved, useBackground: saved.background !== null, background: saved.background ?? "#ffffff" });
    setDialog("layout");
  };

  const estimateCompression = async () => {
    setEstimatingCompression(true);
    setError("");
    try {
      setCompressionEstimate((await api().exportDocument(exportRequest())).bytes.byteLength);
    } catch (cause) {
      fail(cause, "Compression estimate failed.");
    } finally {
      setEstimatingCompression(false);
    }
  };

  // --- original text replacement ---------------------------------------

  const replacementText = (line: PositionedTextLine, text: string, source: number, x = line.x): TextOverlay | null => {
    const info = open?.pages[source];
    if (!info || !text) return null;
    const style = { ...line, x, width: line.width, height: line.height, fitMode: "auto" as const, lineHeight: 1.2 };
    const box = fitTextBox(style, text, info);
    return {
      id: crypto.randomUUID(),
      page: source,
      kind: "text",
      x,
      y: topForBaseline(style, line.baseline, info),
      ...box,
      text,
      size: line.size,
      color: line.color,
      fontFamily: line.fontFamily,
      fontName: line.fontName || null,
      bold: line.bold,
      italic: line.italic,
      underline: false,
      alignment: line.alignment,
      lineHeight: 1.2,
      letterSpacing: line.letterSpacing,
      fitMode: "auto",
    };
  };
  /**
   * Erases a line of text. Only a band from just below the x-height to the
   * baseline is erased: every glyph of the line crosses it, while glyph boxes
   * of tightly spaced neighbouring lines never reach it.
   */
  const eraseBox = (line: { x: number; width: number; baseline: number; size: number }, source: number): Overlay => {
    const pageHeight = open?.pages[source]?.height ?? 792;
    const pad = 0.0015;
    const y = Math.max(0, line.baseline - (0.7 * line.size) / pageHeight);
    return {
      id: crypto.randomUUID(),
      page: source,
      kind: "redact",
      x: Math.max(0, line.x - pad),
      y,
      width: Math.min(1, line.width + pad * 2),
      height: Math.min(1 - y, (0.65 * line.size) / pageHeight),
      color: "#ffffff",
      mode: "eraseText",
    };
  };
  const buildReplacement = (edit: OriginalEdit) => {
    const source = edit.source;
    const info = open?.pages[source];
    if (!info) return { overlays: [] as Overlay[], selectId: null as string | null };
    const line = edit.line;
    if (edit.paragraph) {
      // One box that reflows within the paragraph's width.
      const paragraph = edit.paragraph;
      const erase = paragraph.lines.map((item) => eraseBox(item, source));
      if (!edit.draft.trim()) return { overlays: erase, selectId: null };
      const style = { ...line, x: paragraph.x, width: reflowWidth(paragraph), height: paragraph.height, fitMode: "auto" as const };
      const overlay: TextOverlay = {
        id: crypto.randomUUID(),
        page: source,
        kind: "text",
        x: paragraph.x,
        y: topForBaseline(style, paragraph.lines[0]!.baseline, info),
        width: style.width,
        height: Math.max(paragraph.height, layoutStyled(style, edit.draft, info).height / info.height),
        text: edit.draft,
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
        fitMode: "auto",
      };
      return { overlays: [...erase, overlay], selectId: overlay.id };
    }
    // Runs on the same baseline that touch the edited run form one mixed-style
    // line; separate cells or columns further away are left alone.
    const sameBaseline = edit.lines.filter((candidate) => Math.abs(candidate.baseline - line.baseline) < 0.002).sort((a, b) => a.x - b.x);
    const position = sameBaseline.findIndex((run) => run.id === line.id);
    const near = (left: PositionedTextLine, right: PositionedTextLine) => (right.x - (left.x + left.width)) * info.width < Math.max(left.size, right.size) * 1.2;
    let first = position;
    let last = position;
    while (first > 0 && near(sameBaseline[first - 1]!, sameBaseline[first]!)) first -= 1;
    while (last >= 0 && last < sameBaseline.length - 1 && near(sameBaseline[last]!, sameBaseline[last + 1]!)) last += 1;
    const runs = position < 0 ? [] : sameBaseline.slice(first, last + 1);
    if (runs.length < 2) {
      const text = replacementText(line, edit.draft, source);
      return { overlays: [eraseBox(line, source), ...(text ? [text] : [])], selectId: text?.id ?? null };
    }
    // Mixed-style line: re-flow every run so later runs move with the edit.
    const left = Math.min(...runs.map((run) => run.x));
    const right = Math.max(...runs.map((run) => run.x + run.width));
    const overlays: Overlay[] = [eraseBox({ x: left, width: right - left, baseline: line.baseline, size: Math.max(...runs.map((run) => run.size)) }, source)];
    // Runs before the edited one stay put; later runs keep their original
    // gaps but shift with the edited run's new width.
    const editedIndex = runs.findIndex((run) => run.id === line.id);
    let cursor = 0;
    let selectId: string | null = null;
    runs.forEach((run, index) => {
      const isEdited = index === editedIndex;
      const text = isEdited ? edit.draft : run.text;
      const styled = isEdited ? { ...run, ...line, id: run.id } : run;
      const previous = runs[index - 1];
      const start = index <= editedIndex ? run.x : cursor + (previous ? run.x - (previous.x + previous.width) : 0);
      const overlay = replacementText({ ...styled, x: start }, text, source, start);
      if (overlay) {
        const natural = layoutStyled({ ...overlay, fitMode: "overflow" }, text, info).width / info.width;
        overlay.width = Math.max(0.01, natural + (overlay.size * 0.1) / info.width);
        overlays.push(overlay);
        if (isEdited) selectId = overlay.id;
        cursor = start + natural;
      } else cursor = start;
    });
    return { overlays, selectId };
  };
  const commitOriginalEdit = (edit: OriginalEdit | null, select: boolean) => {
    if (!edit) return;
    setOriginalEdit(null);
    const extracted = edit.lines.find((line) => line.id === edit.line.id);
    if (edit.paragraph) {
      const original = { ...extracted, alignment: edit.paragraph.alignment, lineHeight: edit.paragraph.lineHeight };
      if (edit.draft === edit.paragraph.text && JSON.stringify(original) === JSON.stringify(edit.line)) return;
    } else if (edit.draft === edit.line.text && JSON.stringify(extracted) === JSON.stringify(edit.line)) return;
    const { overlays, selectId } = buildReplacement(edit);
    if (!overlays.length) return;
    execute({ type: "addMany", overlays });
    setSelectedId(select ? selectId : null);
  };

  // Leaving a page keeps an unfinished text edit instead of dropping it.
  const pendingEdit = useRef<{ edit: OriginalEdit | null; commit: typeof commitOriginalEdit }>({ edit: null, commit: commitOriginalEdit });
  pendingEdit.current = { edit: originalEdit, commit: commitOriginalEdit };
  useEffect(() => {
    const { edit, commit } = pendingEdit.current;
    if (edit && edit.source !== sourcePage) commit(edit, false);
  }, [sourcePage]);

  // --- find & replace ----------------------------------------------------

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
      const erasedOn = (source: number, line: PositionedTextLine) =>
        doc.overlays.some(
          (overlay) =>
            overlay.page === source &&
            overlay.kind === "redact" &&
            line.x + line.width / 2 >= overlay.x &&
            line.x + line.width / 2 <= overlay.x + overlay.width &&
            line.y + line.height / 2 >= overlay.y &&
            line.y + line.height / 2 <= overlay.y + overlay.height,
        );
      for (const source of doc.pageOrder) {
        const lines = await withTimeout(api().extractTextLines(source), 20_000, `Text search timed out on page ${doc.pageOrder.indexOf(source) + 1}.`);
        for (const line of lines)
          if ((matchCase ? line.text : line.text.toLocaleLowerCase()).includes(needle) && !erasedOn(source, line)) results.push({ sourcePage: source, line });
        for (const overlay of doc.overlays) {
          if (overlay.kind !== "text" || overlay.page !== source) continue;
          if (!(matchCase ? overlay.text : overlay.text.toLocaleLowerCase()).includes(needle)) continue;
          results.push({
            sourcePage: source,
            overlayId: overlay.id,
            line: { id: overlay.id, text: overlay.text, x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height, baseline: overlay.y, size: overlay.size, color: overlay.color, fontFamily: overlay.fontFamily, fontName: overlay.fontName ?? overlay.fontFamily, bold: overlay.bold, italic: overlay.italic, alignment: overlay.alignment, lineHeight: overlay.lineHeight, letterSpacing: overlay.letterSpacing, fitMode: overlay.fitMode },
          });
        }
      }
      setFindResults(results);
    } catch (cause) {
      fail(cause, "Document search failed.");
    } finally {
      setSearching(false);
    }
  };
  const showResult = (result: FindResult) => {
    const index = doc.pageOrder.indexOf(result.sourcePage);
    if (index >= 0) {
      viewRef.current?.scrollToPage(index, result.line.y);
      setPage(index);
    }
    setTool("select");
    setSearchHighlight({ sourcePage: result.sourcePage, rect: { x: result.line.x, y: result.line.y, width: result.line.width, height: result.line.height } });
  };
  const replaceAllMatches = () => {
    if (!findResults?.length || !findQuery) return;
    const expression = new RegExp(findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
    const commands: Command[] = [];
    let count = 0;
    for (const result of findResults) {
      const replacement = result.line.text.replace(expression, replaceQuery);
      if (replacement === result.line.text) continue;
      count += 1;
      if (result.overlayId) {
        const original = doc.overlays.find((overlay) => overlay.id === result.overlayId);
        if (original?.kind === "text") commands.push({ type: "updateOverlay", before: original, after: { ...original, text: replacement } });
      } else {
        const text = replacementText(result.line, replacement, result.sourcePage);
        commands.push({ type: "addMany", overlays: [eraseBox(result.line, result.sourcePage), ...(text ? [text] : [])] });
      }
    }
    if (commands.length) execute({ type: "batch", commands });
    setNotice(`Replaced ${count} occurrence${count === 1 ? "" : "s"} across the document. Undo reverts all of them.`);
    setFindResults(null);
    setSearchHighlight(null);
    setDialog(null);
  };

  // --- OCR ------------------------------------------------------------------

  const runOcr = async () => {
    if (!open || ocrRunning) return;
    const pages = ocrScope === "document" ? [...doc.pageOrder] : [sourcePage];
    setOcrRunning(true);
    setError("");
    setOcrProgress("Loading the on-device OCR engine…");
    let recognizer: Awaited<ReturnType<typeof createOcrRecognizer>> | null = null;
    try {
      recognizer = await createOcrRecognizer({ language: ocrLanguage, enhancement: scanEnhancement, autoDeskew }, (message) => setOcrProgress(`${message.status} · ${Math.round(message.progress * 100)}%`));
      const created: TextOverlay[] = [];
      for (let index = 0; index < pages.length; index += 1) {
        const source = pages[index]!;
        setOcrProgress(`Recognising page ${index + 1} of ${pages.length}…`);
        const url = pngUrl(await withTimeout(api().renderPage(source, 2.5), 45_000, `Page ${source + 1} could not be prepared for OCR.`));
        try {
          const lines = await recognizer.recognize(url);
          const info = open.pages[source]!;
          for (const line of lines)
            created.push({ id: crypto.randomUUID(), page: source, kind: "text", x: line.x, y: line.y, width: line.width, height: line.height, text: line.text, size: Math.max(4, line.height * info.height * 0.8), color: "#000000", fontFamily: "Helvetica", fontName: null, bold: false, italic: false, underline: false, alignment: "justify", lineHeight: 1, letterSpacing: 0, fitMode: "shrink", invisible: true, ocrConfidence: line.confidence, ocrSource: true });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const old = doc.overlays.filter((overlay) => overlay.kind === "text" && overlay.ocrSource && pages.includes(overlay.page));
      const commands: Command[] = [];
      if (old.length) commands.push({ type: "removeMany", overlays: old });
      if (created.length) commands.push({ type: "addMany", overlays: created });
      if (commands.length) execute({ type: "batch", commands });
      const low = created.filter((overlay) => (overlay.ocrConfidence ?? 100) < confidenceThreshold).length;
      setNotice(`OCR added ${created.length} searchable lines across ${pages.length} page${pages.length === 1 ? "" : "s"}${low ? `; ${low} need review` : ""}.`);
    } catch (cause) {
      fail(cause, "OCR failed on this document.");
    } finally {
      await recognizer?.terminate().catch(() => undefined);
      setOcrRunning(false);
      setOcrProgress("");
    }
  };

  const pickFile = (handler: (file: File) => unknown) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void handler(file);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (!open && /^image\//.test(file.type)) {
      void createFromImages([...event.dataTransfer.files]);
      return;
    }
    if (open && /^image\//.test(file.type)) void addImage(file);
    else if (open && file.name.toLowerCase().endsWith(".pdf")) void file.arrayBuffer().then((bytes) => appendPages({ type: "pdf", bytes }, doc.pageOrder.length, `${file.name} added at the end.`));
    else void load(file);
  };

  const touchDistance = (event: ReactTouchEvent) => Math.hypot(event.touches[0]!.clientX - event.touches[1]!.clientX, event.touches[0]!.clientY - event.touches[1]!.clientY);
  const beginPinch = (event: ReactTouchEvent) => {
    if (event.touches.length !== 2 || !stageRef.current) return;
    const stage = stageRef.current;
    const rect = stage.getBoundingClientRect();
    const offsetX = (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2 - rect.left;
    const offsetY = (event.touches[0]!.clientY + event.touches[1]!.clientY) / 2 - rect.top;
    pinch.current = { distance: touchDistance(event), zoom, contentX: stage.scrollLeft + offsetX, contentY: stage.scrollTop + offsetY, offsetX, offsetY };
  };
  const movePinch = (event: ReactTouchEvent) => {
    if (event.touches.length !== 2 || !pinch.current || !stageRef.current) return;
    const state = pinch.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (state.zoom * touchDistance(event)) / state.distance));
    const ratio = next / state.zoom;
    zoomTo(next);
    requestAnimationFrame(() => {
      if (!stageRef.current) return;
      stageRef.current.scrollLeft = state.contentX * ratio - state.offsetX;
      stageRef.current.scrollTop = state.contentY * ratio - state.offsetY;
    });
  };
  const endPinch = (event: ReactTouchEvent) => {
    if (event.touches.length < 2) pinch.current = null;
  };

  // Ctrl/⌘ + wheel zooms around the pointer, like other document viewers.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = useEditor.getState().zoom;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * Math.exp(-event.deltaY * 0.0025)));
      const rect = stage.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const contentX = stage.scrollLeft + offsetX;
      const contentY = stage.scrollTop + offsetY;
      zoomTo(next);
      requestAnimationFrame(() => {
        stage.scrollLeft = contentX * (next / current) - offsetX;
        stage.scrollTop = contentY * (next / current) - offsetY;
      });
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [open, zoomTo, stageElement]);

  const goTo = (source: number, top = 0) => {
    const index = doc.pageOrder.indexOf(source);
    if (index < 0) {
      setNotice("That page is not part of the document any more.");
      return;
    }
    viewRef.current?.scrollToPage(index, top, "smooth");
    setPage(index);
  };
  const followLink = (link: PageLink) => {
    if (link.page !== undefined) goTo(link.page, link.top ?? 0);
    else if (link.uri && window.confirm(`Open this link?\n\n${link.uri}`)) window.open(link.uri, "_blank", "noopener,noreferrer");
  };
  /** Interacting with a page that isn't current makes it current without scrolling. */
  const activatePage = (index: number) => {
    if (index === page) return;
    viewRef.current?.markCurrent(index);
    setPage(index);
  };
  const fitWidthZoom = () => {
    const stage = stageRef.current;
    if (!stage || !typicalPage) return zoom;
    const width = typicalPage.width;
    return Math.max(MIN_ZOOM, Math.min(1.5, (stage.clientWidth - (window.innerWidth < 760 ? 16 : 48)) / width));
  };
  const zoomAround = (next: number, clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const rect = stage.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const contentX = stage.scrollLeft + offsetX;
    const contentY = stage.scrollTop + offsetY;
    const ratio = clamped / zoom;
    zoomTo(clamped);
    requestAnimationFrame(() => {
      stage.scrollLeft = contentX * ratio - offsetX;
      stage.scrollTop = contentY * ratio - offsetY;
    });
  };
  // Taps on the page: one toggles full-screen reading on phones, two zoom.
  const tap = useRef({ x: 0, y: 0, at: 0, blocked: false, lastAt: 0, lastX: 0, lastY: 0, timer: 0 });
  const stagePointerDown = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement;
    tap.current.blocked =
      !event.isPrimary ||
      tool !== "select" ||
      Boolean(selectedId || originalEdit || editingId) ||
      Boolean(target.closest(".objectBox, .originalTextHit, .linkHit, .inlineEditor, button, input, textarea, select"));
    tap.current.x = event.clientX;
    tap.current.y = event.clientY;
    tap.current.at = performance.now();
  };
  const stagePointerUp = (event: ReactPointerEvent) => {
    const state = tap.current;
    if (state.blocked || pinch.current || performance.now() - state.at > 350 || Math.hypot(event.clientX - state.x, event.clientY - state.y) > 12) return;
    const now = performance.now();
    if (event.pointerType === "touch" && now - state.lastAt < 320 && Math.hypot(event.clientX - state.lastX, event.clientY - state.lastY) < 40) {
      window.clearTimeout(state.timer);
      state.lastAt = 0;
      const fitted = fitWidthZoom();
      if (zoom > fitted * 1.3) setFit("width");
      else zoomAround(fitted * 2.2, event.clientX, event.clientY);
      return;
    }
    state.lastAt = now;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    window.clearTimeout(state.timer);
    if (isPhone) state.timer = window.setTimeout(() => setImmersive((value) => !value), 330);
  };
  const choosePhoneTab = (id: TabId) => {
    if (trayOpen && tab === id) {
      setTrayOpen(false);
      chooseTool("select");
      return;
    }
    setTab(id);
    setTrayOpen(true);
    if (!tabs.find((item) => item.id === id)?.items.some((entry) => entry.tool === tool)) chooseTool("select");
  };

  const chooseTool = (next: Tool) => {
    if (originalEdit) commitOriginalEdit(originalEdit, false);
    setTool(next);
    setEditingId(null);
    if (next !== "select") setSelectedId(null);
    setSearchHighlight(null);
  };

  // Keyboard shortcuts.
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (passwordRequest || (dialog && dialog !== "find")) return;
      const mod = event.ctrlKey || event.metaKey;
      const lower = event.key.toLowerCase();
      if (mod && lower === "s") {
        event.preventDefault();
        void download();
        return;
      }
      if (mod && lower === "f") {
        event.preventDefault();
        setDialog("find");
        return;
      }
      if (mod && lower === "p") {
        event.preventDefault();
        void printDocument();
        return;
      }
      if (isTyping(event.target) || dialog) return;
      if (mod && lower === "z") {
        event.preventDefault();
        if (event.shiftKey) redoOnce();
        else undoOnce();
        return;
      }
      if (mod && lower === "y") {
        event.preventDefault();
        redoOnce();
        return;
      }
      if (mod && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        zoomTo(zoom * 1.2);
        return;
      }
      if (mod && event.key === "-") {
        event.preventDefault();
        zoomTo(zoom / 1.2);
        return;
      }
      if (mod && event.key === "0") {
        event.preventDefault();
        setFit("width");
        return;
      }
      if (mod && lower === "c" && selected) {
        clipboard.current = selected;
        return;
      }
      if (mod && lower === "v" && clipboard.current) {
        event.preventDefault();
        duplicateOverlay(clipboard.current, clipboard.current.page === sourcePage ? 0.02 : 0);
        return;
      }
      if (mod && lower === "d" && selected) {
        event.preventDefault();
        duplicateOverlay(selected);
        return;
      }
      if (event.key === "Escape") {
        if (originalEdit) setOriginalEdit(null);
        else if (selectedId) setSelectedId(null);
        else if (tool !== "select") chooseTool("select");
        setSearchHighlight(null);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selected) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (selected && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 0.01 : 0.002;
        nudge(selected, event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
        return;
      }
      if (selected?.kind === "text" && event.key === "Enter") {
        event.preventDefault();
        setEditingId(selected.id);
        return;
      }
      if (event.key === "PageDown" || (!selected && event.key === "ArrowRight")) setPage(Math.min(doc.pageOrder.length - 1, page + 1));
      else if (event.key === "PageUp" || (!selected && event.key === "ArrowLeft")) setPage(Math.max(0, page - 1));
      else if (event.key === "Home") setPage(0);
      else if (event.key === "End") setPage(doc.pageOrder.length - 1);
      else if (event.key === "?") setDialog("shortcuts");
      else if (!mod && !event.altKey && toolShortcuts[lower]) {
        const next = toolShortcuts[lower]!;
        setTab(next === "markup" || next === "note" ? "comment" : next === "signature" ? "sign" : "edit");
        chooseTool(next);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  // --- render -----------------------------------------------------------

  const passwordDialog = passwordRequest && (
    <Modal
      title="Password required"
      className="passwordModal"
      onClose={() => answerPassword(null)}
      description={`${passwordRequest.name} is protected. The password is only used on this device.`}
      footer={
        <>
          <button onClick={() => answerPassword(null)}>Cancel</button>
          <button className="primary" disabled={!passwordDraft} onClick={() => answerPassword(passwordDraft)}>
            Unlock
          </button>
        </>
      }
    >
      <label>
        Password
        <input
          autoFocus
          type="password"
          autoComplete="current-password"
          value={passwordDraft}
          onChange={(event) => setPasswordDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && passwordDraft) answerPassword(passwordDraft);
          }}
        />
      </label>
      {passwordRequest.incorrect && <p className="fieldError">That password is incorrect. Try again.</p>}
    </Modal>
  );
  const toasts = (
    <div className="toasts">
      {error && <Toast kind="error" message={error} onDismiss={dismissError} />}
      {notice && <Toast kind="success" message={notice} onDismiss={dismissNotice} />}
    </div>
  );

  if (!open || !pageInfo)
    return (
      <main className="home" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
        <header className="brand">
          <span className="mark">P</span>
          <b>Paperless</b>
          <span className="local">
            <Lock /> Local only
          </span>
        </header>
        <section className="hero">
          <p className="eyebrow">PRIVATE BY DEFAULT</p>
          <h1>
            Edit the PDF.
            <br />
            <em>Keep the document.</em>
          </h1>
          <p>Edit text, sign, fill forms, annotate, redact, and organize pages — without an account, an upload, or a paywall.</p>
          <label className="openButton">
            <FilePlus2 />
            Open a PDF
            <input aria-label="Open PDF" type="file" accept="application/pdf,.pdf" onChange={pickFile(load)} />
          </label>
          <label className="secondaryButton">
            <Images />
            Create a PDF from images
            <input
              aria-label="Create PDF from images"
              type="file"
              multiple
              accept="image/png,image/jpeg"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                void createFromImages(files);
              }}
            />
          </label>
          <p className="dropcopy">or drop a PDF or photos anywhere on this page</p>
          {busy && (
            <p className="busyLine" role="status">
              <span className="spinner" /> {busy}
            </p>
          )}
          {recent.length > 0 && (
            <div className="recents">
              <h2>Continue where you left off</h2>
              {recent.map((project) => (
                <div className="recent" key={project.id}>
                  <button onClick={() => void recover(project.id)}>
                    <FileText />
                    <span>
                      <b>{project.name}</b>
                      <small>
                        {project.pageCount} page{project.pageCount === 1 ? "" : "s"} · {new Date(project.updatedAt).toLocaleString()}
                      </small>
                    </span>
                  </button>
                  <button aria-label={`Remove ${project.name}`} title="Remove from this device" onClick={() => void deleteProject(project.id).then(refreshRecent)}>
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <footer>AGPL-3.0 · No uploads · No analytics</footer>
        {passwordDialog}
        {toasts}
      </main>
    );

  const createdFormFields = doc.overlays.filter((item): item is Extract<Overlay, { kind: "formField" }> => item.kind === "formField");
  const ocrText = doc.overlays.filter((overlay): overlay is TextOverlay => overlay.kind === "text" && Boolean(overlay.ocrSource));
  const lowConfidenceOcr = ocrText.filter((overlay) => (overlay.ocrConfidence ?? 100) < confidenceThreshold);
  const reviewOverlays = doc.overlays.filter(isReviewOverlay);
  const filteredReviews = reviewOverlays.filter((overlay) => commentFilter === "all" || (commentFilter === "resolved" ? overlay.resolved : !overlay.resolved));
  const fontOptions = Array.from(new Set([...textLines.map((line) => line.fontName), ...current.filter((item): item is TextOverlay => item.kind === "text").map((item) => item.fontName || item.fontFamily), ...commonFonts].filter(Boolean)));

  type Item = { key: string; label: string; Icon: typeof MousePointer2; tool?: Tool; action?: () => void; active?: boolean; title?: string; disabled?: boolean };
  const toolItem = (id: Tool, label: string, Icon: typeof MousePointer2, title?: string): Item => ({ key: id, label, Icon, tool: id, title: `${title ?? label}${shortcutFor(id) ? ` (${shortcutFor(id)})` : ""}` });
  const tabs: { id: TabId; label: string; Icon: typeof MousePointer2; items: Item[] }[] = [
    {
      id: "edit",
      label: "Edit",
      Icon: Pencil,
      items: [
        toolItem("select", "Select", MousePointer2, "Select, move and edit — click existing text to change it"),
        toolItem("text", "Add text", Type),
        { key: "image", label: "Image", Icon: ImagePlus, action: () => inputs.image.current?.click(), title: "Place a PNG or JPEG image" },
        toolItem("shape", "Shapes", Shapes),
        toolItem("line", "Line", ArrowUpRight, "Line or arrow"),
        toolItem("ink", "Draw", PenLine),
        toolItem("redact", "Redact", Eraser, "Permanently remove content under a box"),
        { key: "pageImages", label: "Page images", Icon: FileImage, action: () => void openNativeImages(), title: "Extract or replace images in this page" },
      ],
    },
    {
      id: "comment",
      label: "Comment",
      Icon: MessageSquareText,
      items: [
        toolItem("markup", "Highlight", Highlighter, "Highlight, underline or strike text"),
        toolItem("note", "Note", MessageSquareText, "Sticky note or callout"),
        toolItem("stamp", "Stamp", Stamp),
        toolItem("measure", "Measure", Ruler),
        { key: "attach", label: "Attach file", Icon: Paperclip, action: () => inputs.attachment.current?.click() },
        { key: "reviews", label: "All comments", Icon: ListChecks, action: () => setShowComments((value) => !value), active: showComments },
      ],
    },
    {
      id: "sign",
      label: "Fill & Sign",
      Icon: Signature,
      items: [
        toolItem("signature", "Sign", Signature, "Draw, type or place a signature"),
        toolItem("form", "Add field", FileKey2, "Draw a new form field"),
        { key: "forms", label: `Form fields${open.formFields.length + createdFormFields.length ? ` (${open.formFields.length + createdFormFields.length})` : ""}`, Icon: ListChecks, action: () => setDialog("forms"), title: "Fill existing fields and manage new ones" },
        { key: "certificate", label: "Certificate", Icon: ShieldCheck, action: () => setDialog("security"), title: "Certificate-backed digital signature" },
      ],
    },
    {
      id: "pages",
      label: "Pages",
      Icon: Layers,
      items: [
        { key: "organize", label: "Organize", Icon: Layers, action: () => { setSelectedPages([page]); setDialog("pages"); }, title: "Reorder, rotate, delete and extract pages" },
        { key: "rotateLeft", label: "Rotate left", Icon: RotateCcw, action: () => rotatePages([sourcePage], -90) },
        { key: "rotate", label: "Rotate right", Icon: RotateCw, action: () => rotatePages([sourcePage], 90) },
        toolItem("crop", "Crop", Crop, "Drag to crop this page"),
        { key: "blank", label: "Blank page", Icon: FilePlus2, action: () => void appendPages({ type: "blank", width: pageInfo.width, height: pageInfo.height }, page + 1, "Blank page inserted.") },
        { key: "duplicate", label: "Duplicate page", Icon: Copy, action: () => void appendPages({ type: "copy", source: sourcePage }, page + 1, "Page duplicated with its edits.", sourcePage) },
        { key: "insert", label: "Insert PDF", Icon: Merge, action: () => inputs.insertPdf.current?.click(), title: "Insert another PDF after this page" },
        { key: "imagePages", label: "Images as pages", Icon: Images, action: () => inputs.imagePages.current?.click(), title: "Insert photos or scans as new pages" },
        { key: "merge", label: "Append PDF", Icon: FileOutput, action: () => inputs.merge.current?.click(), title: "Add another PDF at the end" },
        { key: "pageImage", label: "Page to image", Icon: ImageDown, action: () => void savePageImage(), title: "Save this page as a PNG image" },
        { key: "extract", label: "Extract page", Icon: FileOutput, action: () => void exportPages([sourcePage], `${baseName(open.name)}-page-${page + 1}.pdf`, `Page ${page + 1} exported.`), title: "Save this page as its own PDF" },
        { key: "layout", label: "Header & footer", Icon: LayoutTemplate, action: openLayout, title: "Headers, footers, page numbers, watermark, Bates numbering" },
        { key: "deletePage", label: "Delete page", Icon: Trash2, action: () => removePages([page]), disabled: doc.pageOrder.length < 2 },
      ],
    },
    {
      id: "tools",
      label: "Tools",
      Icon: Wrench,
      items: [
        { key: "find", label: "Find & replace", Icon: Search, action: () => setDialog("find") },
        {
          key: "theme",
          label: readingTheme === "day" ? "Night mode" : readingTheme === "night" ? "Sepia" : "Day mode",
          Icon: Moon,
          action: () => setReadingTheme(readingTheme === "day" ? "night" : readingTheme === "night" ? "sepia" : "day"),
          title: "Change how pages look while reading (not the exported file)",
          active: readingTheme !== "day",
        },
        { key: "print", label: "Print", Icon: Printer, action: () => void printDocument(), title: "Print with all edits (Ctrl+P)" },
        { key: "text", label: "Export text", Icon: FileText, action: () => void exportText(), title: "Save all text as a .txt file" },
        { key: "ocr", label: "OCR scan", Icon: ScanText, action: () => { setOcrProgress(""); setDialog("ocr"); }, title: "Recognise text in scanned pages" },
        { key: "security", label: "Protect", Icon: Lock, action: () => setDialog("security"), title: "Passwords, permissions and digital signatures" },
        { key: "compress", label: "Compress", Icon: ImageDown, action: () => { setCompressionEstimate(null); setDialog("compress"); } },
        { key: "properties", label: "Properties", Icon: Info, action: () => { setMetadataDraft(doc.metadata); setDialog("properties"); } },
        { key: "shortcuts", label: "Shortcuts", Icon: Keyboard, action: () => setDialog("shortcuts") },
      ],
    },
  ];
  const activeTab = tabs.find((item) => item.id === tab)!;

  const colorField = (label: string, value: string, onChange: (value: string) => void) => (
    <label className="swatch" title={label}>
      <span className="srOnly">{label}</span>
      <input type="color" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
  const select = <T extends string>(label: string, value: T, options: [T, string][], onChange: (value: T) => void) => (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
  const toggle = (label: string, active: boolean, onClick: () => void, children: ReactNode) => (
    <button aria-label={label} title={label} aria-pressed={active} className={active ? "active" : ""} onClick={onClick}>
      {children}
    </button>
  );
  const textControls = (style: { fontFamily: string; fontName: string | null; size: number; bold: boolean; italic: boolean; underline?: boolean; alignment: "left" | "center" | "right" | "justify"; color: string; lineHeight: number; letterSpacing: number; fitMode: "auto" | "shrink" | "overflow" }, apply: (patch: Partial<TextOverlay>, merge?: string) => void) => (
    <>
      <label>
        <span>Font</span>
        <select value={style.fontName || style.fontFamily} onChange={(event) => apply({ fontName: event.target.value, fontFamily: event.target.value })}>
          {Array.from(new Set([style.fontName || style.fontFamily, ...fontOptions])).map((font) => (
            <option key={font}>{font}</option>
          ))}
        </select>
      </label>
      <span className="fontNote" title="Fonts are embedded with a metric-compatible substitute so exports look the same everywhere.">
        → {exportFontName[fontCategory(style.fontFamily)]}
      </span>
      <label>
        <span>Size</span>
        <NumberField label="Font size" value={style.size} min={4} max={300} onCommit={(size) => apply({ size })} />
      </label>
      <span className="buttonGroup">
        {toggle("Bold", style.bold, () => apply({ bold: !style.bold }), <Bold />)}
        {toggle("Italic", style.italic, () => apply({ italic: !style.italic }), <Italic />)}
        {style.underline !== undefined && toggle("Underline", style.underline, () => apply({ underline: !style.underline }), <Underline />)}
      </span>
      <span className="buttonGroup">
        {toggle("Align left", style.alignment === "left", () => apply({ alignment: "left" }), <AlignLeft />)}
        {toggle("Align centre", style.alignment === "center", () => apply({ alignment: "center" }), <AlignCenter />)}
        {toggle("Align right", style.alignment === "right", () => apply({ alignment: "right" }), <AlignRight />)}
        {toggle("Justify", style.alignment === "justify", () => apply({ alignment: "justify" }), <AlignJustify />)}
      </span>
      {colorField("Text colour", style.color, (color) => apply({ color }, "color"))}
      <details className="more">
        <summary>Spacing</summary>
        <div>
          <label>
            <span>Line</span>
            <NumberField label="Line spacing" value={style.lineHeight} min={0.8} max={3} step={0.1} onCommit={(lineHeight) => apply({ lineHeight })} />
          </label>
          <label>
            <span>Letter</span>
            <NumberField label="Character spacing" value={style.letterSpacing} min={-5} max={20} step={0.5} onCommit={(letterSpacing) => apply({ letterSpacing })} />
          </label>
          {select("Fit", style.fitMode, [["auto", "Wrap"], ["shrink", "Shrink to fit"], ["overflow", "Overflow"]], (fitMode) => apply({ fitMode }))}
        </div>
      </details>
    </>
  );

  const toolOptions: ReactNode = (() => {
    if (tool === "text")
      return (
        <>
          <span className="hint">Click the page where the text should go.</span>
          <label>
            <span>Font</span>
            <select value={settings.textFont} onChange={(event) => updateSettings({ textFont: event.target.value })}>
              {fontOptions.map((font) => (
                <option key={font}>{font}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Size</span>
            <NumberField label="New text size" value={settings.textSize} min={4} max={300} onCommit={(textSize) => updateSettings({ textSize })} />
          </label>
          {colorField("Text colour", settings.textColor, (textColor) => updateSettings({ textColor }))}
        </>
      );
    if (tool === "shape")
      return (
        <>
          {select("Shape", settings.shapeKind, [["rectangle", "Rectangle"], ["square", "Square"], ["circle", "Ellipse"], ["triangle", "Triangle"]], (shapeKind: ShapeKind) => updateSettings({ shapeKind }))}
          {colorField("Stroke colour", settings.drawColor, (drawColor) => updateSettings({ drawColor }))}
          <label className="checkInline">
            <input type="checkbox" checked={settings.fillColor !== null} onChange={(event) => updateSettings({ fillColor: event.target.checked ? "#fde2dc" : null })} /> Fill
          </label>
          {settings.fillColor !== null && colorField("Fill colour", settings.fillColor, (fillColor) => updateSettings({ fillColor }))}
          <label>
            <span>Width</span>
            <NumberField label="Stroke width" value={settings.strokeWidth} min={0.5} max={20} step={0.5} onCommit={(strokeWidth) => updateSettings({ strokeWidth })} />
          </label>
        </>
      );
    if (tool === "line" || tool === "ink")
      return (
        <>
          {tool === "line" && select("Ends", settings.lineArrow, [["none", "Plain line"], ["end", "Arrow"], ["both", "Double arrow"]], (lineArrow) => updateSettings({ lineArrow }))}
          {colorField("Colour", settings.drawColor, (drawColor) => updateSettings({ drawColor }))}
          <label>
            <span>Width</span>
            <NumberField label="Stroke width" value={settings.strokeWidth} min={0.5} max={20} step={0.5} onCommit={(strokeWidth) => updateSettings({ strokeWidth })} />
          </label>
        </>
      );
    if (tool === "redact") return <span className="hint warn">Drag over anything to remove it permanently from the exported PDF — text, images and lines underneath are deleted, not just covered.</span>;
    if (tool === "crop") return <span className="hint">Drag to choose the visible area of this page. {doc.crops[sourcePage] && <button onClick={() => execute({ type: "setCrop", page: sourcePage, before: doc.crops[sourcePage]!, after: null })}>Remove crop</button>}</span>;
    if (tool === "markup")
      return (
        <>
          {select("Style", settings.markupKind, [["highlight", "Highlight"], ["underline", "Underline"], ["strikeout", "Strikeout"], ["squiggly", "Squiggly"]], (markupKind: MarkupKind) => updateSettings({ markupKind }))}
          {colorField("Colour", settings.drawColor, (drawColor) => updateSettings({ drawColor }))}
          <span className="hint">Drag across text — it snaps to the lines.</span>
        </>
      );
    if (tool === "note")
      return (
        <>
          {select("Type", settings.noteType, [["sticky", "Sticky note"], ["callout", "Text box"]], (noteType) => updateSettings({ noteType }))}
          {colorField("Colour", settings.drawColor, (drawColor) => updateSettings({ drawColor }))}
        </>
      );
    if (tool === "stamp")
      return (
        <>
          {select("Stamp", settings.stampLabel, [["Approved", "Approved"], ["Draft", "Draft"], ["Final", "Final"], ["Rejected", "Rejected"], ["Confidential", "Confidential"], ["For Comment", "For comment"]], (stampLabel) => updateSettings({ stampLabel }))}
          {colorField("Colour", settings.drawColor, (drawColor) => updateSettings({ drawColor }))}
        </>
      );
    if (tool === "measure")
      return (
        <>
          {select("Measure", settings.measureKind, [["distance", "Distance"], ["perimeter", "Perimeter"], ["area", "Area"]], (measureKind) => updateSettings({ measureKind }))}
          {select("Unit", settings.measureUnit, [["pt", "pt"], ["in", "in"], ["cm", "cm"], ["mm", "mm"]], (measureUnit) => updateSettings({ measureUnit }))}
          <label>
            <span>Scale 1:</span>
            <NumberField label="Measurement scale" value={settings.measureScale} min={0.01} max={10000} onCommit={(measureScale) => updateSettings({ measureScale })} />
          </label>
          {colorField("Colour", settings.drawColor, (drawColor) => updateSettings({ drawColor }))}
        </>
      );
    if (tool === "attachment") return <span className="hint">{settings.pendingAttachment ? `Tap the page to place ${settings.pendingAttachment.name}` : "Choose a file with Attach file first."}</span>;
    if (tool === "signature")
      return (
        <>
          {select("Signature", settings.signatureMode, [["draw", "Draw"], ["typed", "Type"], ["image", "Image"], ["digital", "Certificate"]], (signatureMode) => updateSettings({ signatureMode }))}
          {settings.signatureMode !== "draw" && (
            <label>
              <span>Name</span>
              <input value={settings.signatureName} onChange={(event) => updateSettings({ signatureName: event.target.value })} placeholder="Full name" />
            </label>
          )}
          {settings.signatureMode === "image" && <button onClick={() => inputs.signatureImage.current?.click()}>{settings.signatureImage ? "Change image" : "Choose image"}</button>}
          {settings.signatureMode === "digital" && <button onClick={() => setDialog("security")}>{certificate ? certificate.name : "Choose certificate"}</button>}
          <span className="hint">{settings.signatureMode === "draw" ? "Draw your signature on the page." : "Click where the signature should go."}</span>
        </>
      );
    if (tool === "form")
      return (
        <>
          {select("Field", settings.formType, [["text", "Text"], ["choice", "Dropdown"], ["checkbox", "Checkbox"], ["radio", "Radio"], ["signature", "Signature"]], (formType) => updateSettings({ formType }))}
          <label>
            <span>Name</span>
            <input value={settings.formName} onChange={(event) => updateSettings({ formName: event.target.value })} />
          </label>
          {select("Validate", settings.formValidation, [["none", "None"], ["email", "Email"], ["number", "Number"], ["regex", "Pattern"]], (formValidation) => updateSettings({ formValidation }))}
          {settings.formValidation === "regex" && (
            <label>
              <span>Pattern</span>
              <input value={settings.formPattern} onChange={(event) => updateSettings({ formPattern: event.target.value })} />
            </label>
          )}
          <span className="hint">Drag to draw the field.</span>
        </>
      );
    return null;
  })();

  const selectionOptions: ReactNode = (() => {
    if (originalEdit)
      return (
        <>
          <span className="editingLabel">
            <Pencil /> {originalEdit.paragraph ? `Editing paragraph (${originalEdit.paragraph.lines.length} lines)` : "Editing original text"}
          </span>
          {originalEdit.paragraph && (
            <button
              title="Edit only the line you tapped"
              onClick={() => {
                const extracted = originalEdit.lines.find((line) => line.id === originalEdit.line.id) ?? originalEdit.line;
                setOriginalEdit({ line: extracted, draft: extracted.text, source: originalEdit.source, lines: originalEdit.lines });
              }}
            >
              This line only
            </button>
          )}
          {textControls({ ...originalEdit.line, fontName: originalEdit.line.fontName }, (patch) => setOriginalEdit({ ...originalEdit, line: { ...originalEdit.line, ...patch, fontName: patch.fontName ?? (patch.bold !== undefined || patch.italic !== undefined ? "" : originalEdit.line.fontName) } as PositionedTextLine }))}
          <button className="primaryAction" onClick={() => commitOriginalEdit(originalEdit, true)} title="Apply (Ctrl+Enter)">
            Apply
          </button>
          <button onClick={() => commitOriginalEdit({ ...originalEdit, draft: "" }, false)}>
            <Trash2 /> Delete text
          </button>
          <button onClick={() => setOriginalEdit(null)} title="Cancel (Esc)">
            Cancel
          </button>
        </>
      );
    if (!selected) return null;
    const common = (
      <>
        {"x" in selected && "width" in selected && (
          <span className="buttonGroup">
            <button title="Send to back" aria-label="Send to back" onClick={() => arrangeSelected("back")}>
              <SendToBack />
            </button>
            <button title="Bring to front" aria-label="Bring to front" onClick={() => arrangeSelected("front")}>
              <BringToFront />
            </button>
            <select
              aria-label="Align on page"
              value=""
              onChange={(event) => {
                if (event.target.value) alignSelected(event.target.value as "left");
              }}
            >
              <option value="" disabled>
                Align…
              </option>
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
              <option value="top">Top</option>
              <option value="middle">Middle</option>
              <option value="bottom">Bottom</option>
            </select>
          </span>
        )}
        <button title="Duplicate (Ctrl+D)" aria-label="Duplicate" onClick={() => duplicateOverlay(selected)}>
          <Copy />
        </button>
        <button className="danger" title="Delete (Del)" onClick={deleteSelected}>
          <Trash2 /> Delete
        </button>
      </>
    );
    if (selected.kind === "text")
      return (
        <>
          <button onClick={() => setEditingId(selected.id)} title="Edit text (Enter or double-click)">
            <Pencil /> Edit text
          </button>
          {textControls(selected, (patch, merge) => updateText(selected, patch, merge ? `${merge}:${selected.id}` : undefined))}
          {common}
        </>
      );
    if (selected.kind === "image")
      return (
        <>
          <label>
            <span>Opacity</span>
            <NumberField label="Image opacity" value={Math.round(selected.opacity * 100)} min={5} max={100} step={5} onCommit={(value) => updateSelected({ opacity: value / 100 })} />
          </label>
          <label>
            <span>Rotate</span>
            <NumberField label="Image rotation" value={selected.rotation} min={-360} max={360} step={15} onCommit={(value) => updateSelected({ rotation: value })} />
          </label>
          <button onClick={() => inputs.replaceImage.current?.click()}>Replace</button>
          <button onClick={extractSelectedImage}>
            <ImageDown /> Save image
          </button>
          <button onClick={() => { setImageCrop({ left: 0, top: 0, right: 0, bottom: 0 }); setDialog("imageCrop"); }}>
            <Crop /> Crop
          </button>
          {common}
        </>
      );
    if (selected.kind === "formField")
      return (
        <>
          <label>
            <span>Name</span>
            <input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value || selected.name }, `name:${selected.id}`)} />
          </label>
          {selected.fieldType !== "signature" && (
            <label>
              <span>Value</span>
              <input value={selected.value} onChange={(event) => updateSelected({ value: event.target.value }, `value:${selected.id}`)} />
            </label>
          )}
          {selected.fieldType === "choice" && (
            <label>
              <span>Options</span>
              <input value={selected.options.join(", ")} onChange={(event) => updateSelected({ options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) }, `options:${selected.id}`)} />
            </label>
          )}
          {toggle("Required", selected.required, () => updateSelected({ required: !selected.required }), "Required")}
          {toggle("Read only", selected.readOnly, () => updateSelected({ readOnly: !selected.readOnly }), "Read only")}
          {toggle("Flatten on export", selected.flatten, () => updateSelected({ flatten: !selected.flatten }), "Flatten")}
          {common}
        </>
      );
    return (
      <>
        {"color" in selected && selected.kind !== "redact" && selected.kind !== "background" && colorField("Colour", selected.color, (color) => updateSelected({ color }, `color:${selected.id}`))}
        {selected.kind === "shape" && (
          <>
            <label className="checkInline">
              <input type="checkbox" checked={selected.fillColor !== null} onChange={(event) => updateSelected({ fillColor: event.target.checked ? "#fde2dc" : null })} /> Fill
            </label>
            {selected.fillColor !== null && colorField("Fill colour", selected.fillColor, (fillColor) => updateSelected({ fillColor }, `fill:${selected.id}`))}
          </>
        )}
        {(selected.kind === "shape" || selected.kind === "line" || selected.kind === "ink") && (
          <label>
            <span>Width</span>
            <NumberField
              label="Stroke width"
              value={selected.kind === "shape" ? selected.strokeWidth : selected.width}
              min={0.5}
              max={20}
              step={0.5}
              onCommit={(value) => updateSelected(selected.kind === "shape" ? { strokeWidth: value } : { width: value })}
            />
          </label>
        )}
        {selected.kind === "line" && select("Ends", selected.arrow, [["none", "Plain"], ["end", "Arrow"], ["both", "Double arrow"]], (arrow) => updateSelected({ arrow }))}
        {selected.kind === "note" && (
          <label className="grow">
            <span>Text</span>
            <input value={selected.text} onChange={(event) => updateSelected({ text: event.target.value }, `text:${selected.id}`)} />
          </label>
        )}
        {isReviewOverlay(selected) && (
          <>
            <label className="grow">
              <span>Comment</span>
              <input value={selected.comment} placeholder="Add a reply or comment" onChange={(event) => updateSelected({ comment: event.target.value }, `comment:${selected.id}`)} />
            </label>
            {toggle("Resolved", selected.resolved, () => updateSelected({ resolved: !selected.resolved }), selected.resolved ? "Resolved" : "Resolve")}
            {selected.kind !== "attachment" && toggle("Flatten into page on export", selected.flatten, () => updateSelected({ flatten: !selected.flatten }), "Flatten")}
          </>
        )}
        {common}
      </>
    );
  })();

  const contextContent = selectionOptions ?? toolOptions;
  const ribbonBar = (
<div className="ribbon" role="toolbar" aria-label={`${activeTab.label} tools`}>
        {activeTab.items.map((item) => {
          const active = item.tool ? tool === item.tool : item.active;
          return (
            <button
              key={item.key}
              className={active ? "chosen" : ""}
              aria-pressed={item.tool ? active : undefined}
              title={item.title ?? item.label}
              disabled={item.disabled}
              onClick={() => (item.tool ? chooseTool(item.tool) : item.action?.())}
            >
              <item.Icon />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
  );
  const hiddenInputs = (
    <>
      <input ref={inputs.image} hidden type="file" accept="image/png,image/jpeg" onChange={pickFile(addImage)} />
      <input ref={inputs.attachment} hidden type="file" onChange={pickFile(chooseAttachment)} />
      <input ref={inputs.merge} hidden type="file" accept="application/pdf,.pdf" onChange={pickFile((file) => file.arrayBuffer().then((bytes) => appendPages({ type: "pdf", bytes }, doc.pageOrder.length, `${file.name} added at the end.`)))} />
      <input ref={inputs.insertPdf} hidden type="file" accept="application/pdf,.pdf" onChange={pickFile((file) => file.arrayBuffer().then((bytes) => appendPages({ type: "pdf", bytes }, page + 1, `${file.name} inserted.`)))} />
      <input ref={inputs.replaceImage} hidden type="file" accept="image/png,image/jpeg" onChange={pickFile(replaceSelectedImage)} />
      <input ref={inputs.nativeReplace} hidden type="file" accept="image/png,image/jpeg" onChange={pickFile(replaceNativeImage)} />
      <input
        ref={inputs.imagePages}
        hidden
        type="file"
        multiple
        accept="image/png,image/jpeg"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) void Promise.all(files.map((file) => file.arrayBuffer())).then((images) => appendPages({ type: "images", images }, page + 1, `${files.length} image page${files.length === 1 ? "" : "s"} inserted.`));
        }}
      />
      <input ref={inputs.reviewImport} hidden type="file" accept="application/json,.json" onChange={pickFile(importReviews)} />
      <input ref={inputs.signatureImage} hidden type="file" accept="image/png,image/jpeg" onChange={pickFile(async (file) => updateSettings({ signatureImage: await readAsDataUrl(file) }))} />
      <input ref={inputs.certificate} hidden type="file" accept=".p12,.pfx,application/x-pkcs12" onChange={pickFile(async (file) => setCertificate({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))} />
    </>
  );

  return (
    <div className={`app ${isPhone ? "phone" : ""} ${immersive ? "immersive" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <header className="top">
        <div className="file">
          <button className="iconButton" aria-label="Close document" title="Close document" onClick={closeDocument}>
            <ChevronLeft />
          </button>
          <div>
            <b title={open.name}>{open.name}</b>
            <small>
              {doc.pageOrder.length} page{doc.pageOrder.length === 1 ? "" : "s"} · {saving ? "Saving…" : "Saved on this device"}
            </small>
          </div>
        </div>
        {!isPhone && <nav className="tabs" aria-label="Tool groups" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? "selected" : ""}
              onClick={() => {
                setTab(item.id);
                if (!item.items.some((entry) => entry.tool === tool)) chooseTool("select");
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>}
        <div className="topActions">
          {isPhone && (
            <button className="iconButton" aria-label={showRail ? "Hide pages" : "Show pages"} aria-pressed={showRail} onClick={() => setShowRail((value) => !value)}>
              <PanelLeft />
            </button>
          )}
          <button className="iconButton" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!undo.length} onClick={undoOnce}>
            <Undo2 />
          </button>
          <button className="iconButton" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!redo.length} onClick={redoOnce}>
            <Redo2 />
          </button>
          <button className="iconButton hideNarrow" aria-label="Find" title="Find & replace (Ctrl+F)" onClick={() => setDialog("find")}>
            <Search />
          </button>
          <button className="export" disabled={exporting} title={edited ? "Export the edited PDF (Ctrl+S)" : "Download the original PDF"} onClick={() => void download()}>
            <Download /> <span>{exporting ? "Exporting…" : edited ? "Export" : "Download"}</span>
          </button>
        </div>
      </header>
      {!isPhone && ribbonBar}
      {!isPhone && contextContent && <div className="contextBar">{contextContent}</div>}
      <div className={`work ${showRail ? "withRail" : ""} ${showComments ? "withComments" : ""}`}>
        {showRail && (
          <aside className="rail" aria-label="Pages and outline">
            <div className="railTitle">
              <div className="segmented" role="tablist">
                <button role="tab" aria-selected={railTab === "pages"} className={railTab === "pages" ? "active" : ""} onClick={() => setRailTab("pages")}>
                  Thumbnails
                </button>
                <button role="tab" aria-selected={railTab === "outline"} className={railTab === "outline" ? "active" : ""} onClick={() => setRailTab("outline")}>
                  Outline
                </button>
              </div>
              <button className="iconButton" aria-label="Hide pages" onClick={() => setShowRail(false)}>
                <X />
              </button>
            </div>
            {railTab === "outline" && (
              <nav className="outline" aria-label="Document outline">
                {outline.length ? (
                  outline.map((entry, index) => (
                    <button
                      key={index}
                      className="outlineEntry"
                      style={{ paddingLeft: 8 + entry.depth * 14 }}
                      disabled={entry.page === null && !entry.uri}
                      onClick={() => {
                        if (entry.page !== null) goTo(entry.page);
                        else if (entry.uri) followLink({ x: 0, y: 0, width: 0, height: 0, uri: entry.uri });
                        if (isPhone) setShowRail(false);
                      }}
                    >
                      <span>{entry.title}</span>
                      {entry.page !== null && <small>{doc.pageOrder.indexOf(entry.page) + 1 || "–"}</small>}
                    </button>
                  ))
                ) : (
                  <p className="empty">
                    <BookOpen /> This document has no outline.
                  </p>
                )}
              </nav>
            )}
            {railTab === "pages" && doc.pageOrder.map((source, index) => (
              <div
                key={source}
                role="button"
                tabIndex={0}
                className={index === page ? "thumb active" : "thumb"}
                aria-label={`Page ${index + 1}`}
                aria-current={index === page ? "page" : undefined}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/x-page", String(index))}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("text/x-page")) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onDrop={(event) => {
                  const from = event.dataTransfer.getData("text/x-page");
                  if (from === "") return;
                  event.preventDefault();
                  event.stopPropagation();
                  movePage(Number(from), index);
                }}
                onClick={() => {
                  setPage(index);
                  if (window.innerWidth < 760) setShowRail(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setPage(index);
                }}
              >
                <Thumbnail source={source} rotation={doc.rotations[source] ?? 0} url={thumbs.get(source)} onVisible={requestThumb} />
                <span className="thumbFooter">
                  <span>{index + 1}</span>
                  <span className="pageActions">
                    <button aria-label={`Move page ${index + 1} up`} disabled={index === 0} onClick={(event) => { event.stopPropagation(); movePage(index, index - 1); }}>
                      <ArrowUp />
                    </button>
                    <button aria-label={`Move page ${index + 1} down`} disabled={index === doc.pageOrder.length - 1} onClick={(event) => { event.stopPropagation(); movePage(index, index + 1); }}>
                      <ArrowDown />
                    </button>
                    <button aria-label={`Delete page ${index + 1}`} disabled={doc.pageOrder.length < 2} onClick={(event) => { event.stopPropagation(); removePages([index]); }}>
                      <Trash2 />
                    </button>
                  </span>
                </span>
              </div>
            ))}
          </aside>
        )}
        <main className="canvasArea">
          <div
            ref={(node) => {
              stageRef.current = node;
              if (node !== stageElement) setStageElement(node);
            }}
            className={`stage theme-${readingTheme}`}
            onTouchStart={beginPinch}
            onTouchMove={movePinch}
            onTouchEnd={endPinch}
            onTouchCancel={endPinch}
            onPointerDownCapture={stagePointerDown}
            onPointerUp={stagePointerUp}
          >
            {busy && (
              <div className="loading" role="status">
                <span className="spinner" /> {busy}
              </div>
            )}
            <div className="pageViewport">
              <DocumentView
                ref={viewRef}
                stage={stageElement}
                pageOrder={doc.pageOrder}
                pages={open.pages}
                rotations={doc.rotations}
                zoom={zoom}
                renderScale={renderScale}
                documentKey={open.bytes}
                page={page}
                render={renderForView}
                onPageChange={setPage}
                onVisibleChange={loadPageData}
              >
                {({ source, index, image }) => {
                  const lines = pageData.get(source)?.lines ?? [];
                  return (
                    <div className="pageHost" onPointerDownCapture={() => activatePage(index)}>
                      <PageCanvas
                        key={`${source}-${fontsReady}`}
                        image={image}
                        info={open.pages[source]!}
                        zoom={zoom}
                        rotation={doc.rotations[source] ?? 0}
                        overlays={overlaysByPage.get(source) ?? []}
                        textLines={lines}
                        textEditable={tab === "edit" && (!isPhone || trayOpen)}
                        links={pageData.get(source)?.links ?? []}
                        pageImages={tab === "edit" && (!isPhone || trayOpen) ? (pageData.get(source)?.images ?? []) : []}
                        onLiftImage={(image) => void liftImage(source, image)}
                        onLink={followLink}
                        originalEdit={originalEdit?.source === source ? originalEdit : null}
                        crop={doc.crops[source]}
                        tool={tool}
                        settings={settings}
                        selectedId={selectedId}
                        editingId={editingId}
                        highlight={searchHighlight?.sourcePage === source ? searchHighlight.rect : null}
                        page={source}
                        onSelect={(id) => {
                          if (originalEdit) commitOriginalEdit(originalEdit, false);
                          if (id !== editingId) setEditingId(null);
                          setSelectedId(id);
                          setSearchHighlight(null);
                        }}
                        onEditText={setEditingId}
                        onOriginalSelect={(line) => {
                          if (originalEdit) commitOriginalEdit(originalEdit, false);
                          setSelectedId(null);
                          setEditingId(null);
                          // A line inside a uniform paragraph edits the whole paragraph.
                          const paragraph = findParagraph(lines, line, open.pages[source]!);
                          setOriginalEdit(
                            paragraph
                              ? { line: { ...line, alignment: paragraph.alignment, lineHeight: paragraph.lineHeight }, draft: paragraph.text, source, lines, paragraph }
                              : { line, draft: line.text, source, lines },
                          );
                        }}
                        onOriginalChange={(draft) => setOriginalEdit((currentEdit) => (currentEdit ? { ...currentEdit, draft } : null))}
                        onOriginalCommit={() => commitOriginalEdit(originalEdit, true)}
                        onOriginalCancel={() => setOriginalEdit(null)}
                        onAdd={addOverlays}
                        onUpdate={update}
                        onCrop={(crop) => {
                          execute({ type: "setCrop", page: source, before: doc.crops[source] ?? null, after: crop });
                          chooseTool("select");
                          setNotice("Page cropped. Choose Crop again to adjust or remove it.");
                        }}
                        onMessage={setError}
                      />
                    </div>
                  );
                }}
              </DocumentView>
            </div>
          </div>
          {isPhone && (
            <button className={`pagePill ${pillShown || immersive ? "" : "faded"}`} aria-label={`Page ${page + 1} of ${doc.pageOrder.length}. Show pages`} onClick={() => setShowRail(true)}>
              {page + 1} / {doc.pageOrder.length}
            </button>
          )}
          <footer className="status">
            <div>
              <button className="iconButton" aria-label={showRail ? "Hide pages" : "Show pages"} title="Pages" aria-pressed={showRail} onClick={() => setShowRail((value) => !value)}>
                <PanelLeft />
              </button>
            </div>
            <div className="pager">
              <button className="iconButton" aria-label="Previous page" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>
                <ChevronLeft />
              </button>
              <label>
                <span className="srOnly">Page number</span>
                <input
                  className="pageInput"
                  inputMode="numeric"
                  key={page}
                  defaultValue={page + 1}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      const target = Number((event.target as HTMLInputElement).value);
                      if (Number.isInteger(target)) setPage(Math.min(doc.pageOrder.length, Math.max(1, target)) - 1);
                      (event.target as HTMLInputElement).blur();
                    }
                  }}
                />
              </label>
              <span>/ {doc.pageOrder.length}</span>
              <button className="iconButton" aria-label="Next page" onClick={() => setPage(Math.min(doc.pageOrder.length - 1, page + 1))} disabled={page === doc.pageOrder.length - 1}>
                <ChevronRight />
              </button>
            </div>
            <div className="zoom">
              <button className="iconButton" aria-label="Zoom out" title="Zoom out (Ctrl+−)" onClick={() => zoomTo(zoom / 1.2)}>
                <ZoomOut />
              </button>
              <button className="zoomValue" title="Fit width (Ctrl+0)" onClick={() => setFit(fit === "width" ? "page" : "width")}>
                {Math.round(zoom * 100)}%
              </button>
              <button className="iconButton" aria-label="Zoom in" title="Zoom in (Ctrl++)" onClick={() => zoomTo(zoom * 1.2)}>
                <ZoomIn />
              </button>
              <button className={`iconButton hideNarrow ${fit === "width" ? "chosen" : ""}`} aria-label="Fit width" title="Fit width" onClick={() => setFit("width")}>
                <MoveHorizontal />
              </button>
              <button className={`iconButton hideNarrow ${fit === "page" ? "chosen" : ""}`} aria-label="Fit page" title="Fit page" onClick={() => setFit("page")}>
                <Maximize />
              </button>
            </div>
          </footer>
        </main>
        {showComments && (
          <aside className="commentSidebar" aria-label="Comments">
            <header>
              <div>
                <b>Comments</b>
                <span>{reviewOverlays.filter((item) => !item.resolved).length} open</span>
              </div>
              <button className="iconButton" aria-label="Close comments" onClick={() => setShowComments(false)}>
                <X />
              </button>
            </header>
            <label>
              Your name
              <input value={settings.reviewAuthor} onChange={(event) => updateSettings({ reviewAuthor: event.target.value })} />
            </label>
            <div className="segmented">
              {(["all", "open", "resolved"] as const).map((filter) => (
                <button key={filter} className={commentFilter === filter ? "active" : ""} onClick={() => setCommentFilter(filter)}>
                  {filter[0]!.toUpperCase() + filter.slice(1)}
                </button>
              ))}
            </div>
            <div className="reviewList">
              {filteredReviews.length ? (
                filteredReviews.map((overlay) => (
                  <article key={overlay.id} className={`${overlay.resolved ? "resolved" : ""} ${overlay.id === selectedId ? "current" : ""}`}>
                    <button
                      className="reviewJump"
                      onClick={() => {
                        const index = doc.pageOrder.indexOf(overlay.page);
                        if (index >= 0) setPage(index);
                        chooseTool("select");
                        setSelectedId(overlay.id);
                      }}
                    >
                      <span>
                        Page {doc.pageOrder.indexOf(overlay.page) + 1} · {overlay.kind === "measurement" ? overlay.measurement : overlay.kind === "markup" ? overlay.markup : overlay.kind}
                      </span>
                      <b>{overlay.kind === "note" ? overlay.text : overlay.kind === "stamp" ? overlay.label : overlay.kind === "attachment" ? overlay.name : overlay.kind === "measurement" ? overlay.label : textLines.filter((line) => line.y < overlay.y + overlay.height && line.y + line.height > overlay.y && overlay.page === sourcePage).map((line) => line.text.trim()).join(" ").slice(0, 120) || overlay.markup}</b>
                      {overlay.comment && <p>{overlay.comment}</p>}
                      <small>
                        {overlay.author || "Anonymous"} · {overlay.createdAt ? new Date(overlay.createdAt).toLocaleString() : "No date"}
                      </small>
                    </button>
                    <button className="resolveButton" onClick={() => update(overlay, { ...overlay, resolved: !overlay.resolved } as Overlay)}>
                      {overlay.resolved ? "Reopen" : "Resolve"}
                    </button>
                  </article>
                ))
              ) : (
                <p className="empty">{reviewOverlays.length ? "No comments match this filter." : "No comments yet. Use Highlight, Note, Stamp or Measure to start a review."}</p>
              )}
            </div>
            <footer>
              <button onClick={() => inputs.reviewImport.current?.click()}>Import</button>
              <button onClick={exportReviews} disabled={!reviewOverlays.length}>
                Export
              </button>
            </footer>
          </aside>
        )}
      </div>
      {isPhone && (
        <div className="phoneDock">
          {contextContent && <div className="contextBar">{contextContent}</div>}
          {trayOpen && ribbonBar}
          <nav className="bottomNav" role="tablist" aria-label="Tool groups">
            {tabs.map((item) => (
              <button key={item.id} role="tab" aria-selected={trayOpen && tab === item.id} className={trayOpen && tab === item.id ? "selected" : ""} onClick={() => choosePhoneTab(item.id)}>
                <item.Icon />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
      )}
      {hiddenInputs}

      {dialog === "properties" && (
        <Modal
          title="Document properties"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button onClick={() => setDialog(null)}>Cancel</button>
              <button className="primary" onClick={() => { execute({ type: "setMetadata", before: doc.metadata, after: metadataDraft }); setDialog(null); }}>
                Save
              </button>
            </>
          }
        >
          {(["title", "author", "subject", "keywords"] as const).map((key) => (
            <label key={key}>
              {key[0]!.toUpperCase() + key.slice(1)}
              <input value={metadataDraft[key]} onChange={(event) => setMetadataDraft({ ...metadataDraft, [key]: event.target.value })} />
            </label>
          ))}
          <p className="helperText">
            {doc.pageOrder.length} pages · {formatBytes(open.bytes.byteLength)} · {Math.round(pageInfo.width)} × {Math.round(pageInfo.height)} pt ({(pageInfo.width / 72 * 25.4).toFixed(0)} × {(pageInfo.height / 72 * 25.4).toFixed(0)} mm)
          </p>
        </Modal>
      )}

      {dialog === "forms" && (
        <Modal
          title="Form fields"
          className="wideModal"
          description="Fill the document's existing fields, or manage fields you have added."
          onClose={() => setDialog(null)}
          footer={
            <>
              <button onClick={() => { setTab("sign"); chooseTool("form"); setDialog(null); }}>
                <FileKey2 /> Add a field
              </button>
              <button className="primary" onClick={() => setDialog(null)}>
                Done
              </button>
            </>
          }
        >
          <label className="checkRow">
            <input type="checkbox" checked={security.flattenForms} onChange={(event) => setSecurity({ ...security, flattenForms: event.target.checked })} />
            Flatten all fields on export (values become part of the page and can no longer be edited)
          </label>
          {open.formFields.length > 0 && (
            <>
              <h3>Fields in this document</h3>
              <div className="fieldGrid">
                {open.formFields.map((field) => {
                  const value = doc.formValues[field.name] ?? field.value;
                  const set = (after: string) => execute({ type: "setFormValue", name: field.name, before: value, after });
                  return (
                    <label key={`${field.page}-${field.name}`}>
                      <span>
                        {field.label || field.name} <small>· page {doc.pageOrder.indexOf(field.page) + 1}</small>
                      </span>
                      {field.type === "choice" ? (
                        <select disabled={field.readOnly} value={value} onChange={(event) => set(event.target.value)}>
                          {!field.options.includes(value) && <option value={value}>{value || "—"}</option>}
                          {field.options.map((option) => (
                            <option key={option}>{option}</option>
                          ))}
                        </select>
                      ) : field.type === "checkbox" || field.type === "radio" ? (
                        <input disabled={field.readOnly} type="checkbox" checked={value !== "Off" && value !== ""} onChange={(event) => set(event.target.checked ? "Yes" : "Off")} />
                      ) : field.type === "signature" ? (
                        <small>Signature field</small>
                      ) : (
                        <input disabled={field.readOnly} defaultValue={value} onBlur={(event) => event.target.value !== value && set(event.target.value)} />
                      )}
                    </label>
                  );
                })}
              </div>
            </>
          )}
          <h3>Fields you added</h3>
          {createdFormFields.length ? (
            <div className="createdFields">
              {[...createdFormFields]
                .sort((a, b) => a.tabOrder - b.tabOrder)
                .map((field) => (
                  <article key={field.id} className="createdField">
                    <div className="fieldGrid">
                      <label>
                        Name
                        <input value={field.name} onChange={(event) => update(field, { ...field, name: event.target.value }, `name:${field.id}`)} />
                      </label>
                      <label>
                        Default value
                        <input value={field.value} onChange={(event) => update(field, { ...field, value: event.target.value }, `value:${field.id}`)} />
                      </label>
                      <label>
                        Tab order
                        <input type="number" min="0" value={field.tabOrder} onChange={(event) => update(field, { ...field, tabOrder: Number(event.target.value) || 0 })} />
                      </label>
                      <label>
                        Calculation
                        <input value={field.calculation} placeholder="sum:Subtotal,Tax" onChange={(event) => update(field, { ...field, calculation: event.target.value }, `calc:${field.id}`)} />
                      </label>
                    </div>
                    <div className="fieldFlags">
                      {(["required", "readOnly", "multiline", "flatten"] as const).map((key) => (
                        <label className="checkRow" key={key}>
                          <input type="checkbox" checked={field[key]} onChange={(event) => update(field, { ...field, [key]: event.target.checked })} />
                          {key === "readOnly" ? "Read only" : key[0]!.toUpperCase() + key.slice(1)}
                        </label>
                      ))}
                      <button onClick={() => { setPage(doc.pageOrder.indexOf(field.page)); setSelectedId(field.id); chooseTool("select"); setDialog(null); }}>Show</button>
                      <button className="danger" onClick={() => execute({ type: "remove", overlay: field })}>
                        <Trash2 /> Delete
                      </button>
                    </div>
                  </article>
                ))}
            </div>
          ) : (
            <p className="empty">No fields added yet.</p>
          )}
        </Modal>
      )}

      {dialog === "security" && (
        <Modal title="Protect" className="wideModal" description="Encrypt the export, restrict permissions, remove metadata, or sign with a certificate. Everything happens on this device." onClose={() => setDialog(null)} footer={<>{certificate && <button className="danger" onClick={() => { setCertificate(null); setCertificatePassphrase(""); }}>Remove certificate</button>}<button className="primary" onClick={() => setDialog(null)}>Done</button></>}>
          {open.signatures.length > 0 && (
            <div className={edited ? "callout warning" : "callout"}>
              <b>
                {open.signatures.length} existing digital signature{open.signatures.length === 1 ? "" : "s"}
              </b>
              <span>{edited ? "This document has changed. Exporting will invalidate the existing signatures." : "No edits have been made since opening this document."}</span>
              {open.signatures.map((signature, index) => (
                <small key={`${signature.name}-${index}`}>
                  {signature.name || `Signature ${index + 1}`} · {signature.reason || "No reason"} · {signature.modifiedAfterSigning ? "document modified after signing" : "covers the file"}
                </small>
              ))}
            </div>
          )}
          {open.password && <p className="helperText">This PDF was opened with a password. Unless you set a new one below, the export is saved without a password.</p>}
          <h3>Password</h3>
          <div className="fieldGrid">
            <label>
              Password to open
              <input type="password" autoComplete="new-password" value={security.userPassword} onChange={(event) => setSecurity({ ...security, userPassword: event.target.value })} />
            </label>
            <label>
              Owner password (for permissions)
              <input type="password" autoComplete="new-password" value={security.ownerPassword} onChange={(event) => setSecurity({ ...security, ownerPassword: event.target.value })} />
            </label>
          </div>
          <div className="fieldFlags">
            {([["allowPrint", "Allow printing"], ["allowCopy", "Allow copying"], ["allowEdit", "Allow editing"], ["allowAnnotate", "Allow comments"], ["sanitizeMetadata", "Remove document metadata"], ["flattenForms", "Flatten form fields"]] as const).map(([key, label]) => (
              <label className="checkRow" key={key}>
                <input type="checkbox" checked={security[key]} onChange={(event) => setSecurity({ ...security, [key]: event.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          <h3>Certificate signature</h3>
          <p className="helperText">Choose a PKCS#12 certificate (.p12 or .pfx). It and its passphrase stay in memory in this tab and are never saved.</p>
          <div className="fieldGrid">
            <label>
              Certificate
              <button onClick={() => inputs.certificate.current?.click()}>{certificate ? certificate.name : "Choose .p12 or .pfx"}</button>
            </label>
            <label>
              Passphrase
              <input type="password" value={certificatePassphrase} onChange={(event) => setCertificatePassphrase(event.target.value)} />
            </label>
            <label>
              Signer name
              <input value={settings.signatureName} onChange={(event) => updateSettings({ signatureName: event.target.value })} />
            </label>
            <label>
              Reason
              <input value={signatureReason} onChange={(event) => setSignatureReason(event.target.value)} />
            </label>
            <label>
              Location
              <input value={signatureLocation} onChange={(event) => setSignatureLocation(event.target.value)} />
            </label>
            <label>
              Contact
              <input value={signatureContact} onChange={(event) => setSignatureContact(event.target.value)} />
            </label>
          </div>
          {lastAudit && lastAudit.areas > 0 && (
            <div className="callout">
              <b>Redaction audit ready</b>
              <span>
                {lastAudit.areas} area{lastAudit.areas === 1 ? "" : "s"} across {lastAudit.pages.length} page{lastAudit.pages.length === 1 ? "" : "s"} · export verified
              </span>
              <button onClick={() => void downloadBlob(new Blob([JSON.stringify(lastAudit, null, 2)], { type: "application/json" }), `${baseName(open.name)}-redaction-audit.json`)}>Download audit</button>
            </div>
          )}
        </Modal>
      )}

      {dialog === "pageImages" && (
        <Modal title="Page images" className="pageImagesModal" description={`Images embedded on page ${page + 1}.`} onClose={() => setDialog(null)} footer={<button className="primary" onClick={() => setDialog(null)}>Done</button>}>
          {pageImages.length ? (
            <div className="pageImageGrid">
              {pageImages.map((item, index) => (
                <article key={item.id}>
                  <img src={item.dataUrl} alt={`Embedded image ${index + 1}`} />
                  <span>
                    {item.pixelWidth} × {item.pixelHeight}px
                  </span>
                  <div>
                    <button onClick={() => void downloadBlob(dataUrlToBlob(item.dataUrl), `page-${page + 1}-image-${index + 1}.png`)}>Save</button>
                    <button onClick={() => { setNativeReplace(item); inputs.nativeReplace.current?.click(); }}>Replace</button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty">No embedded images were found on this page.</p>
          )}
        </Modal>
      )}

      {dialog === "pages" && (
        <Modal
          title="Organize pages"
          className="pagesModal"
          description="Select pages, then move, rotate, delete or extract them. Drag thumbnails to reorder."
          onClose={() => setDialog(null)}
          footer={<button className="primary" onClick={() => setDialog(null)}>Done</button>}
        >
          <div className="pageBatchActions">
            <button onClick={() => setSelectedPages(selectedPages.length === doc.pageOrder.length ? [] : doc.pageOrder.map((_, index) => index))}>{selectedPages.length === doc.pageOrder.length ? "Select none" : "Select all"}</button>
            <button disabled={!selectedPages.length} onClick={() => rotatePages(selectedPages.map((index) => doc.pageOrder[index]!), -90)}>
              <RotateCcw /> Left
            </button>
            <button disabled={!selectedPages.length} onClick={() => rotatePages(selectedPages.map((index) => doc.pageOrder[index]!), 90)}>
              <RotateCw /> Right
            </button>
            <button disabled={!selectedPages.length} onClick={() => { const picked = new Set(selectedPages); const after = [...doc.pageOrder.filter((_, i) => picked.has(i)), ...doc.pageOrder.filter((_, i) => !picked.has(i))]; execute({ type: "setPageOrder", before: doc.pageOrder, after }); setSelectedPages(selectedPages.map((_, i) => i)); }}>
              Move to start
            </button>
            <button disabled={!selectedPages.length} onClick={() => { const picked = new Set(selectedPages); const rest = doc.pageOrder.filter((_, i) => !picked.has(i)); const after = [...rest, ...doc.pageOrder.filter((_, i) => picked.has(i))]; execute({ type: "setPageOrder", before: doc.pageOrder, after }); setSelectedPages(selectedPages.map((_, i) => rest.length + i)); }}>
              Move to end
            </button>
            <button onClick={() => execute({ type: "setPageOrder", before: doc.pageOrder, after: [...doc.pageOrder].reverse() })}>Reverse order</button>
            <button disabled={!selectedPages.length} onClick={() => void exportPages([...selectedPages].sort((a, b) => a - b).map((index) => doc.pageOrder[index]!), `${baseName(open.name)}-extracted.pdf`, `Extracted ${selectedPages.length} page${selectedPages.length === 1 ? "" : "s"}.`)}>
              <FileOutput /> Extract
            </button>
            <button className="danger" disabled={!selectedPages.length || selectedPages.length >= doc.pageOrder.length} onClick={() => removePages(selectedPages)}>
              <Trash2 /> Delete
            </button>
          </div>
          <div className="organizerGrid">
            {doc.pageOrder.map((source, index) => (
              <label
                key={`${source}-${index}`}
                className={selectedPages.includes(index) ? "selected" : ""}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/x-page", String(index))}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const from = event.dataTransfer.getData("text/x-page");
                  if (from !== "") movePage(Number(from), index);
                }}
              >
                <input type="checkbox" checked={selectedPages.includes(index)} onChange={(event) => setSelectedPages((pages) => (event.target.checked ? [...pages, index] : pages.filter((item) => item !== index)))} />
                <Thumbnail source={source} rotation={doc.rotations[source] ?? 0} url={thumbs.get(source)} onVisible={requestThumb} />
                <span>{index + 1}</span>
              </label>
            ))}
          </div>
        </Modal>
      )}

      {dialog === "layout" && (
        <Modal
          title="Header, footer & watermark"
          description="Applied to every page. Use {page} and {pages} for page numbers."
          onClose={() => setDialog(null)}
          footer={
            <>
              <button
                disabled={!doc.layout && !legacyLayout.length}
                onClick={() => {
                  setLayout(null);
                  setDialog(null);
                }}
              >
                Remove all
              </button>
              <button className="primary" onClick={applyLayout}>
                Apply to all pages
              </button>
            </>
          }
        >
          <label>
            Header
            <input value={layoutDraft.header} onChange={(event) => setLayoutDraft({ ...layoutDraft, header: event.target.value })} placeholder="Document title" />
          </label>
          <label>
            Footer
            <input value={layoutDraft.footer} onChange={(event) => setLayoutDraft({ ...layoutDraft, footer: event.target.value })} placeholder="Page {page} of {pages}" />
          </label>
          <label>
            Watermark
            <input value={layoutDraft.watermark} onChange={(event) => setLayoutDraft({ ...layoutDraft, watermark: event.target.value })} placeholder="DRAFT" />
          </label>
          <div className="layoutGrid">
            <label>
              Bates prefix
              <input value={layoutDraft.batesPrefix} onChange={(event) => setLayoutDraft({ ...layoutDraft, batesPrefix: event.target.value })} placeholder="DOC-" />
            </label>
            <label>
              Start at
              <NumberField label="Bates start" value={layoutDraft.batesStart} min={0} max={99999999} onCommit={(batesStart) => setLayoutDraft({ ...layoutDraft, batesStart })} />
            </label>
            <label>
              Digits
              <NumberField label="Bates digits" value={layoutDraft.batesDigits} min={1} max={10} onCommit={(batesDigits) => setLayoutDraft({ ...layoutDraft, batesDigits })} />
            </label>
          </div>
          <label className="checkRow">
            <input type="checkbox" checked={layoutDraft.useBackground} onChange={(event) => setLayoutDraft({ ...layoutDraft, useBackground: event.target.checked })} />
            Page background colour
            {layoutDraft.useBackground && <input type="color" value={layoutDraft.background} onChange={(event) => setLayoutDraft({ ...layoutDraft, background: event.target.value })} />}
          </label>
        </Modal>
      )}

      {dialog === "compress" && (
        <Modal title="Compress" description="Choose a lossless optimisation profile for exports." onClose={() => setDialog(null)} footer={<><button onClick={() => void estimateCompression()} disabled={estimatingCompression}>{estimatingCompression ? "Estimating…" : "Estimate size"}</button><button className="primary" onClick={() => setDialog(null)}>Use this profile</button></>}>
          <div className="choiceList">
            {([["original", "Original structure", "Minimal cleanup; keeps source streams as they are."], ["balanced", "Balanced", "Compresses streams and removes unused objects."], ["small", "Smallest", "Also recompresses images and fonts losslessly."]] as const).map(([id, title, detail]) => (
              <button key={id} className={compressionProfile === id ? "selected" : ""} onClick={() => { setCompressionProfile(id); setCompressionEstimate(null); }}>
                <b>{title}</b>
                <span>{detail}</span>
              </button>
            ))}
          </div>
          <div className="sizeEstimate">
            <span>Current file</span>
            <b>{formatBytes(open.bytes.byteLength)}</b>
            <span>Estimated export</span>
            <b>{compressionEstimate === null ? "—" : `${formatBytes(compressionEstimate)} (${compressionEstimate <= open.bytes.byteLength ? "−" : "+"}${Math.abs(Math.round((1 - compressionEstimate / open.bytes.byteLength) * 100))}%)`}</b>
          </div>
        </Modal>
      )}

      {dialog === "imageCrop" && selected?.kind === "image" && (
        <Modal title="Crop image" className="imageCropModal" onClose={() => setDialog(null)} footer={<><button onClick={() => setDialog(null)}>Cancel</button><button className="primary" onClick={() => void cropSelectedImage()}>Apply crop</button></>}>
          <img src={selected.dataUrl} alt="Crop preview" style={{ clipPath: `inset(${imageCrop.top}% ${imageCrop.right}% ${imageCrop.bottom}% ${imageCrop.left}%)` }} />
          <div className="layoutGrid four">
            {(["left", "top", "right", "bottom"] as const).map((edge) => (
              <label key={edge}>
                {edge[0]!.toUpperCase() + edge.slice(1)} %
                <input type="range" min="0" max="45" value={imageCrop[edge]} onChange={(event) => setImageCrop({ ...imageCrop, [edge]: Number(event.target.value) })} />
              </label>
            ))}
          </div>
        </Modal>
      )}

      {dialog === "ocr" && (
        <Modal
          title="Recognise text (OCR)"
          className="ocrModal"
          description="Runs on this device. Scanned pages get an invisible, searchable and selectable text layer."
          closeDisabled={ocrRunning}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button disabled={ocrRunning} onClick={() => setDialog(null)}>
                Close
              </button>
              <button className="primary" disabled={ocrRunning} onClick={() => void runOcr()}>
                {ocrRunning ? "Recognising…" : ocrScope === "document" ? "Recognise all pages" : "Recognise this page"}
              </button>
            </>
          }
        >
          <div className="fieldGrid">
            <label>
              Language
              <select value={ocrLanguage} disabled={ocrRunning} onChange={(event) => setOcrLanguage(event.target.value as OcrLanguage)}>
                {ocrLanguages.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Pages
              <select value={ocrScope} disabled={ocrRunning} onChange={(event) => setOcrScope(event.target.value as "page" | "document")}>
                <option value="page">This page</option>
                <option value="document">All pages</option>
              </select>
            </label>
            <label>
              Scan cleanup
              <select value={scanEnhancement} disabled={ocrRunning} onChange={(event) => setScanEnhancement(event.target.value as ScanEnhancement)}>
                <option value="none">None</option>
                <option value="grayscale">Grayscale</option>
                <option value="document">Auto contrast</option>
              </select>
            </label>
            <label>
              Review below (%)
              <NumberField label="Low confidence threshold" value={confidenceThreshold} min={1} max={99} onCommit={setConfidenceThreshold} />
            </label>
          </div>
          <label className="checkRow">
            <input type="checkbox" checked={autoDeskew} disabled={ocrRunning} onChange={(event) => setAutoDeskew(event.target.checked)} />
            Straighten skewed scans before recognition
          </label>
          {ocrProgress && (
            <div className="progressLine" role="status">
              <span className="spinner" /> {ocrProgress}
            </div>
          )}
          <div className="ocrReviewHeader">
            <div>
              <b>Review</b>
              <span>
                {ocrText.length} lines recognised · {lowConfidenceOcr.length} below {confidenceThreshold}%
              </span>
            </div>
            {ocrText.length > 0 && (
              <button className="danger" disabled={ocrRunning} onClick={() => { const targets = ocrText.filter((overlay) => ocrScope === "document" || overlay.page === sourcePage); if (targets.length) execute({ type: "removeMany", overlays: targets }); }}>
                Remove text layer
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
                  <input defaultValue={overlay.text} onBlur={(event) => event.target.value !== overlay.text && update(overlay, { ...overlay, text: event.target.value })} />
                </label>
              ))}
            </div>
          ) : (
            <p className="empty">{ocrText.length ? "Nothing needs review." : "Recognised lines with low confidence appear here for correction."}</p>
          )}
        </Modal>
      )}

      {dialog === "find" && (
        <Modal
          title="Find & replace"
          className="findModal"
          onClose={() => { setDialog(null); }}
          footer={
            <>
              <button onClick={() => void runFind()} disabled={searching || !findQuery.trim()}>
                {searching ? "Searching…" : "Find all"}
              </button>
              <button className="primary" onClick={replaceAllMatches} disabled={!findResults?.length}>
                Replace all
              </button>
            </>
          }
        >
          <label>
            Find
            <input
              autoFocus
              value={findQuery}
              onChange={(event) => { setFindQuery(event.target.value); setFindResults(null); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runFind();
              }}
            />
          </label>
          <label>
            Replace with
            <input value={replaceQuery} onChange={(event) => setReplaceQuery(event.target.value)} />
          </label>
          <label className="checkRow">
            <input type="checkbox" checked={matchCase} onChange={(event) => { setMatchCase(event.target.checked); setFindResults(null); }} />
            Match case
          </label>
          {findResults && (
            <>
              <div className="findSummary">
                {findResults.length} match{findResults.length === 1 ? "" : "es"}
                {findResults.length > 200 && " (showing first 200)"}
              </div>
              <div className="findResults">
                {findResults.slice(0, 200).map((result) => (
                  <button key={`${result.sourcePage}-${result.line.id}`} onClick={() => { showResult(result); setDialog(null); }}>
                    <b>Page {doc.pageOrder.indexOf(result.sourcePage) + 1}</b>
                    <span>{result.line.text.trim()}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}

      {dialog === "shortcuts" && (
        <Modal title="Keyboard shortcuts" onClose={() => setDialog(null)} footer={<button className="primary" onClick={() => setDialog(null)}>Close</button>}>
          <dl className="shortcuts">
            {[
              ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"],
              ["Ctrl+S", "Export PDF"],
              ["Ctrl+F", "Find & replace"],
              ["Ctrl+P", "Print"],
              ["Ctrl + / Ctrl − / Ctrl+0", "Zoom in / out / fit width"],
              ["Ctrl + scroll, pinch", "Zoom"],
              ["← → / PgUp PgDn / Home End", "Change page"],
              ["V T D L R H N S", "Select, Text, Draw, Line, Shapes, Highlight, Note, Sign"],
              ["Del", "Delete selection"],
              ["Arrows (Shift)", "Nudge selection (further)"],
              ["Ctrl+C / Ctrl+V / Ctrl+D", "Copy / paste / duplicate selection"],
              ["Enter / double-click", "Edit selected text"],
              ["Ctrl+Enter", "Finish editing text"],
              ["Esc", "Cancel, deselect, back to Select"],
            ].map(([keys, action]) => (
              <div key={keys}>
                <dt>{keys}</dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
      {passwordDialog}
      {toasts}
    </div>
  );
}
