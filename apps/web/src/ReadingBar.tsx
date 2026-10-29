import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsDown, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { createSpeech, type Sentence, type Voice } from "./readAloud";

const stored = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
};
const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable; settings then last for this visit.
  }
};

/**
 * Reads the document aloud from a page onwards, one sentence at a time,
 * reporting each sentence so the page can highlight and follow it.
 */
export function ReadAloudBar({
  startPage,
  pageCount,
  sentencesFor,
  onSentence,
  onClose,
}: {
  startPage: number;
  pageCount: number;
  sentencesFor: (page: number) => Promise<Sentence[]>;
  onSentence: (page: number, sentence: Sentence | null) => void;
  onClose: () => void;
}) {
  const speech = useRef(createSpeech()).current;
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState<string>(() => stored("paperless.readVoice", ""));
  const [rate, setRate] = useState<number>(() => stored("paperless.readRate", 1));
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState({ page: startPage, sentence: 0 });
  const [status, setStatus] = useState("");
  const run = useRef(0);
  const latest = useRef({ position, rate, voice });
  latest.current = { position, rate, voice };

  useEffect(() => {
    void speech.voices().then(setVoices);
  }, [speech]);
  // Moving through the document while paused moves where reading starts.
  useEffect(() => {
    if (!playing) setPosition({ page: startPage, sentence: 0 });
  }, [startPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const play = useCallback(
    async (from = latest.current.position) => {
      const token = ++run.current;
      setPlaying(true);
      setStatus("");
      let { page, sentence } = from;
      let spoken = false;
      try {
        while (token === run.current && page < pageCount) {
          const sentences = await sentencesFor(page);
          if (token !== run.current) return;
          if (sentence >= sentences.length) {
            page += 1;
            sentence = 0;
            continue;
          }
          const current = sentences[sentence]!;
          setPosition({ page, sentence });
          onSentence(page, current);
          spoken = true;
          const result = await speech.speak(current.text, { rate: latest.current.rate, voice: latest.current.voice || undefined });
          if (token !== run.current || result === "stopped") return;
          sentence += 1;
        }
        if (token !== run.current) return;
        setPlaying(false);
        onSentence(page, null);
        setPosition({ page: startPage, sentence: 0 });
        setStatus(spoken ? "Finished reading." : "There is no text to read here. Scanned pages need OCR first.");
      } catch (cause) {
        if (token !== run.current) return;
        setPlaying(false);
        setStatus(cause instanceof Error ? cause.message : "Reading aloud stopped.");
      }
    },
    [pageCount, sentencesFor, onSentence, speech, startPage],
  );

  // Opening the bar starts reading straight away; closing it stops.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !speech.available) return;
    started.current = true;
    void play();
    return () => {
      started.current = false;
      run.current += 1;
      speech.stop();
    };
  }, [play, speech]);

  const pause = () => {
    run.current += 1;
    speech.stop();
    setPlaying(false);
  };
  const skip = async (delta: number) => {
    const wasPlaying = playing;
    run.current += 1;
    speech.stop();
    let { page, sentence } = latest.current.position;
    sentence += delta;
    if (sentence < 0) {
      // Back past the start of a page: the last sentence of the page before.
      while (page > 0 && sentence < 0) {
        page -= 1;
        sentence = (await sentencesFor(page)).length - 1;
      }
      sentence = Math.max(0, sentence);
    }
    const next = { page, sentence };
    setPosition(next);
    const sentences = await sentencesFor(page);
    if (sentences[sentence]) onSentence(page, sentences[sentence]!);
    if (wasPlaying) void play(next);
  };
  const restartWith = (change: () => void) => {
    change();
    if (playing) {
      run.current += 1;
      speech.stop();
      // Let the state settle before picking the new rate or voice up.
      setTimeout(() => void play(latest.current.position), 0);
    }
  };

  if (!speech.available)
    return (
      <div className="readingBar" role="region" aria-label="Read aloud">
        <span className="readingStatus">This browser can't read aloud.</span>
        <button className="iconButton" aria-label="Close read aloud" onClick={onClose}>
          <X />
        </button>
      </div>
    );

  return (
    <div className="readingBar" role="region" aria-label="Read aloud">
      <button className="iconButton" aria-label="Previous sentence" onClick={() => void skip(-1)}>
        <SkipBack />
      </button>
      <button className="iconButton primaryRound" aria-label={playing ? "Pause reading" : "Start reading"} onClick={() => (playing ? pause() : void play())}>
        {playing ? <Pause /> : <Play />}
      </button>
      <button className="iconButton" aria-label="Next sentence" onClick={() => void skip(1)}>
        <SkipForward />
      </button>
      <span className="readingStatus" aria-live="polite">
        {status || `Page ${position.page + 1} of ${pageCount}`}
      </span>
      <select
        aria-label="Reading speed"
        value={rate}
        onChange={(event) =>
          restartWith(() => {
            setRate(Number(event.target.value));
            store("paperless.readRate", Number(event.target.value));
            latest.current.rate = Number(event.target.value);
          })
        }
      >
        {[0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => (
          <option key={value} value={value}>
            {value}×
          </option>
        ))}
      </select>
      {voices.length > 1 && (
        <select
          aria-label="Voice"
          className="voiceSelect"
          value={voice}
          onChange={(event) =>
            restartWith(() => {
              setVoice(event.target.value);
              store("paperless.readVoice", event.target.value);
              latest.current.voice = event.target.value;
            })
          }
        >
          <option value="">Default voice</option>
          {voices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.lang})
            </option>
          ))}
        </select>
      )}
      <button
        className="iconButton"
        aria-label="Close read aloud"
        onClick={() => {
          pause();
          onSentence(position.page, null);
          onClose();
        }}
      >
        <X />
      </button>
    </div>
  );
}

/** Scrolls the document steadily; any touch, wheel or key pauses it. */
export function AutoScrollBar({ target, onClose }: { target: () => HTMLElement | null; onClose: () => void }) {
  const [speed, setSpeed] = useState<number>(() => stored("paperless.scrollSpeed", 40));
  const [running, setRunning] = useState(true);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    if (!running) return;
    const element = target();
    if (!element) return;
    let frame = 0;
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      const elapsed = Math.min(100, now - last);
      last = now;
      carry += (speedRef.current * elapsed) / 1000;
      const whole = Math.floor(carry);
      if (whole) {
        element.scrollTop += whole;
        carry -= whole;
      }
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1) {
        setRunning(false);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    const stop = () => setRunning(false);
    element.addEventListener("wheel", stop, { passive: true });
    element.addEventListener("touchstart", stop, { passive: true });
    element.addEventListener("pointerdown", stop);
    window.addEventListener("keydown", stop);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("wheel", stop);
      element.removeEventListener("touchstart", stop);
      element.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [running, target]);

  return (
    <div className="readingBar" role="region" aria-label="Auto-scroll">
      <ChevronsDown className="readingIcon" />
      <button className="iconButton primaryRound" aria-label={running ? "Pause scrolling" : "Resume scrolling"} onClick={() => setRunning(!running)}>
        {running ? <Pause /> : <Play />}
      </button>
      <label className="readingSpeed">
        <span>Speed</span>
        <input
          type="range"
          aria-label="Scrolling speed"
          min="10"
          max="240"
          step="5"
          value={speed}
          onChange={(event) => {
            setSpeed(Number(event.target.value));
            store("paperless.scrollSpeed", Number(event.target.value));
          }}
        />
      </label>
      <button className="iconButton" aria-label="Close auto-scroll" onClick={onClose}>
        <X />
      </button>
    </div>
  );
}
