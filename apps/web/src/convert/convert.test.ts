import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../../../packages/pdf-engine/src/engine";
import { buildDocx } from "./docx";
import { buildPptx } from "./pptx";
import { buildXlsx, parseCell } from "./xlsx";
import { columnsPdf, listsPdf, reportPdf } from "./samples";
import { bodySize, structurePage } from "./structure";

const engine = createEngine(mupdf);
const save = (bytes: Uint8Array, name: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "convert-")), name);
  writeFileSync(path, bytes);
  return path;
};
/** Runs a Python check when the Office libraries are installed; returns null otherwise. */
const python = (script: string, path: string) => {
  try {
    execFileSync("python3", ["-c", "import docx, openpyxl, pptx"], { stdio: "ignore" });
  } catch {
    return null;
  }
  return JSON.parse(execFileSync("python3", ["-c", script, path], { encoding: "utf8" })) as unknown;
};

describe("document structure", () => {
  it("finds headings, paragraphs, tables and pictures in reading order", async () => {
    const layouts = await engine.analyzeBytes(reportPdf());
    const page = structurePage(layouts[0]!, bodySize(layouts));
    const kinds = page.items.map((item) => (item.kind === "paragraph" ? `${item.heading ? `h${item.heading}` : "p"}:${item.runs.map((run) => ("tab" in run ? "\t" : run.text)).join("").slice(0, 12)}` : item.kind));
    expect(kinds).toEqual(["h1:Quarterly Re", "p:Prepared for", "p:Revenue grew", "h2:Results by r", "table", "image", "p:Figure 1: Sa", "p:Total\t$2,180"]);
    const body = page.items[2]!;
    expect(body.kind === "paragraph" && body.lines.length).toBe(4);
    const table = page.items[4]!;
    if (table.kind !== "table") throw new Error("expected a table");
    expect(table.cells.map((row) => row.map((cell) => cell.map((paragraph) => paragraph.runs.map((run) => ("tab" in run ? "" : run.text)).join("")).join("")))).toEqual([
      ["Region", "Revenue"],
      ["North", "$1,200,000"],
      ["South", "$980,000"],
    ]);
    expect(table.fills[0]).toEqual(["#d9e6ff", "#d9e6ff"]);
    expect(table.cells[1]![1]![0]!.alignment).toBe("right");
    const caption = page.items[6]!;
    expect(caption.kind === "paragraph" && caption.alignment).toBe("center");
  });

  it("reads two columns one after the other", async () => {
    const layouts = await engine.analyzeBytes(columnsPdf());
    const page = structurePage(layouts[0]!, bodySize(layouts));
    const texts = page.items.map((item) => (item.kind === "paragraph" ? item.runs.map((run) => ("tab" in run ? "\t" : run.text)).join("") : item.kind));
    expect(texts[0]).toBe("Two Column Article");
    expect(texts[1]).toMatch(/^Left column line 1.*Left column line 8 of the text\.$/);
    expect(texts[2]).toMatch(/^Right column line 1.*Right column line 8 of the text\.$/);
  });

  it("keeps list items apart and finds tables drawn with filled borders", async () => {
    const layouts = await engine.analyzeBytes(listsPdf());
    const page = structurePage(layouts[0]!, bodySize(layouts));
    const texts = page.items.map((item) => (item.kind === "paragraph" ? item.runs.map((run) => ("tab" in run ? "\t" : run.text)).join("") : item.kind));
    expect(texts).toEqual(["Goals", "•\tGrow fresh vegetables", "•\tTeach children about soil", "•\tCreate a quiet green space", "1.\tBuild the beds", "2.\tFirst planting", "table"]);
    const item = page.items[1]!;
    if (item.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(item.x).toBeCloseTo(90, 0);
    expect(item.firstLineIndent).toBeCloseTo(-18, 0);
    const table = page.items[6]!;
    if (table.kind !== "table") throw new Error("expected a table");
    expect(table.cells.map((row) => row.map((cell) => cell.map((paragraph) => paragraph.runs.map((run) => ("tab" in run ? "" : run.text)).join("")).join("")))).toEqual([
      ["Item", "Cost"],
      ["Beds", "$2,400"],
      ["Soil", "$900"],
    ]);
  });
});

describe("Word export", () => {
  it("writes an editable document Word libraries can read", async () => {
    const docx = await buildDocx(await engine.analyzeBytes(reportPdf()), "Report");
    const path = save(docx, "report.docx");
    const result = python(
      `import sys, json, docx
d = docx.Document(sys.argv[1])
paras = [(p.style.name, p.text) for p in d.paragraphs if p.text.strip()]
tables = [[[c.text for c in r.cells] for r in t.rows] for t in d.tables]
sections = [(round(s.page_width.pt), round(s.page_height.pt)) for s in d.sections]
runs = [(r.text, r.bold, r.italic, r.font.size.pt if r.font.size else None, r.font.name) for p in d.paragraphs for r in p.runs if r.text.strip()]
print(json.dumps({"paras": paras, "tables": tables, "sections": sections, "runs": runs, "images": len(d.inline_shapes)}))`,
      path,
    ) as { paras: [string, string][]; tables: string[][][]; sections: number[][]; runs: [string, boolean, boolean, number, string][]; images: number } | null;
    if (!result) return;
    expect(result.paras[0]).toEqual(["Heading 1", "Quarterly Report"]);
    expect(result.paras).toContainEqual(["Normal", "Revenue grew steadily across every region this quarter, led by strong demand in the north and a recovering market in the south. Costs stayed flat, so margins improved for the third quarter in a row."]);
    expect(result.paras).toContainEqual(["Heading 2", "Results by region"]);
    expect(result.paras).toContainEqual(["Heading 1", "Appendix"]);
    expect(result.tables).toEqual([[["Region", "Revenue"], ["North", "$1,200,000"], ["South", "$980,000"]]]);
    expect(result.sections).toEqual([[612, 792], [792, 612]]);
    expect(result.images).toBe(1);
    expect(result.runs).toContainEqual(["Quarterly Report", true, null, 26, "Arial"]);
    expect(result.runs).toContainEqual(["Prepared for the board, October 2026", null, true, 14, "Times New Roman"]);
  });
});

describe("Excel export", () => {
  it("reads printed numbers as numbers", () => {
    expect(parseCell("$1,200,000")).toEqual({ number: 1200000, format: '"$"#,##0' });
    expect(parseCell("(12.50)")).toEqual({ number: -12.5, format: "0.00;(0.00)" });
    expect(parseCell("7.5%")).toEqual({ number: 0.075, format: "0.0%" });
    expect(parseCell("42")).toEqual({ number: 42, format: "General" });
    expect(parseCell("North")).toEqual({ text: "North" });
    expect(parseCell("2026-10-29")).toEqual({ text: "2026-10-29" });
  });

  it("writes tables cell for cell, with numbers spreadsheet libraries read", async () => {
    const xlsx = await buildXlsx(await engine.analyzeBytes(reportPdf()), "Report");
    const result = python(
      `import sys, json, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
out = {}
for ws in wb.worksheets:
    out[ws.title] = [[c.value for c in row] for row in ws.iter_rows()]
cell = wb.worksheets[0]
fmt = [c.number_format for row in cell.iter_rows() for c in row if isinstance(c.value, (int, float))]
bold = [c.value for row in cell.iter_rows() for c in row if c.font and c.font.b]
fill = [c.value for row in cell.iter_rows() for c in row if c.fill and c.fill.fgColor and c.fill.fgColor.rgb not in (None, "00000000")]
print(json.dumps({"sheets": out, "formats": fmt, "bold": bold, "fill": fill}))`,
      save(xlsx, "report.xlsx"),
    ) as { sheets: Record<string, unknown[][]>; formats: string[]; bold: string[]; fill: string[] } | null;
    if (!result) return;
    expect(Object.keys(result.sheets)).toEqual(["Page 1", "Page 2"]);
    const rows = result.sheets["Page 1"]!.map((row) => row.filter((value) => value !== null));
    expect(rows).toContainEqual(["Quarterly Report"]);
    expect(rows).toContainEqual(["Region", "Revenue"]);
    expect(rows).toContainEqual(["North", 1200000]);
    expect(rows).toContainEqual(["South", 980000]);
    expect(rows).toContainEqual(["Total", 2180000]);
    expect(result.formats).toEqual(['"$"#,##0', '"$"#,##0', '"$"#,##0']);
    expect(result.bold).toEqual(expect.arrayContaining(["Quarterly Report", "Region", "Revenue"]));
    expect(result.fill).toEqual(["Region", "Revenue"]);
    expect(result.sheets["Page 2"]!.flat().filter(Boolean)).toEqual(["Appendix", "Notes on the method used for this report."]);
  });
});

describe("PowerPoint export", () => {
  it("makes one slide per page with editable text over the page's graphics", async () => {
    const pdf = reportPdf();
    const layouts = await engine.analyzeBytes(pdf);
    const backgrounds = await Promise.all(layouts.map((_, index) => engine.renderBytesWithoutText(pdf, index, 1.5)));
    const pptx = await buildPptx(layouts, backgrounds, "Report");
    const result = python(
      `import sys, json, pptx
p = pptx.Presentation(sys.argv[1])
slides = [[sh.text_frame.text for sh in s.shapes if sh.has_text_frame] for s in p.slides]
pos = {sh.text_frame.text: (round(sh.left.pt), round(sh.top.pt)) for s in p.slides for sh in s.shapes if sh.has_text_frame}
sizes = {r.text: r.font.size.pt for s in p.slides for sh in s.shapes if sh.has_text_frame for para in sh.text_frame.paragraphs for r in para.runs if r.font.size}
print(json.dumps({"size": [round(p.slide_width.pt), round(p.slide_height.pt)], "slides": slides, "pos": pos, "sizes": sizes}))`,
      save(pptx, "report.pptx"),
    ) as { size: number[]; slides: string[][]; pos: Record<string, number[]>; sizes: Record<string, number> } | null;
    if (!result) return;
    expect(result.size).toEqual([612, 792]);
    expect(result.slides).toHaveLength(2);
    expect(result.slides[0]).toEqual(expect.arrayContaining(["Quarterly Report", "Region", "$1,200,000", "Figure 1: Sales mix"]));
    expect(result.pos["Quarterly Report"]![0]).toBe(72);
    const title = layouts[0]!.spans.find((span) => span.text === "Quarterly Report")!;
    expect(Math.abs(result.pos["Quarterly Report"]![1]! - title.y)).toBeLessThan(1);
    expect(result.sizes["Quarterly Report"]).toBe(26);
    // The landscape page is scaled down to fit the portrait slide.
    expect(result.sizes["Appendix"]).toBeCloseTo(20 * (612 / 792), 0);
  });
});

describe("opening Office files", () => {
  const pdfText = (bytes: Uint8Array) => {
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const text = Array.from({ length: doc.countPages() }, (_, index) => doc.loadPage(index).toStructuredText("").asText()).join("\n");
    const sizes = Array.from({ length: doc.countPages() }, (_, index) => doc.loadPage(index).getBounds().slice(2).map(Math.round));
    doc.destroy();
    return { text, sizes };
  };

  it("formats numbers and dates like Excel", async () => {
    const { formatValue } = await import("./fromXlsx");
    expect(formatValue(1200000, '"$"#,##0')).toBe("$1,200,000");
    expect(formatValue(650.5, '"$"#,##0.00')).toBe("$650.50");
    expect(formatValue(0.47, "0%")).toBe("47%");
    expect(formatValue(-12.5, "#,##0.00;(#,##0.00)")).toBe("(12.50)");
    expect(formatValue(-3, "0")).toBe("-3");
    expect(formatValue(46083, "d mmm yyyy")).toBe("2 Mar 2026");
    expect(formatValue(46083, "m/d/yyyy")).toBe("3/2/2026");
    expect(formatValue(46083.75, "h:mm AM/PM")).toBe("6:00 PM");
    expect(formatValue(0.1 + 0.2, "General")).toBe("0.3");
  });

  it("lays out a Word file: text, headings, tables and page sizes", async () => {
    const { docxToHtml } = await import("./fromDocx");
    const docx = await buildDocx(await engine.analyzeBytes(reportPdf()), "Report");
    const parts = await docxToHtml(docx);
    expect(parts.map((part) => [part.width, part.height])).toEqual([[612, 792], [792, 612]]);
    const { text, sizes } = pdfText(await engine.htmlToPdf(parts));
    expect(sizes[0]).toEqual([612, 792]);
    expect(sizes.at(-1)).toEqual([792, 612]);
    for (const expected of ["Quarterly Report", "Revenue grew steadily", "Results by region", "$1,200,000", "Figure 1: Sales mix", "Appendix"]) expect(text).toContain(expected);
    expect(parts[0]!.html).toContain("<table");
    expect(parts[0]!.html).toContain("<img src=\"data:image/jpeg;base64,");
  });

  it("lays out an Excel file sheet by sheet", async () => {
    const { xlsxToHtml } = await import("./fromXlsx");
    const xlsx = await buildXlsx(await engine.analyzeBytes(reportPdf()), "Report");
    const parts = await xlsxToHtml(xlsx);
    expect(parts).toHaveLength(2);
    const { text } = pdfText(await engine.htmlToPdf(parts));
    for (const expected of ["Page 1", "Region", "$1,200,000", "$980,000", "Page 2", "Appendix"]) expect(text).toContain(expected);
  });
});
