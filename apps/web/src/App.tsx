import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, Bold, ChevronLeft, ChevronRight, Crop, Download, FileImage, FilePlus2, Highlighter, Info, Italic, ListChecks, Merge, MousePointer2, PenLine, Redo2, RotateCw, Scissors, Shapes, Signature, Trash2, Type, Underline, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { createPdfEngine, type FormField, type PageInfo, type PdfMetadata } from "@paperless/pdf-engine";
import { EditorDocumentSchema, normalizeRect, type EditorDocument, type Overlay, type Tool } from "@paperless/editor-core";
import { deleteProject, listProjects, loadProject, saveProject, type ProjectSummary } from "./persistence";
import { useEditor } from "./store";
import { configureNativeUi, registerBackHandler, savePdf } from "./platform";

const tools: { id: Tool; label: string; Icon: typeof MousePointer2 }[] = [
  { id: "select", label: "Select", Icon: MousePointer2 },
  { id: "text", label: "Add text", Icon: Type },
  { id: "ink", label: "Draw", Icon: PenLine },
  { id: "signature", label: "Sign", Icon: Signature },
  { id: "shape", label: "Shapes", Icon: Shapes },
  { id: "redact", label: "Redact", Icon: Highlighter },
  { id: "crop", label: "Crop", Icon: Crop },
];

type OpenDoc = { id: string; name: string; bytes: ArrayBuffer; pages: PageInfo[]; urls: Map<string, string>; formFields: FormField[]; initialMetadata: PdfMetadata; initialFormValues: Record<string, string> };
type ShapeKind = "rectangle" | "square" | "circle" | "triangle";
const withTimeout = <T,>(promise: Promise<T>, milliseconds: number, message: string) => new Promise<T>((resolve, reject) => {
  const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
  promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (error) => { window.clearTimeout(timer); reject(error); });
});

