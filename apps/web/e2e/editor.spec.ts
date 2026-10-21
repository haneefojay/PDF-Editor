import { expect, test } from "@playwright/test";
import { inspectPdf, pngImage, samplePdf } from "./fixtures";
import { clickOnPage, dragOnPage, exportPdf, fitPage, openSample, tab, tool } from "./helpers";

test("edits original text without disturbing the table around it", async ({ page }) => {
  await openSample(page);
  await page.getByRole("button", { name: "Edit PDF text: North" }).click();
  await page.getByRole("textbox", { name: "Edit original PDF text" }).fill("Northeast");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".textOverlay", { hasText: "Northeast" })).toBeVisible();
  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.pages[0]!.text).toContain("Northeast");
  expect(pdf.pages[0]!.text).not.toMatch(/^North$/m);
  expect(pdf.pages[0]!.text).toContain("$1,200,000");
});

test("adds text, highlights and shapes, including on a rotated page", async ({ page }) => {
  await openSample(page);
  await fitPage(page);
  await tool(page, "Add text");
  await clickOnPage(page, [0.6, 0.2]);
  await page.keyboard.type("Approved by finance");
  await clickOnPage(page, [0.3, 0.9]);
  await expect(page.locator(".textOverlay", { hasText: "Approved by finance" })).toBeVisible();

  await tab(page, "Comment");
  await tool(page, "Highlight");
  await dragOnPage(page, [0.09, 0.115], [0.5, 0.118]);
  await expect(page.locator(".contextBar")).toContainText("Comment");

  await tab(page, "Pages");
  await tool(page, "Rotate right");
  await tab(page, "Edit");
  await tool(page, "Shapes");
  await dragOnPage(page, [0.1, 0.1], [0.3, 0.25]);

  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.pages[0]!.rotate).toBe(90);
  expect(pdf.pages[0]!.text).toContain("Approved by finance");
  expect(pdf.pages[0]!.annotations).toEqual(expect.arrayContaining(["Highlight", "Square"]));
});

test("page operations are undoable and keep headers in step", async ({ page }) => {
  await openSample(page);
  const thumbs = page.locator(".rail .thumb");
  await expect(thumbs).toHaveCount(3);
  await tab(page, "Pages");
  await tool(page, "Duplicate page");
  await expect(thumbs).toHaveCount(4);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(thumbs).toHaveCount(3);

  await tool(page, "Header & footer");
  await page.getByRole("textbox", { name: "Footer", exact: true }).fill("Page {page} of {pages}");
  await page.getByRole("button", { name: "Apply to all pages" }).click();
  const chooser = page.waitForEvent("filechooser");
  await tool(page, "Insert PDF");
  await (await chooser).setFiles({ name: "more.pdf", mimeType: "application/pdf", buffer: samplePdf() });
  await expect(thumbs).toHaveCount(6);

  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.pages).toHaveLength(6);
  pdf.pages.forEach((item, index) => expect(item.text).toContain(`Page ${index + 1} of 6`));
});

test("redacts, signs, adds a form field and exports with a password", async ({ page }) => {
  await openSample(page);
  await fitPage(page);
  await tool(page, "Redact");
  await dragOnPage(page, [0.08, 0.13], [0.62, 0.16]);
  await tab(page, "Fill & Sign");
  await tool(page, "Sign");
  await page.locator(".contextBar select").first().selectOption("typed");
  await page.getByPlaceholder("Full name").fill("Ada Lovelace");
  await clickOnPage(page, [0.55, 0.85]);
  await tool(page, "Add field");
  await dragOnPage(page, [0.1, 0.92], [0.35, 0.95]);
  await tab(page, "Tools");
  await tool(page, "Protect");
  await page.getByLabel("Password to open").fill("pw");
  await page.getByRole("button", { name: "Done" }).click();

  const bytes = await exportPdf(page);
  expect(inspectPdf(bytes).needsPassword).toBe(true);
  const pdf = inspectPdf(bytes, "pw");
  expect(pdf.pages[0]!.text).not.toContain("Revenue grew");
  expect(pdf.pages[0]!.text).toContain("Ada Lovelace");
  expect(pdf.pages[0]!.widgets).toBe(1);
});

test("finds and replaces across the document", async ({ page }) => {
  await openSample(page);
  await page.keyboard.press("Control+f");
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("South");
  await page.getByRole("textbox", { name: "Replace with" }).fill("West");
  await page.getByRole("button", { name: "Find all" }).click();
  await expect(page.locator(".findSummary")).toHaveText("1 match");
  await page.getByRole("button", { name: "Replace all" }).click();
  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.pages[0]!.text).toContain("West");
  expect(pdf.pages[0]!.text).not.toContain("South");
});

test("opens password-protected PDFs", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles('input[aria-label="Open PDF"]', {
    name: "locked.pdf",
    mimeType: "application/pdf",
    buffer: samplePdf("encrypt=aes-256,user-password=secret,owner-password=owner"),
  });
  const dialog = page.getByRole("dialog", { name: "Password required" });
  await dialog.getByLabel("Password", { exact: true }).fill("wrong");
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".fieldError")).toBeVisible();
  await dialog.getByLabel("Password", { exact: true }).fill("secret");
  await page.keyboard.press("Enter");
  await expect(page.locator(".page img")).toBeVisible({ timeout: 60_000 });
  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.needsPassword).toBe(false);
  expect(pdf.pages[0]!.text).toContain("Quarterly Report");
});

test("creates a PDF from images and adds image pages", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles('input[aria-label="Create PDF from images"]', [
    { name: "scan-1.png", mimeType: "image/png", buffer: pngImage() },
    { name: "scan-2.png", mimeType: "image/png", buffer: pngImage(200, 400) },
  ]);
  await expect(page.locator(".rail .thumb")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator(".file b")).toHaveText("scan-1.pdf");
  await tab(page, "Pages");
  const chooser = page.waitForEvent("filechooser");
  await tool(page, "Images as pages");
  await (await chooser).setFiles({ name: "scan-3.png", mimeType: "image/png", buffer: pngImage() });
  await expect(page.locator(".rail .thumb")).toHaveCount(3);
  expect(inspectPdf(await exportPdf(page)).pages).toHaveLength(3);
});

test("keyboard shortcuts edit, undo and delete objects", async ({ page }) => {
  await openSample(page);
  await fitPage(page);
  await page.keyboard.press("r");
  await dragOnPage(page, [0.5, 0.6], [0.7, 0.7]);
  // Back to Select so objects show their selection boxes.
  await page.keyboard.press("v");
  const boxes = page.locator(".objectBox");
  await expect(boxes).toHaveCount(1);
  await page.keyboard.press("Control+d");
  await expect(boxes).toHaveCount(2);
  await page.keyboard.press("Delete");
  await expect(boxes).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(boxes).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(boxes).toHaveCount(0);
});
