import { expect, test } from "@playwright/test";
import { openSample, tab, tool } from "./helpers";

test("mobile layout fits the screen and organizes pages", async ({ page }) => {
  await openSample(page);
  const viewport = page.viewportSize()!;
  const status = (await page.locator(".status").boundingBox())!;
  expect(Math.round(status.y + status.height)).toBeGreaterThanOrEqual(viewport.height - 2);
  const pageBox = (await page.locator(".pageWrap").boundingBox())!;
  expect(pageBox.width).toBeLessThanOrEqual(viewport.width);
  await tab(page, "Pages");
  await tool(page, "Organize");
  const dialog = page.getByRole("dialog", { name: "Organize pages" });
  await expect(dialog.locator(".organizerGrid label")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Reverse order" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".pageInput")).toHaveValue("1");
});
