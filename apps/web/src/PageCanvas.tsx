import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { normalizeRect, type Overlay, type Tool } from "@paperless/editor-core";
import type { PageInfo, PositionedTextLine } from "@paperless/pdf-engine";
import { fitTextBox, layoutStyled, previewTextStyle } from "./textMetrics";
import { boundsOf, snapToText, type Rect } from "./geometry";
import { LAYOUT_ID } from "./layout";

export type ShapeKind = "rectangle" | "square" | "circle" | "triangle";
export type MarkupKind = "highlight" | "underline" | "strikeout" | "squiggly";
type Point = { x: number; y: number };
type TextOverlay = Extract<Overlay, { kind: "text" }>;

export type CanvasSettings = {
  shapeKind: ShapeKind;
  drawColor: string;
  fillColor: string | null;
  strokeWidth: number;
  lineArrow: "none" | "end" | "both";
  textColor: string;
  textSize: number;
  textFont: string;
  markupKind: MarkupKind;
  noteType: "sticky" | "callout";
  stampLabel: string;
  measureKind: "distance" | "perimeter" | "area";
  measureUnit: "pt" | "in" | "cm" | "mm";
  measureScale: number;
  reviewAuthor: string;
  pendingAttachment: { name: string; mimeType: string; dataUrl: string } | null;
  formType: "text" | "choice" | "checkbox" | "radio" | "signature";
  formName: string;
  formValidation: "none" | "email" | "number" | "regex";
  formPattern: string;
  signatureMode: "draw" | "typed" | "image" | "digital";
  signatureName: string;
  signatureImage: string | null;
  hasCertificate: boolean;
};

/** An in-progress edit of original text, with the page's text runs at the time. */
export type OriginalEdit = { line: PositionedTextLine; draft: string; source: number; lines: PositionedTextLine[] };

