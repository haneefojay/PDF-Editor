/// <reference lib="webworker" />
import * as Comlink from "comlink";
import * as mupdf from "mupdf";
import type { PdfWorkerApi } from "./protocol";

class Engine implements PdfWorkerApi{
 private doc:mupdf.Document|null=null;
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
