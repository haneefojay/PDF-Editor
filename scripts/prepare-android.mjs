import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const run = (...args) => execFileSync("pnpm", ["exec", "cap", ...args], { stdio: "inherit" });
if (!existsSync("android")) run("add", "android");
else run("sync", "android");

const activity = `package dev.paperless.pdfeditor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setNavigationBarColor(android.graphics.Color.rgb(248, 247, 243));
  }
}
`;
mkdirSync("android/app/src/main/java/dev/paperless/pdfeditor", { recursive: true });
writeFileSync("android/app/src/main/java/dev/paperless/pdfeditor/MainActivity.java", activity);

const manifestPath = "android/app/src/main/AndroidManifest.xml";
const manifest = readFileSync(manifestPath, "utf8")
  .replace('android:allowBackup="true"', 'android:allowBackup="false"\n        android:usesCleartextTraffic="false"')
  .replace(/\s*<uses-permission android:name="android.permission.INTERNET"\s*\/>/, "");
// The scanner uses the camera through the WebView; it stays optional so
// devices without one can still install the app.
const cameraPermission = '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />';
const withCamera = manifest.includes("android.permission.CAMERA") ? manifest : manifest.replace("</manifest>", `    ${cameraPermission}\n</manifest>`);
writeFileSync(manifestPath, withCamera);
console.log("Android project prepared with backup and cleartext traffic disabled and optional camera access.");
