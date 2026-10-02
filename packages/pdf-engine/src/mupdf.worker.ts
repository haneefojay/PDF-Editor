/// <reference lib="webworker" />
import * as Comlink from "comlink";
import type { PdfWorkerApi } from "./protocol";
import type * as Mupdf from "mupdf";

// MuPDF's generated loader can stall while resolving its WASM URL from a
// module worker. Supplying the binary explicitly keeps initialization
// deterministic across Vite dev and production builds.
import wasmUrl from "../node_modules/mupdf/dist/mupdf-wasm.wasm?url";
const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
const workerGlobal = globalThis as unknown as {
  process?: unknown;
  $libmupdf_wasm_Module?: { wasmBinary: Uint8Array };
};
workerGlobal.process = undefined;
workerGlobal.$libmupdf_wasm_Module = { wasmBinary };
const mupdf = await import("mupdf");

class Engine implements PdfWorkerApi{
 private doc:Mupdf.Document|null=null;
 async loadDocument(bytes:ArrayBuffer){
  this.doc?.destroy();
  this.doc=mupdf.Document.openDocument(bytes,"application/pdf");
  const pageCount=this.doc.countPages();
  const pages=Array.from({length:pageCount},(_,index)=>{const page=this.doc!.loadPage(index);const [x0,y0,x1,y1]=page.getBounds();const info={width:x1-x0,height:y1-y0};page.destroy();return info});
  return {pageCount,pages};
 }
 async renderPage(index:number,scale:number){
  if(!this.doc) throw new Error("No PDF is open");
  const page=this.doc.loadPage(index);
  const pixmap=page.toPixmap([scale,0,0,scale,0,0],mupdf.ColorSpace.DeviceRGB,false,true);
  const png=pixmap.asPNG();pixmap.destroy();page.destroy();return png;
 }
 async extractText(index:number){if(!this.doc)throw new Error("No PDF is open");const page=this.doc.loadPage(index);const text=page.toStructuredText("").asText();page.destroy();return text}
 async destroy(){this.doc?.destroy();this.doc=null}
}
Comlink.expose(new Engine());
postMessage({ type: "PDF_ENGINE_READY" });
