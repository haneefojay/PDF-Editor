import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { StatusBar, Style } from "@capacitor/status-bar";

export const isNativePlatform = Capacitor.isNativePlatform();

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
};

export async function savePdf(bytes: Uint8Array, filename: string) {
  if (!isNativePlatform) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return "Downloaded PDF";
  }

  const safeName = filename.replace(/[^a-z0-9._-]+/gi, "-");
  await Filesystem.writeFile({ path: `exports/${safeName}`, data: toBase64(bytes), directory: Directory.Cache, recursive: true });
  const { uri } = await Filesystem.getUri({ path: `exports/${safeName}`, directory: Directory.Cache });
  await Share.share({ title: safeName, text: "Edited locally with Paperless PDF Editor", files: [uri], dialogTitle: "Save or share PDF" });
  return "PDF ready to save or share";
}

export async function configureNativeUi() {
  if (!isNativePlatform) return;
  await StatusBar.setOverlaysWebView({ overlay: false });
  await StatusBar.setStyle({ style: Style.Dark });
  await StatusBar.setBackgroundColor({ color: "#f8f7f3" });
}

export async function registerBackHandler(handler: () => boolean) {
  if (!isNativePlatform) return () => undefined;
  const listener = await App.addListener("backButton", () => { if (!handler()) void App.exitApp(); });
  return () => void listener.remove();
}
