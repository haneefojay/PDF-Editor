import * as Comlink from "comlink";import type { PdfWorkerApi } from "./protocol";export type {PageInfo,PdfWorkerApi} from "./protocol";
export function createPdfEngine(){const worker=new Worker(new URL("./mupdf.worker.ts",import.meta.url),{type:"module",name:"mupdf-engine"});const api=Comlink.wrap<PdfWorkerApi>(worker);return {api,terminate:()=>worker.terminate()}}
