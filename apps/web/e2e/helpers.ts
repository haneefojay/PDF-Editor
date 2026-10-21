import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { samplePdf } from "./fixtures";

export async function openSample(page: Page, buffer = samplePdf(), name = "sample.pdf") {
  await page.goto("/");
  await page.setInputFiles('input[aria-label="Open PDF"]', { name, mimeType: "application/pdf", buffer });
  await expect(page.locator(".page img")).toBeVisible({ timeout: 60_000 });
}

export const tab = (page: Page, name: string) => page.getByRole("tab", { name }).click();
export const tool = (page: Page, label: string) => page.locator(".ribbon button", { hasText: label }).first().click();

/** Fraction-of-page pointer helpers; coordinates follow what is on screen. */
export async function dragOnPage(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator(".pageWrap").boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 });
  await page.mouse.up();
}
export async function clickOnPage(page: Page, at: [number, number]) {
  const box = (await page.locator(".pageWrap").boundingBox())!;
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
