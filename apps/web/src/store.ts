import { create } from "zustand";
import { applyCommand, EditorDocumentSchema, emptyDocument, inverseCommand, type Command, type EditorDocument, type Tool } from "@paperless/editor-core";

type Store = {
  tool: Tool;
  zoom: number;
  page: number;
  doc: EditorDocument;
  undo: Command[];
  redo: Command[];
  setTool: (tool: Tool) => void;
  setZoom: (zoom: number) => void;
  setPage: (page: number) => void;
  execute: (command: Command) => void;
  undoOnce: () => void;
  redoOnce: () => void;
  reset: (pageCount: number) => void;
  hydrate: (snapshot: EditorDocument) => void;
};

export const useEditor = create<Store>((set, get) => ({
  tool: "select",
  zoom: 1,
  page: 0,
  doc: emptyDocument(),
  undo: [],
  redo: [],
  setTool: (tool) => set({ tool }),
  setZoom: (zoom) => set({ zoom: Math.min(3, Math.max(0.35, zoom)) }),
  setPage: (page) => set({ page }),
  execute: (command) => set((state) => ({ doc: applyCommand(state.doc, command), undo: [...state.undo, command], redo: [] })),
  undoOnce: () => {
    const state = get();
    const command = state.undo.at(-1);
    if (!command) return;
    set({ doc: applyCommand(state.doc, inverseCommand(command)), undo: state.undo.slice(0, -1), redo: [command, ...state.redo] });
  },
  redoOnce: () => {
    const state = get();
    const command = state.redo[0];
    if (!command) return;
    set({ doc: applyCommand(state.doc, command), undo: [...state.undo, command], redo: state.redo.slice(1) });
  },
  reset: (pageCount) => set({ tool: "select", page: 0, doc: emptyDocument(pageCount), undo: [], redo: [] }),
  hydrate: (snapshot) => set({ tool: "select", page: 0, doc: EditorDocumentSchema.parse(snapshot), undo: [], redo: [] }),
}));
