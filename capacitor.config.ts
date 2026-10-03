import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.paperless.pdfeditor",
  appName: "Paperless PDF Editor",
  webDir: "apps/web/dist",
  backgroundColor: "#f1efe9",
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    StatusBar: { style: "DARK", backgroundColor: "#f8f7f3", overlaysWebView: false },
  },
};

export default config;
