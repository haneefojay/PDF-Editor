import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { samplePdf } from "./fixtures";

export async function openSample(page: Page, buffer = samplePdf(), name = "sample.pdf") {
  await page.goto("/");
  await page.setInputFiles('input[aria-label="Open PDF"]', { name, mimeType: "application/pdf", buffer });
  await expect(page.locator(".page img").first()).toBeVisible({ timeout: 60_000 });
}

/** WCAG 2.1 A and AA, plus axe best practices, with no exceptions. */
export async function expectAccessible(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(
    violations.map((violation) => `${where}: ${violation.id} (${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(", ")})`),
  ).toEqual([]);
}

export const tab = (page: Page, name: string) => page.getByRole("tab", { name }).click();
export const tool = (page: Page, label: string) => page.locator(".ribbon button", { hasText: label }).first().click();

/** The page at a display index (0-based) in the continuous view. */
export const pageAt = (page: Page, index = 0) => page.locator(`.pageSlot[data-index="${index}"] .pageWrap`);

/** Fraction-of-page pointer helpers; coordinates follow what is on screen. */
export async function dragOnPage(page: Page, from: [number, number], to: [number, number], index = 0) {
  await pageAt(page, index).scrollIntoViewIfNeeded();
  const box = (await pageAt(page, index).boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 });
  await page.mouse.up();
}
export async function clickOnPage(page: Page, at: [number, number], index = 0) {
  const box = (await pageAt(page, index).boundingBox())!;
  await page.mouse.click(box.x + box.width * at[0], box.y + box.height * at[1]);
}

export async function fitPage(page: Page) {
  await page.getByRole("button", { name: "Fit page" }).click();
}

export async function exportPdf(page: Page) {
  const download = page.waitForEvent("download", { timeout: 90_000 });
  await page.keyboard.press("Control+s");
  const file = await download;
  return readFile((await file.path())!);
}
