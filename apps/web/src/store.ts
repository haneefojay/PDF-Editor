import { create } from "zustand";
import { applyCommand, EditorDocumentSchema, emptyDocument, inverseCommand, type Command, type EditorDocument, type Tool } from "@paperless/editor-core";

/** Rapid edits to the same field (typing, dragging a colour) undo as one step. */
const COALESCE_MS = 1200;

type Store = {
  tool: Tool;
  zoom: number;
  page: number;
  doc: EditorDocument;
  undo: Command[];
  redo: Command[];
  lastMerge: { key: string; at: number } | null;
  setTool: (tool: Tool) => void;
  setZoom: (zoom: number) => void;
  setPage: (page: number) => void;
  /** Pass `merge` to fold consecutive updates with the same key into one undo step. */
  execute: (command: Command, merge?: string) => void;
  undoOnce: () => void;
  redoOnce: () => void;
  reset: (pageCount: number, seed?: Partial<EditorDocument>) => void;
  hydrate: (snapshot: EditorDocument) => void;
};

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

export const useEditor = create<Store>((set, get) => ({
  tool: "select",
  zoom: 1,
  page: 0,
  doc: emptyDocument(),
  undo: [],
  redo: [],
  lastMerge: null,
  setTool: (tool) => set({ tool }),
  setZoom: (zoom) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) }),
  setPage: (page) => set({ page }),
  execute: (command, merge) =>
    set((state) => {
      const now = Date.now();
      const previous = state.undo.at(-1);
      if (
        merge &&
        state.lastMerge?.key === merge &&
        now - state.lastMerge.at < COALESCE_MS &&
        previous?.type === "updateOverlay" &&
        command.type === "updateOverlay" &&
        previous.after.id === command.before.id
      )
        return {
          doc: applyCommand(state.doc, command),
          undo: [...state.undo.slice(0, -1), { ...previous, after: command.after }],
          redo: [],
          lastMerge: { key: merge, at: now },
        };
      return {
        doc: applyCommand(state.doc, command),
        undo: [...state.undo, command],
        redo: [],
        lastMerge: merge ? { key: merge, at: now } : null,
      };
    }),
  undoOnce: () => {
    const state = get();
    const command = state.undo.at(-1);
    if (!command) return;
    set({ doc: applyCommand(state.doc, inverseCommand(command)), undo: state.undo.slice(0, -1), redo: [command, ...state.redo], lastMerge: null });
  },
  redoOnce: () => {
    const state = get();
    const command = state.redo[0];
    if (!command) return;
    set({ doc: applyCommand(state.doc, command), undo: [...state.undo, command], redo: state.redo.slice(1), lastMerge: null });
  },
  reset: (pageCount, seed) => set({ tool: "select", page: 0, doc: { ...emptyDocument(pageCount), ...seed }, undo: [], redo: [], lastMerge: null }),
  hydrate: (snapshot) => set({ tool: "select", page: 0, doc: EditorDocumentSchema.parse(snapshot), undo: [], redo: [], lastMerge: null }),
}));
