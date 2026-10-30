// Measures how the editor copes with a long document, in Chromium against a
// production build. The numbers in docs/WPS_PARITY_PLAN.md come from this
// script; run it against an older commit's build to reproduce "before" figures.
//
//   pnpm build
//   pnpm --filter @paperless/web exec vite preview --port 4173 --strictPort &
//   node scripts/bench-long-document.mjs [--url http://localhost:4173] [--pages 1000] [--runs 3] [--phone]
//
// --phone emulates a Pixel 7 with the CPU slowed four times. Set
// PLAYWRIGHT_CHROMIUM to use an already installed Chromium.
import { createRequire } from "node:module";
import { chromium, devices } from "@playwright/test";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const mupdf = await import(require.resolve("mupdf"));

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const url = option("url", "http://localhost:4173");
const pages = Number(option("pages", "1000"));
const runs = Number(option("runs", "3"));
const phone = process.argv.includes("--phone");

/** A text PDF: a heading and 20 lines on every page. */
function longPdf(count) {
  const doc = new mupdf.PDFDocument();
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  resources.put("Font", fonts);
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  for (let index = 0; index < count; index += 1) {
    const lines = [`BT /F1 24 Tf 60 730 Td (Page ${index + 1}) Tj ET`];
    for (let line = 0; line < 20; line += 1) lines.push(`BT /F1 10 Tf 60 ${690 - line * 22} Td (Line ${line + 1} of page ${index + 1}) Tj ET`);
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, lines.join("\n")));
  }
  const bytes = Buffer.from(doc.saveToBuffer("garbage=3,compress=yes").asUint8Array());
  doc.destroy();
  return bytes;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, share) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];

async function measure(browser, pdf) {
  const context = await browser.newContext(phone ? { ...devices["Pixel 7"] } : { viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (phone) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize / 1024 / 1024;
  };
  const settle = () => page.waitForTimeout(2000);
  const result = {};

  await page.goto(url);
  let started = performance.now();
  await page.setInputFiles('input[aria-label="Open PDF"]', { name: "long.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.locator(".page img").first().waitFor({ timeout: 120_000 });
  result.openSeconds = (performance.now() - started) / 1000;
  await settle();
  result.domNodes = await page.locator("*").count();
  result.heapMB = await heap();

  // Scroll the document by 60 px a frame for three seconds and time each frame.
  const frames = await page.locator(".stage").evaluate(
    (stage) =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        const end = last + 3000;
        const step = (now) => {
          deltas.push(now - last);
          last = now;
          stage.scrollTop += 60;
          if (now < end) requestAnimationFrame(step);
          else resolve(deltas.slice(1));
        };
        requestAnimationFrame(step);
      }),
  );
  result.frameMedianMs = median(frames);
  result.frameP95Ms = percentile(frames, 0.95);

  // The phone layout keeps the page box, the rail and search in drawers, so
  // those steps run only where the controls are on screen.
  if (await page.locator(".pageInput").isVisible()) {
    const target = Math.min(pages, 900);
    started = performance.now();
    await page.locator(".pageInput").fill(String(target));
    await page.locator(".pageInput").press("Enter");
    await page.locator(`.pageSlot[data-index="${target - 1}"] .page > img`).waitFor({ timeout: 120_000 });
    result.jumpSeconds = (performance.now() - started) / 1000;
  }

  // Scroll the thumbnail rail to its end, letting thumbnails render on the way.
  if (await page.locator(".rail").isVisible()) {
    const rail = page.locator(".rail");
    const steps = await rail.evaluate((element) => {
      let node = element.querySelector(".thumb")?.parentElement ?? element;
      while (node && node !== element.parentElement && !["auto", "scroll"].includes(getComputedStyle(node).overflowY)) node = node.parentElement;
      window.__railScroller = node;
      return Math.ceil(node.scrollHeight / node.clientHeight);
    });
    for (let index = 0; index <= steps; index += 1) {
      await page.evaluate(() => (window.__railScroller.scrollTop += window.__railScroller.clientHeight));
      await page.waitForTimeout(150);
    }
    await settle();
    result.heapAfterRailMB = await heap();
  }

  // Search for a phrase on the last page, then the same search again.
  const search = async () => {
    const begun = performance.now();
    await page.getByRole("button", { name: "Find all" }).click();
    await page.locator(".findSummary").filter({ hasText: /match/ }).waitFor({ timeout: 300_000 });
    return (performance.now() - begun) / 1000;
  };
  await page.keyboard.press("Control+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  if (await find.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await find.fill(`Line 20 of page ${pages}`);
    result.searchSeconds = await search();
    await find.fill(`Line 19 of page ${pages}`);
    result.searchAgainSeconds = await search();
  }

  await context.close();
  return result;
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const pdf = longPdf(pages);
const results = [];
for (let run = 0; run < runs; run += 1) results.push(await measure(browser, pdf));
await browser.close();

const round = (value) => (value === undefined ? "-" : value < 10 ? value.toFixed(2) : Math.round(value));
console.log(`${pages}-page PDF, ${phone ? "Pixel 7 with CPU slowed 4x" : "desktop 1400x900"}, median of ${runs} runs (${url})`);
for (const key of Object.keys(results[0])) console.log(`${key.padEnd(20)} ${round(median(results.map((result) => result[key]).filter((value) => value !== undefined)))}`);
