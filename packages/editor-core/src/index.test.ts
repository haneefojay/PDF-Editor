import { describe, expect, it } from "vitest";
import { applyCommand, EditorDocumentSchema, emptyDocument, inverseCommand, normalizeRect, type Command } from "./index";

describe("commands", () => {
  it("applies and reverses an add", () => {
    const command = { type: "add", overlay: { id: "1", page: 0, kind: "text", x: 1, y: 2, text: "Hello", size: 16, color: "#111" } } as const;
    const next = applyCommand(emptyDocument(1), command);
    expect(next.overlays).toHaveLength(1);
    expect(applyCommand(next, inverseCommand(command)).overlays).toHaveLength(0);
  });

  it("normalizes reverse drags", () => expect(normalizeRect({ x: 10, y: 20 }, { x: 2, y: 4 })).toEqual({ x: 2, y: 4, width: 8, height: 16 }));

  it("normalizes rotation", () => expect(applyCommand(emptyDocument(1), { type: "rotate", page: 0, before: 0, after: 450 }).rotations[0]).toBe(90));

  it("reorders and restores pages", () => {
    const command: Command = { type: "setPageOrder", before: [0, 1, 2], after: [2, 0, 1] };
    const moved = applyCommand(emptyDocument(3), command);
    expect(moved.pageOrder).toEqual([2, 0, 1]);
    expect(applyCommand(moved, inverseCommand(command)).pageOrder).toEqual([0, 1, 2]);
  });

  it("rejects corrupt persisted snapshots", () => {
    expect(() => EditorDocumentSchema.parse({ schemaVersion: 1, overlays: [], rotations: {}, pageOrder: [0, -1] })).toThrow();
  });
});
