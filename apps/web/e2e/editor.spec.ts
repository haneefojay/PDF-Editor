import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { colourAt, imageOnPanelPdf, inspectPdf, longPdf, PARAGRAPH_LINES, paragraphPdf, pngImage, readStoredZip, samplePdf, wordFile, excelFile, presentationFile, zipText, outlineOf, annotatedPdf, manyPagesPdf } from "./fixtures";
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
  await expect(page.locator(".file h1")).toHaveText("scan-1.pdf");
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

test("a 600-page document stays light: only nearby pages and thumbnails exist", async ({ page }) => {
  const started = Date.now();
  await openSample(page, manyPagesPdf(600), "long.pdf");
  expect(Date.now() - started).toBeLessThan(30_000);
  await expect(page.locator(".pageInput")).toHaveValue("1");
  expect(await page.locator(".pageSlot").count()).toBeLessThan(8);
  expect(await page.locator(".rail .thumb").count()).toBeLessThan(20);
  expect(await page.locator("*").count()).toBeLessThan(2500);

  // Jumping far ahead renders that page, and the thumbnail rail follows.
  await page.locator(".pageInput").fill("480");
  await page.locator(".pageInput").press("Enter");
  await expect(page.locator('.pageSlot[data-index="479"] .page > img')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".rail .thumb.active .thumbButton")).toHaveAccessibleName("Page 480");
  await expect(page.locator(".rail .thumb.active")).toBeInViewport();
  await expect(page.locator(".rail .thumb.active .thumbPreview img")).toBeVisible({ timeout: 20_000 });
  expect(await page.locator(".pageSlot").count()).toBeLessThan(8);

  // Scrolling the document moves the current page.
  await page.locator(".stage").evaluate((stage) => stage.scrollBy(0, 5000));
  await expect(page.locator(".pageInput")).not.toHaveValue("480");

  // The organizer only builds the visible part of its grid, and scrolls to the end.
  await tab(page, "Pages");
  await tool(page, "Organize");
  const dialog = page.getByRole("dialog", { name: "Organize pages" });
  expect(await dialog.locator(".organizerGrid label").count()).toBeLessThan(80);
  await dialog.locator(".organizerGrid").evaluate((grid) => {
    let node: HTMLElement | null = grid.parentElement;
    while (node && !["auto", "scroll"].includes(getComputedStyle(node).overflowY)) node = node.parentElement;
    node!.scrollTop = node!.scrollHeight;
  });
  await expect(dialog.locator(".organizerGrid label", { hasText: /^600$/ })).toBeVisible();
  expect(await dialog.locator(".organizerGrid label").count()).toBeLessThan(80);
});

