/** Page groups for splitting a document, as 0-based display indexes. */
export type SplitPlan = { groups: number[][] } | { error: string };

/** One file per comma-separated item: "1-3, 4, 7-" for a 9 page document. */
export function parseRanges(text: string, pageCount: number): SplitPlan {
  const items = text.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  if (!items.length) return { error: "Enter page ranges such as 1-3, 4, 7-." };
  const groups: number[][] = [];
  for (const item of items) {
    const match = /^(\d+)?\s*(?:(-|–)\s*(\d+|end)?)?$/i.exec(item);
    if (!match || (!match[1] && !match[3])) return { error: `"${item}" is not a page or range.` };
    const first = match[1] ? Number(match[1]) : 1;
    const last = !match[2] ? first : !match[3] || match[3].toLowerCase() === "end" ? pageCount : Number(match[3]);
    if (first < 1 || last > pageCount || first > last)
      return { error: `"${item}" is outside pages 1–${pageCount}.` };
    groups.push(Array.from({ length: last - first + 1 }, (_, index) => first - 1 + index));
  }
  return { groups };
}

export function splitEvery(size: number, pageCount: number): SplitPlan {
  if (!Number.isInteger(size) || size < 1) return { error: "Enter a whole number of pages per file." };
  const groups: number[][] = [];
  for (let start = 0; start < pageCount; start += size)
    groups.push(Array.from({ length: Math.min(size, pageCount - start) }, (_, index) => start + index));
  return { groups };
}

/** "1-3" style label for a group of consecutive or scattered pages. */
export const describeGroup = (group: number[]) =>
  group.length === 1 ? `${group[0]! + 1}` : group.every((page, index) => !index || page === group[index - 1]! + 1) ? `${group[0]! + 1}-${group.at(-1)! + 1}` : group.map((page) => page + 1).join("+");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP archive. Files are stored as they are unless `deflated` holds their
 * raw-deflate compressed bytes; PDFs are already compressed internally, so
 * they are simply stored.
 */
export function createZip(files: { name: string; data: Uint8Array; deflated?: Uint8Array }[], date = new Date()) {
  const encoder = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const stored = file.deflated ?? file.data;
    const header = (signature: number, central: boolean) => {
      const buffer = new Uint8Array((central ? 46 : 30) + name.length);
      const view = new DataView(buffer.buffer);
      let at = 0;
      const u16 = (value: number) => (view.setUint16(at, value, true), (at += 2));
      const u32 = (value: number) => (view.setUint32(at, value, true), (at += 4));
      u32(signature);
      if (central) u16(20);
      u16(20); // version needed
      u16(0x0800); // UTF-8 names
      u16(file.deflated ? 8 : 0); // deflate or store
      u16(time);
      u16(day);
      u32(crc);
      u32(stored.length);
      u32(file.data.length);
      u16(name.length);
      u16(0); // extra
      if (central) {
        u16(0); // comment
        u16(0); // disk
        u16(0); // internal attributes
        u32(0); // external attributes
        u32(offset);
      }
      buffer.set(name, at);
      return buffer;
    };
    const local = header(0x04034b50, false);
    locals.push(local, stored);
    centrals.push(header(0x02014b50, true));
    offset += local.length + stored.length;
  }
  const directorySize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const zip = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}
