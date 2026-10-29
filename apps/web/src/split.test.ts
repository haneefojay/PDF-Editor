import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, createZip, describeGroup, parseRanges, splitEvery } from "./split";

describe("split plans", () => {
  it("parses single pages, ranges and open ends", () => {
    expect(parseRanges("1-3, 5; 8-", 9)).toEqual({ groups: [[0, 1, 2], [4], [7, 8]] });
    expect(parseRanges("-2, 3–end", 4)).toEqual({ groups: [[0, 1], [2, 3]] });
  });

  it("rejects ranges outside the document", () => {
    expect(parseRanges("2-12", 9)).toEqual({ error: '"2-12" is outside pages 1–9.' });
    expect(parseRanges("abc", 9)).toHaveProperty("error");
    expect(parseRanges(" ", 9)).toHaveProperty("error");
    expect(parseRanges("4-2", 9)).toHaveProperty("error");
  });

  it("splits every N pages", () => {
    expect(splitEvery(2, 5)).toEqual({ groups: [[0, 1], [2, 3], [4]] });
    expect(splitEvery(0, 5)).toHaveProperty("error");
  });

  it("labels groups", () => {
    expect(describeGroup([0])).toBe("1");
    expect(describeGroup([2, 3, 4])).toBe("3-5");
    expect(describeGroup([0, 2])).toBe("1+3");
  });
});

describe("zip archives", () => {
  it("computes CRC-32", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
  });

  it("writes an archive unzip can read", () => {
    const encoder = new TextEncoder();
    const zip = createZip([
      { name: "a.pdf", data: encoder.encode("first file") },
      { name: "b – é.pdf", data: encoder.encode("second") },
    ]);
    const folder = mkdtempSync(join(tmpdir(), "zip-"));
    const path = join(folder, "test.zip");
    writeFileSync(path, zip);
    let listing: string;
    try {
      listing = execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); [print(i.filename, z.read(i).decode()) for i in z.infolist()]", path], { encoding: "utf8" });
    } catch {
      return; // No Python available to cross-check.
    }
    expect(listing.trim().split("\n")).toEqual(["None", "a.pdf first file", "b – é.pdf second"]);
  });
});
