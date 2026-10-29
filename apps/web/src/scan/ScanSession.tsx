import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, Camera, Check, ChevronLeft, Crop, Images, Maximize, RotateCcw, RotateCw, ScanLine, Trash2, X, Zap, ZapOff } from "lucide-react";
import { scanFilters, type ScanFilter } from "./filters";
import { FULL_FRAME, isUsableQuad, type Point, type Quad, type Raster } from "./geometry";
import { decode, detectIn, drawRaster, finish, nextFrame, prepareScan, rasterOf, renderScan, straighten, toDataUrl, type ScanSettings } from "./process";

export type ScanPageSize = "fit" | "a4" | "letter";
export type ScanResult = { images: Blob[]; pageSize: ScanPageSize; ocr: boolean; language: string };

type ScanPage = ScanSettings & { id: string; source: Blob; width: number; height: number; output: Blob; url: string };
type Draft = ScanSettings & { pageId?: string; source: Blob; url: string; width: number; height: number; detected: boolean };
type View = "camera" | "crop" | "enhance" | "review";

const quadPath = (quad: Quad, width: number, height: number) => quad.map((point) => `${point.x * width},${point.y * height}`).join(" ");

/**
 * A full-screen, multi-page scanner: camera with live page outline, corner
 * adjustment, enhancement filters and a page review before the PDF is made.
 */
