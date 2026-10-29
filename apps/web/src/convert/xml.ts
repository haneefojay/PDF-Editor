// A small XML reader for Office files: elements, attributes and text.
export type XmlNode = { name: string; attrs: Record<string, string>; children: (XmlNode | string)[] };

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) =>
    entity[0] === "#" ? String.fromCodePoint(entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : (ENTITIES[entity] ?? whole),
  );

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const match of source.matchAll(pattern)) {
    const parent = stack.at(-1)!;
    if (match[1] !== undefined) parent.children.push(match[1]);
    else if (match[2]) {
      if (stack.length > 1) stack.pop();
    } else if (match[3]) {
      const attrs: Record<string, string> = {};
      for (const attr of match[4]!.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[attr[1]!] = decode(attr[2] ?? attr[3] ?? "");
      const node: XmlNode = { name: match[3], attrs, children: [] };
      parent.children.push(node);
      if (!match[5]) stack.push(node);
    } else if (match[6] !== undefined && stack.length > 1) parent.children.push(decode(match[6]));
  }
  return root;
}

export const elements = (node: XmlNode | undefined, name?: string) =>
  (node?.children ?? []).filter((child): child is XmlNode => typeof child !== "string" && (!name || child.name === name));
export const child = (node: XmlNode | undefined, name: string) => elements(node, name)[0];
/** First descendant with the name, depth first. */
export function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  for (const item of elements(node)) {
    if (item.name === name) return item;
    const found = find(item, name);
    if (found) return found;
  }
  return undefined;
}
export const findAll = (node: XmlNode | undefined, name: string, found: XmlNode[] = []): XmlNode[] => {
  for (const item of elements(node)) {
    if (item.name === name) found.push(item);
    else findAll(item, name, found);
  }
  return found;
};
export const textOf = (node: XmlNode | undefined): string =>
  (node?.children ?? []).map((item) => (typeof item === "string" ? item : textOf(item))).join("");
