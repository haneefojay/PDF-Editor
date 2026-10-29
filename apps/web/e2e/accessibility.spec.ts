import { expect, test } from "@playwright/test";
import { longPdf } from "./fixtures";
import { expectAccessible, openSample, tab, tool } from "./helpers";

test("the editor passes an accessibility audit in light and dark themes", async ({ page }) => {
  await page.goto("/");
  await expectAccessible(page, "home");
  await openSample(page, longPdf(), "long.pdf");
  for (const name of ["Edit", "Comment", "Fill & Sign", "Pages", "Tools"]) {
    await tab(page, name);
    await expectAccessible(page, name);
  }
  await page.getByRole("tab", { name: "Outline" }).click();
  await expectAccessible(page, "outline");
  await tab(page, "Pages");
  await tool(page, "Organize");
  await expectAccessible(page, "organize dialog");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "dark theme");
});

test("dialogs keep the keyboard inside and hide the editor behind them", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  await tab(page, "Tools");
  const opener = page.locator(".ribbon button", { hasText: "Properties" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Document properties" });
  await expect(dialog).toBeVisible();
  // The editor behind the dialog is inert.
  await expect(page.locator("header.top")).toHaveAttribute("inert", "");
  // Tab cycles within the dialog, forwards and backwards.
  for (let step = 0; step < 15; step += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  for (let step = 0; step < 15; step += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  // Closing it gives focus back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("header.top")).not.toHaveAttribute("inert", "");
  await expect(opener).toBeFocused();
});