export function ScanSession({
  appending,
  languages,
  defaultLanguage,
  backRef,
  onCancel,
  onDone,
}: {
  appending: boolean;
  languages: readonly { code: string; label: string }[];
  defaultLanguage: string;
  backRef: MutableRefObject<(() => boolean) | null>;
  onCancel: () => void;
  onDone: (result: ScanResult) => void;
}) {
  const [view, setView] = useState<View>("camera");
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<ScanFilter>("document");
  const [working, setWorking] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [live, setLive] = useState<Quad | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [flash, setFlash] = useState(false);
  const [pageSize, setPageSize] = useState<ScanPageSize>("fit");
  const [ocr, setOcr] = useState(false);
  const [language, setLanguage] = useState(defaultLanguage);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());

  const track = (url: string) => (urls.current.add(url), url);
  const release = (url: string) => {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  };
  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  // Camera runs only while its view is open.
  useEffect(() => {
    if (view !== "camera") return;
    let cancelled = false;
    setCameraError("");
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("Live camera isn't available here. Take a photo or import pictures instead.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((item) => item.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const capabilities = stream.getVideoTracks()[0]?.getCapabilities?.() as { torch?: boolean } | undefined;
        setTorch(capabilities?.torch ? false : null);
        setCameraReady(true);
      } catch (cause) {
        if (cancelled) return;
        const name = cause instanceof DOMException ? cause.name : "";
        setCameraError(
          name === "NotAllowedError"
            ? "Camera access is blocked. Allow it in your browser or app settings, or import photos instead."
            : name === "NotFoundError"
              ? "No camera was found. Import photos instead."
              : "The camera could not be started. Import photos instead.",
        );
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((item) => item.stop());
      streamRef.current = null;
      setCameraReady(false);
      setLive(null);
    };
  }, [view]);

  // Outline the page in the viewfinder a few times a second.
  useEffect(() => {
    if (!cameraReady) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video?.videoWidth) return;
      setLive(detectIn(video, video.videoWidth, video.videoHeight));
    }, 350);
    return () => window.clearInterval(timer);
  }, [cameraReady]);

  const toggleTorch = async () => {
    const videoTrack = streamRef.current?.getVideoTracks()[0];
    if (!videoTrack || torch === null) return;
    try {
      await videoTrack.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const startDraft = useCallback(
    async (source: Blob, prepared?: { width: number; height: number; corners: Quad; detected: boolean }) => {
      const info = prepared ?? (await prepareScan(source));
      setDraft({ source, url: track(URL.createObjectURL(source)), ...info, filter, rotation: 0 });
      setView("crop");
    },
    [filter],
  );

  const capture = async () => {
    const video = videoRef.current;
    if (!video?.videoWidth || working) return;
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    navigator.vibrate?.(15);
    const frame = document.createElement("canvas");
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext("2d")!.drawImage(video, 0, 0);
    const corners = detectIn(frame, frame.width, frame.height, 800);
    const blob = await new Promise<Blob | null>((resolve) => frame.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return;
    await startDraft(blob, { width: frame.width, height: frame.height, corners: corners ?? FULL_FRAME, detected: Boolean(corners) });
  };

  const addPage = async (source: Blob, settings: ScanSettings, size: { width: number; height: number }, pageId?: string) => {
    const output = await renderScan(source, settings);
    const url = track(URL.createObjectURL(output));
    setPages((current) => {
      const existing = pageId ? current.find((item) => item.id === pageId) : undefined;
      if (existing) {
        release(existing.url);
        return current.map((item) => (item.id === pageId ? { ...item, ...settings, output, url } : item));
      }
      return [...current, { id: crypto.randomUUID(), source, ...size, ...settings, output, url }];
    });
  };

  const importFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    if (images.length === 1) {
      setWorking("Finding the page…");
      try {
        await startDraft(images[0]!);
      } finally {
        setWorking("");
      }
      return;
    }
    try {
      for (const [index, file] of images.entries()) {
        setWorking(`Processing photo ${index + 1} of ${images.length}…`);
        await nextFrame();
        const info = await prepareScan(file);
        await addPage(file, { corners: info.corners, filter, rotation: 0 }, info);
      }
      setView("review");
    } catch {
      setCameraError("One of the photos could not be read.");
    } finally {
      setWorking("");
    }
  };

  const keepDraft = async () => {
    if (!draft) return;
    setWorking("Saving page…");
    await nextFrame();
    try {
      await addPage(draft.source, draft, draft, draft.pageId);
      setFilter(draft.filter);
      const editing = Boolean(draft.pageId);
      release(draft.url);
      setDraft(null);
      setView(editing ? "review" : "camera");
    } finally {
      setWorking("");
    }
  };

  const editPage = (page: ScanPage) => {
    setDraft({ pageId: page.id, source: page.source, url: track(URL.createObjectURL(page.source)), width: page.width, height: page.height, corners: page.corners, filter: page.filter, rotation: page.rotation, detected: true });
    setView("crop");
  };

  const discardDraft = () => {
    if (draft) release(draft.url);
    const editing = Boolean(draft?.pageId);
    setDraft(null);
    setView(editing ? "review" : "camera");
  };

  const close = () => {
    if (pages.length && !window.confirm(`Discard ${pages.length} scanned page${pages.length === 1 ? "" : "s"}?`)) return;
    onCancel();
  };

  // Android back steps back through the scanner before leaving it.
  backRef.current = () => {
    if (working) return true;
    if (view === "enhance") setView("crop");
    else if (view === "crop") discardDraft();
    else if (view === "review" && pages.length) setView("camera");
    else close();
    return true;
  };
  useEffect(() => () => void (backRef.current = null), [backRef]);

  const move = (index: number, delta: number) =>
    setPages((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, moved!);
      return next;
    });
  const remove = (page: ScanPage) => {
    release(page.url);
    setPages((current) => current.filter((item) => item.id !== page.id));
  };

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label="Scan document">
      {view === "camera" && (
        <section className="scanCamera">
          <header className="scanTop">
            <button className="scanIcon" aria-label="Close scanner" onClick={close}>
              <X />
            </button>
            <span>{appending ? "Scan pages" : "Scan document"}</span>
            {torch !== null ? (
              <button className="scanIcon" aria-label={torch ? "Turn flash off" : "Turn flash on"} aria-pressed={torch} onClick={() => void toggleTorch()}>
                {torch ? <Zap /> : <ZapOff />}
              </button>
            ) : (
              <span className="scanIcon" />
            )}
          </header>
          <Viewfinder videoRef={videoRef} live={live} hidden={Boolean(cameraError)} flash={flash} />
          {cameraError && (
            <div className="scanFallback">
              <ScanLine />
              <p>{cameraError}</p>
              <button className="scanPrimary" onClick={() => photoRef.current?.click()}>
                <Camera /> Take a photo
              </button>
            </div>
          )}
          {!cameraError && (
            <p className="scanHint" aria-live="polite">
              {!cameraReady ? "Starting camera…" : live ? "Page found — hold steady" : "Fit the page in view"}
            </p>
          )}
          <footer className="scanControls">
            <button className="scanSide" onClick={() => importRef.current?.click()}>
              <Images />
              <span>Import</span>
            </button>
            <button className="shutter" aria-label="Take photo" disabled={!cameraReady || Boolean(working)} onClick={() => void capture()}>
              <span />
            </button>
            <button className="scanSide" disabled={!pages.length} onClick={() => setView("review")} aria-label={pages.length ? `Done, ${pages.length} page${pages.length === 1 ? "" : "s"}` : "Done"}>
              {pages.length ? <img src={pages.at(-1)!.url} alt="" /> : <Check />}
              <span>{pages.length ? `Done (${pages.length})` : "Done"}</span>
            </button>
          </footer>
        </section>
      )}

      {view === "crop" && draft && (
        <CropView
          draft={draft}
          onChange={(corners) => setDraft({ ...draft, corners })}
          onBack={discardDraft}
          onNext={() => setView("enhance")}
          retake={!draft.pageId}
        />
      )}

      {view === "enhance" && draft && (
        <EnhanceView draft={draft} working={working} onChange={(settings) => setDraft({ ...draft, ...settings })} onBack={() => setView("crop")} onKeep={() => void keepDraft()} />
      )}

      {view === "review" && (
        <section className="scanReview">
          <header className="scanTop light">
            <button className="scanIcon" aria-label="Back to camera" onClick={() => setView("camera")}>
              <ChevronLeft />
            </button>
            <span>
              {pages.length} page{pages.length === 1 ? "" : "s"}
            </span>
            <button className="scanIcon" aria-label="Close scanner" onClick={close}>
              <X />
            </button>
          </header>
          <ol className="scanPages">
            {pages.map((page, index) => (
              <li key={page.id}>
                <button className="scanThumb" aria-label={`Edit page ${index + 1}`} onClick={() => editPage(page)}>
                  <img src={page.url} alt={`Scanned page ${index + 1}`} />
                </button>
                <div className="scanThumbBar">
                  <button aria-label={`Move page ${index + 1} earlier`} disabled={!index} onClick={() => move(index, -1)}>
                    <ArrowLeft />
                  </button>
                  <b>{index + 1}</b>
                  <button aria-label={`Move page ${index + 1} later`} disabled={index === pages.length - 1} onClick={() => move(index, 1)}>
                    <ArrowRight />
                  </button>
                  <button aria-label={`Delete page ${index + 1}`} onClick={() => remove(page)}>
                    <Trash2 />
                  </button>
                </div>
              </li>
            ))}
            <li>
              <button className="scanThumb add" onClick={() => setView("camera")}>
                <Camera />
                <span>Add page</span>
              </button>
            </li>
          </ol>
          <div className="scanOptions">
            <label>
              Page size
              <select value={pageSize} onChange={(event) => setPageSize(event.target.value as ScanPageSize)}>
                <option value="fit">Fit to scan</option>
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select>
            </label>
            <label className="scanToggle">
              <input type="checkbox" checked={ocr} onChange={(event) => setOcr(event.target.checked)} />
              Make text searchable (OCR)
            </label>
            {ocr && (
              <label>
                Language
                <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                  {languages.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <footer className="scanFooter">
            <button className="scanPrimary" disabled={!pages.length} onClick={() => onDone({ images: pages.map((page) => page.output), pageSize, ocr, language })}>
              <Check /> {appending ? `Add ${pages.length} page${pages.length === 1 ? "" : "s"}` : "Create PDF"}
            </button>
          </footer>
        </section>
      )}

      {working && (
        <div className="scanWorking" role="status">
          <span className="spinner" /> {working}
        </div>
      )}
      <input
        ref={importRef}
        hidden
        type="file"
        accept="image/*"
        multiple
        aria-label="Import photos to scan"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void importFiles(files);
        }}
      />
      <input
        ref={photoRef}
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Take a photo to scan"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void importFiles(files);
        }}
      />
    </div>
  );
}

