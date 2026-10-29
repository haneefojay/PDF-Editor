import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colourAt, inspectPdf, scanPhoto, scanVideo } from "./fixtures";
import { exportPdf, openSample, tab, tool } from "./helpers";

// Chromium's fake camera plays a photo of a page lying on a desk.
const video = join(mkdtempSync(join(tmpdir(), "scan-")), "page.y4m");
writeFileSync(video, scanVideo());
test.use({
  permissions: ["camera"],
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
  },
});

test("scans a page with the camera, straightens it and makes it searchable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scanner = page.getByRole("dialog", { name: "Scan document" });
  // The page is outlined live in the viewfinder.
  await expect(scanner.locator(".scanLiveQuad polygon")).toBeVisible({ timeout: 30_000 });
  await expect(scanner).toContainText("Page found");
  await scanner.getByRole("button", { name: "Take photo" }).click();

  await expect(scanner.getByRole("slider")).toHaveCount(4);
  await scanner.getByRole("button", { name: "Next" }).click();
  await expect(scanner.getByRole("img", { name: "Corrected page" })).toBeVisible();
  await expect(scanner.getByRole("radio", { name: "Document" })).toHaveAttribute("aria-checked", "true");
  await scanner.getByRole("button", { name: "Keep page" }).click();

  await scanner.getByRole("button", { name: "Done, 1 page" }).click();
  await expect(scanner.getByRole("img", { name: "Scanned page 1" })).toBeVisible();
  await scanner.getByLabel("Make text searchable (OCR)").check();
  await scanner.getByRole("button", { name: "Create PDF" }).click();

  await expect(page.locator(".page img").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".toast")).toContainText("OCR added", { timeout: 120_000 });
  const ocrDialog = page.getByRole("dialog", { name: "Recognise text (OCR)" });
  await ocrDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(ocrDialog).toBeHidden();

  const bytes = await exportPdf(page);
  const pdf = inspectPdf(bytes);
  expect(pdf.pages).toHaveLength(1);
  expect(pdf.pages[0]!.text).toContain("INVOICE");
  // Shaped like the page, with the desk cropped away and the paper whitened.
  const [width, height] = pdf.pages[0]!.size;
  expect(width! / height!).toBeGreaterThan(0.72);
  expect(width! / height!).toBeLessThan(0.78);
  for (const [x, y] of [[0.03, 0.03], [0.97, 0.04], [0.5, 0.97]] as const) expect(Math.min(...colourAt(bytes, x, y))).toBeGreaterThan(215);
});

test("imports photos as scans and adds them to an open document", async ({ page }) => {
  await openSample(page);
  await tab(page, "Pages");
  await tool(page, "Scan pages");
  const scanner = page.getByRole("dialog", { name: "Scan document" });
  await scanner.locator('input[aria-label="Import photos to scan"]').setInputFiles([
    { name: "one.png", mimeType: "image/png", buffer: scanPhoto() },
    { name: "two.png", mimeType: "image/png", buffer: scanPhoto(480, 640) },
  ]);
  await expect(scanner.getByRole("img", { name: /Scanned page/ })).toHaveCount(2, { timeout: 30_000 });

  // Re-crop the second page to the whole photo, then put it first.
  await scanner.getByRole("button", { name: "Edit page 2" }).click();
  await scanner.getByRole("button", { name: "Whole photo" }).click();
  await scanner.getByRole("button", { name: "Next" }).click();
  await scanner.getByRole("radio", { name: "Original" }).click();
  await scanner.getByRole("button", { name: "Save page" }).click();
  await scanner.getByRole("button", { name: "Move page 2 earlier" }).click();
  await scanner.getByLabel("Page size").selectOption("a4");
  await scanner.getByRole("button", { name: "Add 2 pages" }).click();

  await expect(page.locator(".rail .thumb")).toHaveCount(5);
  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.pages.map((item) => item.size)).toEqual([[612, 792], [595, 842], [595, 842], [612, 792], [792, 612]]);
});
