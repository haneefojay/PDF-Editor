import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { colourAt, imageOnPanelPdf, inspectPdf, longPdf, PARAGRAPH_LINES, paragraphPdf, pngImage, readStoredZip, samplePdf } from "./fixtures";
import { clickOnPage, dragOnPage, exportPdf, fitPage, openSample, pageAt, tab, tool } from "./helpers";

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
  // The tool stays active for the next highlight.
  await expect(page.locator(".contextBar")).toContainText("snaps to the lines");

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
  await expect(page.locator(".page img").first()).toBeVisible({ timeout: 60_000 });
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
  await boxes.first().click();
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

test("keeps an unfinished text edit when changing page", async ({ page }) => {
  await openSample(page);
  await page.getByRole("button", { name: "Edit PDF text: South" }).click();
  await page.getByRole("textbox", { name: "Edit original PDF text" }).fill("Southwest");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.locator(".pageInput")).toHaveValue("2");
  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.pages[0]!.text).toContain("Southwest");
});

test("continuous scrolling tracks the page and follows outline and links", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  await expect(page.locator(".pageSlot")).toHaveCount(12);
  // Only pages near the viewport are rendered.
  expect(await page.locator(".page > img").count()).toBeLessThan(6);

  await page.locator(".stage").evaluate((stage) => stage.scrollBy(0, stage.scrollHeight / 2));
  await expect(page.locator(".pageInput")).not.toHaveValue("1");

  await page.getByRole("tab", { name: "Outline" }).click();
  await page.locator(".outlineEntry", { hasText: "Methods" }).click();
  await expect(page.locator(".pageInput")).toHaveValue("4");

  await page.locator(".outlineEntry", { hasText: "Introduction" }).click();
  await expect(page.locator(".pageInput")).toHaveValue("1");
  // Links are followed outside the Edit tab, where clicking text edits it.
  await tab(page, "Comment");
  await expect(page.getByRole("link", { name: "Link to https://example.com/" })).toBeAttached();
  await page.getByRole("link", { name: "Link to page 9" }).click();
  await expect(page.locator(".pageInput")).toHaveValue("9");
});

test("edits a page further down without losing the place", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  await page.locator(".rail .thumb").nth(5).click();
  await expect(page.locator(".pageInput")).toHaveValue("6");
  await tool(page, "Shapes");
  await dragOnPage(page, [0.3, 0.3], [0.6, 0.5], 5);
  const pdf = inspectPdf(await exportPdf(page));
  expect(pdf.pages[5]!.annotations).toEqual(["Square"]);
  expect(pdf.pages[0]!.annotations).toEqual([]);
});

test("edits a whole paragraph and reflows it in the same width", async ({ page }) => {
  await openSample(page, paragraphPdf(), "paragraph.pdf");
  await page.getByRole("button", { name: /^Edit PDF text: uploaded, so private/ }).click();
  const editor = page.getByRole("textbox", { name: "Edit paragraph" });
  await expect(editor).toHaveValue(PARAGRAPH_LINES.join(" "));
  await expect(page.locator(".editingLabel")).toContainText("4 lines");
  await editor.fill(PARAGRAPH_LINES.join(" ").replace("medical letters", "medical letters, tax returns, school reports"));
  await page.keyboard.press("Control+Enter");
  const text = inspectPdf(await exportPdf(page)).pages[0]!.text;
  const lines = text.split("\n").filter((line) => line.trim() && line !== "Privacy first");
  expect(lines.join(" ")).toContain("medical letters, tax returns, school reports and bank papers");
  // Reflowed into more lines rather than overflowing the original width.
  expect(lines.length).toBeGreaterThan(PARAGRAPH_LINES.length);
  expect(text).toContain("Privacy first");
});

test("can fall back to editing a single line of a paragraph", async ({ page }) => {
  await openSample(page, paragraphPdf(), "paragraph.pdf");
  await page.getByRole("button", { name: /^Edit PDF text: never leave the phone/ }).click();
  await page.getByRole("button", { name: "This line only" }).click();
  const editor = page.getByRole("textbox", { name: "Edit original PDF text" });
  await expect(editor).toHaveValue(PARAGRAPH_LINES[2]!);
  await editor.fill("never leave this laptop.");
  await page.keyboard.press("Control+Enter");
  const text = inspectPdf(await exportPdf(page)).pages[0]!.text;
  expect(text).toContain("never leave this laptop.");
  expect(text).toContain(PARAGRAPH_LINES[3]!);
});