/** Size and offset of media drawn with object-fit inside a box. */
function fitted(box: { width: number; height: number }, media: { width: number; height: number }, mode: "contain" | "cover") {
  const scale = (mode === "contain" ? Math.min : Math.max)(box.width / media.width, box.height / media.height);
  const width = media.width * scale;
  const height = media.height * scale;
  return { width, height, left: (box.width - width) / 2, top: (box.height - height) / 2 };
}

function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function Viewfinder({ videoRef, live, hidden, flash }: { videoRef: MutableRefObject<HTMLVideoElement | null>; live: Quad | null; hidden: boolean; flash: boolean }) {
  const [boxRef, box] = useBoxSize<HTMLDivElement>();
  const video = videoRef.current;
  const frame = video?.videoWidth && box.width ? fitted(box, { width: video.videoWidth, height: video.videoHeight }, "cover") : null;
  return (
    <div className="viewfinder" ref={boxRef} hidden={hidden}>
      <video ref={videoRef} playsInline muted autoPlay />
      {frame && live && (
        <svg className="scanLiveQuad" width={box.width} height={box.height} aria-hidden="true">
          <polygon points={live.map((point) => `${frame.left + point.x * frame.width},${frame.top + point.y * frame.height}`).join(" ")} />
        </svg>
      )}
      {flash && <div className="scanFlash" />}
    </div>
  );
}

