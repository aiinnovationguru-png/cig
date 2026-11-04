import { useEffect } from 'react';
import { useCigStore } from '../../store/cigStore';

/** Messaggio di esito in basso a destra: si chiude da solo, ma resta leggibile. */
export function Toast() {
  const toast = useCigStore((state) => state.toast);
  const dismissToast = useCigStore((state) => state.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismissToast, 6000);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;
  const error = toast.tone === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
      className={`fixed bottom-6 right-6 z-[60] max-w-[440px] rounded border px-3.5 py-2.5 text-[12px] shadow-lg ${
        error
          ? 'border-rose-300 bg-rose-50 text-rose-900'
          : 'border-cyan-300 bg-cyan-50 text-cyan-900'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 leading-snug">{toast.message}</span>
        <button
          type="button"
          onClick={dismissToast}
          aria-label="Chiudi il messaggio"
          className="-mr-1 -mt-0.5 shrink-0 rounded px-1 text-[13px] leading-none opacity-60 hover:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
