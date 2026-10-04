import { produce } from "immer";
import { z } from "zod";

export const Point = z.object({ x: z.number(), y: z.number() });
export const NormalizedRect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type NormalizedRect = z.infer<typeof NormalizedRect>;
export const Metadata = z.object({
  title: z.string(),
  author: z.string(),
  subject: z.string(),
  keywords: z.string(),
});
export type Metadata = z.infer<typeof Metadata>;
const ReviewMetadata = {
  author: z.string().default(""),
  createdAt: z.string().default(""),
  comment: z.string().default(""),
  resolved: z.boolean().default(false),
  flatten: z.boolean().default(false),
};

export const Overlay = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("text"),
    x: z.number(),
    y: z.number(),
    width: z.number().positive().default(0.3),
    height: z.number().positive().default(0.06),
    text: z.string(),
    size: z.number().positive(),
    color: z.string(),
    fontFamily: z.string().min(1).default("Helvetica"),
    fontName: z.string().nullable().default(null),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    underline: z.boolean().default(false),
    alignment: z.enum(["left", "center", "right", "justify"]).default("left"),
    lineHeight: z.number().min(0.8).max(3).default(1.2),
    letterSpacing: z.number().min(-5).max(20).default(0),
    fitMode: z.enum(["auto", "shrink", "overflow"]).default("auto"),
    invisible: z.boolean().optional(),
    ocrConfidence: z.number().min(0).max(100).optional(),
    ocrSource: z.boolean().optional(),
    opacity: z.number().min(0.05).max(1).optional(),
    rotation: z.number().optional(),
    layoutRole: z.enum(["header", "footer", "watermark", "bates"]).optional(),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("ink"),
    points: z.array(Point).min(2),
    color: z.string(),
    width: z.number().positive(),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("signature"),
    points: z.array(Point).min(2),
    color: z.string(),
    width: z.number().positive(),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("shape"),
    shape: z.enum(["rectangle", "square", "circle", "triangle"]),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    color: z.string(),
    fillColor: z.string().nullable().default(null),
    strokeWidth: z.number().positive().default(2),
  }),
  // Kept for projects saved by versions before the Shapes tool.
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("rect"),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    color: z.string(),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("redact"),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    color: z.string(),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("image"),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    dataUrl: z.string().startsWith("data:image/"),
    name: z.string().optional(),
    opacity: z.number().min(0.05).max(1).default(1),
    rotation: z.number().default(0),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("background"),
    color: z.string(),
    opacity: z.number().min(0).max(1).default(1),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("markup"),
    markup: z.enum(["highlight", "underline", "strikeout", "squiggly"]),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    color: z.string(),
    opacity: z.number().min(0.05).max(1).default(0.35),
    ...ReviewMetadata,
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("note"),
    noteType: z.enum(["sticky", "callout"]),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    color: z.string(),
    text: z.string(),
    ...ReviewMetadata,
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("stamp"),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    label: z.string(),
    color: z.string(),
    ...ReviewMetadata,
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("attachment"),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    name: z.string(),
    mimeType: z.string(),
    dataUrl: z.string().startsWith("data:"),
    ...ReviewMetadata,
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("measurement"),
    measurement: z.enum(["distance", "perimeter", "area"]),
    points: z.array(Point).min(2),
    color: z.string(),
    unit: z.enum(["pt", "in", "cm", "mm"]),
    scale: z.number().positive(),
    label: z.string(),
    ...ReviewMetadata,
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("formField"),
    fieldType: z.enum(["text", "choice", "checkbox", "radio", "signature"]),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    name: z.string().min(1),
    label: z.string(),
    value: z.string(),
    options: z.array(z.string()).default([]),
    required: z.boolean().default(false),
    readOnly: z.boolean().default(false),
    multiline: z.boolean().default(false),
    maxLength: z.number().int().nonnegative().default(0),
    validation: z.enum(["none", "email", "number", "regex"]).default("none"),
    validationPattern: z.string().default(""),
    calculation: z.string().default(""),
    tabOrder: z.number().int().nonnegative().default(0),
    flatten: z.boolean().default(false),
  }),
  z.object({
    id: z.string(),
    page: z.number().int().nonnegative(),
    kind: z.literal("visualSignature"),
    mode: z.enum(["typed", "image", "digital"]),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    text: z.string(),
    dataUrl: z.string().optional(),
    color: z.string(),
    signer: z.string(),
    signedAt: z.string(),
  }),
]);
export type Overlay = z.infer<typeof Overlay>;
export type Tool =
  | "select"
  | "text"
  | "ink"
  | "signature"
  | "shape"
  | "redact"
  | "crop"
  | "markup"
  | "note"
  | "stamp"
  | "attachment"
  | "measure"
  | "form";