const rectTools: Tool[] = ["shape", "redact", "crop", "markup", "measure", "form"];
const pointTools: Tool[] = ["ink", "line"];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const percent = (rect: Rect): CSSProperties => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`,
  height: `${rect.height * 100}%`,
});

function TextBlock({ overlay, info, zoom }: { overlay: TextOverlay; info: PageInfo; zoom: number }) {
  const layout = layoutStyled(overlay, overlay.text, info);
  return (
    <span
      className="textOverlay"
      style={{
        ...percent(overlay),
        ...previewTextStyle(overlay, layout.size, zoom),
        opacity: overlay.opacity ?? 1,
        transform: overlay.rotation ? `rotate(${overlay.rotation}deg)` : undefined,
      }}
    >
      {layout.lines.map((line, index) => (
        <span
          key={index}
          className="textLine"
          style={{
            textAlign:
              overlay.alignment === "justify" ? (index < layout.lines.length - 1 ? "justify" : "left") : overlay.alignment,
            textAlignLast: overlay.alignment === "justify" && index < layout.lines.length - 1 ? "justify" : undefined,
          }}
        >
          {line || "​"}
        </span>
      ))}
    </span>
  );
}

type Draft = { kind: "text" | "note"; x: number; y: number; text: string };

export function PageCanvas(props: {
  image: string | null;
  info: PageInfo;
  zoom: number;
  rotation: number;
  overlays: Overlay[];
  textLines: PositionedTextLine[];
  originalEdit: OriginalEdit | null;
  crop?: Rect;
  tool: Tool;
  settings: CanvasSettings;
  selectedId: string | null;
  editingId: string | null;
  highlight: Rect | null;
  page: number;
  onSelect: (id: string | null) => void;
  onEditText: (id: string | null) => void;
  onOriginalSelect: (line: PositionedTextLine) => void;
  onOriginalChange: (draft: string) => void;
  onOriginalCommit: () => void;
  onOriginalCancel: () => void;
  onAdd: (overlays: Overlay[]) => void;
  onUpdate: (before: Overlay, after: Overlay, merge?: string) => void;
  onCrop: (crop: Rect) => void;
  onMessage: (message: string) => void;
}) {
  const { info, zoom, tool, settings, page } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const start = useRef<Point | null>(null);
  const points = useRef<Point[]>([]);
  const drag = useRef<{ before: Overlay; start: Point; bounds: Rect; mode: "move" | "resize" } | null>(null);
  const [livePoints, setLivePoints] = useState<Point[]>([]);
  const [liveRect, setLiveRect] = useState<Rect | null>(null);
  const [preview, setPreview] = useState<Overlay | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [draft, setDraftState] = useState<Draft | null>(null);
  // Commits can come from both blur and a page click; the ref makes them idempotent.
  const draftRef = useRef<Draft | null>(null);
  const setDraft = (next: Draft | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const rotation = ((props.rotation % 360) + 360) % 360;
  const sideways = rotation === 90 || rotation === 270;
  const pageWidth = info.width * zoom;
  const pageHeight = info.height * zoom;

  useEffect(() => {
    draftRef.current = null;
    setDraftState(null);
  }, [page, tool]);

  /** Maps a pointer to normalized coordinates of the unrotated page. */
  const position = (event: { clientX: number; clientY: number }): Point => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    const mapped =
      rotation === 90 ? { x: v, y: 1 - u } : rotation === 180 ? { x: 1 - u, y: 1 - v } : rotation === 270 ? { x: 1 - v, y: u } : { x: u, y: v };
    return { x: clamp01(mapped.x), y: clamp01(mapped.y) };
  };

  const sizedRect = (a: Point, b: Point) => {
    if (tool !== "shape" || settings.shapeKind !== "square") return normalizeRect(a, b);
    const side = Math.min(Math.abs(b.x - a.x) * info.width, Math.abs(b.y - a.y) * info.height);
    const width = side / info.width;
    const height = side / info.height;
    return { x: b.x < a.x ? a.x - width : a.x, y: b.y < a.y ? a.y - height : a.y, width, height };
  };

  const review = () => ({
    author: settings.reviewAuthor,
    createdAt: new Date().toISOString(),
    comment: "",
    resolved: false,
    flatten: false,
  });

  const commitDraft = () => {
    const current = draftRef.current;
    setDraft(null);
    if (!current || !current.text.trim()) return;
    if (current.kind === "note") {
      const sticky = settings.noteType === "sticky";
      props.onAdd([
        {
          id: crypto.randomUUID(),
          page,
          kind: "note",
          noteType: settings.noteType,
          x: Math.min(current.x, sticky ? 0.95 : 0.7),
          y: Math.min(current.y, sticky ? 0.95 : 0.9),
          width: sticky ? 0.04 : 0.3,
          height: sticky ? 0.03 : 0.1,
          color: settings.drawColor,
          text: current.text,
          ...review(),
        },
      ]);
      return;
    }
    const style = {
      x: current.x,
      width: 0.05,
      height: 0.02,
      size: settings.textSize,
      fontFamily: settings.textFont,
      bold: false,
      italic: false,
      lineHeight: 1.2,
      letterSpacing: 0,
      fitMode: "auto" as const,
    };
    props.onAdd([
      {
        id: crypto.randomUUID(),
        page,
        kind: "text",
        y: current.y,
        ...style,
        ...fitTextBox(style, current.text, info, ""),
        text: current.text,
        color: settings.textColor,
        fontName: null,
        underline: false,
        alignment: "left",
      },
    ]);
  };

  const down = (event: ReactPointerEvent) => {
    if (event.button > 0) return;
    if (draftRef.current) {
      commitDraft();
      return;
    }
    if (tool === "select") {
      props.onSelect(null);
      return;
    }
    const at = position(event);
    const placeAt = (width: number, height: number) => ({
      x: Math.min(at.x, 1 - width),
      y: Math.min(at.y, 1 - height),
      width,
      height,
    });
    if (tool === "stamp") {
      props.onAdd([{ id: crypto.randomUUID(), page, kind: "stamp", ...placeAt(0.2, 0.06), label: settings.stampLabel, color: settings.drawColor, ...review() }]);
      return;
    }
    if (tool === "attachment") {
      if (!settings.pendingAttachment) props.onMessage("Choose a file to attach first.");
      else props.onAdd([{ id: crypto.randomUUID(), page, kind: "attachment", ...placeAt(0.035, 0.03), ...settings.pendingAttachment, ...review() }]);
      return;
    }
    if (tool === "signature" && settings.signatureMode !== "draw") {
      if (settings.signatureMode === "image" && !settings.signatureImage) {
        props.onMessage("Choose a signature image first.");
        return;
      }
      if (settings.signatureMode === "digital" && !settings.hasCertificate) {
        props.onMessage("Choose a PKCS#12 certificate in Protect → Security first.");
        return;
      }
      const signer = settings.signatureName || "Signer";
      props.onAdd([
        {
          id: crypto.randomUUID(),
          page,
          kind: "visualSignature",
          mode: settings.signatureMode,
          ...placeAt(0.3, 0.07),
          text: settings.signatureMode === "digital" ? `Digitally signed by ${signer}` : signer,
          dataUrl: settings.signatureMode === "image" ? (settings.signatureImage ?? undefined) : undefined,
          color: "#1d2a5b",
          signer,
          signedAt: new Date().toISOString(),
        },
      ]);
      return;
    }
    wrapRef.current?.setPointerCapture(event.pointerId);
    start.current = at;
    points.current = [at];
    setLivePoints([at]);
    setLiveRect(null);
  };

  const move = (event: ReactPointerEvent) => {
    const current = position(event);
    if (drag.current) {
      const { before, start: origin, bounds, mode } = drag.current;
      const dx = current.x - origin.x;
      const dy = current.y - origin.y;
      if (before.kind === "background") return;
      if ("points" in before) {
        if (mode === "move") {
          const shiftX = Math.min(1 - bounds.x - bounds.width, Math.max(-bounds.x, dx));
          const shiftY = Math.min(1 - bounds.y - bounds.height, Math.max(-bounds.y, dy));
          setPreview({ ...before, points: before.points.map((point) => ({ x: point.x + shiftX, y: point.y + shiftY })) } as Overlay);
        } else {
          const width = Math.max(0.01, current.x - bounds.x);
          const height = Math.max(0.01, current.y - bounds.y);
          setPreview({
            ...before,
            points: before.points.map((point) => ({
              x: bounds.x + ((point.x - bounds.x) / bounds.width) * width,
              y: bounds.y + ((point.y - bounds.y) / bounds.height) * height,
            })),
          } as Overlay);
        }
      } else if (mode === "move") {
        let x = Math.min(1 - bounds.width, Math.max(0, bounds.x + dx));
        let y = Math.min(1 - bounds.height, Math.max(0, bounds.y + dy));
        const nextGuides: { x?: number; y?: number } = {};
        for (const [target, guide] of [[0, 0], [0.5 - bounds.width / 2, 0.5], [1 - bounds.width, 1]] as const)
          if (Math.abs(x - target) < 0.01) {
            x = target;
            nextGuides.x = guide;
            break;
          }
        for (const [target, guide] of [[0, 0], [0.5 - bounds.height / 2, 0.5], [1 - bounds.height, 1]] as const)
          if (Math.abs(y - target) < 0.01) {
            y = target;
            nextGuides.y = guide;
            break;
          }
        setGuides(nextGuides);
        setPreview({ ...before, x, y } as Overlay);
      } else {
        const width = Math.min(1 - bounds.x, Math.max(0.02, current.x - bounds.x));
        let height = Math.min(1 - bounds.y, Math.max(0.01, current.y - bounds.y));
        if (before.kind === "text" && before.fitMode !== "overflow")
          height = Math.max(height, layoutStyled(before, before.text, info, width).height / info.height);
        setPreview({ ...before, width, height } as Overlay);
      }
      return;
    }
    if (!start.current) return;
    if (pointTools.includes(tool) || (tool === "signature" && settings.signatureMode === "draw")) {
      points.current = tool === "line" ? [start.current, current] : [...points.current, current];
      setLivePoints(points.current);
    }
    if (rectTools.includes(tool)) setLiveRect(sizedRect(start.current, current));
  };

  const up = (event: ReactPointerEvent) => {
    if (drag.current) {
      const before = drag.current.before;
      if (preview && JSON.stringify(preview) !== JSON.stringify(before)) props.onUpdate(before, preview);
      drag.current = null;
      setPreview(null);
      setGuides({});
      return;
    }
    if (!start.current) return;
    const origin = start.current;
    const end = position(event);
    const rect = normalizeRect(origin, end);
    start.current = null;
    // Drafts open on release so the browser's own focus handling for the
    // press cannot immediately blur the new editor.
    if (tool === "text" || tool === "note") {
      setLivePoints([]);
      setDraft({ kind: tool, x: origin.x, y: origin.y, text: "" });
      return;
    }
    const stroke = points.current;
    points.current = [];
    setLivePoints([]);
    setLiveRect(null);
    const id = crypto.randomUUID();
    if ((tool === "ink" || (tool === "signature" && settings.signatureMode === "draw")) && stroke.length > 1)
      props.onAdd([
        tool === "signature"
          ? { id, page, kind: "signature", points: stroke, color: "#1d2a5b", width: 2 }
          : { id, page, kind: "ink", points: stroke, color: settings.drawColor, width: settings.strokeWidth },
      ]);
    if (tool === "line" && Math.hypot(end.x - origin.x, end.y - origin.y) > 0.01)
      props.onAdd([{ id, page, kind: "line", points: [origin, end], color: settings.drawColor, width: settings.strokeWidth, arrow: settings.lineArrow }]);
    if (tool === "shape") {
      const shaped = sizedRect(origin, end);
      if (shaped.width > 0.01 && shaped.height > 0.01)
        props.onAdd([{ id, page, kind: "shape", shape: settings.shapeKind, ...shaped, color: settings.drawColor, fillColor: settings.fillColor, strokeWidth: settings.strokeWidth }]);
    }
    if (tool === "redact" && rect.width > 0.005 && rect.height > 0.005)
      props.onAdd([{ id, page, kind: "redact", ...rect, color: "#000000", mode: "redact" }]);
    if (tool === "crop" && rect.width > 0.05 && rect.height > 0.05) props.onCrop(rect);
    if (tool === "markup") {
      const snapped = snapToText(rect, props.textLines);
      const boxes = snapped.length ? snapped : rect.width > 0.005 && rect.height > 0.005 ? [rect] : [];
      if (boxes.length)
        props.onAdd(
          boxes.map((box) => ({
            id: crypto.randomUUID(),
            page,
            kind: "markup" as const,
            markup: settings.markupKind,
            ...box,
            color: settings.drawColor,
            opacity: settings.markupKind === "highlight" ? 0.4 : 1,
            ...review(),
          })),
        );
    }
    if (tool === "measure" && (rect.width > 0.005 || rect.height > 0.005)) {
      const kind = settings.measureKind;
      const measured =
        kind === "distance"
          ? [origin, end]
          : [
              { x: rect.x, y: rect.y },
              { x: rect.x + rect.width, y: rect.y },
              { x: rect.x + rect.width, y: rect.y + rect.height },
              { x: rect.x, y: rect.y + rect.height },
            ];
      const widthPoints = rect.width * info.width;
      const heightPoints = rect.height * info.height;
      const unitFactor = { in: 1 / 72, cm: 2.54 / 72, mm: 25.4 / 72, pt: 1 }[settings.measureUnit];
      const raw =
        kind === "distance"
          ? Math.hypot((end.x - origin.x) * info.width, (end.y - origin.y) * info.height)
          : kind === "perimeter"
            ? 2 * (widthPoints + heightPoints)
            : widthPoints * heightPoints;
      const power = kind === "area" ? 2 : 1;
      const value = raw * Math.pow(unitFactor * settings.measureScale, power);
      props.onAdd([
        {
          id,
          page,
          kind: "measurement",
          measurement: kind,
          points: measured,
          color: settings.drawColor,
          unit: settings.measureUnit,
          scale: settings.measureScale,
          label: `${value.toFixed(value >= 100 ? 0 : 2)} ${settings.measureUnit}${power === 2 ? "²" : ""}`,
          ...review(),
        },
      ]);
    }
    if (tool === "form" && rect.width > 0.02 && rect.height > 0.012)
      props.onAdd([
        {
          id,
          page,
          kind: "formField",
          fieldType: settings.formType,
          ...rect,
          name: settings.formName || `Field${Date.now()}`,
          label: settings.formName,
          value: "",
          options: settings.formType === "choice" ? ["Option 1", "Option 2"] : [],
          required: false,
          readOnly: false,
          multiline: false,
          maxLength: 0,
          validation: settings.formValidation,
          validationPattern: settings.formPattern,
          calculation: "",
          tabOrder: props.overlays.filter((item) => item.kind === "formField").length,
          flatten: false,
        },
      ]);
  };

  const shown = props.overlays.map((overlay) => (preview?.id === overlay.id ? preview : overlay));
  const objectDown = (event: ReactPointerEvent, overlay: Overlay, mode: "move" | "resize") => {
    if (tool !== "select" || event.button > 0) return;
    event.stopPropagation();
    if (props.editingId === overlay.id) return;
    wrapRef.current?.setPointerCapture(event.pointerId);
    props.onSelect(overlay.id);
    drag.current = { before: overlay, start: position(event), bounds: boundsOf(overlay), mode };
    setPreview(overlay);
  };
  const lineWasReplaced = (line: PositionedTextLine) =>
    shown.some(
      (overlay) =>
        overlay.kind === "redact" &&
        overlay.mode !== "redact" &&
        overlay.mode !== "eraseImage" &&
        (overlay.mode === "eraseText" || overlay.color.toLowerCase() === "#ffffff") &&
        line.x + line.width / 2 >= overlay.x &&
        line.x + line.width / 2 <= overlay.x + overlay.width &&
        line.y + line.height / 2 >= overlay.y &&
        line.y + line.height / 2 <= overlay.y + overlay.height,
    );
  const liveMarkup = liveRect && tool === "markup" ? snapToText(liveRect, props.textLines) : [];
  const editing = shown.find((overlay): overlay is TextOverlay => overlay.kind === "text" && overlay.id === props.editingId) ?? null;
  const original = props.originalEdit;
  const originalBox = original ? fitTextBox({ ...original.line, fitMode: "auto", lineHeight: 1.2 }, original.draft, info) : null;
  const originalLayout = original && originalBox ? layoutStyled({ ...original.line, fitMode: "auto", lineHeight: 1.2 }, original.draft, info, originalBox.width) : null;
  const draftSize = draft?.kind === "text" ? settings.textSize : 11;
  const editorKeys = (event: ReactKeyboardEvent, commit: () => void, cancel: () => void) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    }
  };

  return (
    <div
      ref={wrapRef}
      className="pageWrap"
      style={{ width: sideways ? pageHeight : pageWidth, height: sideways ? pageWidth : pageHeight }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div
        className={`page tool-${tool}`}
        style={{ width: pageWidth, height: pageHeight, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
      >
        {props.image && <img src={props.image} alt={`Rendered PDF page ${page + 1}`} draggable={false} />}
        {shown.map((overlay) => {
          if (overlay.kind === "background")
            return <span key={overlay.id} className="backgroundOverlay" style={{ background: overlay.color, opacity: overlay.opacity }} />;
          if (overlay.kind === "image")
            return (
              <img
                key={overlay.id}
                className="imageOverlay"
                src={overlay.dataUrl}
                alt={overlay.name ?? "Placed image"}
                draggable={false}
                style={{ ...percent(overlay), opacity: overlay.opacity, transform: `rotate(${overlay.rotation}deg)` }}
              />
            );
          if (overlay.kind === "redact" && overlay.mode !== "redact" && (overlay.mode || overlay.color.toLowerCase() === "#ffffff"))
            return <span key={overlay.id} className="eraseOverlay" style={percent(overlay)} />;
          if (overlay.kind === "visualSignature")
            return overlay.mode === "image" && overlay.dataUrl ? (
              <img key={overlay.id} className="visualSignatureOverlay" src={overlay.dataUrl} alt={`Signature of ${overlay.signer}`} draggable={false} style={percent(overlay)} />
            ) : (
              <span
                key={overlay.id}
                className={`visualSignatureOverlay ${overlay.mode === "digital" ? "digital" : ""}`}
                style={{ ...percent(overlay), color: overlay.color, fontSize: Math.max(10, Math.min(28, overlay.height * info.height * 0.6)) * zoom }}
              >
                {overlay.text}
                {overlay.mode === "digital" && <small>{new Date(overlay.signedAt).toLocaleString()}</small>}
              </span>
            );
          if (overlay.kind === "formField")
            return (
              <span key={overlay.id} className={`formFieldOverlay form-${overlay.fieldType}`} style={{ ...percent(overlay), fontSize: Math.max(8, Math.min(12, overlay.height * info.height * 0.65)) * zoom }}>
                {overlay.fieldType === "checkbox" || overlay.fieldType === "radio"
                  ? overlay.value !== "" && overlay.value !== "Off"
                    ? "✓"
                    : ""
                  : overlay.fieldType === "signature"
                    ? "Sign here"
                    : overlay.value || overlay.label || overlay.name}
                {overlay.required && <b aria-label="Required">*</b>}
              </span>
            );
          if (overlay.kind === "note" && overlay.noteType === "callout")
            return (
              <span key={overlay.id} className="calloutOverlay" style={{ ...percent(overlay), borderColor: overlay.color, color: overlay.color, fontSize: 10 * zoom }}>
                {overlay.text}
              </span>
            );
          if (overlay.kind === "stamp")
            return (
              <span key={overlay.id} className="stampOverlay" style={{ ...percent(overlay), borderColor: overlay.color, color: overlay.color, fontSize: Math.min(14, overlay.height * info.height * 0.55) * zoom }}>
                {overlay.label}
              </span>
            );
          return null;
        })}
        <svg className="overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
          <defs>
            {shown
              .filter((overlay): overlay is Extract<Overlay, { kind: "line" }> => overlay.kind === "line" && overlay.arrow !== "none")
              .map((overlay) => (
                <marker key={overlay.id} id={`arrow-${overlay.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse" markerUnits="strokeWidth">
                  <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke={overlay.color} strokeWidth="1.6" />
                </marker>
              ))}
            <marker id="arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse" markerUnits="strokeWidth">
              <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke={settings.drawColor} strokeWidth="1.6" />
            </marker>
          </defs>
          {shown.map((overlay) => {
            const line = { vectorEffect: "non-scaling-stroke" as const, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
            if (overlay.kind === "ink" || overlay.kind === "signature")
              return <polyline key={overlay.id} points={overlay.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={overlay.color} strokeWidth={overlay.width * zoom} {...line} />;
            if (overlay.kind === "line")
              return (
                <line
                  key={overlay.id}
                  x1={overlay.points[0]!.x}
                  y1={overlay.points[0]!.y}
                  x2={overlay.points[1]!.x}
                  y2={overlay.points[1]!.y}
                  stroke={overlay.color}
                  strokeWidth={overlay.width * zoom}
                  markerEnd={overlay.arrow !== "none" ? `url(#arrow-${overlay.id})` : undefined}
                  markerStart={overlay.arrow === "both" ? `url(#arrow-${overlay.id})` : undefined}
                  {...line}
                />
              );
            if (overlay.kind === "rect")
              return <rect key={overlay.id} {...boundsOf(overlay)} fill="none" stroke={overlay.color} strokeWidth={2 * zoom} {...line} />;
            if (overlay.kind === "redact" && (overlay.mode === "redact" || (!overlay.mode && overlay.color.toLowerCase() !== "#ffffff")))
              return <rect key={overlay.id} {...boundsOf(overlay)} className="redactOverlay" fill={overlay.color} />;
            if (overlay.kind === "shape") {
              const common = { fill: overlay.fillColor ?? "none", stroke: overlay.color, strokeWidth: overlay.strokeWidth * zoom, ...line };
              if (overlay.shape === "circle")
                return <ellipse key={overlay.id} cx={overlay.x + overlay.width / 2} cy={overlay.y + overlay.height / 2} rx={overlay.width / 2} ry={overlay.height / 2} {...common} />;
              if (overlay.shape === "triangle")
                return <polygon key={overlay.id} points={`${overlay.x + overlay.width / 2},${overlay.y} ${overlay.x + overlay.width},${overlay.y + overlay.height} ${overlay.x},${overlay.y + overlay.height}`} {...common} />;
              return <rect key={overlay.id} x={overlay.x} y={overlay.y} width={overlay.width} height={overlay.height} {...common} />;
            }
            if (overlay.kind === "markup") {
              const { x, y, width, height } = overlay;
              if (overlay.markup === "highlight")
                return <rect key={overlay.id} x={x} y={y} width={width} height={height} fill={overlay.color} opacity={overlay.opacity} style={{ mixBlendMode: "multiply" }} />;
              if (overlay.markup === "squiggly") {
                const steps = Math.max(4, Math.round((width * info.width) / 4));
                const amplitude = Math.min(height * 0.12, 3 / info.height);
                const path = Array.from({ length: steps + 1 }, (_, index) => `${index ? "L" : "M"} ${x + (width * index) / steps} ${y + height - amplitude - (index % 2 ? amplitude : 0)}`).join(" ");
                return <path key={overlay.id} d={path} fill="none" stroke={overlay.color} strokeWidth={1.2 * zoom} {...line} />;
              }
              const lineY = overlay.markup === "strikeout" ? y + height / 2 : y + height * 0.94;
              return <line key={overlay.id} x1={x} y1={lineY} x2={x + width} y2={lineY} stroke={overlay.color} strokeWidth={Math.max(1, (height * info.height) / 14) * zoom} {...line} />;
            }
            if (overlay.kind === "note" && overlay.noteType === "sticky")
              return (
                <g key={overlay.id}>
                  <rect x={overlay.x} y={overlay.y} width={overlay.width} height={overlay.height} rx="0.004" fill="#ffe58a" stroke={overlay.color} strokeWidth={1.2 * zoom} {...line} />
                  <path d={`M ${overlay.x + overlay.width * 0.25} ${overlay.y + overlay.height * 0.38} h ${overlay.width * 0.5} M ${overlay.x + overlay.width * 0.25} ${overlay.y + overlay.height * 0.62} h ${overlay.width * 0.35}`} stroke={overlay.color} strokeWidth={1.2 * zoom} {...line} />
                </g>
              );
            if (overlay.kind === "attachment")
              return (
                <g key={overlay.id}>
                  <rect x={overlay.x} y={overlay.y} width={overlay.width} height={overlay.height} rx="0.004" fill="#fff" stroke="#d64b35" strokeWidth={1.2 * zoom} {...line} />
                  <path d={`M ${overlay.x + overlay.width * 0.3} ${overlay.y + overlay.height * 0.7} L ${overlay.x + overlay.width * 0.65} ${overlay.y + overlay.height * 0.3}`} stroke="#d64b35" strokeWidth={1.6 * zoom} {...line} />
                </g>
              );
            if (overlay.kind === "measurement")
              return (
                <g key={overlay.id}>
                  <polyline
                    points={[...overlay.points, ...(overlay.measurement === "distance" ? [] : overlay.points.slice(0, 1))].map((point) => `${point.x},${point.y}`).join(" ")}
                    fill={overlay.measurement === "area" ? `${overlay.color}22` : "none"}
                    stroke={overlay.color}
                    strokeWidth={1.5 * zoom}
                    {...line}
                  />
                </g>
              );
            return null;
          })}
          {livePoints.length > 1 &&
            (tool === "line" ? (
              <line
                x1={livePoints[0]!.x}
                y1={livePoints[0]!.y}
                x2={livePoints[1]!.x}
                y2={livePoints[1]!.y}
                stroke={settings.drawColor}
                strokeWidth={settings.strokeWidth * zoom}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                markerEnd={settings.lineArrow !== "none" ? "url(#arrow-live)" : undefined}
                markerStart={settings.lineArrow === "both" ? "url(#arrow-live)" : undefined}
              />
            ) : (
              <polyline
                points={livePoints.map((point) => `${point.x},${point.y}`).join(" ")}
                fill="none"
                stroke={tool === "signature" ? "#1d2a5b" : settings.drawColor}
                strokeWidth={(tool === "signature" ? 2 : settings.strokeWidth) * zoom}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          {liveRect && tool === "shape" && (
            settings.shapeKind === "circle" ? (
              <ellipse cx={liveRect.x + liveRect.width / 2} cy={liveRect.y + liveRect.height / 2} rx={liveRect.width / 2} ry={liveRect.height / 2} fill={settings.fillColor ?? "none"} stroke={settings.drawColor} strokeWidth={settings.strokeWidth * zoom} vectorEffect="non-scaling-stroke" />
            ) : settings.shapeKind === "triangle" ? (
              <polygon points={`${liveRect.x + liveRect.width / 2},${liveRect.y} ${liveRect.x + liveRect.width},${liveRect.y + liveRect.height} ${liveRect.x},${liveRect.y + liveRect.height}`} fill={settings.fillColor ?? "none"} stroke={settings.drawColor} strokeWidth={settings.strokeWidth * zoom} vectorEffect="non-scaling-stroke" />
            ) : (
              <rect {...liveRect} fill={settings.fillColor ?? "none"} stroke={settings.drawColor} strokeWidth={settings.strokeWidth * zoom} vectorEffect="non-scaling-stroke" />
            )
          )}
          {liveRect && (tool === "redact" || tool === "crop" || tool === "measure" || tool === "form" || (tool === "markup" && !liveMarkup.length)) && (
            <rect {...liveRect} className={`liveRect live-${tool}`} vectorEffect="non-scaling-stroke" />
          )}
          {liveMarkup.map((box, index) => (
            <rect key={index} {...box} fill={settings.drawColor} opacity="0.35" />
          ))}
          {props.crop && (
            <path
              className="cropShade"
              fillRule="evenodd"
              d={`M0 0H1V1H0Z M${props.crop.x} ${props.crop.y}V${props.crop.y + props.crop.height}H${props.crop.x + props.crop.width}V${props.crop.y}Z`}
            />
          )}
          {props.crop && <rect className="cropRect" {...props.crop} vectorEffect="non-scaling-stroke" />}
          {props.highlight && <rect className="searchHighlight" {...props.highlight} />}
          {guides.x !== undefined && <line className="guide" x1={guides.x} y1="0" x2={guides.x} y2="1" vectorEffect="non-scaling-stroke" />}
          {guides.y !== undefined && <line className="guide" x1="0" y1={guides.y} x2="1" y2={guides.y} vectorEffect="non-scaling-stroke" />}
        </svg>
        {shown.map((overlay) =>
          overlay.kind === "measurement" ? (
            <span key={`label-${overlay.id}`} className="measureLabel" style={{ left: `${overlay.points[0]!.x * 100}%`, top: `${overlay.points[0]!.y * 100}%`, color: overlay.color, fontSize: 10 * zoom }}>
              {overlay.label}
            </span>
          ) : overlay.kind === "text" && !overlay.invisible && overlay.id !== props.editingId ? (
            <TextBlock key={overlay.id} overlay={overlay} info={info} zoom={zoom} />
          ) : null,
        )}
        {tool === "select" &&
          props.textLines
            .filter((line) => !lineWasReplaced(line) && line.id !== original?.line.id)
            .map((line) => (
              <button
                key={line.id}
                className="originalTextHit"
                aria-label={`Edit PDF text: ${line.text.trim().slice(0, 80)}`}
                title="Click to edit this text"
                style={percent(line)}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  props.onOriginalSelect(line);
                }}
              />
            ))}
        {original && originalLayout && (
          <>
            <span className="eraseOverlay" style={percent(original.line)} />
            <textarea
              autoFocus
              className="inlineEditor"
              aria-label="Edit original PDF text"
              value={original.draft}
              spellCheck={false}
              style={{
                left: `${original.line.x * 100}%`,
                top: `${original.line.y * 100}%`,
                width: `${Math.max(original.line.width, originalBox!.width) * 100}%`,
                height: `${Math.max(original.line.height, originalLayout.height / info.height) * 100}%`,
                ...previewTextStyle({ ...original.line, lineHeight: 1.2 }, originalLayout.size, zoom),
                textAlign: original.line.alignment,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => props.onOriginalChange(event.target.value)}
              onKeyDown={(event) => editorKeys(event, props.onOriginalCommit, props.onOriginalCancel)}
            />
          </>
        )}
        {editing && (
          <textarea
            autoFocus
            className="inlineEditor"
            aria-label="Edit text"
            value={editing.text}
            spellCheck={false}
            style={{
              ...percent(editing),
              ...previewTextStyle(editing, layoutStyled(editing, editing.text, info).size, zoom),
              textAlign: editing.alignment,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
            onChange={(event) => {
              const text = event.target.value;
              props.onUpdate(editing, { ...editing, text, ...fitTextBox(editing, text, info, editing.text) }, `text:${editing.id}`);
            }}
            onBlur={() => props.onEditText(null)}
            onKeyDown={(event) => editorKeys(event, () => props.onEditText(null), () => props.onEditText(null))}
          />
        )}
        {draft && (
          <textarea
            autoFocus
            className={`inlineEditor draft draft-${draft.kind}`}
            aria-label={draft.kind === "text" ? "New text" : "New comment"}
            placeholder={draft.kind === "text" ? "Type here" : "Write a comment"}
            value={draft.text}
            style={{
              left: `${draft.x * 100}%`,
              top: `${draft.y * 100}%`,
              ...(draft.kind === "text"
                ? previewTextStyle({ x: 0, width: 0, size: draftSize, fontFamily: settings.textFont, bold: false, italic: false, lineHeight: 1.2, letterSpacing: 0, fitMode: "auto", color: settings.textColor }, draftSize, zoom)
                : { fontSize: 13 }),
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            onBlur={commitDraft}
            onKeyDown={(event) => editorKeys(event, commitDraft, () => setDraft(null))}
          />
        )}
        {tool === "select" &&
          shown
            .filter((overlay) => overlay.kind !== "background" && !overlay.id.startsWith(LAYOUT_ID) && !(overlay.kind === "text" && overlay.invisible) && overlay.id !== props.editingId)
            .map((overlay) => {
              const selected = props.selectedId === overlay.id;
              return (
                <div
                  key={`hit-${overlay.id}`}
                  className={`objectBox ${selected ? "selected" : ""} ${overlay.kind === "text" ? "textBox" : ""}`}
                  style={percent(boundsOf(overlay))}
                  title={overlay.kind === "text" ? "Double-click to edit" : undefined}
                  onPointerDown={(event) => objectDown(event, overlay, "move")}
                  onDoubleClick={() => overlay.kind === "text" && props.onEditText(overlay.id)}
                >
                  {selected && <button className="resizeHandle" aria-label="Resize selected object" onPointerDown={(event) => objectDown(event, overlay, "resize")} />}
                </div>
              );
            })}
      </div>
    </div>
  );
}
