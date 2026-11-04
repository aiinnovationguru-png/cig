import { invoke } from '@tauri-apps/api/core';
import { useCigStore } from '../store/cigStore';

export async function api<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args ?? {});
  } catch (err: unknown) {
    const { setToast } = useCigStore.getState();
    const msg = err instanceof Error ? err.message : String(err);
    setToast({ message: `Errore ${cmd}: ${msg}`, tone: 'error' });
    throw err;
  }
}
