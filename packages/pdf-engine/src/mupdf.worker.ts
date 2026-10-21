/// <reference lib="webworker" />
import * as Comlink from "comlink";
import wasmUrl from "../node_modules/mupdf/dist/mupdf-wasm.wasm?url";
import { createEngine } from "./engine";

// MuPDF must find its WebAssembly binary and must not mistake the worker for
// Node.js before the module is evaluated, so it is imported dynamically.
const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
const workerGlobal = globalThis as unknown as {
  process?: unknown;
  $libmupdf_wasm_Module?: { wasmBinary: Uint8Array };
};
workerGlobal.process = undefined;
workerGlobal.$libmupdf_wasm_Module = { wasmBinary };
const mupdf = await import("mupdf");

Comlink.expose(createEngine(mupdf));
postMessage({ type: "PDF_ENGINE_READY" });