test("continuous scrolling tracks the page and follows outline and links", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  // Only pages near the viewport are in the page, but the column is as tall as all 12.
  expect(await page.locator(".pageSlot").count()).toBeLessThan(6);
  expect(await page.locator(".page > img").count()).toBeLessThan(6);
  const firstHeight = (await page.locator(".pageSlot").first().boundingBox())!.height;
  expect(await page.locator(".pageColumn").evaluate((column) => column.scrollHeight)).toBeGreaterThan(firstHeight * 12);

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

test("converts to Word, Excel and PowerPoint", async ({ page }) => {
  await openSample(page);
  const convert = async (format: string, scope: string, range?: string) => {
    await tab(page, "Tools");
    await tool(page, "Convert");
    const dialog = page.getByRole("dialog", { name: "Convert" });
    await dialog.getByRole("radio", { name: new RegExp(`^${format}`) }).click();
    await dialog.getByRole("combobox", { name: /^Pages/ }).selectOption(scope);
    if (range) await dialog.getByRole("textbox", { name: "Pages to convert" }).fill(range);
    const download = page.waitForEvent("download", { timeout: 90_000 });
    await dialog.getByRole("button", { name: /^Convert \d+ page/ }).click();
    const file = await download;
    await expect(dialog).toBeHidden();
    return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
  };

  const word = await convert("Word", "all");
  expect(word.name).toBe("sample.docx");
  const document = zipText(word.bytes, "word/document.xml");
  expect(document).toContain('<w:pStyle w:val="Heading1"/>');
  expect(document).toContain(">Quarterly Report<");
  expect(document).toContain("<w:tbl>");
  expect(document).toMatch(/North<\/w:t>.*\$1,200,000<\/w:t>/);
  expect(document.match(/<w:pageBreakBefore\/>/g)).toHaveLength(2);

  const excel = await convert("Excel", "range", "1");
  expect(excel.name).toBe("sample.xlsx");
  expect(readStoredZip(excel.bytes).map((file) => file.name)).toContain("xl/worksheets/sheet1.xml");
  expect(readStoredZip(excel.bytes).map((file) => file.name)).not.toContain("xl/worksheets/sheet2.xml");
  const sheet = zipText(excel.bytes, "xl/worksheets/sheet1.xml");
  expect(sheet).toContain("<v>1200000</v>");
  expect(sheet).toContain(">Region<");

  const slides = await convert("PowerPoint", "page");
  expect(slides.name).toBe("sample.pptx");
  const files = readStoredZip(slides.bytes).map((file) => file.name);
  expect(files).toEqual(expect.arrayContaining(["ppt/slides/slide1.xml", "ppt/media/page1.png"]));
  expect(files).not.toContain("ppt/slides/slide2.xml");
  expect(zipText(slides.bytes, "ppt/slides/slide1.xml")).toContain(">Quarterly Report<");
});

test("opens Word and Excel files as PDFs, and inserts them into a PDF", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles('input[aria-label="Open PDF"]', { name: "notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await wordFile() });
  await expect(page.locator(".page img").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".title, header").first()).toContainText("notes.pdf");
  await expect(page.locator(".rail .thumb")).toHaveCount(3);
  const word = inspectPdf(await exportPdf(page));
  expect(word.pages.map((item) => item.size)).toEqual([[612, 792], [612, 792], [792, 612]]);
  expect(word.pages[0]!.text).toContain("Meeting Notes");
  expect(word.pages[0]!.text).toMatch(/1\.\s+Order the beds/);
  expect(word.pages[0]!.text).toMatch(/2\.\s+Book the van/);
  expect(word.pages[0]!.text).toContain("Soil delivery");
  expect(word.pages[1]!.text).toContain("Second page text");
  expect(word.pages[2]!.text).toContain("Landscape appendix");

  // Insert a workbook after the first page.
  await tab(page, "Pages");
  const chooser = page.waitForEvent("filechooser");
  await tool(page, "Insert PDF");
  await (await chooser).setFiles({ name: "costs.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await excelFile() });
  await expect(page.locator(".rail .thumb")).toHaveCount(4);
  const merged = inspectPdf(await exportPdf(page));
  expect(merged.pages[1]!.text).toMatch(/Raised beds\s+\$2,400\.00\s+2-Mar-26/);
});

test("opens a PowerPoint file as a PDF, one page per shown slide", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles('input[aria-label="Open PDF"]', { name: "garden.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: await presentationFile() });
  await expect(page.locator(".page img").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".file h1")).toContainText("garden.pdf");
  await expect(page.locator(".rail .thumb")).toHaveCount(2);
  const slides = inspectPdf(await exportPdf(page));
  expect(slides.pages.map((item) => item.size)).toEqual([[720, 405], [720, 405]]);
  expect(slides.pages[0]!.text).toContain("Garden Plan");
  expect(slides.pages[0]!.text).toContain("Budget OK");
  expect(slides.pages[1]!.text).toMatch(/1\.\s+Dig/);
  expect(slides.pages.map((item) => item.text).join(" ")).not.toContain("Hidden draft");
});

test("explains which files cannot be opened", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles('input[aria-label="Open PDF"]', { name: "deck.ppt", mimeType: "application/vnd.ms-powerpoint", buffer: Buffer.from("x") });
  await expect(page.getByRole("alert")).toContainText("Older .doc, .xls and .ppt files can't be opened");
  await page.setInputFiles('input[aria-label="Open PDF"]', { name: "broken.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
  await expect(page.getByRole("alert")).toContainText("not a valid Office document");
});

/** A stand-in speech engine: each utterance "ends" after a short pause. */
const fakeSpeech = () => {
  const spoken: string[] = [];
  let current: { onend?: () => void; onerror?: (event: { error: string }) => void } | null = null;
  class Utterance {
    text: string;
    rate = 1;
    voice: unknown = null;
    lang = "";
    onend?: () => void;
    onerror?: (event: { error: string }) => void;
    constructor(text: string) {
      this.text = text;
    }
  }
  // The real properties are read-only accessors, so they are redefined.
  Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance, configurable: true });
  Object.defineProperty(window, "__spoken", { value: spoken, configurable: true });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [{ voiceURI: "test-voice", name: "Test voice", lang: "en-US" }, { voiceURI: "other", name: "Other voice", lang: "en-GB" }],
      addEventListener: () => undefined,
      resume: () => undefined,
      speak: (utterance: Utterance) => {
        current = utterance;
        spoken.push(utterance.text);
        setTimeout(() => current === utterance && utterance.onend?.(), 300);
      },
      cancel: () => {
        const stopped = current;
        current = null;
        stopped?.onerror?.({ error: "interrupted" });
      },
    },
  });
};

