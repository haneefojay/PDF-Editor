// Shared pieces for writing Office Open XML packages (DOCX, XLSX, PPTX).
import { createZip } from "../split";

export type PackagePart = { name: string; data: string | Uint8Array; compress?: boolean };

export const escapeXml = (text: string) =>
  text
    // Characters XML 1.0 cannot carry at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

async function deflate(data: Uint8Array) {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Zips package parts, compressing XML; images are stored since they are already compressed. */
export async function writePackage(parts: PackagePart[]) {
  const encoder = new TextEncoder();
  const files = await Promise.all(
    parts.map(async (part) => {
      const data = typeof part.data === "string" ? encoder.encode(part.data) : part.data;
      const compress = part.compress ?? typeof part.data === "string";
      return { name: part.name, data, deflated: compress && data.length > 64 ? await deflate(data) : undefined };
    }),
  );
  return createZip(files);
}

/** Package metadata parts shared by every format. */
export function coreProperties(title: string, application: string) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return [
    {
      name: "docProps/core.xml",
      data: `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Paperless PDF Editor</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${escapeXml(application)}</Application></Properties>`,
    },
  ];
}

export const packageRelationships = (main: { type: string; target: string }) =>
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${main.type}" Target="${main.target}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

export const contentTypes = (overrides: [string, string][], images: boolean) =>
  `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${
    images ? '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' : ""
  }<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join("")}</Types>`;

/** Points to English Metric Units. */
export const emu = (points: number) => Math.round(points * 12700);
/** Points to twentieths of a point. */
export const twips = (points: number) => Math.round(points * 20);
export const hexColor = (color: string) => color.replace("#", "").toUpperCase().padStart(6, "0").slice(0, 6);

/** A font name Office knows, from a PDF font name and its traits. */
export function officeFont(span: { fontFamily: string; serif: boolean; monospace: boolean }) {
  const family = span.fontFamily.replace(/^[A-Z]{6}\+/, "").replace(/[-,_](PS)?$/i, "").replace(/PS$/, "");
  const key = family.toLowerCase().replace(/[\s_-]/g, "");
  const known: [RegExp, string][] = [
    [/^(helvetica|arial|liberationsans|arimo|nimbussans)/, "Arial"],
    [/^(times|liberationserif|tinos|nimbusroman)/, "Times New Roman"],
    [/^(courier|liberationmono|cousine|nimbusmono)/, "Courier New"],
  ];
  for (const [pattern, name] of known) if (pattern.test(key)) return name;
  // Embedded fonts with made-up names fall back to the closest common face.
  if (!family || /^(f\d+|t\d+|font\d*|t3font.*|type3.*|cid.*)$/i.test(family)) return span.monospace ? "Courier New" : span.serif ? "Times New Roman" : "Arial";
  return family.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
}
