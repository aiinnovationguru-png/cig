import { createClient } from '@supabase/supabase-js';

// URL e chiave pubblicabile identificano il progetto di prova. Sono pubblici:
// la protezione dei dati è applicata sul server tramite autenticazione e RLS.
// Un deployment diverso può sovrascriverli con le variabili VITE_*.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || 'https://ulfxnswidqjsxsjmknws.supabase.co';
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) || 'sb_publishable_Dv_6c1rLy2tAyobh87eY-g_YlmJiQ2z';

// La chiave pubblicabile non bypassa RLS. Le chiavi secret/service_role non
// devono mai essere usate nel frontend o nei file VITE_*.
export const supabase = url && key ? createClient(url, key) : null;
