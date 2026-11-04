import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type View =
  | 'ricerca'
  | 'intelligence'
  | 'bacheca'
  | 'valutazione'
  | 'alert'
  | 'dati'
  | 'impostazioni'
  | 'api-esterni';

export interface ToastMessage {
  message: string;
  tone: 'info' | 'error';
}

/**
 * Stato condiviso dell'interfaccia: sezione attiva e messaggi.
 * Gli altri dati (statistiche, segnali, drawer) vivono in Layout, che è l'unico
 * componente che li possiede.
 */
interface CigState {
  view: View;
  setView: (view: View) => void;
  toast: ToastMessage | null;
  setToast: (toast: ToastMessage) => void;
  dismissToast: () => void;
}

export const useCigStore = create<CigState>()(
  persist(
    (set) => ({
      view: 'ricerca',
      setView: (view) => set({ view }),
      toast: null,
      setToast: (toast) => set({ toast }),
      dismissToast: () => set({ toast: null }),
    }),
    {
      name: 'cig-ui',
      // Solo la sezione resta tra un avvio e l'altro: un toast salvato
      // verrebbe ripresentato vecchio al riavvio.
      partialize: (state) => ({ view: state.view }),
    },
  ),
);
