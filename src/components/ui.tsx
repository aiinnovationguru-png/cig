import { useEffect, useId, useRef, type ReactNode } from "react";

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "accent" | "success";
}) {
  const valueTone =
    tone === "accent" ? "text-amber-700" : tone === "success" ? "text-emerald-700" : "text-heading";
  return (
    <div className="card px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-[22px] font-semibold leading-tight tabular ${valueTone}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "amber" | "green" | "blue" | "red";
}) {
  const tones: Record<string, string> = {
    neutral: "border-line bg-slate-50 text-slate-600",
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    green: "border-emerald-300 bg-emerald-50 text-emerald-800",
    blue: "border-sky-300 bg-sky-50 text-sky-800",
    red: "border-rose-300 bg-rose-50 text-rose-800",
  };
  return <span className={`badge ${tones[tone]}`}>{children}</span>;
}

export function Bar({
  value,
  max,
  tone = "amber",
  height = 6,
}: {
  value: number;
  max: number;
  tone?: "amber" | "green" | "red" | "slate";
  height?: number;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const colors: Record<string, string> = {
    amber: "bg-amber-500",
    green: "bg-emerald-600",
    red: "bg-rose-600",
    slate: "bg-slate-400",
  };
  return (
    <div className="w-full overflow-hidden rounded-full bg-slate-200" style={{ height }}>
      <div
        className={`rounded-full ${colors[tone]}`}
        style={{ width: `${ratio * 100}%`, height }}
      />
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-6 py-14 text-center">
      <div className="text-[13px] font-medium text-heading">{title}</div>
      {hint ? <div className="mt-1 max-w-md text-[12px] leading-relaxed text-muted">{hint}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-cyan-700"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

/// Gestisce il fuoco di una superficie modale (modali e pannelli laterali):
/// porta il fuoco dentro, tiene il Tab all'interno e alla chiusura lo restituisce
/// all'elemento che l'aveva aperta.
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(active = true) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.offsetParent !== null);

    container.focus({ preventScroll: true });
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      previous?.focus?.({ preventScroll: true });
    };
  }, [active]);

  return ref;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  const boxRef = useDialogFocus(open);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`card mt-12 w-full ${width} overflow-hidden shadow-2xl shadow-black/50 focus:outline-none`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h3 id={titleId} className="text-[14px] font-semibold text-heading">
            {title}
          </h3>
          <button className="btn btn-ghost px-2 py-1" onClick={onClose} aria-label="Chiudi">
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-[12px] text-copy"
    >
      <span
        className={`relative h-5 w-9 rounded-full transition-colors ${
          checked ? "bg-cyan-700" : "bg-slate-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-all ${
            checked ? "left-4.5" : "left-0.5"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

export function Progress({ value, total }: { value: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
      <div
        className="h-full rounded-full bg-cyan-700 transition-all"
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}