test("moves an image that is part of the page without leaving a hole", async ({ page }) => {
  await openSample(page, imageOnPanelPdf(), "image.pdf");
  await fitPage(page);
  const hit = page.getByRole("button", { name: /^Edit image/ });
  await hit.click();
  await expect(page.locator(".objectBox.selected")).toBeVisible();
  // Image centre is at (160, 240) of a 600×800 page; drag it 200pt right.
  const box = (await page.locator(".objectBox.selected").boundingBox())!;
  const pageBox = (await pageAt(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + (pageBox.width * 200) / 600, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const bytes = await exportPdf(page);
  // Where the image was, the blue panel shows through.
  expect(colourAt(bytes, 160 / 600, 240 / 800)).toEqual([0, 0, 255]);
  // The image is drawn at its new place.
  const moved = colourAt(bytes, 360 / 600, 240 / 800);
  expect(Math.max(...moved)).toBeLessThan(40);
});

test("draws with the highlighter and erases pen strokes", async ({ page }) => {
  await openSample(page);
  await fitPage(page);
  await tool(page, "Draw");
  await page.locator(".contextBar select").first().selectOption("highlighter");
  await dragOnPage(page, [0.1, 0.3], [0.5, 0.3]);
  await page.locator(".contextBar select").first().selectOption("pen");
  await dragOnPage(page, [0.1, 0.6], [0.5, 0.6]);
  await dragOnPage(page, [0.1, 0.7], [0.5, 0.7]);
  await tool(page, "Eraser");
  await dragOnPage(page, [0.3, 0.55], [0.3, 0.65]);
  const bytes = await exportPdf(page);
  const pdf = inspectPdf(bytes);
  expect(pdf.pages[0]!.annotations).toEqual(["Ink", "Ink"]);
});

test("changes the page size with edits kept, then splits into a ZIP", async ({ page }) => {
  await openSample(page);
  await fitPage(page);
  await tool(page, "Add text");
  await clickOnPage(page, [0.6, 0.2]);
  await page.keyboard.type("Moves with the page");
  await clickOnPage(page, [0.3, 0.9]);

  await tab(page, "Pages");
  await tool(page, "Page size");
  const sizeDialog = page.getByRole("dialog", { name: "Page size" });
  await expect(sizeDialog).toContainText("Page 1 is 216 × 279 mm (Letter)");
  await sizeDialog.getByRole("combobox", { name: /^Pages/ }).selectOption("all");
  await sizeDialog.getByRole("combobox", { name: /^Paper size/ }).selectOption("A5");
  await sizeDialog.getByRole("button", { name: "Resize 3 pages" }).click();
  await expect(sizeDialog).toBeHidden();
  await expect(page.locator(".textOverlay", { hasText: "Moves with the page" })).toBeVisible();

  const resized = inspectPdf(await exportPdf(page));
  // Portrait pages become A5 portrait; the sideways third page stays landscape.
  expect(resized.pages.map((item) => item.size)).toEqual([[420, 595], [420, 595], [595, 420]]);
  expect(resized.pages[0]!.text).toContain("Quarterly Report");
  expect(resized.pages[0]!.text).toContain("Moves with the page");

  await tool(page, "Split");
  const splitDialog = page.getByRole("dialog", { name: "Split document" });
  await splitDialog.getByRole("radio", { name: "Page ranges" }).click();
  await splitDialog.getByLabel("Ranges, one file each").fill("1-2, 9");
  await expect(splitDialog).toContainText('"9" is outside pages 1–3.');
  await splitDialog.getByLabel("Ranges, one file each").fill("1-2, 3");
  await expect(splitDialog).toContainText("2 files: pages 1-2, 3");
  const download = page.waitForEvent("download");
  await splitDialog.getByRole("button", { name: "Save 2 files" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("sample-split.zip");
  const parts = readStoredZip(await readFile((await file.path())!));
  expect(parts.map((part) => part.name)).toEqual(["sample-p1-2.pdf", "sample-p3.pdf"]);
  const first = inspectPdf(parts[0]!.data);
  expect(first.pages).toHaveLength(2);
  expect(first.pages[0]!.size).toEqual([420, 595]);
  expect(first.pages[0]!.text).toContain("Moves with the page");
  expect(inspectPdf(parts[1]!.data).pages[0]!.text).toContain("Page three");

  await page.getByRole("button", { name: "Undo" }).click();
  expect(inspectPdf(await exportPdf(page)).pages.map((item) => item.size)).toEqual([[612, 792], [612, 792], [792, 612]]);
});

test("the scanner offers photos when no camera can be used", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Scan a document" }).click();
  const scanner = page.getByRole("dialog", { name: "Scan document" });
  await expect(scanner).toContainText("instead");
  await expect(scanner.getByRole("button", { name: "Take a photo" })).toBeVisible();
  await expect(scanner.getByRole("button", { name: "Take photo" })).toBeDisabled();
  await scanner.getByRole("button", { name: "Close scanner" }).click();
  await expect(scanner).toBeHidden();
});