function CropView({ draft, onChange, onBack, onNext, retake }: { draft: Draft; onChange: (corners: Quad) => void; onBack: () => void; onNext: () => void; retake: boolean }) {
  const [boxRef, box] = useBoxSize<HTMLDivElement>();
  const [dragging, setDragging] = useState<number | null>(null);
  const [detected, setDetected] = useState<Quad | null>(draft.detected ? draft.corners : null);
  const frame = box.width ? fitted(box, draft, "contain") : null;
  const usable = isUsableQuad(draft.corners);
  const full = draft.corners.every((point, index) => Math.abs(point.x - FULL_FRAME[index]!.x) < 1e-3 && Math.abs(point.y - FULL_FRAME[index]!.y) < 1e-3);

  const pointAt = (event: ReactPointerEvent): Point => {
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };
  const detect = async () => {
    if (detected) return onChange(detected);
    const bitmap = await decode(draft.source);
    const found = detectIn(bitmap, bitmap.width, bitmap.height, 800);
    bitmap.close();
    if (found) {
      setDetected(found);
      onChange(found);
    }
  };
  const active = dragging === null ? null : draft.corners[dragging]!;

  return (
    <section className="scanEdit">
      <header className="scanTop">
        <button className="scanIcon" aria-label={retake ? "Retake" : "Cancel"} onClick={onBack}>
          <ChevronLeft />
        </button>
        <span>Adjust corners</span>
        <span className="scanIcon" />
      </header>
      <div className="scanStage" ref={boxRef}>
        {frame && (
          <div className="cropFrame" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}>
            <img src={draft.url} alt="Photo to crop" draggable={false} />
            <svg
              viewBox={`0 0 ${frame.width} ${frame.height}`}
              onPointerMove={(event) => {
                if (dragging === null) return;
                const corners = [...draft.corners] as Quad;
                corners[dragging] = pointAt(event);
                onChange(corners);
              }}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
            >
              <path className="cropShade" fillRule="evenodd" d={`M0 0H${frame.width}V${frame.height}H0Z M${quadPath(draft.corners, frame.width, frame.height).replaceAll(" ", " L")}Z`} />
              <polygon className={usable ? "cropOutline" : "cropOutline bad"} points={quadPath(draft.corners, frame.width, frame.height)} />
              {draft.corners.map((point, index) => (
                <circle
                  key={index}
                  className="cropHandle"
                  role="slider"
                  aria-label={["Top-left corner", "Top-right corner", "Bottom-right corner", "Bottom-left corner"][index]}
                  aria-valuenow={Math.round(point.x * 100)}
                  cx={point.x * frame.width}
                  cy={point.y * frame.height}
                  r={dragging === index ? 16 : 13}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    (event.currentTarget.ownerSVGElement ?? event.currentTarget).setPointerCapture?.(event.pointerId);
                    setDragging(index);
                  }}
                />
              ))}
            </svg>
            {active && (
              <div
                className={`cropLoupe ${active.x < 0.5 && active.y < 0.4 ? "right" : ""}`}
                style={{
                  backgroundImage: `url(${draft.url})`,
                  backgroundSize: `${frame.width * 3}px ${frame.height * 3}px`,
                  backgroundPosition: `${48 - active.x * frame.width * 3}px ${48 - active.y * frame.height * 3}px`,
                }}
              />
            )}
          </div>
        )}
      </div>
      <p className="scanHint dark">{usable ? (detected || !draft.detected ? "Drag the corners to the page edges." : "") : "The corners cross over. Drag them to the page corners."}</p>
      <footer className="scanBar">
        <button onClick={() => (full ? void detect() : onChange(FULL_FRAME))}>
          {full ? <Crop /> : <Maximize />}
          <span>{full ? "Auto detect" : "Whole photo"}</span>
        </button>
        <button className="scanPrimary" disabled={!usable} onClick={onNext}>
          Next <ArrowRight />
        </button>
      </footer>
    </section>
  );
}