test("reads aloud sentence by sentence, following the text onto the next page", async ({ page }) => {
  await page.addInitScript(fakeSpeech);
  await openSample(page, longPdf(), "long.pdf");
  await tab(page, "Tools");
  await tool(page, "Read aloud");
  const bar = page.getByRole("region", { name: "Read aloud" });
  await expect(page.locator(".readingHighlight").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken[0])).toContain("Chapter 1");
  // It moves on to page 2 by itself and scrolls it into view.
  await expect(bar).toContainText("Page 2 of 12", { timeout: 20_000 });
  await expect(pageAt(page, 1)).toBeInViewport();
  await bar.getByRole("button", { name: "Pause reading" }).click();
  const count = await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.length);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.length)).toBe(count);
  await expect(bar.getByRole("combobox", { name: "Voice" })).toContainText("Other voice");
  await bar.getByRole("button", { name: "Next sentence" }).click();
  await expect(page.locator(".readingHighlight").first()).toBeVisible();
  await bar.getByRole("button", { name: "Start reading" }).click();
  await expect(bar.getByRole("button", { name: "Pause reading" })).toBeVisible();
  await bar.getByRole("button", { name: "Close read aloud" }).click();
  await expect(page.locator(".readingHighlight")).toHaveCount(0);
});

test("auto-scrolls and pauses", async ({ page }) => {
  await openSample(page, longPdf(), "long.pdf");
  await tab(page, "Tools");
  await tool(page, "Auto-scroll");
  const stage = page.locator(".stage");
  await expect.poll(() => stage.evaluate((element) => element.scrollTop), { timeout: 10_000 }).toBeGreaterThan(40);
  const bar = page.getByRole("region", { name: "Auto-scroll" });
  await bar.getByRole("button", { name: "Pause scrolling" }).click();
  const stopped = await stage.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(400);
  expect(await stage.evaluate((element) => element.scrollTop)).toBe(stopped);
  await bar.getByRole("button", { name: "Close auto-scroll" }).click();
  await expect(bar).toHaveCount(0);
});

test("adds, renames, nests and reorders bookmarks, and exports them", async ({ page }) => {
  await openSample(page);
  await tab(page, "Pages");
  await tool(page, "Bookmark page");
  const outline = page.getByRole("navigation", { name: "Document outline" });
  const first = outline.getByRole("textbox", { name: "Bookmark 1 title" });
  await expect(first).toBeFocused();
  await page.keyboard.type("Summary");
  await page.keyboard.press("Enter");

  await page.locator(".rail").getByRole("tab", { name: "Thumbnails" }).click();
  await page.locator(".rail .thumb").nth(2).click();
  await tab(page, "Pages");
  await tool(page, "Bookmark page");
  await expect(outline.getByRole("textbox", { name: "Bookmark 2 title" })).toBeFocused();
  await page.keyboard.type("Appendix");
  await page.keyboard.press("Enter");
  await outline.getByRole("button", { name: "Indent Appendix" }).click();
  await outline.getByRole("button", { name: "Done" }).click();
  await expect(outline.locator(".outlineEntry")).toHaveText(["Summary1", "Appendix3"]);

  await outline.getByRole("button", { name: /Summary/ }).click();
  await expect(pageAt(page, 0)).toBeInViewport();

  expect(outlineOf(await exportPdf(page))).toEqual([
    ["Summary", 0, 0],
    ["Appendix", 2, 1],
  ]);

  // Undo takes back the last change (the indent), keeping the rest.
  await outline.getByRole("button", { name: "Edit" }).click();
  await outline.getByRole("button", { name: "Move Appendix up" }).click();
  expect(outlineOf(await exportPdf(page)).map((row) => row[0])).toEqual(["Appendix", "Summary"]);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(outlineOf(await exportPdf(page)).map((row) => row[0])).toEqual(["Summary", "Appendix"]);
});

test("lists the annotations already in the file and jumps to them", async ({ page }) => {
  await openSample(page, annotatedPdf(), "annotated.pdf");
  await tab(page, "Comment");
  await tool(page, "All comments");
  const panel = page.getByRole("complementary", { name: "Comments" });
  await expect(panel).toContainText("2 in the file");
  await expect(panel.getByRole("heading", { name: "Already in the file (2)" })).toBeVisible();
  // Listed top to bottom: the note sits above the highlight.
  await expect(panel.locator(".fileAnnotation").first()).toContainText("Signed copy is in the drawer.");
  await expect(panel.locator(".fileAnnotation").first()).not.toContainText("1969");
  const highlight = panel.locator(".fileAnnotation").nth(1);
  await expect(highlight).toContainText("Page 3 · Highlight");
  await expect(highlight).toContainText("The contract renews every year in March.");
  await expect(highlight).toContainText("Is this still right?");
  await expect(highlight).toContainText("Lee");
  await highlight.getByRole("button").click();
  await expect(pageAt(page, 2)).toBeInViewport();
  await expect(pageAt(page, 2).locator(".searchHighlight")).toHaveCount(1);
});