export function App() {
  const engine = useRef<ReturnType<typeof createPdfEngine> | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const [open, setOpen] = useState<OpenDoc | null>(null);
  const [showProperties, setShowProperties] = useState(false);
  const [showForms, setShowForms] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState<PdfMetadata>({ title: "", author: "", subject: "", keywords: "" });
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rectangle");
  const [drawColor, setDrawColor] = useState("#d64b35");
  const { tool, zoom, page, doc, undo, redo, setTool, setZoom, setPage, execute, undoOnce, redoOnce, reset, hydrate } = useEditor();

  const refreshRecent = useCallback(() => listProjects().then(setRecent).catch(() => setRecent([])), []);

  useEffect(() => {
    engine.current = createPdfEngine();
    void configureNativeUi();
    void refreshRecent();
    return () => engine.current?.terminate();
  }, [refreshRecent]);

  const openBytes = useCallback(async (input: { id: string; name: string; bytes: ArrayBuffer; snapshot?: EditorDocument }) => {
    const sequence = ++loadSequence.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const loadOnce = async () => {
        const activeEngine = engine.current!;
        await withTimeout(activeEngine.ready, 20_000, "The PDF engine took too long to start.");
        return withTimeout(activeEngine.api.loadDocument(input.bytes.slice(0)), 35_000, "This document took too long to load.");
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
        const validOrder = snapshot.pageOrder.length > 0 && snapshot.pageOrder.every((item) => item < meta.pageCount) && new Set(snapshot.pageOrder).size === snapshot.pageOrder.length;
        if (!validOrder) throw new Error("The recovered page order is invalid for this PDF.");
        hydrate(snapshot);
      } else {
        const formValues = Object.fromEntries(meta.formFields.map((field) => [field.name, field.value]));
        reset(meta.pageCount, { metadata: meta.metadata, formValues });
      }
      const initialFormValues = Object.fromEntries(meta.formFields.map((field) => [field.name, field.value]));
      setMetadataDraft(input.snapshot?.metadata ?? meta.metadata);
      setOpen({ id: input.id, name: input.name, bytes: input.bytes, pages: meta.pages, urls: new Map(), formFields: meta.formFields, initialMetadata: meta.metadata, initialFormValues });
      setImage(null);
      setSelectedId(null);
    } catch (cause) {
      if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "This PDF could not be opened.");
    } finally {
      if (sequence === loadSequence.current) setBusy(false);
    }
  }, [hydrate, reset]);

  const load = useCallback(async (file: File) => {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF file.");
      return;
    }
    await openBytes({ id: crypto.randomUUID(), name: file.name, bytes: await file.arrayBuffer() });
  }, [openBytes]);

  const recover = useCallback(async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const project = await loadProject(id);
      await openBytes(project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The project could not be recovered.");
      setBusy(false);
    }
  }, [openBytes]);

  const openId = open?.id;
  const openName = open?.name;
  const openBytesRef = open?.bytes;
  const sourcePage = doc.pageOrder[page] ?? 0;
  useEffect(() => {
    if (!openBytesRef || doc.pageOrder.length === 0) return;
    let active = true;
    setBusy(true);
    const render = async () => {
      try {
        await withTimeout(engine.current!.ready, 20_000, "The PDF renderer did not start.");
        return await withTimeout(engine.current!.api.renderPage(sourcePage, Math.min(2, Math.max(1, window.devicePixelRatio))), 30_000, "This page took too long to render.");
      } catch {
        engine.current?.terminate();
        engine.current = createPdfEngine();
        await withTimeout(engine.current.ready, 20_000, "The PDF renderer did not restart.");
        await withTimeout(engine.current.api.loadDocument(openBytesRef.slice(0)), 35_000, "The document could not be recovered.");
        return withTimeout(engine.current.api.renderPage(sourcePage, Math.min(2, Math.max(1, window.devicePixelRatio))), 30_000, "This page could not be rendered.");
      }
    };
    void render().then((png) => {
      if (!active) return;
      const key = `${sourcePage}`;
      const copy = new Uint8Array(png.byteLength);
      copy.set(png);
      const url = URL.createObjectURL(new Blob([copy.buffer], { type: "image/png" }));
      setOpen((current) => {
        if (!current) return current;
        const old = current.urls.get(key);
        if (old) URL.revokeObjectURL(old);
        return { ...current, urls: new Map(current.urls).set(key, url) };
      });
      setImage(url);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Page render failed")).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [openBytesRef, sourcePage, doc.pageOrder.length]);

  useEffect(() => {
    if (!openId || !openName || !openBytesRef || doc.pageOrder.length === 0) return;
    setSaving(true);
    const timer = window.setTimeout(() => {
      void saveProject({ id: openId, name: openName, bytes: openBytesRef, snapshot: doc })
        .then(refreshRecent)
        .catch((cause) => setError(cause instanceof Error ? cause.message : "Autosave failed."))
        .finally(() => setSaving(false));
    }, 500);
    return () => { window.clearTimeout(timer); setSaving(false); };
  }, [openId, openName, openBytesRef, doc, refreshRecent]);

  useEffect(() => {
    if (page >= doc.pageOrder.length && doc.pageOrder.length > 0) setPage(doc.pageOrder.length - 1);
  }, [doc.pageOrder.length, page, setPage]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoOnce(); else undoOnce();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redoOnce(); }
      if (event.key === "PageDown" && open) setPage(Math.min(doc.pageOrder.length - 1, page + 1));
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
    if (doc.pageOrder.length <= 1) { setError("A PDF must contain at least one page."); return; }
    const after = doc.pageOrder.filter((_, itemIndex) => itemIndex !== index);
    execute({ type: "setPageOrder", before: doc.pageOrder, after });
    setPage(Math.min(index, after.length - 1));
  };

  const closeDocument = () => {
    open?.urls.forEach((url) => URL.revokeObjectURL(url));
    setOpen(null);
    setImage(null);
    setNotice("");
    setError("");
    void refreshRecent();
  };

  useEffect(() => {
    let dispose = () => undefined;
    void registerBackHandler(() => {
      if (showProperties) { setShowProperties(false); return true; }
      if (showForms) { setShowForms(false); return true; }
      if (open) { open.urls.forEach((url) => URL.revokeObjectURL(url)); setOpen(null); setImage(null); void refreshRecent(); return true; }
      return false;
    }).then((cleanup) => { dispose = cleanup; });
    return () => dispose();
  }, [open, refreshRecent, showForms, showProperties]);

  const download = async () => {
    if (!open) return;
    setError("");
    setNotice("");
    setExporting(true);
    try {
      const edited = doc.overlays.length > 0 || Object.keys(doc.rotations).length > 0 || Object.keys(doc.crops).length > 0 || JSON.stringify(doc.metadata) !== JSON.stringify(open.initialMetadata) || JSON.stringify(doc.formValues) !== JSON.stringify(open.initialFormValues) || doc.pageOrder.some((item, index) => item !== index) || doc.pageOrder.length !== open.pages.length;
      let bytes: Uint8Array | ArrayBuffer = open.bytes;
      let filename = open.name;
      if (edited) {
        setNotice("Preparing and validating your PDF…");
        await withTimeout(engine.current!.ready, 20_000, "The PDF exporter did not start.");
        const result = await withTimeout(engine.current!.api.exportDocument({ overlays: doc.overlays, rotations: doc.rotations, pageOrder: doc.pageOrder, crops: doc.crops, metadata: doc.metadata, formValues: doc.formValues }), 90_000, "Export timed out. Your edits are still saved locally; please try again.");
        const copy = new Uint8Array(result.bytes.byteLength);
        copy.set(result.bytes);
        bytes = copy.buffer;
        filename = `${open.name.replace(/\.pdf$/i, "")}-edited.pdf`;
        setNotice(`Export verified: ${result.pageCount} pages, ${result.annotationCount} edits, ${result.redactionCount} redactions.`);
      }
      const message = await withTimeout(savePdf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), filename), 45_000, "The Android save dialog did not open. Please try again.");
      setNotice((current) => current ? `${current} ${message}.` : message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PDF export failed validation.");
    } finally {
      setExporting(false);
    }
  };

  const exportRequest = { overlays: doc.overlays, rotations: doc.rotations, pageOrder: doc.pageOrder, crops: doc.crops, metadata: doc.metadata, formValues: doc.formValues };
  const downloadBytes = (bytes: Uint8Array, filename: string) => savePdf(bytes, filename);

  const addImage = async (file: File) => {
    if (!open || !file.type.startsWith("image/")) { setError("Choose a PNG or JPEG image."); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = reject; image.src = dataUrl; });
    const info = open.pages[sourcePage]!; const width = 0.3; const height = Math.min(0.5, width * (dimensions.height / dimensions.width) * (info.width / info.height));
    const overlay: Overlay = { id: crypto.randomUUID(), page: sourcePage, kind: "image", x: 0.12, y: 0.12, width, height, dataUrl };
    execute({ type: "add", overlay });
    setSelectedId(overlay.id);
    setTool("select");
  };

  const mergePdf = async (file: File) => {
    if (!open) return;
    setBusy(true); setError("");
    try { const result = await engine.current!.api.mergeDocument(await file.arrayBuffer(), exportRequest); const copy = new Uint8Array(result.bytes.byteLength); copy.set(result.bytes); await openBytes({ id: crypto.randomUUID(), name: `${open.name.replace(/\.pdf$/i, "")}-merged.pdf`, bytes: copy.buffer }); setNotice(`Merged document created with ${result.pageCount} pages.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "PDF merge failed."); }
    finally { setBusy(false); }
  };

  const splitCurrentPage = async () => {
    if (!open) return;
    setExporting(true); setError("");
    try { const result = await engine.current!.api.exportDocument({ ...exportRequest, pageOrder: [sourcePage] }); const message = await downloadBytes(result.bytes, `${open.name.replace(/\.pdf$/i, "")}-page-${page + 1}.pdf`); setNotice(`Current page exported and verified. ${message}.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Page split failed."); }
    finally { setExporting(false); }
  };

  const saveMetadata = () => { execute({ type: "setMetadata", before: doc.metadata, after: metadataDraft }); setShowProperties(false); };
  const pick = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void load(file); };
  const drop = (event: DragEvent) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void load(file); };

  if (!open) return (
    <main className="home" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <header className="brand"><span className="mark">P</span><b>Paperless</b><span className="local">Local only</span></header>
      <section className="hero">
        <p className="eyebrow">PRIVATE BY DEFAULT</p>
        <h1>Edit the PDF.<br /><em>Keep the document.</em></h1>
        <p>Open, review, and mark up PDFs without an account, an upload, or a paywall.</p>
        <label className="openButton"><FilePlus2 />Open a PDF<input aria-label="Open PDF" type="file" accept="application/pdf,.pdf" onChange={pick} /></label>
        <p className="dropcopy">or drop a PDF anywhere</p>
        {recent.length > 0 && <div className="recents"><h2>Recent local projects</h2>{recent.map((project) => <div className="recent" key={project.id}><button onClick={() => void recover(project.id)}><b>{project.name}</b><span>{project.pageCount} pages · {new Date(project.updatedAt).toLocaleString()}</span></button><button aria-label={`Remove ${project.name}`} onClick={() => void deleteProject(project.id).then(refreshRecent)}><Trash2 /></button></div>)}</div>}
        {busy && <p role="status">Opening securely on this device…</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <footer>AGPL-3.0 · No uploads · No analytics</footer>
    </main>
  );

  const current = doc.overlays.filter((item) => item.page === sourcePage);
  const selected = current.find((item) => item.id === selectedId) ?? null;
  const pageInfo = open.pages[sourcePage]!;
  const edited = doc.overlays.length > 0 || Object.keys(doc.rotations).length > 0 || Object.keys(doc.crops).length > 0 || JSON.stringify(doc.metadata) !== JSON.stringify(open.initialMetadata) || JSON.stringify(doc.formValues) !== JSON.stringify(open.initialFormValues) || doc.pageOrder.some((item, index) => item !== index) || doc.pageOrder.length !== open.pages.length;

  return <div className="app">
    <header className="top">
      <div className="file"><span className="mark">P</span><div><b>{open.name}</b><small>{doc.pageOrder.length} pages · {saving ? "saving…" : "saved locally"}</small></div><button aria-label="Close document" onClick={closeDocument}><X /></button></div>
      <div className="history"><button aria-label="Undo" disabled={!undo.length} onClick={undoOnce}><Undo2 /></button><button aria-label="Redo" disabled={!redo.length} onClick={redoOnce}><Redo2 /></button></div>
      <button className="export" disabled={exporting} title={edited ? "Export a validated edited PDF" : "Download original PDF"} onClick={() => void download()}><Download /> {exporting ? "Exporting…" : edited ? "Export PDF" : "Download"}</button>
    </header>
    <div className="work">
      <aside className="rail"><div className="railTitle"><b>Pages</b><span>{doc.pageOrder.length}</span></div>{doc.pageOrder.map((source, index) => <div key={source} role="button" tabIndex={0} className={index === page ? "thumb active" : "thumb"} onClick={() => setPage(index)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setPage(index); }}><span>{index + 1}</span><div className="thumbPreview">Page {source + 1}</div><span className="pageActions"><button aria-label={`Move page ${index + 1} up`} disabled={index === 0} onClick={(event) => { event.stopPropagation(); movePage(index, -1); }}><ArrowUp /></button><button aria-label={`Move page ${index + 1} down`} disabled={index === doc.pageOrder.length - 1} onClick={(event) => { event.stopPropagation(); movePage(index, 1); }}><ArrowDown /></button><button aria-label={`Delete page ${index + 1}`} onClick={(event) => { event.stopPropagation(); removePage(index); }}><Trash2 /></button></span></div>)}</aside>
      <main className="canvasArea">
        <div className="toolRegion">
          <nav className="tools" aria-label="Editing tools">{tools.map(({ id, label, Icon }) => <button key={id} className={tool === id ? "chosen" : ""} aria-pressed={tool === id} onClick={() => { setTool(id); if (id !== "select") setSelectedId(null); }}><Icon /><span>{label}</span></button>)}<span className="divide" /><button onClick={() => imageInput.current?.click()}><FileImage /><span>Image</span></button><input ref={imageInput} hidden type="file" accept="image/png,image/jpeg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void addImage(file); event.target.value = ""; }} /><button onClick={() => execute({ type: "rotate", page: sourcePage, before: doc.rotations[sourcePage] ?? 0, after: (doc.rotations[sourcePage] ?? 0) + 90 })}><RotateCw /><span>Rotate</span></button><button onClick={() => mergeInput.current?.click()}><Merge /><span>Merge</span></button><input ref={mergeInput} hidden type="file" accept="application/pdf,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void mergePdf(file); event.target.value = ""; }} /><button onClick={() => void splitCurrentPage()}><Scissors /><span>Split</span></button><button onClick={() => { setMetadataDraft(doc.metadata); setShowProperties(true); }}><Info /><span>Properties</span></button><button title={open.formFields.length ? "Edit interactive PDF fields" : "No interactive form fields detected"} onClick={() => open.formFields.length ? setShowForms(true) : setNotice("This PDF has no interactive form fields.")}><ListChecks /><span>Forms</span></button></nav>
          {(tool === "shape" || tool === "ink" || tool === "signature" || selected) && <div className="contextBar">
            {tool === "shape" && <label>Shape<select value={shapeKind} onChange={(event) => setShapeKind(event.target.value as ShapeKind)}><option value="rectangle">Rectangle</option><option value="square">Square</option><option value="circle">Circle</option><option value="triangle">Triangle</option></select></label>}
            {(tool === "shape" || tool === "ink" || tool === "signature") && <label>Colour<input aria-label="Drawing colour" type="color" value={drawColor} onChange={(event) => setDrawColor(event.target.value)} /></label>}
            {selected?.kind === "text" && <><label>Text<input className="textInput" value={selected.text} onChange={(event) => execute({ type: "updateOverlay", before: selected, after: { ...selected, text: event.target.value } })} /></label><label>Font<select value={selected.fontFamily} onChange={(event) => execute({ type: "updateOverlay", before: selected, after: { ...selected, fontFamily: event.target.value as "Helvetica" | "Times" | "Courier" } })}><option>Helvetica</option><option>Times</option><option>Courier</option></select></label><label>Size<input className="numberInput" type="number" min="6" max="144" value={selected.size} onChange={(event) => execute({ type: "updateOverlay", before: selected, after: { ...selected, size: Math.max(6, Number(event.target.value)) } })} /></label><button aria-label="Bold" className={selected.bold ? "active" : ""} onClick={() => execute({ type: "updateOverlay", before: selected, after: { ...selected, bold: !selected.bold } })}><Bold /></button><button aria-label="Italic" className={selected.italic ? "active" : ""} onClick={() => execute({ type: "updateOverlay", before: selected, after: { ...selected, italic: !selected.italic } })}><Italic /></button><button aria-label="Underline" className={selected.underline ? "active" : ""} onClick={() => execute({ type: "updateOverlay", before: selected, after: { ...selected, underline: !selected.underline } })}><Underline /></button><label>Colour<input type="color" value={selected.color} onChange={(event) => execute({ type: "updateOverlay", before: selected, after: { ...selected, color: event.target.value } })} /></label></>}
            {selected && selected.kind !== "text" && "color" in selected && <label>Colour<input type="color" value={selected.color} onChange={(event) => execute({ type: "updateOverlay", before: selected, after: { ...selected, color: event.target.value } as Overlay })} /></label>}
            {selected && <button className="danger" onClick={() => { execute({ type: "remove", overlay: selected }); setSelectedId(null); }}><Trash2 /> Delete</button>}
          </div>}
        </div>
        <div className="stage">{busy && <div className="loading">Rendering page…</div>}<div className="pageViewport"><PageCanvas image={image} info={pageInfo} zoom={zoom} rotation={doc.rotations[sourcePage] ?? 0} overlays={current} crop={doc.crops[sourcePage]} tool={tool} shapeKind={shapeKind} drawColor={drawColor} selectedId={selectedId} onSelect={setSelectedId} onAdd={(overlay) => { execute({ type: "add", overlay }); setSelectedId(overlay.id); if (overlay.kind === "text") setTool("select"); }} onUpdate={(before, after) => execute({ type: "updateOverlay", before, after })} onCrop={(crop) => execute({ type: "setCrop", page: sourcePage, before: doc.crops[sourcePage] ?? null, after: crop })} page={sourcePage} /></div></div>
        <div className="status"><div><button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}><ChevronLeft /></button><span>{page + 1} / {doc.pageOrder.length}</span><button onClick={() => setPage(Math.min(doc.pageOrder.length - 1, page + 1))} disabled={page === doc.pageOrder.length - 1}><ChevronRight /></button></div><div><button aria-label="Zoom out" onClick={() => setZoom(zoom - 0.15)}><ZoomOut /></button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => setZoom(zoom + 0.15)}><ZoomIn /></button></div></div>
      </main>
    </div>
    {showProperties && <div className="modalBackdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label="Document properties"><header><h2>Document properties</h2><button aria-label="Close properties" onClick={() => setShowProperties(false)}><X /></button></header>{(["title", "author", "subject", "keywords"] as const).map((key) => <label key={key}>{key.charAt(0).toUpperCase() + key.slice(1)}<input value={metadataDraft[key]} onChange={(event) => setMetadataDraft({ ...metadataDraft, [key]: event.target.value })} /></label>)}<footer><button onClick={() => setShowProperties(false)}>Cancel</button><button className="primary" onClick={saveMetadata}>Save properties</button></footer></section></div>}
    {showForms && <div className="modalBackdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label="PDF form fields"><header><h2>Form fields</h2><button aria-label="Close forms" onClick={() => setShowForms(false)}><X /></button></header>{open.formFields.map((field) => <label key={`${field.page}-${field.name}`}>{field.label || field.name}<span>Page {field.page + 1}</span>{field.type === "choice" ? <select disabled={field.readOnly} value={doc.formValues[field.name] ?? field.value} onChange={(event) => execute({ type: "setFormValue", name: field.name, before: doc.formValues[field.name] ?? field.value, after: event.target.value })}>{field.options.map((option) => <option key={option}>{option}</option>)}</select> : field.type === "checkbox" || field.type === "radio" ? <input disabled={field.readOnly} type="checkbox" checked={(doc.formValues[field.name] ?? field.value) !== "Off"} onChange={(event) => execute({ type: "setFormValue", name: field.name, before: doc.formValues[field.name] ?? field.value, after: event.target.checked ? "Yes" : "Off" })} /> : <input disabled={field.readOnly} defaultValue={doc.formValues[field.name] ?? field.value} onBlur={(event) => execute({ type: "setFormValue", name: field.name, before: doc.formValues[field.name] ?? field.value, after: event.target.value })} />}</label>)}<footer><button className="primary" onClick={() => setShowForms(false)}>Done</button></footer></section></div>}
    {error && <div className="toast" role="alert">{error}</div>}{notice && <div className="toast success" role="status">{notice}</div>}
  </div>;
}

function PageCanvas({ image, info, zoom, rotation, overlays, crop, tool, shapeKind, drawColor, selectedId, onSelect, onAdd, onUpdate, onCrop, page }: { image: string | null; info: PageInfo; zoom: number; rotation: number; overlays: Overlay[]; crop?: { x: number; y: number; width: number; height: number }; tool: Tool; shapeKind: ShapeKind; drawColor: string; selectedId: string | null; onSelect: (id: string | null) => void; onAdd: (overlay: Overlay) => void; onUpdate: (before: Overlay, after: Overlay) => void; onCrop: (crop: { x: number; y: number; width: number; height: number }) => void; page: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const points = useRef<{ x: number; y: number }[]>([]);
  const drag = useRef<{ before: Overlay; start: { x: number; y: number }; bounds: { x: number; y: number; width: number; height: number }; mode: "move" | "resize" } | null>(null);
  const [livePoints, setLivePoints] = useState<{ x: number; y: number }[]>([]);
  const [liveRect, setLiveRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [preview, setPreview] = useState<Overlay | null>(null);
  const position = (event: ReactPointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };
  const boundsOf = (overlay: Overlay) => {
    if (overlay.kind === "ink" || overlay.kind === "signature") {
      const xs = overlay.points.map((point) => point.x); const ys = overlay.points.map((point) => point.y);
      const x = Math.min(...xs); const y = Math.min(...ys);
      return { x, y, width: Math.max(0.02, Math.max(...xs) - x), height: Math.max(0.02, Math.max(...ys) - y) };
    }
    return { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height };
  };
  const sizedRect = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    if (tool !== "shape" || shapeKind !== "square") return normalizeRect(a, b);
    const side = Math.min(Math.abs(b.x - a.x) * info.width, Math.abs(b.y - a.y) * info.height);
    const width = side / info.width; const height = side / info.height;
    return { x: b.x < a.x ? a.x - width : a.x, y: b.y < a.y ? a.y - height : a.y, width, height };
  };
  const down = (event: ReactPointerEvent) => {
    if (tool === "select") { onSelect(null); return; }
    ref.current?.setPointerCapture(event.pointerId);
    start.current = position(event);
    points.current = [start.current];
    setLivePoints(points.current);
    setLiveRect(null);
    if (tool === "text") {
      const text = prompt("Text to add");
      if (text) onAdd({ id: crypto.randomUUID(), page, kind: "text", x: start.current.x, y: start.current.y, width: 0.3, height: 0.07, text, size: 18, color: drawColor, fontFamily: "Helvetica", bold: false, italic: false, underline: false });
      start.current = null;
      setLivePoints([]);
    }
  };
  const move = (event: ReactPointerEvent) => {
    const current = position(event);
    if (drag.current) {
      const { before, start: origin, bounds, mode } = drag.current;
      const dx = current.x - origin.x; const dy = current.y - origin.y;
      if (before.kind === "ink" || before.kind === "signature") {
        if (mode === "move") setPreview({ ...before, points: before.points.map((point) => ({ x: Math.min(1, Math.max(0, point.x + dx)), y: Math.min(1, Math.max(0, point.y + dy)) })) });
        else {
          const width = Math.max(0.02, current.x - bounds.x); const height = Math.max(0.02, current.y - bounds.y);
          setPreview({ ...before, points: before.points.map((point) => ({ x: bounds.x + ((point.x - bounds.x) / bounds.width) * width, y: bounds.y + ((point.y - bounds.y) / bounds.height) * height })) });
        }
      } else if (mode === "move") {
        setPreview({ ...before, x: Math.min(1 - bounds.width, Math.max(0, bounds.x + dx)), y: Math.min(1 - bounds.height, Math.max(0, bounds.y + dy)) });
      } else {
        setPreview({ ...before, width: Math.max(0.02, current.x - bounds.x), height: Math.max(0.02, current.y - bounds.y) });
      }
      return;
    }
    if ((tool === "ink" || tool === "signature") && start.current) { points.current = [...points.current, current]; setLivePoints(points.current); }
    if ((tool === "shape" || tool === "redact" || tool === "crop") && start.current) setLiveRect(sizedRect(start.current, current));
  };
  const up = (event: ReactPointerEvent) => {
    if (drag.current) {
      const before = drag.current.before;
      if (preview && JSON.stringify(preview) !== JSON.stringify(before)) onUpdate(before, preview);
      drag.current = null; setPreview(null);
      return;
    }
    if (!start.current) return;
    const end = position(event);
    if ((tool === "ink" || tool === "signature") && points.current.length > 1) onAdd({ id: crypto.randomUUID(), page, kind: tool, points: points.current, color: tool === "signature" ? "#171714" : drawColor, width: tool === "signature" ? 2 : 3 });
    if (tool === "shape") { const rect = sizedRect(start.current, end); if (rect.width > 0.01 && rect.height > 0.01) onAdd({ id: crypto.randomUUID(), page, kind: "shape", shape: shapeKind, ...rect, color: drawColor, fillColor: null, strokeWidth: 2 }); }
    if (tool === "redact") { const rect = normalizeRect(start.current, end); if (rect.width > 0.01 && rect.height > 0.01) onAdd({ id: crypto.randomUUID(), page, kind: "redact", ...rect, color: "#111111" }); }
    if (tool === "crop") { const rect = normalizeRect(start.current, end); if (rect.width > 0.05 && rect.height > 0.05) onCrop(rect); }
    start.current = null;
    points.current = [];
    setLivePoints([]);
    setLiveRect(null);
  };
  const shown = overlays.map((overlay) => preview?.id === overlay.id ? preview : overlay);
  const objectDown = (event: ReactPointerEvent, overlay: Overlay, mode: "move" | "resize") => {
    if (tool !== "select") return;
    event.stopPropagation(); ref.current?.setPointerCapture(event.pointerId); onSelect(overlay.id);
    drag.current = { before: overlay, start: position(event), bounds: boundsOf(overlay), mode };
    setPreview(overlay);
  };
  return <div className="pageWrap" style={{ width: info.width * zoom, height: info.height * zoom, transform: `rotate(${rotation}deg)` }}><div ref={ref} className={`page tool-${tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    {image && <img src={image} alt={`Rendered PDF page ${page + 1}`} draggable={false} />}
    {shown.filter((overlay): overlay is Extract<Overlay, { kind: "image" }> => overlay.kind === "image").map((overlay) => <img key={overlay.id} className="imageOverlay" src={overlay.dataUrl} alt="Placed PDF content" style={{ left: `${overlay.x * 100}%`, top: `${overlay.y * 100}%`, width: `${overlay.width * 100}%`, height: `${overlay.height * 100}%` }} />)}
    <svg className="overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
      {shown.map((overlay) => overlay.kind === "ink" || overlay.kind === "signature" ? <polyline key={overlay.id} points={overlay.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={overlay.color} strokeWidth={overlay.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" /> : overlay.kind === "rect" || overlay.kind === "redact" ? <rect key={overlay.id} x={overlay.x} y={overlay.y} width={overlay.width} height={overlay.height} fill={overlay.kind === "redact" ? overlay.color : "transparent"} stroke={overlay.color} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : overlay.kind === "shape" ? overlay.shape === "circle" ? <ellipse key={overlay.id} cx={overlay.x + overlay.width / 2} cy={overlay.y + overlay.height / 2} rx={overlay.width / 2} ry={overlay.height / 2} fill={overlay.fillColor ?? "transparent"} stroke={overlay.color} strokeWidth={overlay.strokeWidth} vectorEffect="non-scaling-stroke" /> : overlay.shape === "triangle" ? <polygon key={overlay.id} points={`${overlay.x + overlay.width / 2},${overlay.y} ${overlay.x + overlay.width},${overlay.y + overlay.height} ${overlay.x},${overlay.y + overlay.height}`} fill={overlay.fillColor ?? "transparent"} stroke={overlay.color} strokeWidth={overlay.strokeWidth} vectorEffect="non-scaling-stroke" /> : <rect key={overlay.id} x={overlay.x} y={overlay.y} width={overlay.width} height={overlay.height} fill={overlay.fillColor ?? "transparent"} stroke={overlay.color} strokeWidth={overlay.strokeWidth} vectorEffect="non-scaling-stroke" /> : null)}
      {livePoints.length > 1 && <polyline points={livePoints.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={tool === "signature" ? "#171714" : drawColor} strokeWidth={tool === "signature" ? 2 : 3} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />}
      {liveRect && tool === "shape" && (shapeKind === "circle" ? <ellipse cx={liveRect.x + liveRect.width / 2} cy={liveRect.y + liveRect.height / 2} rx={liveRect.width / 2} ry={liveRect.height / 2} fill="transparent" stroke={drawColor} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : shapeKind === "triangle" ? <polygon points={`${liveRect.x + liveRect.width / 2},${liveRect.y} ${liveRect.x + liveRect.width},${liveRect.y + liveRect.height} ${liveRect.x},${liveRect.y + liveRect.height}`} fill="transparent" stroke={drawColor} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : <rect x={liveRect.x} y={liveRect.y} width={liveRect.width} height={liveRect.height} fill="transparent" stroke={drawColor} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      {liveRect && tool === "redact" && <rect x={liveRect.x} y={liveRect.y} width={liveRect.width} height={liveRect.height} fill="#d64b3544" stroke="#d64b35" strokeWidth="2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
      {liveRect && tool === "crop" && <rect className="cropRect" x={liveRect.x} y={liveRect.y} width={liveRect.width} height={liveRect.height} />}
      {crop && <rect className="cropRect" x={crop.x} y={crop.y} width={crop.width} height={crop.height} />}
    </svg>
    {shown.filter((overlay): overlay is Extract<Overlay, { kind: "text" }> => overlay.kind === "text").map((overlay) => <span key={overlay.id} className="textOverlay" style={{ left: `${overlay.x * 100}%`, top: `${overlay.y * 100}%`, width: `${overlay.width * 100}%`, height: `${overlay.height * 100}%`, fontSize: overlay.size * zoom, color: overlay.color, fontFamily: overlay.fontFamily === "Times" ? "Times New Roman, serif" : overlay.fontFamily === "Courier" ? "Courier New, monospace" : "Arial, sans-serif", fontWeight: overlay.bold ? 700 : 400, fontStyle: overlay.italic ? "italic" : "normal", textDecoration: overlay.underline ? "underline" : "none" }}>{overlay.text}</span>)}
    {tool === "select" && shown.map((overlay) => { const bounds = boundsOf(overlay); const selected = selectedId === overlay.id; return <div key={`hit-${overlay.id}`} className={`objectBox ${selected ? "selected" : ""}`} style={{ left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }} onPointerDown={(event) => objectDown(event, overlay, "move")}>{selected && <button className="resizeHandle" aria-label="Resize selected object" onPointerDown={(event) => objectDown(event, overlay, "resize")} />}</div>; })}
  </div></div>;
}
