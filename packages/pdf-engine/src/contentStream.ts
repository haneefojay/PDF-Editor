// A small tokenizer for PDF content streams, enough to follow the graphics
// state and find where image XObjects are drawn.

export type Matrix = [number, number, number, number, number, number];

/** Applies `a` first, then `b`. */
export const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set("()<>[]{}/%".split("").map((character) => character.charCodeAt(0)));

type Token =
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "name"; value: string; start: number; end: number }
  | { kind: "operator"; value: string; start: number; end: number }
  | { kind: "other"; start: number; end: number };

function* tokens(bytes: Uint8Array): Generator<Token> {
  let index = 0;
  const length = bytes.length;
  const regular = (byte: number) => !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
  while (index < length) {
    const byte = bytes[index]!;
    if (WHITESPACE.has(byte)) {
      index += 1;
      continue;
    }
    const start = index;
    if (byte === 0x25) {
      // Comment to end of line.
      while (index < length && bytes[index] !== 10 && bytes[index] !== 13) index += 1;
      continue;
    }
    if (byte === 0x28) {
      // Literal string with nesting and escapes.
      let depth = 0;
      while (index < length) {
        const current = bytes[index]!;
        if (current === 0x5c) index += 2;
        else {
          if (current === 0x28) depth += 1;
          if (current === 0x29) depth -= 1;
          index += 1;
          if (depth === 0) break;
        }
      }
      yield { kind: "other", start, end: index };
      continue;
    }
    if (byte === 0x3c) {
      if (bytes[index + 1] === 0x3c) {
        index += 2;
        yield { kind: "other", start, end: index };
        continue;
      }
      while (index < length && bytes[index] !== 0x3e) index += 1;
      index += 1;
      yield { kind: "other", start, end: index };
      continue;
    }
    if (byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d) {
      index += byte === 0x3e && bytes[index + 1] === 0x3e ? 2 : 1;
      yield { kind: "other", start, end: index };
      continue;
    }
    if (byte === 0x2f) {
      index += 1;
      while (index < length && regular(bytes[index]!)) index += 1;
      const raw = new TextDecoder("latin1").decode(bytes.subarray(start + 1, index));
      yield { kind: "name", value: raw.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), start, end: index };
      continue;
    }
    while (index < length && regular(bytes[index]!)) index += 1;
    if (index === start) {
      index += 1;
      continue;
    }
    const word = new TextDecoder("latin1").decode(bytes.subarray(start, index));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) yield { kind: "number", value: Number(word), start, end: index };
    else {
      yield { kind: "operator", value: word, start, end: index };
      if (word === "ID") {
        // Inline image data runs until whitespace + EI + whitespace.
        index += 1;
        while (index < length - 2) {
          if (WHITESPACE.has(bytes[index - 1]!) && bytes[index] === 0x45 && bytes[index + 1] === 0x49 && (index + 2 >= length || WHITESPACE.has(bytes[index + 2]!))) {
            index += 2;
            break;
          }
          index += 1;
        }
      }
    }
  }
}

export type ImageDraw = {
  /** Stream index within the page's contents and the byte range of `/Name Do`. */
  stream: number;
  start: number;
  end: number;
  name: string;
  /** Matrix mapping the image's unit square to user space. */
  matrix: Matrix;
};

/** Every XObject draw in the content streams, with the transform it is drawn with. */
export function findXObjectDraws(streams: Uint8Array[]): ImageDraw[] {
  const draws: ImageDraw[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  streams.forEach((bytes, stream) => {
    const operands: Token[] = [];
    for (const token of tokens(bytes)) {
      if (token.kind !== "operator") {
        operands.push(token);
        if (operands.length > 12) operands.shift();
        continue;
      }
      if (token.value === "q") stack.push(ctm);
      else if (token.value === "Q") ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (token.value === "cm") {
        const values = operands.slice(-6);
        if (values.length === 6 && values.every((value) => value.kind === "number"))
          ctm = multiply(values.map((value) => (value as { value: number }).value) as Matrix, ctm);
      } else if (token.value === "Do") {
        const name = operands.at(-1);
        if (name?.kind === "name") draws.push({ stream, start: name.start, end: token.end, name: name.value, matrix: ctm });
      }
      operands.length = 0;
    }
  });
  return draws;
}

/** Replaces byte ranges with spaces so every other offset stays valid. */
export function blankRanges(bytes: Uint8Array, ranges: { start: number; end: number }[]) {
  const copy = new Uint8Array(bytes);
  for (const { start, end } of ranges) copy.fill(32, start, end);
  return copy;
}
