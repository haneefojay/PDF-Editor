import Dexie, { type EntityTable } from "dexie";
import { EditorDocumentSchema, type EditorDocument } from "@paperless/editor-core";

export type ProjectSummary = { id: string; name: string; updatedAt: number; pageCount: number };
type ProjectRecord = ProjectSummary & {
  storage: "opfs" | "idb";
  bytes?: ArrayBuffer;
  snapshot: EditorDocument;
};

const db = new Dexie("paperless-pdf-editor") as Dexie & { projects: EntityTable<ProjectRecord, "id"> };
db.version(1).stores({ projects: "id, updatedAt, name" });

const opfsFileName = (id: string) => `${id}.pdf`;

async function writeOpfs(id: string, bytes: ArrayBuffer) {
  if (!navigator.storage?.getDirectory) throw new Error("OPFS unavailable");
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(opfsFileName(id), { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function readOpfs(id: string) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(opfsFileName(id));
  return (await handle.getFile()).arrayBuffer();
}

export async function saveProject(input: { id: string; name: string; bytes: ArrayBuffer; snapshot: EditorDocument }) {
  const snapshot = EditorDocumentSchema.parse(input.snapshot);
  let storage: ProjectRecord["storage"] = "opfs";
  let fallbackBytes: ArrayBuffer | undefined;
  try {
    await writeOpfs(input.id, input.bytes.slice(0));
  } catch {
    storage = "idb";
    fallbackBytes = input.bytes.slice(0);
  }
  await db.projects.put({ id: input.id, name: input.name, updatedAt: Date.now(), pageCount: snapshot.pageOrder.length, storage, bytes: fallbackBytes, snapshot });
  localStorage.setItem("paperless:last-project", input.id);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const records = await db.projects.orderBy("updatedAt").reverse().limit(8).toArray();
  return records.map(({ id, name, updatedAt, pageCount }) => ({ id, name, updatedAt, pageCount }));
}

export async function loadProject(id: string) {
  const record = await db.projects.get(id);
  if (!record) throw new Error("This recovered project is no longer available.");
  const snapshot = EditorDocumentSchema.parse(record.snapshot);
  const bytes = record.storage === "opfs" ? await readOpfs(id) : record.bytes?.slice(0);
  if (!bytes) throw new Error("The recovered PDF data is missing.");
  localStorage.setItem("paperless:last-project", id);
  return { id: record.id, name: record.name, bytes, snapshot };
}

export async function deleteProject(id: string) {
  const record = await db.projects.get(id);
  await db.projects.delete(id);
  if (record?.storage === "opfs") {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(opfsFileName(id));
    } catch {
      // Metadata is already removed; a stale OPFS file is harmless and can be
      // reclaimed by browser storage cleanup.
    }
  }
}