export const EditorDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  overlays: z.array(Overlay),
  rotations: z.record(z.string(), z.number()),
  pageOrder: z.array(z.number().int().nonnegative()),
  crops: z.record(z.string(), NormalizedRect).default({}),
  metadata: Metadata.default({
    title: "",
    author: "",
    subject: "",
    keywords: "",
  }),
  formValues: z.record(z.string(), z.string()).default({}),
});
export type EditorDocument = z.infer<typeof EditorDocumentSchema>;

export type Command =
  | { type: "add"; overlay: Overlay }
  | { type: "addMany"; overlays: Overlay[] }
  | { type: "remove"; overlay: Overlay }
  | { type: "removeMany"; overlays: Overlay[] }
  | { type: "updateOverlay"; before: Overlay; after: Overlay }
  | { type: "setOverlayOrder"; before: Overlay[]; after: Overlay[] }
  | { type: "rotate"; page: number; before: number; after: number }
  | { type: "setPageOrder"; before: number[]; after: number[] }
  | {
      type: "setCrop";
      page: number;
      before: NormalizedRect | null;
      after: NormalizedRect | null;
    }
  | { type: "setMetadata"; before: Metadata; after: Metadata }
  | { type: "setFormValue"; name: string; before: string; after: string };

export const emptyDocument = (pageCount = 0): EditorDocument => ({
  schemaVersion: 1,
  overlays: [],
  rotations: {},
  pageOrder: Array.from({ length: pageCount }, (_, index) => index),
  crops: {},
  metadata: { title: "", author: "", subject: "", keywords: "" },
  formValues: {},
});

export function applyCommand(
  state: EditorDocument,
  command: Command,
): EditorDocument {
  return produce(state, (draft) => {
    if (command.type === "add") draft.overlays.push(command.overlay);
    if (command.type === "addMany") draft.overlays.push(...command.overlays);
    if (command.type === "remove")
      draft.overlays = draft.overlays.filter(
        (item) => item.id !== command.overlay.id,
      );
    if (command.type === "removeMany") {
      const ids = new Set(command.overlays.map((item) => item.id));
      draft.overlays = draft.overlays.filter((item) => !ids.has(item.id));
    }
    if (command.type === "updateOverlay") {
      const index = draft.overlays.findIndex(
        (item) => item.id === command.before.id,
      );
      if (index >= 0) draft.overlays[index] = command.after;
    }
    if (command.type === "setOverlayOrder") draft.overlays = [...command.after];
    if (command.type === "rotate")
      draft.rotations[command.page] = ((command.after % 360) + 360) % 360;
    if (command.type === "setPageOrder") draft.pageOrder = [...command.after];
    if (command.type === "setCrop") {
      if (command.after) draft.crops[command.page] = command.after;
      else delete draft.crops[command.page];
    }
    if (command.type === "setMetadata") draft.metadata = command.after;
    if (command.type === "setFormValue")
      draft.formValues[command.name] = command.after;
  });
}

export function inverseCommand(command: Command): Command {
  if (command.type === "add")
    return { type: "remove", overlay: command.overlay };
  if (command.type === "addMany")
    return { type: "removeMany", overlays: command.overlays };
  if (command.type === "remove")
    return { type: "add", overlay: command.overlay };
  if (command.type === "removeMany")
    return { type: "addMany", overlays: command.overlays };
  if (command.type === "updateOverlay")
    return { ...command, before: command.after, after: command.before };
  if (command.type === "setOverlayOrder")
    return { ...command, before: command.after, after: command.before };
  if (command.type === "rotate")
    return { ...command, before: command.after, after: command.before };
  if (command.type === "setPageOrder")
    return { ...command, before: command.after, after: command.before };
  if (command.type === "setCrop")
    return { ...command, before: command.after, after: command.before };
  if (command.type === "setMetadata")
    return { ...command, before: command.after, after: command.before };
  if (command.type === "setFormValue")
    return { ...command, before: command.after, after: command.before };
  throw new Error("Unsupported command");
}

export function normalizeRect(
  a: z.infer<typeof Point>,
  b: z.infer<typeof Point>,
): NormalizedRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}
