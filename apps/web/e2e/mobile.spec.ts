import { expect, test } from "@playwright/test";
import { longPdf, samplePdf } from "./fixtures";
import { openSample, pageAt } from "./helpers";

const bottomTab = (page: import("@playwright/test").Page, name: string) => page.locator(".bottomNav").getByRole("tab", { name });

test("phone shell fits the screen and opens tool trays from the bottom bar", async ({ page }) => {
  await openSample(page, samplePdf());
  const viewport = page.viewportSize()!;
  const dock = (await page.locator(".phoneDock").boundingBox())!;
  expect(Math.round(dock.y + dock.height)).toBeGreaterThanOrEqual(viewport.height - 2);
  // The sample mixes portrait and landscape pages; portrait ones still sit at the margin.
  const first = (await pageAt(page).boundingBox())!;
  expect(first.width).toBeLessThanOrEqual(viewport.width);
  expect(first.x).toBeLessThan(20);
  await expect(page.locator(".phoneDock .ribbon")).toHaveCount(0);

  await bottomTab(page, "Pages").tap();
  await expect(page.locator(".phoneDock .ribbon")).toBeVisible();
  await page.locator(".phoneDock .ribbon button", { hasText: "Organize" }).tap();
  const dialog = page.getByRole("dialog", { name: "Organize pages" });
  await expect(dialog.locator(".organizerGrid label")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Done" }).tap();

  await bottomTab(page, "Pages").tap();
  await expect(page.locator(".phoneDock .ribbon")).toHaveCount(0);
});

test("reading on a phone: original text is not editable until Edit is open", async ({ page }) => {
  await openSample(page, samplePdf());
  await expect(page.locator(".originalTextHit")).toHaveCount(0);
  await bottomTab(page, "Edit").tap();
  await expect(page.locator(".originalTextHit").first()).toBeAttached();
});

test("tap toggles full-screen reading and double-tap zooms", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  const box = (await pageAt(page).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.5);
  await expect(page.locator(".app.immersive")).toHaveCount(1);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.5);
  await expect(page.locator(".app.immersive")).toHaveCount(0);

  const before = (await pageAt(page).boundingBox())!.width;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
  await expect.poll(async () => (await pageAt(page).boundingBox())!.width).toBeGreaterThan(before * 1.8);
});

test("outline navigation from the pages drawer", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  await page.getByRole("button", { name: "Show pages", exact: true }).tap();
  await page.getByRole("tab", { name: "Outline" }).tap();
  await page.locator(".outlineEntry", { hasText: "Results" }).tap();
  await expect(page.locator(".rail")).toHaveCount(0);
  await expect(page.locator(".pagePill")).toHaveText("7 / 12");
});

test("typing new text on a phone keeps the page in place", async ({ page }) => {
  await openSample(page, samplePdf());
  await bottomTab(page, "Edit").tap();
  await page.locator(".phoneDock .ribbon button", { hasText: "Add text" }).tap();
  const box = (await pageAt(page).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.35);
  await page.keyboard.type("Hello from my phone");
  await expect(page.locator(".stage")).toHaveJSProperty("scrollLeft", 0);
  await page.touchscreen.tap(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await expect(page.locator(".textOverlay", { hasText: "Hello from my phone" })).toBeVisible();
  expect((await pageAt(page).boundingBox())!.x).toBeCloseTo(box.x, 0);
});

test("read aloud on a phone closes the tray and fits on one row", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  await bottomTab(page, "Tools").tap();
  await page.locator(".phoneDock .ribbon button", { hasText: "Read aloud" }).tap();
  await expect(page.locator(".phoneDock .ribbon")).toHaveCount(0);
  const bar = page.getByRole("region", { name: "Read aloud" });
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  expect(box.height).toBeLessThan(80);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await bar.getByRole("button", { name: "Close read aloud" }).tap();
  await expect(bar).toHaveCount(0);
});