/** Answers Messages API calls with a streamed reply, recording each request. */
async function mockClaude(page: import("@playwright/test").Page, reply: (body: { messages: { content: string }[] }) => string, status = 200) {
  const requests: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  await page.route("https://api.anthropic.com/**", async (route) => {
    const request = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = request.postDataJSON() as { messages: { content: string }[] };
    requests.push({ headers: await request.allHeaders(), body });
    if (status !== 200)
      return route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    const text = reply(body);
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ...text.split(/(?<= )/).map((part) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }]),
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    await route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("") });
  });
  return requests;
}

test("AI assistant is off until set up, then summarizes and translates with the user's key", async ({ page }) => {
  const requests = await mockClaude(page, (body) => (body.messages[0]!.content.includes("Quarterly Report") ? "The board report shows steady revenue growth." : "Página traducida."));
  await openSample(page);
  await tab(page, "Tools");
  await tool(page, "AI assistant");
  const setup = page.getByRole("dialog", { name: "Set up the AI assistant" });
  const turnOn = setup.getByRole("button", { name: "Turn on" });
  await expect(turnOn).toBeDisabled();
  await setup.getByLabel("Anthropic API key").fill("sk-ant-test-key");
  await expect(turnOn).toBeDisabled();
  await setup.getByRole("checkbox", { name: /I understand/ }).check();
  await turnOn.click();
  expect(requests).toHaveLength(0);

  const assistant = page.getByRole("dialog", { name: "AI assistant" });
  await expect(assistant).toContainText("api.anthropic.com");
  await assistant.getByRole("button", { name: "Send 1 page" }).click();
  await expect(assistant.locator(".aiOutput")).toHaveText("The board report shows steady revenue growth.");
  await expect(assistant.getByRole("status")).toHaveText(/Done/);
  expect(requests).toHaveLength(1);
  const [summary] = requests;
  // The SDK sends the key as a bearer token.
  expect(summary!.headers["authorization"]).toBe("Bearer sk-ant-test-key");
  expect(summary!.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(summary!.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
  expect(summary!.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", stream: true });
  expect(summary!.body.messages).toEqual([{ role: "user", content: expect.stringContaining("Quarterly Report") }]);

  // Translation goes page by page.
  await assistant.getByRole("radio", { name: "Translate" }).click();
  await assistant.getByRole("combobox", { name: /^Into/ }).selectOption("Spanish");
  await assistant.getByRole("combobox", { name: /^Pages/ }).selectOption("range");
  await assistant.getByRole("textbox", { name: "Pages to send" }).fill("2-3");
  await assistant.getByRole("button", { name: "Send 2 pages" }).click();
  await expect(assistant.locator(".aiOutput")).toHaveText("Page 2\nPágina traducida.\n\nPage 3\nPágina traducida.");
  expect(requests).toHaveLength(3);
  expect(String(requests[1]!.body.system)).toContain("into Spanish");
  expect(requests[1]!.body.messages).toEqual([{ role: "user", content: expect.stringContaining("Page two") }]);
});

test("AI assistant explains a rejected key and can be turned off", async ({ page }) => {
  const requests = await mockClaude(page, () => "", 401);
  await openSample(page);
  await tab(page, "Tools");
  await tool(page, "AI assistant");
  const setup = page.getByRole("dialog", { name: "Set up the AI assistant" });
  await setup.getByLabel("Anthropic API key").fill("sk-ant-wrong");
  await setup.getByRole("checkbox", { name: /I understand/ }).check();
  await setup.getByRole("button", { name: "Turn on" }).click();
  const assistant = page.getByRole("dialog", { name: "AI assistant" });
  await assistant.getByRole("button", { name: "Send 1 page" }).click();
  await expect(assistant.getByRole("status")).toContainText("The API key was not accepted");
  expect(requests.length).toBeGreaterThan(0);
  await assistant.getByRole("button", { name: "AI settings" }).click();
  await page.getByRole("button", { name: "Turn off and forget key" }).click();
  await expect(page.getByLabel("Anthropic API key")).toHaveValue("");
});
