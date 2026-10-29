// Read aloud: page text split into sentences that know where they are on
// the page, and a small speech adapter over the system's voices.
import { Capacitor } from "@capacitor/core";
import type { PositionedTextLine } from "@paperless/pdf-engine";

export type Box = { x: number; y: number; width: number; height: number };
export type Sentence = { text: string; boxes: Box[]; top: number };

/** Long sentences are spoken in pieces; some engines stop after ~15 seconds of speech. */
const MAX_CHUNK = 220;

function sentenceRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(text: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  if (Segmenter) {
    for (const { segment, index } of new Segmenter(undefined, { granularity: "sentence" }).segment(text)) ranges.push([index, index + segment.length]);
  } else {
    for (const match of text.matchAll(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g)) ranges.push([match.index!, match.index! + match[0].length]);
  }
  // Split long sentences at a comma or space.
  return ranges.flatMap(([start, end]) => {
    const pieces: [number, number][] = [];
    let from = start;
    while (end - from > MAX_CHUNK) {
      const window = text.slice(from, from + MAX_CHUNK);
      const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; ")) > MAX_CHUNK / 2 ? Math.max(window.lastIndexOf(", "), window.lastIndexOf("; ")) + 2 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") + 1 : MAX_CHUNK;
      pieces.push([from, from + cut]);
      from += cut;
    }
    pieces.push([from, end]);
    return pieces;
  });
}

/**
 * Sentences of a page in reading order, each with boxes covering its words
 * (normalized page coordinates). Runs of one line are joined first.
 */
export function sentencesOf(lines: PositionedTextLine[]): Sentence[] {
  // Runs of one visual line, in reading order.
  const grouped: PositionedTextLine[][] = [];
  const index = new Map<string, PositionedTextLine[]>();
  for (const line of lines) {
    const key = line.block !== undefined && line.line !== undefined ? `${line.block}:${line.line}` : line.id;
    let group = index.get(key);
    if (!group) {
      group = [];
      index.set(key, group);
      grouped.push(group);
    }
    group.push(line);
  }
  let text = "";
  const pieces: { start: number; end: number; box: Box }[] = [];
  for (const group of grouped) {
    for (const run of [...group].sort((a, b) => a.x - b.x)) {
      const value = run.text.replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (text && /[A-Za-zÀ-ÿ]-$/.test(text) && /^[a-zà-ÿ]/.test(value)) text = text.slice(0, -1);
      else if (text) text += " ";
      pieces.push({ start: text.length, end: text.length + value.length, box: { x: run.x, y: run.y, width: run.width, height: run.height } });
      text += value;
    }
  }
  return sentenceRanges(text)
    .map(([start, end]) => {
      const boxes = pieces
        .filter((piece) => piece.start < end && piece.end > start)
        .map((piece) => {
          // Characters are assumed evenly wide; close enough for a highlight.
          const length = piece.end - piece.start;
          const from = (Math.max(start, piece.start) - piece.start) / length;
          const to = (Math.min(end, piece.end) - piece.start) / length;
          return { x: piece.box.x + piece.box.width * from, y: piece.box.y, width: piece.box.width * (to - from), height: piece.box.height };
        });
      return { text: text.slice(start, end).trim(), boxes, top: Math.min(...boxes.map((box) => box.y)) };
    })
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence.text));
}

export type Voice = { id: string; name: string; lang: string };
export type Speech = {
  available: boolean;
  voices(): Promise<Voice[]>;
  /** Resolves "done" when spoken, or "stopped" when interrupted by stop(). */
  speak(text: string, options: { rate: number; voice?: string }): Promise<"done" | "stopped">;
  stop(): void;
};

function browserSpeech(): Speech {
  const synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
  let stopping = false;
  return {
    available: Boolean(synth),
    voices: () =>
      new Promise((resolve) => {
        if (!synth) return resolve([]);
        const list = () => synth.getVoices().map((voice) => ({ id: voice.voiceURI, name: voice.name, lang: voice.lang }));
        if (synth.getVoices().length) return resolve(list());
        // Voices often arrive a moment after load.
        const timer = setTimeout(() => resolve(list()), 1500);
        synth.addEventListener("voiceschanged", () => {
          clearTimeout(timer);
          resolve(list());
        }, { once: true });
      }),
    speak: (text, options) =>
      new Promise((resolve, reject) => {
        if (!synth) return reject(new Error("This browser cannot read aloud."));
        stopping = false;
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = options.rate;
        const voice = synth.getVoices().find((item) => item.voiceURI === options.voice);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        utterance.onend = () => resolve(stopping ? "stopped" : "done");
        utterance.onerror = (event) => (stopping || event.error === "interrupted" || event.error === "canceled" ? resolve("stopped") : reject(new Error(`Reading aloud failed (${event.error}).`)));
        synth.resume();
        synth.speak(utterance);
      }),
    stop: () => {
      stopping = true;
      synth?.cancel();
    },
  };
}

/** Android's WebView has no speech engine; the app uses the system's through a plugin. */
function nativeSpeech(): Speech {
  let stopping = false;
  const plugin = import("@capacitor-community/text-to-speech").then((module) => module.TextToSpeech);
  let voiceList: Voice[] = [];
  return {
    available: true,
    voices: async () => {
      const { voices } = await (await plugin).getSupportedVoices();
      voiceList = voices.map((voice) => ({ id: voice.voiceURI, name: voice.name, lang: voice.lang }));
      return voiceList;
    },
    speak: async (text, options) => {
      stopping = false;
      const voice = voiceList.findIndex((item) => item.id === options.voice);
      try {
        await (await plugin).speak({ text, rate: options.rate, ...(voice >= 0 ? { voice, lang: voiceList[voice]!.lang } : {}) });
      } catch (cause) {
        if (stopping) return "stopped";
        throw cause;
      }
      return stopping ? "stopped" : "done";
    },
    stop: () => {
      stopping = true;
      void plugin.then((tts) => tts.stop());
    },
  };
}

export const createSpeech = (): Speech => (Capacitor.isNativePlatform() ? nativeSpeech() : browserSpeech());
