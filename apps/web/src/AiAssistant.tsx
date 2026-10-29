import { useRef, useState } from "react";
import { Copy, Download, Settings, Square } from "lucide-react";
import { AI_MODELS, AiError, aiHost, aiReady, loadAiSettings, runAi, saveAiSettings, validBaseURL, type AiSettings } from "./ai";
import { parseRanges } from "./split";
import { Modal } from "./ui";

const LANGUAGES = [
  "Arabic", "Chinese (Simplified)", "Dutch", "English", "French", "German", "Hausa", "Hindi", "Igbo", "Indonesian", "Italian",
  "Japanese", "Korean", "Polish", "Portuguese", "Russian", "Spanish", "Swahili", "Turkish", "Ukrainian", "Vietnamese", "Yoruba",
];
const browserLanguage = () => {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(navigator.language.split("-")[0] ?? "en");
    return name && LANGUAGES.includes(name) ? name : "English";
  } catch {
    return "English";
  }
};

/**
 * Optional AI summary and translation. Nothing is sent until the user has
 * given their own API key, agreed to send page text, and pressed Send.
 */
export function AiAssistant({
  pageCount,
  currentPage,
  native,
  textOf,
  onSave,
  onClose,
}: {
  pageCount: number;
  currentPage: number;
  native: boolean;
  /** Text of display pages, in order, with all edits applied. */
  textOf: (indexes: number[]) => Promise<string[]>;
  onSave: (text: string, kind: "summary" | "translation") => void;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
  const [setup, setSetup] = useState(() => !aiReady(loadAiSettings()));
  const [draft, setDraft] = useState<AiSettings>(settings);
  const [kind, setKind] = useState<"summary" | "translate">("summary");
  const [language, setLanguage] = useState(browserLanguage);
  const [scope, setScope] = useState<"page" | "all" | "range">("page");
  const [range, setRange] = useState("");
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);

  if (native)
    return (
      <Modal title="AI assistant" onClose={onClose} footer={<button className="primary" onClick={onClose}>Close</button>}>
        <p className="aiNote">The Android app has no internet access by design, so the AI assistant is only available in the web version.</p>
      </Modal>
    );

  if (setup) {
    const valid = draft.apiKey.trim().length > 0 && draft.consent && validBaseURL(draft.baseURL);
    return (
      <Modal
        title="Set up the AI assistant"
        description="Optional and off until you turn it on. It summarizes or translates pages using Claude, with your own Anthropic API key."
        onClose={onClose}
        footer={
          <>
            {aiReady(settings) && (
              <button
                className="danger"
                onClick={() => {
                  const off = { ...settings, apiKey: "", consent: false, remember: false };
                  saveAiSettings(off);
                  setSettings(off);
                  setDraft(off);
                }}
              >
                Turn off and forget key
              </button>
            )}
            <button onClick={onClose}>Cancel</button>
            <button
              className="primary"
              disabled={!valid}
              onClick={() => {
                saveAiSettings(draft);
                setSettings(draft);
                setSetup(false);
              }}
            >
              Turn on
            </button>
          </>
        }
      >
        <div className="fieldGrid">
          <label>
            Anthropic API key
            <input type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} placeholder="sk-ant-…" onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
          </label>
          <label>
            Model
            <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
              {AI_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details className="aiAdvanced">
          <summary>Advanced</summary>
          <label>
            API address (leave empty for Anthropic)
            <input value={draft.baseURL} placeholder="https://api.anthropic.com" onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} />
          </label>
          {!validBaseURL(draft.baseURL) && <p className="fieldError">Use an https:// address, or http://localhost for a gateway on this computer.</p>}
        </details>
        <label className="checkRow">
          <input type="checkbox" checked={draft.consent} onChange={(event) => setDraft({ ...draft, consent: event.target.checked })} />
          <span>
            I understand that when I press Send, the text of the pages I choose is sent to <b>{aiHost(draft)}</b>. Nothing is sent otherwise.
          </span>
        </label>
        <label className="checkRow">
          <input type="checkbox" checked={draft.remember} onChange={(event) => setDraft({ ...draft, remember: event.target.checked })} />
          <span>Remember the key on this device (otherwise it is forgotten when you close the app)</span>
        </label>
      </Modal>
    );
  }

  const plan = scope === "all" ? { groups: [Array.from({ length: pageCount }, (_, index) => index)] } : scope === "page" ? { groups: [[currentPage]] } : parseRanges(range, pageCount);
  const indexes = "groups" in plan ? [...new Set(plan.groups.flat())].sort((a, b) => a - b) : [];

  const send = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setOutput("");
    setStatus("Reading the pages…");
    let text = "";
    const append = (delta: string) => {
      text += delta;
      setOutput(text);
    };
    try {
      const pages = (await textOf(indexes)).map((content) => content.trim());
      if (!pages.some(Boolean)) throw new AiError("There is no text on these pages. Scanned pages need OCR first.");
      let truncated = false;
      if (kind === "summary") {
        setStatus(`Summarizing with ${aiHost(settings)}…`);
        const joined = pages.map((content, index) => (indexes.length > 1 ? `--- Page ${indexes[index]! + 1} ---\n${content}` : content)).join("\n\n");
        truncated = (await runAi(settings, { kind: "summary" }, joined, append, abort.signal)).truncated;
      } else {
        // Page by page, so long documents never run past one answer's length.
        for (const [position, content] of pages.entries()) {
          if (!content) continue;
          if (indexes.length > 1) append(`${text ? "\n\n" : ""}Page ${indexes[position]! + 1}\n`);
          setStatus(`Translating page ${position + 1} of ${pages.length} with ${aiHost(settings)}…`);
          truncated = (await runAi(settings, { kind: "translate", language }, content, append, abort.signal)).truncated || truncated;
        }
      }
      setStatus(truncated ? "The answer reached its length limit and may be cut short." : "Done.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "The request failed.");
    } finally {
      setRunning(false);
      controller.current = null;
    }
  };

  return (
    <Modal
      title="AI assistant"
      className="wideModal"
      description={`Uses ${AI_MODELS.find((model) => model.id === settings.model)?.label ?? settings.model} through ${aiHost(settings)} with your key.`}
      onClose={() => {
        controller.current?.abort();
        onClose();
      }}
      footer={
        <>
          <button onClick={() => setSetup(true)} disabled={running}>
            <Settings /> AI settings
          </button>
          {running ? (
            <button onClick={() => controller.current?.abort()}>
              <Square /> Stop
            </button>
          ) : (
            <button className="primary" disabled={!indexes.length} onClick={() => void send()}>
              Send {indexes.length} page{indexes.length === 1 ? "" : "s"}
            </button>
          )}
        </>
      }
    >
      <div className="segmented" role="radiogroup" aria-label="Task">
        <button role="radio" aria-checked={kind === "summary"} className={kind === "summary" ? "active" : ""} onClick={() => setKind("summary")}>
          Summarize
        </button>
        <button role="radio" aria-checked={kind === "translate"} className={kind === "translate" ? "active" : ""} onClick={() => setKind("translate")}>
          Translate
        </button>
      </div>
      <div className="fieldGrid">
        <label>
          Pages
          <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="page">This page ({currentPage + 1})</option>
            <option value="all">All pages</option>
            <option value="range">Page range…</option>
          </select>
        </label>
        {scope === "range" && (
          <label>
            Pages to send
            <input value={range} placeholder="e.g. 1-3, 5" onChange={(event) => setRange(event.target.value)} />
          </label>
        )}
        {kind === "translate" && (
          <label>
            Into
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              {LANGUAGES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="aiNote">
        Sends the text of {indexes.length === pageCount && pageCount > 1 ? "every page" : `${indexes.length} page${indexes.length === 1 ? "" : "s"}`} to {aiHost(settings)}, including your edits. Pictures are not sent.
      </p>
      {(output || status) && (
        <section className="aiResult" aria-label="Result">
          {status && (
            <p className="aiStatus" role="status">
              {running && <span className="spinner" />} {status}
            </p>
          )}
          {output && <div className="aiOutput">{output}</div>}
          {output && !running && (
            <div className="aiActions">
              <button onClick={() => void navigator.clipboard?.writeText(output)}>
                <Copy /> Copy
              </button>
              <button onClick={() => onSave(output, kind === "summary" ? "summary" : "translation")}>
                <Download /> Save as text
              </button>
            </div>
          )}
        </section>
      )}
    </Modal>
  );
}
