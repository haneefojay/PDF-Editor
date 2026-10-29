import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVideo } from "./fixtures";

const video = join(mkdtempSync(join(tmpdir(), "scan-")), "page.y4m");
writeFileSync(video, scanVideo());
test.use({
  permissions: ["camera"],
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
  },
});

test("scanning two pages on a phone, with a retake", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Scan a document" }).tap();
  const scanner = page.getByRole("dialog", { name: "Scan document" });
  const viewport = page.viewportSize()!;
  const shutter = (await scanner.getByRole("button", { name: "Take photo" }).boundingBox())!;
  // The shutter sits at the bottom, within thumb reach.
  expect(shutter.y).toBeGreaterThan(viewport.height * 0.8);
  await expect(scanner.locator(".scanLiveQuad polygon")).toBeVisible({ timeout: 30_000 });

  // A retake goes back to the camera without adding a page.
  await scanner.getByRole("button", { name: "Take photo" }).tap();
  await scanner.getByRole("button", { name: "Retake" }).tap();
  await expect(scanner.getByRole("button", { name: "Done", exact: true })).toBeDisabled();

  for (let count = 1; count <= 2; count += 1) {
    await expect(scanner.getByRole("button", { name: "Take photo" })).toBeEnabled({ timeout: 30_000 });
    await scanner.getByRole("button", { name: "Take photo" }).tap();
    await scanner.getByRole("button", { name: "Next" }).tap();
    if (count === 2) await scanner.getByRole("radio", { name: "B&W" }).tap();
    await scanner.getByRole("button", { name: "Keep page" }).tap();
    await expect(scanner.getByRole("button", { name: `Done, ${count} page${count === 1 ? "" : "s"}` })).toBeVisible();
  }
  await scanner.getByRole("button", { name: "Done, 2 pages" }).tap();
  await scanner.getByRole("button", { name: "Create PDF" }).tap();
  await expect(page.locator(".pageSlot")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator(".app.phone")).toBeVisible();
});
