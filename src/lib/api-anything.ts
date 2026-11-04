import { invoke } from "@tauri-apps/api/core";

export interface ApiAnythingResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    class: string;
    reason: string;
    next?: string;
    retry?: string;
    retryAfterMs?: number;
  };
}

export interface SiteInfo {
  name: string;
  operations: OperationInfo[];
  notes?: string;
  source: "local" | "catalog";
}

export interface OperationInfo {
  name: string;
  description?: string;
  argsSchema: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  isWrite: boolean;
}

export interface CallResult<T = unknown> {
  ok: boolean;
  class: string;
  tier?: number;
  data?: T;
  reason?: string;
  next?: string;
  retry?: string;
  retryAfterMs?: number;
  write?: string;
  heal?: {
    strategy: string;
    changes: Record<string, unknown>;
  };
  nextPage?: string;
  hasMore?: boolean;
  resultId?: string;
  more?: boolean;
}

export interface LearnResult {
  site: string;
  operation: string;
  proven: boolean;
  checkInput: Record<string, unknown>;
}

const PREDEFINED_SITES = [
  "anac",
  "ted",
  "simog",
  "acquistinrete",
  "mepa",
  "start",
  "bonifica",
] as const;

export type PredefinedSite = typeof PREDEFINED_SITES[number];

export function isPredefinedSite(site: string): site is PredefinedSite {
  return PREDEFINED_SITES.includes(site as PredefinedSite);
}

/**
 * Search for sites in the catalog by query
 */
export async function apiAnythingSites(
  query?: string
): Promise<ApiAnythingResult<SiteInfo[]>> {
  try {
    const data = await invoke<SiteInfo[]>("api_anything_sites", {
      query,
    });
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        class: "error",
        reason: String(err),
      },
    };
  }
}

/**
 * List operations for a site
 */
export async function apiAnythingOps(site: string): Promise<ApiAnythingResult<OperationInfo[]>> {
  try {
    const data = await invoke<OperationInfo[]>("api_anything_ops", { site });
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        class: "error",
        reason: String(err),
      },
    };
  }
}

/**
 * Call an operation on a site
 */
export async function apiAnythingCall<T = unknown>(
  site: string,
  op: string,
  args: Record<string, unknown>
): Promise<ApiAnythingResult<CallResult<T>>> {
  try {
    const argsJson = JSON.stringify(args);
    const data = await invoke<CallResult<T>>("api_anything_call", {
      site,
      op,
      args_json: argsJson,
    });
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        class: "error",
        reason: String(err),
      },
    };
  }
}

/**
 * Typed call helper
 */
export async function callTyped<TArgs extends Record<string, unknown>, TResult>(
  site: string,
  operation: string,
  args: TArgs
): Promise<ApiAnythingResult<CallResult<TResult>>> {
  return apiAnythingCall<TResult>(site, operation, args);
}

export const apiAnythingService = {
  sites: apiAnythingSites,
  ops: apiAnythingOps,
  call: apiAnythingCall,
  callTyped,
  isPredefinedSite,
  PREDEFINED_SITES,
};