function EnhanceView({
  draft,
  working,
  onChange,
  onBack,
  onKeep,
}: {
  draft: Draft;
  working: string;
  onChange: (settings: Partial<ScanSettings>) => void;
  onBack: () => void;
  onKeep: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [straight, setStraight] = useState<{ preview: Raster; tiny: Raster } | null>(null);
  const cornersKey = JSON.stringify(draft.corners);

  useEffect(() => {
    let cancelled = false;
    setStraight(null);
    void (async () => {
      await nextFrame();
      const bitmap = await decode(draft.source);
      try {
        const raster = rasterOf(bitmap, bitmap.width, bitmap.height, 1600);
        const preview = straighten(raster, draft.corners, 1100);
        const tiny = straighten(raster, draft.corners, 120);
        if (!cancelled) setStraight({ preview, tiny });
      } finally {
        bitmap.close();
      }
    })();
    return () => {
      cancelled = true;
    };
    // The corners decide the straightened image; filter and rotation do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.source, cornersKey]);

  useEffect(() => {
    if (straight && canvasRef.current) drawRaster(canvasRef.current, finish(straight.preview, draft));
  }, [straight, draft.filter, draft.rotation]); // eslint-disable-line react-hooks/exhaustive-deps

  const thumbnails = useMemo(
    () => (straight ? Object.fromEntries(scanFilters.map((item) => [item.id, toDataUrl(finish(straight.tiny, { filter: item.id, rotation: 0 }))])) : {}),
    [straight],
  );

  return (
    <section className="scanEdit">
      <header className="scanTop">
        <button className="scanIcon" aria-label="Back to corners" onClick={onBack}>
          <ChevronLeft />
        </button>
        <span>Enhance</span>
        <span className="scanIcon" />
      </header>
      <div className="scanStage">{straight ? <canvas ref={canvasRef} className="scanPreview" role="img" aria-label="Corrected page" /> : <span className="spinner" />}</div>
      <div className="scanFilters" role="radiogroup" aria-label="Filter">
        {scanFilters.map((item) => (
          <button key={item.id} role="radio" aria-checked={draft.filter === item.id} className={draft.filter === item.id ? "active" : ""} onClick={() => onChange({ filter: item.id })}>
            {thumbnails[item.id] ? <img src={thumbnails[item.id]} alt="" /> : <span className="filterBlank" />}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <footer className="scanBar">
        <button aria-label="Rotate left" onClick={() => onChange({ rotation: (draft.rotation + 270) % 360 })}>
          <RotateCcw />
        </button>
        <button aria-label="Rotate right" onClick={() => onChange({ rotation: (draft.rotation + 90) % 360 })}>
          <RotateCw />
        </button>
        <button className="scanPrimary" disabled={!straight || Boolean(working)} onClick={onKeep}>
          <Check /> {draft.pageId ? "Save page" : "Keep page"}
        </button>
      </footer>
    </section>
  );
}
