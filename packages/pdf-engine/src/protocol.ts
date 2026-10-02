export type PageInfo={width:number;height:number};
export interface PdfWorkerApi{loadDocument(bytes:ArrayBuffer):Promise<{pageCount:number;pages:PageInfo[]}>;renderPage(index:number,scale:number):Promise<Uint8Array>;extractText(index:number):Promise<string>;destroy():Promise<void>}
