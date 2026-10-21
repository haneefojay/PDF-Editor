import { saveFile } from "./platform";

export const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const dataUrlToBlob = (dataUrl: string) => {
  const [header = "", encoded = ""] = dataUrl.split(",");
  const mimeType = /^data:([^;,]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const raw = atob(encoded);
  return new Blob([Uint8Array.from(raw, (character) => character.charCodeAt(0))], { type: mimeType });
};

export const downloadBlob = (blob: Blob, filename: string) => saveFile(blob, filename, blob.type || "application/octet-stream");
