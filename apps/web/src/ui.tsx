import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";

/** Number input that accepts temporary invalid drafts and commits on blur/Enter. */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
}) {
  const format = (input: number) => String(Math.round(input * 100) / 100);
  const [draft, setDraft] = useState(format(value));
  useEffect(() => setDraft(format(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(format(value));
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(format(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      className="numberInput"
      aria-label={label}
      inputMode="decimal"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const next = Math.min(max, Math.max(min, (Number(draft) || value) + (event.key === "ArrowUp" ? step : -step)));
          setDraft(format(next));
          onCommit(next);
        }
      }}
    />
  );
}

export function Modal({
  title,
  description,
  className = "",
  onClose,
  closeDisabled,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  className?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Everything behind the dialog is out of reach, for the mouse, keyboard and
    // screen readers alike. Messages stay readable.
    const hidden: Element[] = [];
    for (let child: Element | null = node?.parentElement ?? null; child && child !== document.body; child = child.parentElement) {
      for (const sibling of child.parentElement?.children ?? []) {
        if (sibling === child || sibling.hasAttribute("inert") || sibling.matches(".toasts, script, style")) continue;
        sibling.setAttribute("inert", "");
        hidden.push(sibling);
      }
    }
    if (node && !node.contains(document.activeElement))
      (node.querySelector<HTMLElement>("[autofocus], input, select, textarea, button.primary") ?? node).focus();
    return () => {
      hidden.forEach((element) => element.removeAttribute("inert"));
      previous?.focus?.();
    };
  }, []);
  // Tab and Shift+Tab cycle through the dialog's own controls.
  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !ref.current) return;
    const focusable = [...ref.current.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")].filter(
      (element) => !element.matches(":disabled, [tabindex='-1']") && element.offsetParent !== null,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className="modalBackdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          trapFocus(event);
          if (event.key === "Escape" && !closeDisabled) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modalHeader">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button aria-label={`Close ${title.toLowerCase()}`} disabled={closeDisabled} onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="modalBody">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

export function Toast({ kind, message, onDismiss }: { kind: "error" | "success"; message: string; onDismiss: () => void }) {
  useEffect(() => {
    // Errors stay until read; progress/success notices clear themselves.
    if (kind === "error") return;
    const timer = window.setTimeout(onDismiss, Math.min(9000, 3500 + message.length * 40));
    return () => window.clearTimeout(timer);
  }, [kind, message, onDismiss]);
  return (
    <div className={`toast ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{message}</span>
      <button aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </button>
    </div>
  );
}
